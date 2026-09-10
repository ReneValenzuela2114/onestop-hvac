/* =========================================================================
   One Stop Heating and Cooling · Capa de datos
   -------------------------------------------------------------------------
   Cómo está armado (tres capas, de abajo hacia arriba):

     1. ALMACÉN   → el único lugar que sabe DÓNDE se guardan los datos.
                    Hoy: localStorage. Mañana: fetch() al Worker de D1.
                    Cuando llegue D1, se reemplaza este objeto y nada más.

     2. ESTADO    → una copia de todo en memoria, cargada una sola vez al
                    abrir la app (DB.iniciar()). Las pantallas leen de acá,
                    así que leer sigue siendo INSTANTÁNEO aunque los datos
                    vengan de internet. Esto es lo que evita tener que
                    reescribir las 46 llamadas del index.html el día que
                    conectemos la base.

     3. REPOS     → DB.clientes, DB.trabajos, etc. Lo único que usa la UI.
                    Validan, escriben en el estado y le avisan al almacén.

   Reglas que no se rompen:
   - La plata SIEMPRE en centavos enteros (precio_centavos, costo_centavos).
     Nunca decimales: 0.1 + 0.2 no da 0.3 en una computadora y los reportes
     terminan sin cuadrar. Usar el helper `Dinero` para convertir.
   - Nada se borra de verdad: se marca `eliminado` con la fecha y se esconde.
   - Los campos de cada objeto son EXACTAMENTE las columnas de su tabla en
     worker-d1/schema.sql. Campo nuevo = se agrega en los dos lados.
   - IDs: crypto.randomUUID(). Fechas de auditoría: epoch ms (Date.now()).
   ========================================================================= */

const ESQUEMA_VERSION = 13;

const CLAVES = {
  clientes: "os_clientes_v1",
  categoriasClientes: "os_categorias_clientes_v1",
  usuarios: "os_usuarios_v1",
  trabajos: "os_trabajos_v1",
  archivos: "os_archivos_v1",
  proveedores: "os_proveedores_v1",
  catalogo: "os_catalogo_v1",
  cotizaciones: "os_cotizaciones_v1",
  cotizacionItems: "os_cotizacion_items_v1",
  conversiones: "os_conversiones_v1",
  combos: "os_combos_v1",
  comboItems: "os_combo_items_v1",
  movimientos: "os_movimientos_v1",
  cuentas: "os_cuentas_v1",
  config: "os_config_v1",
};

const COLECCIONES = ["clientes", "categoriasClientes", "usuarios", "trabajos", "archivos", "proveedores", "catalogo", "cotizaciones", "cotizacionItems", "conversiones", "combos", "comboItems", "movimientos", "cuentas"];

/* Los bytes de los archivos (logo, y en el futuro fotos) no viven con los
   demás datos: van aparte, igual que van a vivir aparte en R2. */
const PREFIJO_BYTES = "os_bytes_";

/* ---------- Error propio, para que la UI sepa qué mostrar ---------- */
class ErrorDatos extends Error {
  constructor(codigo, detalle = null) {
    super(codigo);
    this.name = "ErrorDatos";
    this.codigo = codigo;   // clave de i18n, ej. "error_sin_espacio"
    this.detalle = detalle; // en validación: lista de claves de i18n
  }
}

/* ---------- Utilidades ---------- */
function _uuid() {
  return crypto.randomUUID
    ? crypto.randomUUID()
    : "id-" + Date.now() + "-" + Math.random().toString(16).slice(2);
}
function _texto(v, porDefecto = "") {
  return typeof v === "string" ? v.trim() : porDefecto;
}
function _numeroONulo(v) {
  return typeof v === "number" && isFinite(v) ? v : null;
}
/* Epoch ms → "YYYY-MM-DD" en la hora LOCAL del dispositivo.
   Nunca usar toISOString() acá: devuelve la fecha en UTC y de noche adelanta
   un día, así que una cotización hecha hoy saldría fechada mañana. */
