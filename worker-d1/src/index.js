/* =========================================================================
   One Stop Heating and Cooling · Worker
   -------------------------------------------------------------------------
   Dos endpoints, los dos con la misma forma:

     POST /api/leer-cliente   { mime, datos, hoy }  →  { nombre, telefono, ..., trabajo_titulo, trabajo_fecha, ... }
     POST /api/leer-baucher   { mime, datos }       →  { fecha, numero, monto, banco, notas }

   `datos` es la imagen o el PDF en base64. La respuesta son los campos del
   formulario; lo que la IA no encuentre vuelve como texto vacío.

   POR QUÉ EXISTE ESTE WORKER: la clave de Claude no se puede poner en la app,
   porque la app corre en el navegador y cualquiera vería la clave en el código
   fuente. Acá adentro nadie la ve — la app le pide al Worker, y el Worker le
   pide a Claude.

   Defensas (mientras no exista el login):
     · Solo se aceptan pedidos desde los sitios de ORIGENES_PERMITIDOS.
     · Se rechaza cualquier archivo que no sea imagen o PDF.
     · Se rechaza cualquier archivo de más de 5 MB.
     · La red de seguridad final es el TOPE DE GASTO del workspace en la
       consola de Claude: si algo se descontrola, se corta ahí.
   ========================================================================= */

/* Mismo modelo que usa DES, la otra app de Rene, donde ya demostró leer bien
   comprobantes y PDF. Unas 6 veces más barato que Opus para esta tarea: copiar
   datos de una captura no necesita razonamiento profundo. */
const MODELO = "claude-haiku-4-5";
const MAX_BYTES = 5 * 1024 * 1024;
const TIPOS_OK = ["image/jpeg", "image/png", "image/gif", "image/webp", "application/pdf"];

/* Los campos son EXACTAMENTE los del formulario de cliente en la app.
   `required` con todos: la IA devuelve texto vacío en vez de omitir el campo,
   así la app no tiene que adivinar qué falta. */
const ESQUEMA_CLIENTE = {
  type: "object",
  properties: {
    nombre: { type: "string", description: "Nombre y apellido de la persona. Vacío si no aparece." },
    empresa: { type: "string", description: "Nombre del negocio, solo si se menciona uno." },
    telefono: { type: "string", description: "Teléfono tal como aparece, sin reformatear." },
    email: { type: "string", description: "Correo electrónico. Vacío si no aparece." },
    direccion: { type: "string", description: "Dirección del servicio: calle y número, ciudad y estado." },
    notas: { type: "string", description: "Una o dos frases: qué necesita el cliente." },
    /* Lo del TRABAJO que pide: con esto la app llena también el formulario de
       trabajo cuando el cliente se crea desde "Nuevo trabajo". Mismo criterio,
       texto vacío si no aparece. */
    trabajo_titulo: { type: "string", description: "Nombre corto del trabajo que pide, de 3 a 8 palabras (ej. 'Revisión de AC que no enfría'). Vacío si no se entiende qué pide." },
    trabajo_fecha: { type: "string", description: "Día en que pide el servicio, en formato AAAA-MM-DD. Vacío si no dice un día." },
    trabajo_hora_inicio: { type: "string", description: "Hora a la que pide que empiece el servicio, HH:MM en 24 horas. Vacío si no dice una hora." },
    trabajo_hora_fin: { type: "string", description: "Hora a la que termina el servicio, HH:MM en 24 horas. Vacío si no la dice." },
  },
  required: ["nombre", "empresa", "telefono", "email", "direccion", "notas",
    "trabajo_titulo", "trabajo_fecha", "trabajo_hora_inicio", "trabajo_hora_fin"],
  additionalProperties: false,
};

/* Es una función y no un texto fijo porque lleva la fecha de HOY: sin ella la
   IA no puede saber qué día es "mañana" o "el martes". */
