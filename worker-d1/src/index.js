/* =========================================================================
   One Stop Heating and Cooling · Worker
   -------------------------------------------------------------------------
   Único endpoint por ahora:

     POST /api/leer-cliente   { mime, datos }  →  { nombre, telefono, ... }

   `datos` es la imagen o el PDF en base64. La respuesta son los campos del
   formulario de cliente; lo que la IA no encuentre vuelve como texto vacío.

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
  },
  required: ["nombre", "empresa", "telefono", "email", "direccion", "notas"],
  additionalProperties: false,
};

const INSTRUCCIONES = `Esta imagen es la captura de una conversación (mensaje de texto, WhatsApp, correo) entre una empresa de aire acondicionado y una persona que pide servicio.

Extraé los datos del CLIENTE — la persona que pide el servicio, no la empresa que responde.

Reglas:
- Copiá los datos tal como aparecen. No corrijas ni completes nada.
- Si un dato no está en la imagen, devolvé texto vacío. NO lo inventes ni lo deduzcas.
- Si hay varias personas, quedate con quien pide el servicio.
- El teléfono puede estar en el encabezado del chat, no solo en el texto.
- En "notas", resumí en una o dos frases qué necesita, con las palabras del cliente.`;

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
    if (url.pathname !== "/api/leer-cliente" || request.method !== "POST") {
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
            format: { type: "json_schema", schema: ESQUEMA_CLIENTE },
          },
          messages: [{ role: "user", content: [adjunto, { type: "text", text: INSTRUCCIONES }] }],
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

    return responder({
      nombre: texto_(campos.nombre),
      empresa: texto_(campos.empresa),
      telefono: texto_(campos.telefono),
      email: texto_(campos.email),
      direccion: texto_(campos.direccion),
      notas: texto_(campos.notas),
    }, 200, origen);
  },
};

/* ---------------- Utilidades ---------------- */
function texto_(v) {
  return typeof v === "string" ? v.trim() : "";
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