function _fechaLocalISO(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/* =========================================================================
   DINERO · la plata se guarda en centavos enteros, siempre
   -------------------------------------------------------------------------
   $250.50 se guarda como 25050. Se divide por 100 solo para mostrarlo.
   ========================================================================= */
const Dinero = {
  /* Texto del formulario → centavos. "" da 0; basura da NaN (lo caza la validación). */
  aCentavos(valor) {
    if (valor === "" || valor === null || valor === undefined) return 0;
    const n = typeof valor === "number" ? valor : parseFloat(String(valor).replace(",", "."));
    if (!isFinite(n) || n < 0) return NaN;
    return Math.round(n * 100);
  },
  /* Centavos → texto para un <input type="number">. 25050 → "250.50" */
  aTexto(centavos) {
    return (Math.round(centavos || 0) / 100).toFixed(2);
  },
  /* Centavos → texto para mostrar en pantalla. 25050 → "$250.50" */
  formato(centavos, lang) {
    return new Intl.NumberFormat(lang === "es" ? "es-US" : "en-US", {
      style: "currency", currency: "USD",
    }).format((centavos || 0) / 100);
  },
  esValido(centavos) {
    return Number.isInteger(centavos) && centavos >= 0;
  },
};

/* =========================================================================
   CANTIDAD · igual que el dinero, en centésimas enteras
   -------------------------------------------------------------------------
   "12.5 pies de tubería" se guarda como 1250. Misma razón que la plata: una
   cantidad se suma y se resta muchas veces (entradas y salidas de bodega) y
   se multiplica por el precio. Con decimales, cada operación arrastra un
   error invisible; en enteros no hay error que arrastrar.

   Para multiplicar cantidad por precio SIEMPRE usar `porPrecio`, nunca a mano.
   ========================================================================= */
const Cantidad = {
  aCentesimas(valor) {
    if (valor === "" || valor === null || valor === undefined) return 0;
    const n = typeof valor === "number" ? valor : parseFloat(String(valor).replace(",", "."));
    if (!isFinite(n) || n < 0) return NaN;
    return Math.round(n * 100);
  },
  /* 1250 → "12.5" (sin ceros de relleno: las cantidades se leen mejor así) */
  aTexto(centesimas) {
    const n = (Math.round(centesimas || 0)) / 100;
    return String(Number(n.toFixed(2)));
  },
  esValida(centesimas) {
    return Number.isInteger(centesimas) && centesimas >= 0;
  },
  /* 12.5 pies × $4.50 → centavos exactos, sin pasar por decimales */
  porPrecio(centesimas, precioCentavos) {
    return Math.round(((Number(centesimas) || 0) * (Number(precioCentavos) || 0)) / 100);
  },
};

/* =========================================================================
   CAPA 1 · ALMACÉN — el único lugar que sabe dónde viven los datos
   -------------------------------------------------------------------------
   Todos los métodos devuelven una promesa aunque hoy localStorage sea
   instantáneo: así el día que adentro haya un fetch() al Worker, la forma
   de la capa no cambia y no hay que tocar nada más.
   ========================================================================= */
/* Una colección sin su clave escribiría en `localStorage["undefined"]`, la
   MISMA para todas las que falten: se pisan entre sí y los datos salen
   mezclados. Pasó de verdad al agregar combos —conversiones venía sin clave
   desde antes y no se notó porque era la única—. Falla acá, ruidoso y al
   arrancar, en vez de aparecer como un dato raro tres pantallas después. */
for (const col of COLECCIONES) {
  if (!CLAVES[col]) throw new Error("Falta CLAVES." + col + " en data.js");
}

const AlmacenLocal = {
  cargarTodo() {
    const datos = { config: {} };
    for (const col of COLECCIONES) datos[col] = this._leer(CLAVES[col], []);
    datos.config = this._leer(CLAVES.config, {});
    return Promise.resolve(datos);
  },

  /* Con localStorage las tres operaciones son la misma: reescribir la
     colección entera. Con D1 pasan a ser POST / PATCH / DELETE distintos. */
  crear(coleccion) { return this._volcar(coleccion); },
  actualizar(coleccion) { return this._volcar(coleccion); },
  eliminar(coleccion) { return this._volcar(coleccion); },
  guardarConfig() { return this._volcar("config"); },

  leerBytes(clave) {
    return Promise.resolve(localStorage.getItem(PREFIJO_BYTES + clave));
  },
  guardarBytes(clave, dataUrl) {
    return this._intentar(() => localStorage.setItem(PREFIJO_BYTES + clave, dataUrl));
  },
  borrarBytes(clave) {
    localStorage.removeItem(PREFIJO_BYTES + clave);
    return Promise.resolve();
  },

  _leer(clave, porDefecto) {
    try {
      const crudo = localStorage.getItem(clave);
      return crudo ? JSON.parse(crudo) : porDefecto;
    } catch (e) {
      console.error("Datos corruptos en", clave, e);
      return porDefecto;
    }
  },
  _volcar(coleccion) {
    return this._intentar(() =>
      localStorage.setItem(CLAVES[coleccion], JSON.stringify(_estado[coleccion])));
  },
  _intentar(fn) {
    try {
      fn();
      return Promise.resolve();
    } catch (e) {
      const sinEspacio = e.name === "QuotaExceededError" || e.code === 22;
      return Promise.reject(new ErrorDatos(sinEspacio ? "error_sin_espacio" : "error_guardado_fallido", e));
    }
  },
};

let Almacen = AlmacenLocal;

/* =========================================================================
   CAPA 2 · ESTADO en memoria
   ========================================================================= */
let _estado = { clientes: [], categoriasClientes: [], usuarios: [], trabajos: [], archivos: [], proveedores: [], catalogo: [], config: {} };
let _iniciado = false;

/* La UI registra acá qué hacer si falla un guardado (mostrar un aviso).
   Nunca se pierde un error en silencio. */
let _alFallarGuardado = (err) => console.error("Guardado fallido:", err);

function _persistir(promesa) {
  promesa.catch((err) => _alFallarGuardado(err));
}

/* Quién está usando el dispositivo — se firma solo en creado_por /
   actualizado_por, sin que las pantallas tengan que pasarlo a mano. */
function _usuarioActualId() {
  return _estado.config.usuario_actual_id || null;
}

/* =========================================================================
   VALIDACIÓN
   -------------------------------------------------------------------------
   Devuelve una lista de claves de i18n. Vacía = está bien.
   Ojo: esto es la red de contención del programador. Cuando exista el
   Worker, la MISMA validación tiene que correr en el servidor: al navegador
   nunca se le cree.
   ========================================================================= */
const ROLES = ["dueno", "administrador", "tecnico"];
const ESTADOS_CLIENTE = ["activo", "inactivo"];
/* Lead = todavía no compró nada; cliente = ya le vendimos. Es distinto de
   activo/inactivo: un lead puede estar activo (lo estamos persiguiendo) y un
   cliente puede estar inactivo (hace años que no llama). Por eso son dos
   campos y no uno solo con cuatro valores. */
const RELACIONES_CLIENTE = ["lead", "cliente"];
const ESTADOS_TRABAJO_VALIDOS = ["por_agendar", "agendado", "en_curso", "terminado", "cancelado"];
const TIPOS_ARCHIVO = ["foto", "documento", "firma", "logo"];
const ENTIDADES_ARCHIVO = ["trabajo", "cliente", "usuario", "empresa"];
const ESTADOS_COTIZACION = ["borrador", "enviada", "aprobada", "rechazada", "vencida"];
const TIPOS_CATALOGO = ["equipo", "material", "servicio"];
const UNIDADES = ["unidad", "pie", "libra", "galon", "hora", "juego"];
/* Un movimiento LISTO ya pasó de verdad; uno PENDIENTE es una promesa. Solo
   los listos suman al saldo — es la regla que trae DES y es la que hace que
   el número de arriba sea plata que existe y no plata que se espera. */
const ESTADOS_MOVIMIENTO = ["listo", "pendiente"];
/* Las mismas tres de DES, a pedido de Rene. Solo aplican a los movimientos de
   la EMPRESA; los de un trabajo se agrupan por su trabajo, no por categoría. */
const CATEGORIAS_MOVIMIENTO = ["mantenimiento", "impuestos", "otros"];

const RE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const RE_FECHA = /^\d{4}-\d{2}-\d{2}$/;
const RE_HORA = /^([01]\d|2[0-3]):[0-5]\d$/;

const Validar = {
  cliente(d) {
    const e = [];
    if (!_texto(d.nombre)) e.push("error_nombre_requerido");
    if (_texto(d.email) && !RE_EMAIL.test(_texto(d.email))) e.push("error_email_invalido");
    if (d.estado !== undefined && !ESTADOS_CLIENTE.includes(d.estado)) e.push("error_estado_invalido");
    if (d.relacion !== undefined && !RELACIONES_CLIENTE.includes(d.relacion)) e.push("error_relacion_invalida");
    return e;
  },
  trabajo(d) {
    const e = [];
    if (!d.cliente_id) e.push("error_cliente_requerido");
    else if (!Clientes.get(d.cliente_id)) e.push("error_cliente_inexistente");
    if (!_texto(d.titulo)) e.push("error_titulo_requerido");
    if (d.estado !== undefined && !ESTADOS_TRABAJO_VALIDOS.includes(d.estado)) e.push("error_estado_invalido");
    if (d.fecha && !RE_FECHA.test(d.fecha)) e.push("error_fecha_invalida");
    if ((d.estado === "agendado" || d.estado === "en_curso") && !d.fecha) e.push("error_fecha_requerida");
    for (const campo of ["hora_inicio", "hora_fin"]) {
      if (_texto(d[campo]) && !RE_HORA.test(d[campo])) e.push("error_hora_invalida");
    }
    for (const campo of ["precio_centavos", "costo_centavos"]) {
      if (d[campo] !== undefined && !Dinero.esValido(d[campo])) e.push("error_monto_invalido");
    }
    return e;
  },
  usuario(d) {
    const e = [];
    if (!_texto(d.nombre)) e.push("error_nombre_requerido");
    if (d.rol !== undefined && !ROLES.includes(d.rol)) e.push("error_rol_invalido");
    if (_texto(d.email) && !RE_EMAIL.test(_texto(d.email))) e.push("error_email_invalido");
    return e;
  },
  categoria(d) {
    const e = [];
    if (!_texto(d.nombre)) e.push("error_nombre_requerido");
    return e;
  },
  cotizacion(d) {
    const e = [];
    if (!d.cliente_id) e.push("error_cliente_requerido");
    else if (!Clientes.get(d.cliente_id)) e.push("error_cliente_inexistente");
    if (!_texto(d.titulo)) e.push("error_titulo_requerido");
    if (d.estado !== undefined && !ESTADOS_COTIZACION.includes(d.estado)) e.push("error_estado_invalido");
    for (const campo of ["fecha", "valida_hasta"]) {
      if (d[campo] && !RE_FECHA.test(d[campo])) e.push("error_fecha_invalida");
    }
    /* El impuesto se guarda en centésimas de por ciento: 7.25% es 725. Igual
       que la plata, entero, para que no se arrastre error al calcular. */
    if (d.impuesto_centesimas !== undefined
        && (!Number.isInteger(d.impuesto_centesimas) || d.impuesto_centesimas < 0 || d.impuesto_centesimas > 10000)) {
      e.push("error_impuesto_invalido");
    }
    return e;
  },
  cotizacionItem(d) {
    const e = [];
    if (!_texto(d.nombre)) e.push("error_nombre_requerido");
    if (d.unidad !== undefined && !UNIDADES.includes(d.unidad)) e.push("error_unidad_invalida");
    if (!Cantidad.esValida(d.cantidad_centesimas) || d.cantidad_centesimas <= 0) e.push("error_cantidad_invalida");
    for (const campo of ["precio_centavos", "costo_centavos"]) {
      if (d[campo] !== undefined && !Dinero.esValido(d[campo])) e.push("error_monto_invalido");
    }
    return e;
  },
  combo(d) {
    const e = [];
    if (!_texto(d.nombre)) e.push("error_nombre_requerido");
    return e;
  },
  /* El renglón de un combo se valida EXACTAMENTE igual que el de una
     cotización: son la misma cosa guardada en dos tablas. Si un día se
     endurece una, hay que endurecer la otra. */
  comboItem(d) {
    return this.cotizacionItem(d);
  },
  movimiento(d) {
    const e = [];
    if (!_texto(d.descripcion)) e.push("error_descripcion_requerida");
    if (!d.fecha || !RE_FECHA.test(d.fecha)) e.push("error_fecha_invalida");
    if (d.trabajo_id && !Trabajos.get(d.trabajo_id)) e.push("error_trabajo_inexistente");
    if (d.estado !== undefined && !ESTADOS_MOVIMIENTO.includes(d.estado)) e.push("error_estado_invalido");
    /* La categoría solo tiene sentido en un movimiento de la empresa: uno de
       un trabajo ya está agrupado por su trabajo. */
    if (!d.trabajo_id && d.categoria !== undefined && !CATEGORIAS_MOVIMIENTO.includes(d.categoria)) {
      e.push("error_categoria_invalida");
    }
    for (const campo of ["entrada_centavos", "salida_centavos"]) {
      if (d[campo] !== undefined && !Dinero.esValido(d[campo])) e.push("error_monto_invalido");
    }
    /* Un movimiento es entrada O salida, nunca las dos ni ninguna: si fuera
       las dos, el saldo lo tomaría como la resta y nadie sabría qué pasó. */
    const ent = d.entrada_centavos || 0, sal = d.salida_centavos || 0;
    if (ent > 0 && sal > 0) e.push("error_entrada_y_salida");
    if (ent <= 0 && sal <= 0) e.push("error_monto_requerido");
    return e;
  },
  cuenta(d) {
    const e = [];
    if (!_texto(d.descripcion)) e.push("error_descripcion_requerida");
    if (d.tipo !== "entrada" && d.tipo !== "salida") e.push("error_tipo_invalido");
    if (!Dinero.esValido(d.total_centavos) || d.total_centavos <= 0) e.push("error_monto_requerido");
    if (d.trabajo_id && !Trabajos.get(d.trabajo_id)) e.push("error_trabajo_inexistente");
    return e;
  },
  proveedor(d) {
    const e = [];
    if (!_texto(d.nombre)) e.push("error_nombre_requerido");
    if (_texto(d.email) && !RE_EMAIL.test(_texto(d.email))) e.push("error_email_invalido");
    return e;
  },
  catalogo(d) {
    const e = [];
    if (!_texto(d.nombre)) e.push("error_nombre_requerido");
    if (d.tipo !== undefined && !TIPOS_CATALOGO.includes(d.tipo)) e.push("error_tipo_invalido");
    if (d.unidad !== undefined && !UNIDADES.includes(d.unidad)) e.push("error_unidad_invalida");
    if (d.proveedor_id && !Proveedores.get(d.proveedor_id)) e.push("error_proveedor_inexistente");
    for (const campo of ["precio_centavos", "costo_centavos"]) {
      if (d[campo] !== undefined && !Dinero.esValido(d[campo])) e.push("error_monto_invalido");
    }
    for (const campo of ["stock_centesimas", "stock_minimo_centesimas"]) {
      if (d[campo] !== undefined && !Cantidad.esValida(d[campo])) e.push("error_cantidad_invalida");
    }
    if (d.capacidad_btu !== undefined && d.capacidad_btu !== null
        && (!Number.isInteger(d.capacidad_btu) || d.capacidad_btu < 0)) e.push("error_capacidad_invalida");
    /* El código es el que se busca y el que va a cruzar con facturas del
       proveedor: dos productos con el mismo código vuelven ambiguo el reporte. */
    const codigo = _texto(d.codigo);
    if (codigo && _vivos("catalogo").some((x) => x.id !== d.id && _texto(x.codigo).toLowerCase() === codigo.toLowerCase())) {
      e.push("error_codigo_repetido");
    }
    return e;
  },
};

function _exigir(errores) {
  if (errores.length) throw new ErrorDatos("error_validacion", errores);
}

/* ---------- Sellos de auditoría, iguales para todas las tablas ---------- */
function _sellosNuevo() {
  const ahora = Date.now();
  const yo = _usuarioActualId();
  return { creado: ahora, creado_por: yo, actualizado: ahora, actualizado_por: yo, eliminado: null, eliminado_por: null };
}
function _sellosEdicion() {
  return { actualizado: Date.now(), actualizado_por: _usuarioActualId() };
}

/* Toma solo los campos permitidos de `datos` que realmente vinieron.
   Sin esto, quien llame puede pisar id, creado o rol. */
function _tomar(datos, campos) {
  const out = {};
  for (const c of campos) if (datos[c] !== undefined) out[c] = datos[c];
  return out;
}

function _vivos(coleccion) {
  return _estado[coleccion].filter((x) => !x.eliminado);
}
function _borradoSuave(coleccion, id) {
  const item = _estado[coleccion].find((x) => x.id === id);
  if (!item || item.eliminado) return false;
  item.eliminado = Date.now();
  item.eliminado_por = _usuarioActualId();
  Object.assign(item, _sellosEdicion());
  _persistir(Almacen.actualizar(coleccion, item));
  return true;
}

/* =========================================================================
   CAPA 3 · REPOSITORIOS (lo único que usa la interfaz)
   ========================================================================= */

/* ---------------- Clientes ---------------- */
const CAMPOS_CLIENTE = [
  "nombre", "empresa", "telefono", "email", "direccion", "direccion_2", "lat", "lng",
  "fact_igual", "direccion_fact", "direccion_fact_2", "categoria_id", "notas", "estado",
  "relacion",
];

const Clientes = {
  getAll() {
    return _vivos("clientes").slice().sort((a, b) => a.nombre.localeCompare(b.nombre, "en"));
  },
  get(id) {
    return _vivos("clientes").find((c) => c.id === id) || null;
  },
  create(datos) {
    _exigir(Validar.cliente(datos));
    const item = {
      id: _uuid(),
      nombre: _texto(datos.nombre),
      empresa: _texto(datos.empresa),
      telefono: _texto(datos.telefono),
      email: _texto(datos.email),
      direccion: _texto(datos.direccion),
      direccion_2: _texto(datos.direccion_2),
      lat: _numeroONulo(datos.lat),
      lng: _numeroONulo(datos.lng),
      fact_igual: datos.fact_igual !== false,
      direccion_fact: _texto(datos.direccion_fact),
      direccion_fact_2: _texto(datos.direccion_fact_2),
      categoria_id: datos.categoria_id || null,
      notas: _texto(datos.notas),
      estado: datos.estado === "inactivo" ? "inactivo" : "activo",
      /* Nace como lead: nadie es cliente hasta que le vendimos algo. */
      relacion: datos.relacion === "cliente" ? "cliente" : "lead",
      ..._sellosNuevo(),
    };
    _estado.clientes.push(item);
    _persistir(Almacen.crear("clientes", item));
    /* Nacer ya como cliente cuenta para los reportes: si no se registrara,
       "clientes ganados este mes" dejaría fuera al que se dio de alta así. */
    if (item.relacion === "cliente") Conversiones._registrar(item.id, null, "cliente");
    return item;
  },
  update(id, datos) {
    const item = this.get(id);
    if (!item) return null;
    _exigir(Validar.cliente({ ...item, ..._tomar(datos, CAMPOS_CLIENTE) }));
    const cambios = _tomar(datos, CAMPOS_CLIENTE);
    const relacionAntes = item.relacion;
    for (const campo of ["nombre", "empresa", "telefono", "email", "direccion", "direccion_2",
      "direccion_fact", "direccion_fact_2", "notas"]) {
      if (cambios[campo] !== undefined) cambios[campo] = _texto(cambios[campo]);
    }
    if (cambios.lat !== undefined) cambios.lat = _numeroONulo(cambios.lat);
    if (cambios.lng !== undefined) cambios.lng = _numeroONulo(cambios.lng);
    if (cambios.categoria_id !== undefined) cambios.categoria_id = cambios.categoria_id || null;
    Object.assign(item, cambios, _sellosEdicion());
    _persistir(Almacen.actualizar("clientes", item));
    /* Va acá adentro y no en la pantalla: así queda grabado venga de donde
       venga el cambio —la lista, el formulario o una importación— y ninguna
       pantalla nueva puede olvidarse de registrarlo. */
    if (item.relacion !== relacionAntes) {
      Conversiones._registrar(item.id, relacionAntes, item.relacion);
    }
    return item;
  },
  /* No borra: marca como eliminado. Se bloquea si tiene trabajos, para no
     dejar historial de plata colgando de un cliente que ya no aparece. */
  remove(id) {
    if (Trabajos.deCliente(id).length) throw new ErrorDatos("error_cliente_con_trabajos");
    return _borradoSuave("clientes", id);
  },
};

/* ---------------- Combos ----------------
   Un combo es una RECETA, no un documento: "Sistema completo 3 toneladas" =
   condensadora + evaporadora + línea + mano de obra. Sirve para no cargar los
   mismos ocho renglones a mano cada vez.

   Un renglón de combo es EXACTAMENTE un renglón de cotización: mismo nombre,
   descripción, unidad, cantidad, precio, costo y ojo del PDF. Se guarda todo,
   no se apunta al catálogo. Así el combo se arma igual que una cotización —se
   puede cambiar un nombre, poner un precio de paquete, esconder el permiso— y
   al jalarlo se copia tal cual quedó.

   Consecuencia que hay que tener presente: **el combo NO se entera si mañana
   cambia el precio en el catálogo.** Es el precio del día que se armó. Para
   eso está `actualizarPreciosDesdeCatalogo()`, que se dispara con un botón y
   nunca sola: refrescar en silencio cambiaría un precio de paquete puesto a
   mano sin que nadie lo pida. */
const CAMPOS_COMBO = ["nombre", "descripcion", "notas", "activo"];

const Combos = {
  getAll() {
    return _vivos("combos").slice().sort((a, b) => a.nombre.localeCompare(b.nombre));
  },
  activos() {
    return this.getAll().filter((c) => c.activo !== false);
  },
  get(id) {
    return _vivos("combos").find((c) => c.id === id) || null;
  },
  create(datos = {}) {
    _exigir(Validar.combo(datos));
    const item = {
      id: _uuid(),
      nombre: _texto(datos.nombre),
      descripcion: _texto(datos.descripcion),
      notas: _texto(datos.notas),
      activo: datos.activo !== false,
      ..._sellosNuevo(),
    };
    _estado.combos.push(item);
    _persistir(Almacen.crear("combos", item));
    return item;
  },
  update(id, datos) {
    const item = this.get(id);
    if (!item) return null;
    const cambios = _tomar(datos, CAMPOS_COMBO);
    _exigir(Validar.combo({ ...item, ...cambios }));
    for (const c of ["nombre", "descripcion", "notas"]) {
      if (cambios[c] !== undefined) cambios[c] = _texto(cambios[c]);
    }
    Object.assign(item, cambios, _sellosEdicion());
    _persistir(Almacen.actualizar("combos", item));
    return item;
  },
  remove(id) {
    /* Los renglones se van con él. No es historial de plata: es una receta que
       ya no se usa, y dejarlos sueltos solo ensucia la base. */
    _vivos("comboItems").filter((i) => i.combo_id === id)
      .forEach((i) => _borradoSuave("comboItems", i.id));
    return _borradoSuave("combos", id);
  },

  /* ---- Los productos que lleva ---- */
  items(comboId) {
    return _vivos("comboItems").filter((i) => i.combo_id === comboId)
      .slice().sort((a, b) => a.orden - b.orden);
  },
  guardarItems(comboId, filas) {
    if (!this.get(comboId)) return null;
    const limpias = (filas || []).map((f, i) => {
      const item = {
        id: _uuid(),
        combo_id: comboId,
        catalogo_id: f.catalogo_id || null,
        nombre: _texto(f.nombre),
        descripcion: _texto(f.descripcion),
        unidad: UNIDADES.includes(f.unidad) ? f.unidad : "unidad",
        cantidad_centesimas: Math.round(Number(f.cantidad_centesimas) || 0),
        precio_centavos: Math.round(Number(f.precio_centavos) || 0),
        costo_centavos: Math.round(Number(f.costo_centavos) || 0),
        /* Mismo significado que en la cotización (regla 3g): 0 saca el renglón
           de la lista impresa pero su plata sigue contando. Se copia al jalar
           el combo, así el permiso que nunca se muestra queda escondido de una
           vez y no hay que acordarse en cada cotización. */
        en_pdf: f.en_pdf === 0 || f.en_pdf === false ? 0 : 1,
        orden: i,
        ..._sellosNuevo(),
      };
      _exigir(Validar.comboItem(item));
      return item;
    });
    /* Se valida TODO antes de escribir: si el renglón 5 está mal, no puede
       quedar el combo con los primeros cuatro y sin el resto. */
    _vivos("comboItems").filter((i) => i.combo_id === comboId)
      .forEach((i) => _borradoSuave("comboItems", i.id));
    limpias.forEach((i) => {
      _estado.comboItems.push(i);
      _persistir(Almacen.crear("comboItems", i));
    });
    return limpias;
  },

  /* Un renglón vacío para escribir a mano, igual que en la cotización. */
  filaManual() {
    return Cotizaciones.filaManual();
  },

  /* Lo que vale el combo. Suma sus propios renglones, no el catálogo. No se
     guarda en ningún lado, por lo mismo que los totales de la cotización
     (regla 3d): dos verdades terminan sin coincidir.

     `desactualizados` cuenta los renglones que vinieron del catálogo y hoy
     tienen otro precio allá. No se corrige solo —sería pisar un precio de
     paquete puesto a mano—: la pantalla lo avisa y ofrece el botón. */
  totales(comboId) {
    let precio = 0, costo = 0, desactualizados = 0;
    for (const i of this.items(comboId)) {
      precio += Cantidad.porPrecio(i.cantidad_centesimas, i.precio_centavos || 0);
      costo += Cantidad.porPrecio(i.cantidad_centesimas, i.costo_centavos || 0);
      if (!i.catalogo_id) continue;
      const p = Catalogo.get(i.catalogo_id);
      if (p && (p.precio_centavos !== i.precio_centavos || p.costo_centavos !== i.costo_centavos)) {
        desactualizados++;
      }
    }
    return { precio_centavos: precio, costo_centavos: costo, desactualizados };
  },

  /* Trae el precio y el costo de hoy del catálogo a los renglones que vinieron
     de ahí. Lo dispara un botón, nunca corre sola: el nombre, la descripción,
     la cantidad y el ojo NO se tocan, porque son lo que la persona ajustó a
     mano para este combo. */
  actualizarPreciosDesdeCatalogo(comboId) {
    const antes = this.items(comboId);
    const filas = antes.map((i) => {
      const p = i.catalogo_id ? Catalogo.get(i.catalogo_id) : null;
      if (!p) return i;
      return { ...i, precio_centavos: p.precio_centavos || 0, costo_centavos: p.costo_centavos || 0 };
    });
    const cambiados = filas.filter((f, n) =>
      f.precio_centavos !== antes[n].precio_centavos || f.costo_centavos !== antes[n].costo_centavos).length;
    if (cambiados) this.guardarItems(comboId, filas);
    return cambiados;
  },

  /* Los renglones listos para meter en una cotización: se copia TODO tal como
     quedó el combo —nombre, descripción, unidad, cantidad, precio, costo y el
     ojo del PDF—. De acá en adelante rige la regla 3b y la cotización queda
     congelada aunque después se toque el combo. */
  filasParaCotizacion(comboId) {
    return this.items(comboId).map((i) => ({
      catalogo_id: i.catalogo_id || null,
      nombre: i.nombre,
      descripcion: i.descripcion || "",
      unidad: i.unidad,
      cantidad_centesimas: i.cantidad_centesimas,
      precio_centavos: i.precio_centavos || 0,
      costo_centavos: i.costo_centavos || 0,
      en_pdf: i.en_pdf === 0 ? 0 : 1,
    }));
  },
};

/* ---------------- Movimientos de dinero ----------------
   El libro de la plata: qué entró y qué salió, de verdad.

   `trabajo_id` con valor = el movimiento es de ESE trabajo (lo que se cobró y
   lo que se gastó haciéndolo). En null = es de la empresa (renta, impuestos,
   herramienta) y entonces va a una de las tres categorías.

   ⚠️ Cada movimiento es una FILA de su propia tabla, no una lista guardada
   adentro del trabajo. En DES viven adentro del proyecto y arreglarlo con
   datos reales costó tres días; acá nace bien.

   El precio y el costo del trabajo son lo PRESUPUESTADO; esto es lo que pasó
   de verdad. Son dos cosas y por eso se guardan aparte: comparar una con otra
   es justamente lo que dice si el trabajo salió como se pensaba. */
const CAMPOS_MOVIMIENTO = ["trabajo_id", "cuenta_id", "categoria", "fecha", "descripcion",
  "entrada_centavos", "salida_centavos", "estado", "archivo_id"];

const Movimientos = {
  getAll() {
    /* Por fecha y, dentro del mismo día, por orden de carga: dos movimientos
       del mismo día tienen que salir siempre en el mismo orden o el saldo
       corrido baila de una pantalla a otra. */
    return _vivos("movimientos").slice()
      .sort((a, b) => (a.fecha || "").localeCompare(b.fecha || "") || a.creado - b.creado);
  },
  get(id) {
    return _vivos("movimientos").find((m) => m.id === id) || null;
  },
  /* Los de un trabajo. */
  deTrabajo(trabajoId) {
    return this.getAll().filter((m) => m.trabajo_id === trabajoId);
  },
  /* Los de la empresa: los que no cuelgan de ningún trabajo. */
  deEmpresa(categoria) {
    return this.getAll().filter((m) => !m.trabajo_id && (!categoria || m.categoria === categoria));
  },
  create(datos = {}) {
    const item = {
      id: _uuid(),
      trabajo_id: datos.trabajo_id || null,
      cuenta_id: datos.cuenta_id || null,
      categoria: datos.trabajo_id ? null
        : (CATEGORIAS_MOVIMIENTO.includes(datos.categoria) ? datos.categoria : "otros"),
      fecha: datos.fecha || _fechaLocalISO(Date.now()),
      descripcion: _texto(datos.descripcion),
      entrada_centavos: Math.round(Number(datos.entrada_centavos) || 0),
      salida_centavos: Math.round(Number(datos.salida_centavos) || 0),
      estado: ESTADOS_MOVIMIENTO.includes(datos.estado) ? datos.estado : "listo",
      archivo_id: datos.archivo_id || null,
      ..._sellosNuevo(),
    };
    _exigir(Validar.movimiento(item));
    _estado.movimientos.push(item);
    _persistir(Almacen.crear("movimientos", item));
    return item;
  },
  update(id, datos) {
    const item = this.get(id);
    if (!item) return null;
    const cambios = _tomar(datos, CAMPOS_MOVIMIENTO);
    if (cambios.descripcion !== undefined) cambios.descripcion = _texto(cambios.descripcion);
    for (const c of ["entrada_centavos", "salida_centavos"]) {
      if (cambios[c] !== undefined) cambios[c] = Math.round(Number(cambios[c]) || 0);
    }
    _exigir(Validar.movimiento({ ...item, ...cambios }));
    Object.assign(item, cambios, _sellosEdicion());
    _persistir(Almacen.actualizar("movimientos", item));
    return item;
  },
  remove(id) {
    return _borradoSuave("movimientos", id);
  },

  /* ---- Las cuentas ----
     Cuánto se lleva pagado de un acuerdo. Solo cuenta lo LISTO: una cuota
     prometida no baja lo que se debe. */
  pagadoDeCuenta(cuentaId) {
    return this.getAll()
      .filter((m) => m.cuenta_id === cuentaId && m.estado === "listo")
      .reduce((s, m) => s + (m.entrada_centavos || 0) + (m.salida_centavos || 0), 0);
  },

  /* ---- El saldo ----
     UNA sola función, como los totales de la cotización (regla 3d). Todo se
     acumula en centavos enteros: el saldo corrido suma fila por fila y con
     decimales cada suma arrastra su error; para la fila 150 ya no cierra.
     `pendientes` va aparte para poder mostrarlo sin mezclarlo con lo real. */
  totales(lista) {
    let entradas = 0, salidas = 0, entradasPend = 0, salidasPend = 0;
    for (const m of lista || []) {
      if (m.estado === "listo") {
        entradas += m.entrada_centavos || 0;
        salidas += m.salida_centavos || 0;
      } else {
        entradasPend += m.entrada_centavos || 0;
        salidasPend += m.salida_centavos || 0;
      }
    }
    return {
      entradas_centavos: entradas,
      salidas_centavos: salidas,
      saldo_centavos: entradas - salidas,
      entradas_pendientes_centavos: entradasPend,
      salidas_pendientes_centavos: salidasPend,
    };
  },
};

/* ---------------- Cuentas (acuerdos que se pagan en cuotas) ----------------
   "Instalación del equipo, $3,000, a pagar en tres". La cuenta guarda el
   TOTAL acordado; cada cuota es un movimiento que apunta a ella. Así el
   pendiente se calcula y no se guarda: si se guardara, borrar una cuota
   dejaría el pendiente mintiendo. */
const CAMPOS_CUENTA = ["trabajo_id", "descripcion", "tipo", "total_centavos"];

const Cuentas = {
  getAll() {
    return _vivos("cuentas").slice().sort((a, b) => a.creado - b.creado);
  },
  get(id) {
    return _vivos("cuentas").find((c) => c.id === id) || null;
  },
  deTrabajo(trabajoId) {
    return this.getAll().filter((c) => c.trabajo_id === trabajoId);
  },
  deEmpresa() {
    return this.getAll().filter((c) => !c.trabajo_id);
  },
  create(datos = {}) {
    const item = {
      id: _uuid(),
      trabajo_id: datos.trabajo_id || null,
      descripcion: _texto(datos.descripcion),
      tipo: datos.tipo === "entrada" ? "entrada" : "salida",
      total_centavos: Math.round(Number(datos.total_centavos) || 0),
      ..._sellosNuevo(),
    };
    _exigir(Validar.cuenta(item));
    _estado.cuentas.push(item);
    _persistir(Almacen.crear("cuentas", item));
    return item;
  },
  update(id, datos) {
    const item = this.get(id);
    if (!item) return null;
    const cambios = _tomar(datos, CAMPOS_CUENTA);
    if (cambios.descripcion !== undefined) cambios.descripcion = _texto(cambios.descripcion);
    if (cambios.total_centavos !== undefined) cambios.total_centavos = Math.round(Number(cambios.total_centavos) || 0);
    _exigir(Validar.cuenta({ ...item, ...cambios }));
    Object.assign(item, cambios, _sellosEdicion());
    _persistir(Almacen.actualizar("cuentas", item));
    return item;
  },
  /* Al borrar la cuenta, sus cuotas NO se borran: son plata que se movió de
     verdad. Solo se sueltan del acuerdo y quedan como movimientos comunes. */
  remove(id) {
    _vivos("movimientos").filter((m) => m.cuenta_id === id)
      .forEach((m) => Movimientos.update(m.id, { cuenta_id: null }));
    return _borradoSuave("cuentas", id);
  },
  /* Cuánto se pagó y cuánto falta. No se guarda: se calcula (regla 3d). */
  estado(id) {
    const c = this.get(id);
    if (!c) return null;
    const pagado = Movimientos.pagadoDeCuenta(id);
    const pendiente = Math.max(0, c.total_centavos - pagado);
    const cuotas = Movimientos.getAll().filter((m) => m.cuenta_id === id).length;
    return { pagado_centavos: pagado, pendiente_centavos: pendiente, saldada: pendiente <= 0, cuotas };
  },
};

/* ---------------- Conversiones ----------------
   Una fila cada vez que una ficha cambia de lead a cliente o al revés. NO es
   un campo "fecha en que se hizo cliente": ese guarda solo la última vez y
   pierde el historial si alguien va y viene. Con una fila por cambio se puede
   preguntar "cuántos leads convertimos en septiembre" y la respuesta no
   depende de que nadie haya tocado la ficha después.

   Las escribe la capa de datos sola, dentro de `Clientes.create` y
   `Clientes.update`. Así queda registrado venga de donde venga —la lista, el
   formulario o una importación— y ninguna pantalla puede olvidarse.

   Un evento pasado no se edita ni se borra: es lo que hace que un reporte de
   marzo siga diciendo lo mismo dentro de dos años. Por eso este módulo no
   tiene `update` ni `remove`. */
const Conversiones = {
  getAll() {
    return _vivos("conversiones").slice().sort((a, b) => b.creado - a.creado);
  },
  deCliente(clienteId) {
    return this.getAll().filter((c) => c.cliente_id === clienteId);
  },
  /* Para los reportes: todo lo que pasó entre dos fechas, inclusive. Se
     compara sobre `fecha` (YYYY-MM-DD local) y no sobre `creado`, que es epoch
     UTC: agrupar por mes con el epoch corre los eventos de la noche al día
     siguiente y el reporte de fin de mes sale mal. */
  entre(desdeISO, hastaISO) {
    return this.getAll().filter((c) =>
      (!desdeISO || c.fecha >= desdeISO) && (!hastaISO || c.fecha <= hastaISO));
  },
  /* La primera vez que esta ficha pasó a cliente, que es la que interesa para
     medir cuánto tardó en convertir. Devuelve null si nunca lo fue. */
  primeraAcliente(clienteId) {
    return this.deCliente(clienteId).filter((c) => c.hacia === "cliente")
      .sort((a, b) => a.creado - b.creado)[0] || null;
  },
  /* Uso interno de Clientes. `desde` en null = la ficha nació así, no hubo
     conversión; se registra igual para que "clientes ganados en septiembre"
     no deje fuera al que se dio de alta ya como cliente. */
  _registrar(clienteId, desde, hacia) {
    if (!RELACIONES_CLIENTE.includes(hacia)) return null;
    if (desde === hacia) return null;
    const item = {
      id: _uuid(),
      cliente_id: clienteId,
      desde: RELACIONES_CLIENTE.includes(desde) ? desde : null,
      hacia,
      fecha: _fechaLocalISO(Date.now()),
      ..._sellosNuevo(),
    };
    _estado.conversiones.push(item);
    _persistir(Almacen.crear("conversiones", item));
    return item;
  },
};

/* ---------------- Categorías de clientes ---------------- */
const CAMPOS_CATEGORIA = ["nombre", "color", "orden"];

const CategoriasClientes = {
  getAll() {
    return _vivos("categoriasClientes").slice().sort((a, b) => a.orden - b.orden);
  },
  get(id) {
    return _vivos("categoriasClientes").find((c) => c.id === id) || null;
  },
  create(nombre, color = "#2E8FD9") {
    _exigir(Validar.categoria({ nombre }));
    const item = {
      id: _uuid(),
      nombre: _texto(nombre),
      color: color || "#2E8FD9",
      orden: _vivos("categoriasClientes").length,
      ..._sellosNuevo(),
    };
    _estado.categoriasClientes.push(item);
    _persistir(Almacen.crear("categoriasClientes", item));
    return item;
  },
  update(id, datos) {
    const item = this.get(id);
    if (!item) return null;
    const cambios = _tomar(datos, CAMPOS_CATEGORIA);
    _exigir(Validar.categoria({ ...item, ...cambios }));
    if (cambios.nombre !== undefined) cambios.nombre = _texto(cambios.nombre);
    Object.assign(item, cambios, _sellosEdicion());
    _persistir(Almacen.actualizar("categoriasClientes", item));
    return item;
  },
  enUso(id) {
    return _vivos("clientes").some((c) => c.categoria_id === id);
  },
  remove(id) {
    if (this.enUso(id)) return false;
    return _borradoSuave("categoriasClientes", id);
  },
};

/* ---------------- Cotizaciones ----------------
   Dos tablas: el encabezado y sus renglones, una fila por renglón. Nunca la
   lista entera metida como texto adentro de la cotización.

   ⚠️ CADA RENGLÓN GUARDA SU PROPIA COPIA del nombre y del precio. El
   `catalogo_id` queda solo para reportes ("¿qué se vende más?"). Si el renglón
   apuntara al catálogo, subir un precio hoy cambiaría el total de una
   cotización que el cliente ya firmó. Las fotos del pasado no se recalculan. */
const CAMPOS_COTIZACION = ["cliente_id", "titulo", "descripcion", "estado", "fecha",
  "valida_hasta", "impuesto_centesimas", "notas", "trabajo_id", "mostrar_precios"];

const Cotizaciones = {
  getAll() {
    return _vivos("cotizaciones").slice().sort((a, b) => b.numero - a.numero);
  },
  get(id) {
    return _vivos("cotizaciones").find((c) => c.id === id) || null;
  },
  deCliente(clienteId) {
    return this.getAll().filter((c) => c.cliente_id === clienteId);
  },

  /* Consecutivo y legible: "COT-014". Nunca retrocede ni se reusa, aunque se
     borre una cotización: un número entregado a un cliente es para siempre. */
  _siguienteNumero() {
    const n = (parseInt(_estado.config.contador_cotizaciones, 10) || 0) + 1;
    Config.set("contador_cotizaciones", n);
    return n;
  },

  /* ---------- Renglones ---------- */
  items(cotizacionId) {
    return _vivos("cotizacionItems")
      .filter((i) => i.cotizacion_id === cotizacionId)
      .sort((a, b) => a.orden - b.orden);
  },

  /* Reemplaza el conjunto completo de renglones. Se hace así y no agregando
     encima porque editar una cotización es dejarla como se ve en pantalla:
     con lo agregado, lo cambiado y sin lo que se quitó. */
  guardarItems(cotizacionId, filas) {
    const cot = this.get(cotizacionId);
    if (!cot) return null;
    const limpias = (filas || []).map((f, i) => {
      const item = {
        nombre: _texto(f.nombre),
        descripcion: _texto(f.descripcion),
        unidad: UNIDADES.includes(f.unidad) ? f.unidad : "unidad",
        cantidad_centesimas: Math.round(Number(f.cantidad_centesimas) || 0),
        precio_centavos: Math.round(Number(f.precio_centavos) || 0),
        costo_centavos: Math.round(Number(f.costo_centavos) || 0),
        catalogo_id: f.catalogo_id || null,
        /* 1 = sale listado en el PDF, 0 = no. Esconderlo NO le quita la plata
           al total: el renglón se sigue cobrando, solo deja de mostrarse el
           desglose. Por eso `totales()` sigue sumando todos los renglones. */
        en_pdf: f.en_pdf === 0 || f.en_pdf === false ? 0 : 1,
        /* El orden lo manda la posición en el arreglo, que es la que la
           persona armó arrastrando. No se recalcula por nombre ni por precio. */
        orden: i,
      };
      _exigir(Validar.cotizacionItem(item));
      return item;
    });

    /* Se valida TODO antes de escribir nada: si el renglón 5 está mal, no
       puede quedar la cotización con los primeros cuatro y sin el resto. */
    const viejos = _estado.cotizacionItems.filter((i) => i.cotizacion_id === cotizacionId);
    for (const v of viejos) {
      const idx = _estado.cotizacionItems.indexOf(v);
      if (idx >= 0) _estado.cotizacionItems.splice(idx, 1);
    }
    for (const l of limpias) {
      _estado.cotizacionItems.push({ id: _uuid(), cotizacion_id: cotizacionId, ...l, ..._sellosNuevo() });
    }
    Object.assign(cot, _sellosEdicion());
    _persistir(Promise.all([
      Almacen.actualizar("cotizacionItems"),
      Almacen.actualizar("cotizaciones"),
    ]));
    return this.items(cotizacionId);
  },

  /* ---------- LA cuenta del total ----------
     Una sola función para toda la app. Si mañana cambia cómo se calcula, se
     cambia acá y no en cinco lugares que se van separando sin que nadie note.
     Todo en centavos enteros de punta a punta. */
  totales(cotizacionOId) {
    const cot = typeof cotizacionOId === "string" ? this.get(cotizacionOId) : cotizacionOId;
    const filas = cot ? this.items(cot.id) : [];
    let subtotal = 0, costo = 0;
    for (const f of filas) {
      subtotal += Cantidad.porPrecio(f.cantidad_centesimas, f.precio_centavos);
      costo += Cantidad.porPrecio(f.cantidad_centesimas, f.costo_centavos);
    }
    const tasa = Number(cot?.impuesto_centesimas) || 0; // 725 = 7.25%
    const impuesto = Math.round((subtotal * tasa) / 10000);
    return {
      renglones: filas.length,
      subtotal_centavos: subtotal,
      impuesto_centavos: impuesto,
      total_centavos: subtotal + impuesto,
      costo_centavos: costo,
      ganancia_centavos: subtotal - costo,
    };
  },

  /* Un renglón nuevo a partir de un producto del catálogo: acá es donde se
     hace la copia del precio. */
  filaDesdeCatalogo(catalogoId, cantidadCentesimas = 100) {
    const p = Catalogo.get(catalogoId);
    if (!p) return null;
    return {
      catalogo_id: p.id,
      nombre: p.nombre,
      descripcion: p.descripcion || "",
      unidad: p.unidad || "unidad",
      cantidad_centesimas: Math.round(Number(cantidadCentesimas) || 100),
      precio_centavos: p.precio_centavos || 0,
      costo_centavos: p.costo_centavos || 0,
      en_pdf: 1,
    };
  },

  /* Renglón escrito a mano, sin producto del catálogo. `catalogo_id` queda en
     null, que es lo que la tabla ya permitía: sirve para reportes saber que
     esto no salió del catálogo. */
  filaManual() {
    return {
      catalogo_id: null,
      nombre: "",
      descripcion: "",
      unidad: "unidad",
      cantidad_centesimas: 100,
      precio_centavos: 0,
      costo_centavos: 0,
      en_pdf: 1,
    };
  },

  create(datos = {}) {
    const limpio = {
      cliente_id: datos.cliente_id || null,
      titulo: _texto(datos.titulo),
      descripcion: _texto(datos.descripcion),
      estado: ESTADOS_COTIZACION.includes(datos.estado) ? datos.estado : "borrador",
      /* Sin fecha no hay cotización: si la pantalla no la manda, se pone hoy. */
      fecha: datos.fecha || _fechaLocalISO(Date.now()),
      valida_hasta: datos.valida_hasta || null,
      impuesto_centesimas: Math.round(Number(datos.impuesto_centesimas) || 0),
      notas: _texto(datos.notas),
      /* 0 = el PDF no muestra el precio ni el total de cada producto, solo el
         subtotal, el impuesto y el total. Arranca en 0 porque es como Rene
         manda las cotizaciones; se prende por cotización cuando hace falta. */
      /* null = automático: lo decide `mostrarPrecios()` mirando si hay algún
         renglón escondido. Solo las cotizaciones de antes de sep 2026 tienen
         acá un 0 o un 1 congelado. */
      mostrar_precios: datos.mostrar_precios === 0 || datos.mostrar_precios === 1
        ? datos.mostrar_precios : null,
      trabajo_id: null,
    };
    _exigir(Validar.cotizacion(limpio));
    const item = { id: _uuid(), numero: this._siguienteNumero(), ...limpio, ..._sellosNuevo() };
    _estado.cotizaciones.push(item);
    _persistir(Almacen.crear("cotizaciones", item));
    return item;
  },

  update(id, datos) {
    const item = this.get(id);
    if (!item) return null;
    const cambios = _tomar(datos, CAMPOS_COTIZACION);
    for (const c of ["titulo", "descripcion", "notas"]) {
      if (cambios[c] !== undefined) cambios[c] = _texto(cambios[c]);
    }
    if (cambios.impuesto_centesimas !== undefined) {
      cambios.impuesto_centesimas = Math.round(Number(cambios.impuesto_centesimas) || 0);
    }
    if (cambios.mostrar_precios !== undefined) {
      cambios.mostrar_precios = cambios.mostrar_precios === 0 || cambios.mostrar_precios === 1
        ? cambios.mostrar_precios : null;
    }
    _exigir(Validar.cotizacion({ ...item, ...cambios }));
    Object.assign(item, cambios, _sellosEdicion());
    _persistir(Almacen.actualizar("cotizaciones", item));
    return item;
  },

  /* ¿El PDF muestra el precio de cada renglón? UNA sola función lo decide,
     como con los totales: si la pantalla y el PDF lo calcularan cada uno por
     su lado, terminarían discrepando.

     Manda el ojo: si hay aunque sea un renglón escondido, los precios por
     renglón no salen. Es que la cuenta no cerraría —el escondido igual se
     cobra (regla 3g)— y el cliente que suma lo que ve encuentra menos que el
     total. Antes esto se elegía a mano con un check y podían quedar las dos
     cosas juntas, que es justo lo incoherente.

     Un 0 o un 1 guardado gana sobre el cálculo: son las cotizaciones que ya
     se enviaron antes de este cambio y no pueden cambiar de forma solas. */
  mostrarPrecios(cot) {
    if (!cot) return false;
    if (cot.mostrar_precios === 0 || cot.mostrar_precios === 1) return cot.mostrar_precios === 1;
    return !this.items(cot.id).some((i) => i.en_pdf === 0);
  },

  /* Enlaza una cotización con un trabajo que YA existe y la marca aprobada.
     Es lo que usa la pantalla: el trabajo lo arma la persona en su formulario
     —con fecha, técnicos y dirección— y recién cuando lo guarda se cierra el
     circuito. Así una cotización nunca queda "aprobada" por un trabajo que la
     persona terminó cancelando. */
  enlazarTrabajo(id, trabajoId) {
    const cot = this.get(id);
    const trabajo = Trabajos.get(trabajoId);
    if (!cot || !trabajo) return null;
    this.update(id, { estado: "aprobada", trabajo_id: trabajo.id });
    return trabajo;
  },

  /* Aprobar crea el trabajo solo, con el total ya puesto, y los deja enlazados.
     Lo usa la carga de datos de ejemplo, que crea muchos de una vez. La
     pantalla usa enlazarTrabajo(), para que la persona complete el trabajo.
     Así el circuito queda cerrado: cliente → cotización → trabajo → reporte. */
  aprobar(id) {
    const cot = this.get(id);
    if (!cot) return null;
    if (cot.trabajo_id && Trabajos.get(cot.trabajo_id)) {
      this.update(id, { estado: "aprobada" });
      return Trabajos.get(cot.trabajo_id);
    }
    const t = this.totales(cot);
    /* Al trabajo va el SUBTOTAL, sin impuesto. El impuesto no es plata de la
       empresa: se cobra y se entrega. Si fuera al precio del trabajo,
       `DB.trabajos.ganancia()` lo contaría como ganancia y todos los reportes
       de "cuánto se ganó" saldrían inflados por la tasa. El total con
       impuesto sigue estando en la cotización, que es el papel que firma el
       cliente. */
    const trabajo = Trabajos.create({
      cliente_id: cot.cliente_id,
      titulo: cot.titulo,
      descripcion: cot.descripcion,
      estado: "por_agendar",
      precio_centavos: t.subtotal_centavos,
      costo_centavos: t.costo_centavos,
    });
    this.update(id, { estado: "aprobada", trabajo_id: trabajo.id });
    return trabajo;
  },

  remove(id) {
    return _borradoSuave("cotizaciones", id);
  },
};

/* ---------------- Proveedores (a quién le compramos) ----------------
   Tabla propia, no un texto dentro del producto: así los reportes pueden
   agrupar por proveedor y el teléfono se corrige en un solo lugar. */
const CAMPOS_PROVEEDOR = ["nombre", "contacto", "telefono", "email", "sitio_web", "direccion", "notas", "activo"];

const Proveedores = {
  getAll() {
    return _vivos("proveedores").slice().sort((a, b) => a.nombre.localeCompare(b.nombre));
  },
  activos() {
    return this.getAll().filter((p) => p.activo !== false);
  },
  get(id) {
    return _vivos("proveedores").find((p) => p.id === id) || null;
  },
  create(datos = {}) {
    _exigir(Validar.proveedor(datos));
    const item = {
      id: _uuid(),
      nombre: _texto(datos.nombre),
      contacto: _texto(datos.contacto),
      telefono: _texto(datos.telefono),
      email: _texto(datos.email),
      sitio_web: _texto(datos.sitio_web),
      direccion: _texto(datos.direccion),
      notas: _texto(datos.notas),
      activo: datos.activo !== false,
      ..._sellosNuevo(),
    };
    _estado.proveedores.push(item);
    _persistir(Almacen.crear("proveedores", item));
    return item;
  },
  update(id, datos) {
    const item = this.get(id);
    if (!item) return null;
    const cambios = _tomar(datos, CAMPOS_PROVEEDOR);
    _exigir(Validar.proveedor({ ...item, ...cambios }));
    for (const c of CAMPOS_PROVEEDOR) {
      if (c !== "activo" && cambios[c] !== undefined) cambios[c] = _texto(cambios[c]);
    }
    Object.assign(item, cambios, _sellosEdicion());
    _persistir(Almacen.actualizar("proveedores", item));
    return item;
  },
  /* Cuántos productos le compramos: sirve para el reporte y para no borrarlo */
  productos(id) {
    return _vivos("catalogo").filter((p) => p.proveedor_id === id);
  },
  enUso(id) {
    return this.productos(id).length > 0;
  },
  remove(id) {
    if (this.enUso(id)) throw new ErrorDatos("error_proveedor_con_productos");
    return _borradoSuave("proveedores", id);
  },
};

/* ---------------- Catálogo (equipos, materiales y servicios) ----------------
   Una sola tabla con un campo `tipo`: los tres se buscan, se cotizan y se
   facturan igual. Separarlos en tres tablas obligaría a repetir la misma
   pantalla tres veces sin ganar nada.

   ⚠️ Al llevar un producto a una cotización o un trabajo se COPIA el precio,
   no se apunta acá. Si se apuntara, subir un precio hoy cambiaría el total de
   una cotización que el cliente ya firmó. */
const CAMPOS_CATALOGO = [
  "tipo", "codigo", "nombre", "descripcion", "marca", "modelo", "capacidad_btu",
  "proveedor_id", "unidad", "costo_centavos", "precio_centavos", "activo",
  /* Inventario: los campos ya existen para no migrar después. Todavía sin pantalla. */
  "controlar_stock", "stock_centesimas", "stock_minimo_centesimas", "ubicacion",
];

const Catalogo = {
  getAll() {
    return _vivos("catalogo").slice().sort((a, b) => a.nombre.localeCompare(b.nombre));
  },
  activos() {
    return this.getAll().filter((p) => p.activo !== false);
  },
  get(id) {
    return _vivos("catalogo").find((p) => p.id === id) || null;
  },

  /* Un solo buscador para toda la app: la pantalla de catálogo y, mañana, el
     selector de productos de una cotización. Si hubiera dos, se irían separando. */
  buscar({ texto = "", tipo = "", proveedor_id = "", marca = "", soloActivos = false } = {}) {
    const q = _texto(texto).toLowerCase();
    return this.getAll().filter((p) => {
      if (soloActivos && p.activo === false) return false;
      if (tipo && p.tipo !== tipo) return false;
      if (proveedor_id && p.proveedor_id !== proveedor_id) return false;
      if (marca && _texto(p.marca).toLowerCase() !== marca.toLowerCase()) return false;
      if (!q) return true;
      return [p.nombre, p.codigo, p.marca, p.modelo, p.descripcion]
        .some((campo) => _texto(campo).toLowerCase().includes(q));
    });
  },

  /* Las marcas que existen de verdad, para llenar el filtro sin inventarlas */
  marcas() {
    const vistas = new Map();
    for (const p of this.getAll()) {
      const m = _texto(p.marca);
      if (m && !vistas.has(m.toLowerCase())) vistas.set(m.toLowerCase(), m);
    }
    return [...vistas.values()].sort((a, b) => a.localeCompare(b));
  },

  /* LA cuenta del margen. Una sola, para que no aparezcan dos que no coinciden.
     `porcentaje` es null cuando no hay precio: cero por ciento sería mentira. */
  margen(item) {
    const costo = Number(item?.costo_centavos) || 0;
    const precio = Number(item?.precio_centavos) || 0;
    const ganancia = precio - costo;
    return {
      ganancia_centavos: ganancia,
      porcentaje: precio > 0 ? Math.round((ganancia / precio) * 100) : null,
    };
  },

  create(datos = {}) {
    const limpio = _normalizarCatalogo(datos);
    _exigir(Validar.catalogo(limpio));
    const item = { id: _uuid(), ...limpio, ..._sellosNuevo() };
    _estado.catalogo.push(item);
    _persistir(Almacen.crear("catalogo", item));
    return item;
  },
  update(id, datos) {
    const item = this.get(id);
    if (!item) return null;
    const cambios = _normalizarCatalogo(_tomar(datos, CAMPOS_CATALOGO), item);
    _exigir(Validar.catalogo({ ...item, ...cambios, id }));
    Object.assign(item, cambios, _sellosEdicion());
    _persistir(Almacen.actualizar("catalogo", item));
    return item;
  },
  remove(id) {
    return _borradoSuave("catalogo", id);
  },
};

/* Deja cada campo en su tipo definitivo antes de validar y guardar.
   `base` viene solo en las ediciones: sin él, un campo que no se mandó
   quedaría en su valor por defecto y pisaría lo que ya estaba guardado. */
function _normalizarCatalogo(d, base = null) {
  const out = {};
  const tiene = (c) => d[c] !== undefined || base === null;
  const valor = (c, porDefecto) => (d[c] !== undefined ? d[c] : porDefecto);

  /* Vacío toma el valor por defecto; un valor equivocado se deja pasar tal cual
     para que la validación lo rechace. Corregirlo acá en silencio convertiría
     un "herramienta" en "material" sin que nadie se entere, y ese es el error
     que más tarda en aparecer. */
  if (tiene("tipo")) { const v = valor("tipo"); out.tipo = (v === undefined || v === null || v === "") ? "material" : v; }
  if (tiene("unidad")) { const v = valor("unidad"); out.unidad = (v === undefined || v === null || v === "") ? "unidad" : v; }
  for (const c of ["codigo", "nombre", "descripcion", "marca", "modelo", "ubicacion"]) {
    if (tiene(c)) out[c] = _texto(valor(c));
  }
  if (tiene("proveedor_id")) out.proveedor_id = valor("proveedor_id") || null;
  if (tiene("capacidad_btu")) {
    const n = _numeroONulo(valor("capacidad_btu"));
    out.capacidad_btu = n === null ? null : Math.round(n);
  }
  for (const c of ["costo_centavos", "precio_centavos"]) {
    if (tiene(c)) out[c] = Math.round(Number(valor(c, 0)) || 0);
  }
  for (const c of ["stock_centesimas", "stock_minimo_centesimas"]) {
    if (tiene(c)) out[c] = Math.round(Number(valor(c, 0)) || 0);
  }
  if (tiene("controlar_stock")) out.controlar_stock = valor("controlar_stock") === true;
  if (tiene("activo")) out.activo = valor("activo") !== false;
  return out;
}

/* ---------------- Usuarios (directorio + rol, sin login todavía) ---------------- */
const CAMPOS_USUARIO = ["nombre", "telefono", "email", "rol", "activo"];

const Usuarios = {
  getAll() {
    return _vivos("usuarios");
  },
  get(id) {
    return _vivos("usuarios").find((u) => u.id === id) || null;
  },
  activos() {
    return _vivos("usuarios").filter((u) => u.activo !== false);
  },
  create(datos) {
    _exigir(Validar.usuario(datos));
    const item = {
      id: _uuid(),
      nombre: _texto(datos.nombre),
      telefono: _texto(datos.telefono),
      email: _texto(datos.email),
      rol: ROLES.includes(datos.rol) ? datos.rol : "tecnico",
      activo: datos.activo !== false,
      ..._sellosNuevo(),
    };
    _estado.usuarios.push(item);
    _persistir(Almacen.crear("usuarios", item));
    return item;
  },
  update(id, datos) {
    const item = this.get(id);
    if (!item) return null;
    const cambios = _tomar(datos, CAMPOS_USUARIO);
    _exigir(Validar.usuario({ ...item, ...cambios }));
    for (const campo of ["nombre", "telefono", "email"]) {
      if (cambios[campo] !== undefined) cambios[campo] = _texto(cambios[campo]);
    }
    Object.assign(item, cambios, _sellosEdicion());
    _persistir(Almacen.actualizar("usuarios", item));
    return item;
  },
  /* Cuántos trabajos vivos tiene asignados (para avisar antes de borrarlo).
     D1 rechaza el borrado por llave foránea, así que la app tiene que
     comportarse igual desde ahora. */
  trabajosAsignados(id) {
    return _vivos("trabajos").filter((tj) => (tj.trabajador_ids || []).includes(id)).length;
  },
  remove(id) {
    if (this.trabajosAsignados(id)) throw new ErrorDatos("error_trabajador_con_trabajos");
    if (_estado.config.usuario_actual_id === id) Config.set("usuario_actual_id", "");
    return _borradoSuave("usuarios", id);
  },
};

/* ---------------- Trabajos (jobs) ---------------- */
const CAMPOS_TRABAJO = [
  "cliente_id", "titulo", "descripcion", "estado", "fecha", "hora_inicio", "hora_fin",
  "trabajador_ids", "direccion", "direccion_2", "lat", "lng", "precio_centavos", "costo_centavos",
];

const Trabajos = {
  getAll() {
    return _vivos("trabajos");
  },
  get(id) {
    return _vivos("trabajos").find((tj) => tj.id === id) || null;
  },
  deCliente(clienteId) {
    return _vivos("trabajos").filter((tj) => tj.cliente_id === clienteId);
  },
  deFecha(fechaISO) {
    return _vivos("trabajos").filter((tj) => tj.fecha === fechaISO);
  },
  ganancia(tj) {
    return (tj.precio_centavos || 0) - (tj.costo_centavos || 0);
  },
  /* Número consecutivo y legible: "Trabajo #1042". El contador nunca
     retrocede, ni siquiera si se borra un trabajo — un número no se reusa. */
  _siguienteNumero() {
    const n = (parseInt(_estado.config.contador_trabajos, 10) || 0) + 1;
    Config.set("contador_trabajos", n);
    return n;
  },
  create(datos) {
    _exigir(Validar.trabajo(datos));
    const item = {
      id: _uuid(),
      numero: this._siguienteNumero(),
      cliente_id: datos.cliente_id,
      titulo: _texto(datos.titulo),
      descripcion: _texto(datos.descripcion),
      estado: ESTADOS_TRABAJO_VALIDOS.includes(datos.estado) ? datos.estado : "por_agendar",
      fecha: datos.fecha || null,
      hora_inicio: _texto(datos.hora_inicio),
      hora_fin: _texto(datos.hora_fin),
      trabajador_ids: Array.isArray(datos.trabajador_ids) ? datos.trabajador_ids.slice() : [],
      direccion: _texto(datos.direccion),
      direccion_2: _texto(datos.direccion_2),
      lat: _numeroONulo(datos.lat),
      lng: _numeroONulo(datos.lng),
      precio_centavos: datos.precio_centavos || 0,
      costo_centavos: datos.costo_centavos || 0,
      ..._sellosNuevo(),
    };
    _estado.trabajos.push(item);
    _persistir(Almacen.crear("trabajos", item));
    return item;
  },
  update(id, datos) {
    const item = this.get(id);
    if (!item) return null;
    const cambios = _tomar(datos, CAMPOS_TRABAJO);
    _exigir(Validar.trabajo({ ...item, ...cambios }));
    for (const campo of ["titulo", "descripcion", "hora_inicio", "hora_fin", "direccion", "direccion_2"]) {
      if (cambios[campo] !== undefined) cambios[campo] = _texto(cambios[campo]);
    }
    if (cambios.fecha !== undefined) cambios.fecha = cambios.fecha || null;
    if (cambios.lat !== undefined) cambios.lat = _numeroONulo(cambios.lat);
    if (cambios.lng !== undefined) cambios.lng = _numeroONulo(cambios.lng);
    if (cambios.trabajador_ids !== undefined) {
      cambios.trabajador_ids = Array.isArray(cambios.trabajador_ids) ? cambios.trabajador_ids.slice() : item.trabajador_ids;
    }
    Object.assign(item, cambios, _sellosEdicion());
    _persistir(Almacen.actualizar("trabajos", item));
    return item;
  },
  remove(id) {
    return _borradoSuave("trabajos", id);
  },
};

/* ---------------- Archivos (hoy en el navegador, mañana en R2) ----------------
   El patrón profesional: los DATOS del archivo (a qué trabajo pertenece,
   quién lo subió, cuánto pesa) van en la base; los BYTES van en R2, un
   almacén hecho para eso. Acá se respeta esa separación desde ahora:
   la ficha vive en la colección `archivos` y los bytes aparte, bajo la misma
   `r2_clave` que va a usar el bucket. Migrar a R2 = cambiar dos métodos.  */
const Archivos = {
  getAll() {
    return _vivos("archivos");
  },
  get(id) {
    return _vivos("archivos").find((a) => a.id === id) || null;
  },
  de(entidad, entidadId) {
    return _vivos("archivos").filter((a) => a.entidad === entidad && a.entidad_id === entidadId);
  },
  logoEmpresa() {
    return _vivos("archivos").find((a) => a.entidad === "empresa" && a.tipo === "logo") || null;
  },
  /* La imagen de la firma de la empresa, para la cotización impresa. Vive como
     un archivo más, igual que el logo: el día que exista R2 los dos se mudan
     juntos sin tocar las pantallas. */
  firmaEmpresa() {
    return _vivos("archivos").find((a) => a.entidad === "empresa" && a.tipo === "firma") || null;
  },

  /* dataUrl: el contenido leído con FileReader. Devuelve la ficha creada. */
  crear({ entidad, entidad_id, tipo, nombre_original, mime, bytes, dataUrl }) {
    if (!ENTIDADES_ARCHIVO.includes(entidad) || !TIPOS_ARCHIVO.includes(tipo)) {
      throw new ErrorDatos("error_archivo_invalido");
    }
    const id = _uuid();
    const item = {
      id,
      entidad,
      entidad_id: entidad_id || null,
      tipo,
      r2_clave: `${entidad}/${entidad_id || "general"}/${id}`,
      nombre_original: _texto(nombre_original),
      mime: _texto(mime),
      bytes: typeof bytes === "number" ? bytes : 0,
      ..._sellosNuevo(),
    };
    _estado.archivos.push(item);
    _persistir(Almacen.guardarBytes(item.r2_clave, dataUrl));
    _persistir(Almacen.crear("archivos", item));
    return item;
  },

  /* Hoy devuelve el contenido guardado en el navegador.
     Con R2: acá va a devolver un link firmado que expira. */
  url(archivo) {
    if (!archivo) return "";
    return localStorage.getItem(PREFIJO_BYTES + archivo.r2_clave) || "";
  },

  remove(id) {
    const a = this.get(id);
    if (!a) return false;
    _persistir(Almacen.borrarBytes(a.r2_clave));
    return _borradoSuave("archivos", id);
  },
};

/* ---------------- Configuración (clave/valor) ---------------- */
const Config = {
  get(clave, porDefecto = null) {
    return clave in _estado.config ? _estado.config[clave] : porDefecto;
  },
  set(clave, valor) {
    _estado.config[clave] = valor;
    _persistir(Almacen.guardarConfig());
  },
  getAll() {
    return { ..._estado.config };
  },
};

/* =========================================================================
   MIGRACIONES · llevar datos viejos a la forma nueva, una sola vez
   -------------------------------------------------------------------------
   Toda migración tiene que poder correr dos veces sin romper nada.
   ========================================================================= */
function _migrar() {
  const desde = parseInt(_estado.config.esquema_version, 10) || 1;
  if (desde >= ESQUEMA_VERSION) return false;

  /* --- v1 → v2: plata en centavos, borrado suave, auditoría, número de
         trabajo, y el logo pasa a ser un archivo como cualquier otro --- */
  if (desde < 2) {
    const sellos = (x) => {
      if (x.creado_por === undefined) x.creado_por = null;
      if (x.actualizado === undefined) x.actualizado = x.creado || Date.now();
      if (x.actualizado_por === undefined) x.actualizado_por = null;
      if (x.eliminado === undefined) x.eliminado = null;
      if (x.eliminado_por === undefined) x.eliminado_por = null;
    };
    _estado.clientes.forEach(sellos);
    _estado.usuarios.forEach(sellos);
    _estado.categoriasClientes.forEach(sellos);

    let contador = parseInt(_estado.config.contador_trabajos, 10) || 0;
    _estado.trabajos.forEach((tj) => {
      sellos(tj);
      if (tj.precio_centavos === undefined) tj.precio_centavos = Math.round((Number(tj.precio) || 0) * 100);
      if (tj.costo_centavos === undefined) tj.costo_centavos = Math.round((Number(tj.costo) || 0) * 100);
      delete tj.precio;
      delete tj.costo;
      if (!tj.numero) tj.numero = ++contador;
    });
    _estado.config.contador_trabajos = contador;

    /* El logo estaba guardado como texto dentro de configuracion. Pasa a la
       colección de archivos, que es donde R2 lo va a ir a buscar. */
    if (_estado.config.logo_url && !Archivos.logoEmpresa()) {
      const id = _uuid();
      const clave = `empresa/general/${id}`;
      const ahora = Date.now();
      localStorage.setItem(PREFIJO_BYTES + clave, _estado.config.logo_url);
      _estado.archivos.push({
        id, entidad: "empresa", entidad_id: null, tipo: "logo",
        r2_clave: clave, nombre_original: "logo", mime: "image/png",
        bytes: _estado.config.logo_url.length,
        creado: ahora, creado_por: null, actualizado: ahora, actualizado_por: null,
        eliminado: null, eliminado_por: null,
      });
    }
    delete _estado.config.logo_url;
  }

  /* --- v2 → v3: aparecen proveedores y catálogo ---
     No hay datos viejos que convertir: las dos colecciones nacen vacías. Lo
     que sí se hace es completar los campos de inventario en cualquier producto
     que ya existiera, para que nadie lea `undefined` cuando llegue esa pantalla. */
  if (desde < 3) {
    if (!Array.isArray(_estado.proveedores)) _estado.proveedores = [];
    if (!Array.isArray(_estado.catalogo)) _estado.catalogo = [];
    _estado.catalogo.forEach((p) => {
      if (p.controlar_stock === undefined) p.controlar_stock = false;
      if (p.stock_centesimas === undefined) p.stock_centesimas = 0;
      if (p.stock_minimo_centesimas === undefined) p.stock_minimo_centesimas = 0;
      if (p.ubicacion === undefined) p.ubicacion = "";
      if (p.proveedor_id === undefined) p.proveedor_id = null;
    });
  }

  /* --- v3 → v4: aparecen las cotizaciones y sus renglones ---
     Nacen vacías, no hay datos viejos que convertir. Se deja el contador de
     numeración arrancado en cero para que la primera sea la COT-1. */
  if (desde < 4) {
    if (!Array.isArray(_estado.cotizaciones)) _estado.cotizaciones = [];
    if (!Array.isArray(_estado.cotizacionItems)) _estado.cotizacionItems = [];
    if (_estado.config.contador_cotizaciones === undefined) _estado.config.contador_cotizaciones = 0;
  }

  /* --- v4 → v5: ninguna cotización puede quedar sin fecha ---
     Una cotización que se le manda al cliente sin fecha no dice desde cuándo
     corre la validez. Las que quedaron en null se rellenan con el día en que
     realmente se crearon, que es el sello de auditoría `creado`. */
  if (desde < 5) {
    _estado.cotizaciones.forEach((c) => {
      if (!c.fecha) c.fecha = _fechaLocalISO(c.creado || Date.now());
    });
  }

  /* --- v5 → v6: el ojo del PDF en cada renglón de cotización ---
     Los renglones que ya existían se muestran todos, que es como venían
     comportándose. `en_pdf` en 0 esconde el renglón del papel del cliente,
     pero su plata sigue contando en el total. */
  if (desde < 6) {
    _estado.cotizacionItems.forEach((i) => {
      if (i.en_pdf === undefined || i.en_pdf === null) i.en_pdf = 1;
    });
  }

  /* --- v6 → v7: mostrar u ocultar los precios por producto en el PDF ---
     Las cotizaciones que YA existen quedan en 1, mostrando los precios: es
     como se vieron el día que se hicieron y como las recibió el cliente. Una
     cotización ya enviada no puede cambiar de forma sola. Las nuevas nacen en
     0, que es lo que Rene pidió por defecto. */
  if (desde < 7) {
    _estado.cotizaciones.forEach((c) => {
      if (c.mostrar_precios === undefined || c.mostrar_precios === null) c.mostrar_precios = 1;
    });
  }

  /* --- v7 → v8: cada ficha dice si es lead o cliente ---
     Los que YA estaban quedan como "cliente", no como lead. Toda la app los
     venía tratando así (la pantalla se llama Clientes) y muchos tienen
     trabajos cobrados: marcarlos lead sería escribir algo falso en la ficha.
     Los que se den de alta de acá en adelante nacen lead, que es lo pedido. */
  if (desde < 8) {
    _estado.clientes.forEach((c) => {
      if (!RELACIONES_CLIENTE.includes(c.relacion)) c.relacion = "cliente";
    });
  }

  /* --- v8 → v9: queda registrado cada paso de lead a cliente ---
     La colección nace VACÍA a propósito. Las fichas que ya existen pasaron a
     "cliente" en la migración anterior, pero nadie sabe qué día ocurrió de
     verdad: ese dato nunca se guardó. Rellenarlo con una fecha inventada
     llenaría los reportes de conversiones que nunca pasaron. El historial
     arranca el día que se publica esto. */
  if (desde < 9) {
    if (!Array.isArray(_estado.conversiones)) _estado.conversiones = [];
  }

  /* --- v9 → v10: el ojo del PDF decide solo si se ven los precios ---
     Las que siguen en borrador pasan a automático (null): todavía no salieron
     a la calle. Las que ya se enviaron, aprobaron, rechazaron o vencieron
     conservan el 0 o el 1 que tenían: una cotización que el cliente ya recibió
     no puede cambiar de forma sola, ni siquiera para quedar más coherente. */
  if (desde < 10) {
    _estado.cotizaciones.forEach((c) => {
      if (c.estado === "borrador") c.mostrar_precios = null;
      else if (c.mostrar_precios !== 0 && c.mostrar_precios !== 1) c.mostrar_precios = 1;
    });
  }

  /* --- v10 → v11: aparecen los combos ---
     Nacen vacíos, no hay datos viejos que convertir. */
  if (desde < 11) {
    if (!Array.isArray(_estado.combos)) _estado.combos = [];
    if (!Array.isArray(_estado.comboItems)) _estado.comboItems = [];
  }

  /* --- v11 → v12: el renglón de un combo se vuelve igual al de una cotización ---
     Los que ya existían solo guardaban el producto y la cantidad. Se completan
     copiando del catálogo lo que hoy vale, que es exactamente lo que la
     pantalla venía mostrando: la ficha no cambia de valor, solo deja de
     depender del catálogo para saberlo. Si el producto ya no existe, el
     renglón queda con lo que se pueda y nombre vacío: se ve en la pantalla y
     se corrige a mano, en vez de desaparecer sin avisar. */
  if (desde < 12) {
    _estado.comboItems.forEach((i) => {
      const p = i.catalogo_id ? _estado.catalogo.find((x) => x.id === i.catalogo_id && !x.eliminado) : null;
      if (i.nombre === undefined) i.nombre = p ? p.nombre : "";
      if (i.descripcion === undefined) i.descripcion = "";
      if (i.unidad === undefined) i.unidad = p ? p.unidad : "unidad";
      if (i.precio_centavos === undefined) i.precio_centavos = p ? (p.precio_centavos || 0) : 0;
      if (i.costo_centavos === undefined) i.costo_centavos = p ? (p.costo_centavos || 0) : 0;
      if (i.en_pdf === undefined || i.en_pdf === null) i.en_pdf = 1;
    });
  }

  /* --- v12 → v13: aparece el libro de la plata ---
     Nacen vacías, no hay datos viejos que convertir. El precio y el costo que
     ya tienen los trabajos NO se convierten en movimientos: son lo
     presupuestado, no lo que paso de verdad, y meterlos como movimientos
     inventaría cobros que quizá nunca ocurrieron. */
  if (desde < 13) {
    if (!Array.isArray(_estado.movimientos)) _estado.movimientos = [];
    if (!Array.isArray(_estado.cuentas)) _estado.cuentas = [];
  }

  _estado.config.esquema_version = ESQUEMA_VERSION;
  return true;
}

/* ---------- Semillas: solo la primera vez ---------- */
function _sembrarSiVacio() {
  if (_estado.categoriasClientes.length) return false;
  const ahora = Date.now();
  const base = { creado: ahora, creado_por: null, actualizado: ahora, actualizado_por: null, eliminado: null, eliminado_por: null };
  _estado.categoriasClientes = [
    { id: _uuid(), nombre: "Residencial", color: "#2E8FD9", orden: 0, ...base },
    { id: _uuid(), nombre: "Comercial", color: "#E8622C", orden: 1, ...base },
    { id: _uuid(), nombre: "Mantenimiento", color: "#3AA76D", orden: 2, ...base },
  ];
  return true;
}

/* =========================================================================
   RESPALDO · exportar / importar mientras los datos vivan solo acá
   -------------------------------------------------------------------------
   Red de seguridad hasta que exista D1. Con la base en la nube deja de
   ser imprescindible, pero sigue sirviendo para llevarse una copia.
   ========================================================================= */
const Respaldo = {
  exportar() {
    return JSON.stringify({
      app: "onestop-hvac",
      esquema_version: ESQUEMA_VERSION,
      exportado: Date.now(),
      /* Se arma desde COLECCIONES, no a mano: cuando se enumeraban una por
         una, agregar una tabla nueva y olvidarse de esta línea dejaba un
         respaldo incompleto sin que nada avisara. */
      datos: COLECCIONES.reduce((acc, col) => {
        acc[col] = _estado[col];
        return acc;
      }, { config: _estado.config }),
      bytes: _estado.archivos.reduce((acc, a) => {
        const b = localStorage.getItem(PREFIJO_BYTES + a.r2_clave);
        if (b) acc[a.r2_clave] = b;
        return acc;
      }, {}),
    }, null, 2);
  },

  nombreArchivo() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `onestop-respaldo-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.json`;
  },

  /* Reemplaza TODO lo que hay. La UI pide confirmación antes de llamar acá. */
  importar(textoJson) {
    let paquete;
    try {
      paquete = JSON.parse(textoJson);
    } catch {
      throw new ErrorDatos("error_respaldo_ilegible");
    }
    if (!paquete || paquete.app !== "onestop-hvac" || !paquete.datos) {
      throw new ErrorDatos("error_respaldo_ajeno");
    }
    if ((parseInt(paquete.esquema_version, 10) || 1) > ESQUEMA_VERSION) {
      throw new ErrorDatos("error_respaldo_mas_nuevo");
    }
    for (const col of COLECCIONES) {
      _estado[col] = Array.isArray(paquete.datos[col]) ? paquete.datos[col] : [];
    }
    _estado.config = paquete.datos.config && typeof paquete.datos.config === "object" ? paquete.datos.config : {};
    for (const [clave, valor] of Object.entries(paquete.bytes || {})) {
      localStorage.setItem(PREFIJO_BYTES + clave, valor);
    }
    _migrar();
    return Promise.all([
      ...COLECCIONES.map((col) => Almacen.actualizar(col)),
      Almacen.guardarConfig(),
    ]);
  },
};