const instruccionesCliente = (hoy) => `Esta imagen es la captura de una conversación (mensaje de texto, WhatsApp, correo) entre una empresa de aire acondicionado y una persona que pide servicio.

Extraé los datos del CLIENTE —la persona que pide el servicio, no la empresa que responde— y del TRABAJO que pide.

Reglas:
- Copiá los datos tal como aparecen. No corrijas ni completes nada.
- Si un dato no está en la imagen, devolvé texto vacío. NO lo inventes ni lo deduzcas.
- Si hay varias personas, quedate con quien pide el servicio.
- El teléfono puede estar en el encabezado del chat, no solo en el texto.
- En "notas", resumí en una o dos frases qué necesita, con las palabras del cliente. Si dice cuándo lo quiere, incluilo tal como lo dijo ("el martes en la tarde").
- "trabajo_titulo" va en el mismo idioma que el mensaje.

Fecha y hora del trabajo:
- Son las del SERVICIO que pide, NO la hora en que se mandó el mensaje (la que aparece al lado de cada burbuja).
- Hoy es ${hoy}. Si dice un día relativo ("mañana", "el martes", "next Monday"), calculalo desde la fecha en que se mandó el mensaje si se ve en la captura; si no se ve, desde hoy.
- Si dice solo "en la mañana" o "en la tarde", sin una hora, dejá las horas vacías.
- Si hay cualquier duda sobre el día, dejá la fecha vacía: una fecha equivocada termina en el calendario en el día equivocado.`;

/* Lo que se saca de un comprobante de pago. Mismo criterio que el de cliente:
   `required` con todos y texto vacío cuando no aparece, para que la app no
   tenga que adivinar qué falta. El monto va como TEXTO tal cual se lee: la app
   lo convierte a centavos con su propia función, que es la que sabe de comas y
   puntos. Si el Worker mandara un número, ya habría redondeado por su cuenta. */
const ESQUEMA_BAUCHER = {
  type: "object",
  properties: {
    fecha: { type: "string", description: "Fecha del pago tal como aparece. Vacío si no está." },
    numero: { type: "string", description: "Número de transferencia, referencia o autorización." },
    monto: { type: "string", description: "Monto total pagado, solo el número tal como se lee." },
    banco: { type: "string", description: "Banco o medio de pago (Chase, Zelle, efectivo...)." },
    notas: { type: "string", description: "Concepto del pago en pocas palabras, si aparece." },
  },
  required: ["fecha", "numero", "monto", "banco", "notas"],
  additionalProperties: false,
};

const INSTRUCCIONES_BAUCHER = `Esta imagen es un comprobante de pago: una transferencia, un depósito, un recibo o el ticket de una compra.

Extraé los datos del pago.

Reglas:
- Copiá los datos tal como aparecen. No corrijas ni completes nada.
- Si un dato no está, devolvé texto vacío. NO lo inventes ni lo deduzcas.
- El monto es el TOTAL pagado, no el subtotal ni el impuesto por separado.
- Devolvé el monto solo como número, sin el signo de moneda.
- Si hay varias fechas, la del pago, no la de impresión.`;

/* Cada ruta con su esquema, sus instrucciones y lo que devuelve. Agregar una
   tercera es un bloque más acá y no tocar el resto.
   `salida` es de CADA ruta: antes la respuesta armaba siempre los campos del
   cliente, y un baucher habría vuelto vacío (fecha, número y monto se perdían
   por el camino sin ningún error). Se encontró antes de publicarlo, sep 2026. */
const RUTAS = {
  "/api/leer-cliente": {
    esquema: ESQUEMA_CLIENTE,
    instrucciones: instruccionesCliente,
    salida: (c) => ({
      nombre: texto_(c.nombre),
      empresa: texto_(c.empresa),
      telefono: texto_(c.telefono),
      email: texto_(c.email),
      direccion: texto_(c.direccion),
      notas: texto_(c.notas),
      trabajo_titulo: texto_(c.trabajo_titulo).slice(0, 120),
      // Lo que no tenga la forma exacta vuelve vacío: la app no adivina.
      trabajo_fecha: fechaValida(texto_(c.trabajo_fecha)),
      trabajo_hora_inicio: horaValida(texto_(c.trabajo_hora_inicio)),
      trabajo_hora_fin: horaValida(texto_(c.trabajo_hora_fin)),
    }),
  },
  "/api/leer-baucher": {
    esquema: ESQUEMA_BAUCHER,
    instrucciones: () => INSTRUCCIONES_BAUCHER,
    salida: (c) => ({
      fecha: texto_(c.fecha),
      numero: texto_(c.numero),
      monto: texto_(c.monto),
      banco: texto_(c.banco),
      notas: texto_(c.notas),
    }),
  },
};

export default {
  async fetch(request, env) {
    const origen = request.headers.get("Origin") || "";
    const permitido = origenPermitido(origen, env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cabeceras(permitido ? origen : "") });
    }
    if (!permitido) {
      return responder({ error: "error_ia_origen" }, 403, "");
    }

    const url = new URL(request.url);
    const ruta = RUTAS[url.pathname];
    if (!ruta || request.method !== "POST") {
      return responder({ error: "error_ia_ruta" }, 404, origen);
    }
    if (!env.ANTHROPIC_API_KEY) {
      return responder({ error: "error_ia_sin_clave" }, 500, origen);
    }

    let cuerpo;
    try {
      cuerpo = await request.json();
    } catch {
      return responder({ error: "error_ia_pedido" }, 400, origen);
    }

    const mime = String(cuerpo?.mime || "");
    const datos = String(cuerpo?.datos || "");
    if (!TIPOS_OK.includes(mime)) return responder({ error: "error_ia_tipo" }, 400, origen);
    if (!datos) return responder({ error: "error_ia_pedido" }, 400, origen);
    // base64 ocupa ~4 caracteres por cada 3 bytes reales
    if (datos.length * 0.75 > MAX_BYTES) return responder({ error: "error_ia_pesado" }, 413, origen);
    /* La fecha de HOY la manda la app —la del teléfono, en California—: el
       Worker corre en UTC, y a la tarde de allá acá ya sería mañana. */
    const hoy = /^\d{4}-\d{2}-\d{2}$/.test(String(cuerpo?.hoy || ""))
      ? cuerpo.hoy : new Date().toISOString().slice(0, 10);

    const adjunto = mime === "application/pdf"
      ? { type: "document", source: { type: "base64", media_type: mime, data: datos } }
      : { type: "image", source: { type: "base64", media_type: mime, data: datos } };

    let respuesta;
    try {
      respuesta = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: MODELO,
          max_tokens: 4000,
          // Salida estructurada: la respuesta siempre tiene la forma exacta del
          // formulario, sin parsear texto a mano.
          // OJO: no agregar `effort` acá. Haiku 4.5 no lo acepta y devuelve 400.
          // Si algún día se vuelve a un modelo Opus/Sonnet, ahí sí se puede usar.
          output_config: {
            format: { type: "json_schema", schema: ruta.esquema },
          },
          messages: [{ role: "user", content: [adjunto, { type: "text", text: ruta.instrucciones(hoy) }] }],
        }),
      });
    } catch {
      return responder({ error: "error_ia_red" }, 502, origen);
    }

    if (!respuesta.ok) {
      const detalle = await respuesta.text();
      console.error("Claude respondió", respuesta.status, detalle);
      // 429 = sin créditos o demasiados pedidos; es el caso que más se ve
      const clave = respuesta.status === 429 ? "error_ia_sin_creditos" : "error_ia_servicio";
      return responder({ error: clave }, 502, origen);
    }

    const mensaje = await respuesta.json();

    // Los clasificadores de seguridad pueden rechazar el pedido: llega 200
    // igual, con stop_reason "refusal" y sin contenido.
    if (mensaje.stop_reason === "refusal") {
      return responder({ error: "error_ia_rechazado" }, 422, origen);
    }

    const texto = (mensaje.content || []).find((b) => b.type === "text")?.text;
    if (!texto) return responder({ error: "error_ia_vacio" }, 502, origen);

    let campos;
    try {
      campos = JSON.parse(texto);
    } catch {
      return responder({ error: "error_ia_vacio" }, 502, origen);
    }

    return responder(ruta.salida(campos), 200, origen);
  },
};

/* ---------------- Utilidades ---------------- */
function texto_(v) {
  return typeof v === "string" ? v.trim() : "";
}

/* AAAA-MM-DD de un día que exista (sin 31 de febrero); si no, vacío. */
function fechaValida(v) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return "";
  const [a, m, d] = v.split("-").map(Number);
  const f = new Date(Date.UTC(a, m - 1, d));
  return f.getUTCFullYear() === a && f.getUTCMonth() === m - 1 && f.getUTCDate() === d ? v : "";
}

/* HH:MM en 24 horas (9:00 → 09:00); cualquier otra cosa, vacío. */
function horaValida(v) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(v);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return "";
  return m[1].padStart(2, "0") + ":" + m[2];
}

function origenPermitido(origen, env) {
  const lista = String(env.ORIGENES_PERMITIDOS || "")
    .split(",")
    .map((o) => o.trim().replace(/\/$/, ""))
    .filter(Boolean);
  return lista.includes(origen.replace(/\/$/, ""));
}

function cabeceras(origen) {
  const h = {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
    vary: "Origin",
  };
  if (origen) h["access-control-allow-origin"] = origen;
  return h;
}

function responder(cuerpo, estado, origen) {
  return new Response(JSON.stringify(cuerpo), { status: estado, headers: cabeceras(origen) });
}