/* =========================================================================
   ARRANQUE
   -------------------------------------------------------------------------
   DB.iniciar() es el único punto asíncrono de toda la capa. Hoy carga de
   localStorage; el día que haya Worker cargará de la red — y como es acá
   adentro, ninguna pantalla se entera.
   ========================================================================= */
const DB = {
  clientes: Clientes,
  categoriasClientes: CategoriasClientes,
  usuarios: Usuarios,
  trabajos: Trabajos,
  archivos: Archivos,
  proveedores: Proveedores,
  catalogo: Catalogo,
  cotizaciones: Cotizaciones,
  conversiones: Conversiones,
  combos: Combos,
  movimientos: Movimientos,
  cuentas: Cuentas,
  config: Config,
  respaldo: Respaldo,
  dinero: Dinero,
  cantidad: Cantidad,
  /* Listas cerradas: las pantallas arman sus menús desde acá, así no aparece
     un tipo o una unidad que la validación después rechaza. */
  tiposCatalogo: TIPOS_CATALOGO,
  unidades: UNIDADES,
  estadosCotizacion: ESTADOS_COTIZACION,
  estadosMovimiento: ESTADOS_MOVIMIENTO,
  categoriasMovimiento: CATEGORIAS_MOVIMIENTO,
  ErrorDatos,

  alFallarGuardado(fn) { _alFallarGuardado = fn; },

  async iniciar() {
    if (_iniciado) return;
    _estado = await Almacen.cargarTodo();
    for (const col of COLECCIONES) if (!Array.isArray(_estado[col])) _estado[col] = [];
    if (!_estado.config || typeof _estado.config !== "object") _estado.config = {};

    const sembro = _sembrarSiVacio();
    const migro = _migrar();
    if (sembro || migro) {
      await Promise.all([
        ...COLECCIONES.map((col) => Almacen.actualizar(col)),
        Almacen.guardarConfig(),
      ]).catch((err) => _alFallarGuardado(err));
    }
    _iniciado = true;
  },
};
