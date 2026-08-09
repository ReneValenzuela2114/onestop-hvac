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

const ESQUEMA_VERSION = 3;

const CLAVES = {
  clientes: "os_clientes_v1",
  categoriasClientes: "os_categorias_clientes_v1",
  usuarios: "os_usuarios_v1",
  trabajos: "os_trabajos_v1",
  archivos: "os_archivos_v1",
  proveedores: "os_proveedores_v1",
  catalogo: "os_catalogo_v1",
  config: "os_config_v1",
};

const COLECCIONES = ["clientes", "categoriasClientes", "usuarios", "trabajos", "archivos", "proveedores", "catalogo"];

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
const ESTADOS_TRABAJO_VALIDOS = ["por_agendar", "agendado", "en_curso", "terminado", "cancelado"];
const TIPOS_ARCHIVO = ["foto", "documento", "firma", "logo"];
const ENTIDADES_ARCHIVO = ["trabajo", "cliente", "usuario", "empresa"];
const TIPOS_CATALOGO = ["equipo", "material", "servicio"];
const UNIDADES = ["unidad", "pie", "libra", "galon", "hora", "juego"];

const RE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const RE_FECHA = /^\d{4}-\d{2}-\d{2}$/;
const RE_HORA = /^([01]\d|2[0-3]):[0-5]\d$/;

const Validar = {
  cliente(d) {
    const e = [];
    if (!_texto(d.nombre)) e.push("error_nombre_requerido");
    if (_texto(d.email) && !RE_EMAIL.test(_texto(d.email))) e.push("error_email_invalido");
    if (d.estado !== undefined && !ESTADOS_CLIENTE.includes(d.estado)) e.push("error_estado_invalido");
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
      ..._sellosNuevo(),
    };
    _estado.clientes.push(item);
    _persistir(Almacen.crear("clientes", item));
    return item;
  },
  update(id, datos) {
    const item = this.get(id);
    if (!item) return null;
    _exigir(Validar.cliente({ ...item, ..._tomar(datos, CAMPOS_CLIENTE) }));
    const cambios = _tomar(datos, CAMPOS_CLIENTE);
    for (const campo of ["nombre", "empresa", "telefono", "email", "direccion", "direccion_2",
      "direccion_fact", "direccion_fact_2", "notas"]) {
      if (cambios[campo] !== undefined) cambios[campo] = _texto(cambios[campo]);
    }
    if (cambios.lat !== undefined) cambios.lat = _numeroONulo(cambios.lat);
    if (cambios.lng !== undefined) cambios.lng = _numeroONulo(cambios.lng);
    if (cambios.categoria_id !== undefined) cambios.categoria_id = cambios.categoria_id || null;
    Object.assign(item, cambios, _sellosEdicion());
    _persistir(Almacen.actualizar("clientes", item));
    return item;
  },
  /* No borra: marca como eliminado. Se bloquea si tiene trabajos, para no
     dejar historial de plata colgando de un cliente que ya no aparece. */
  remove(id) {
    if (Trabajos.deCliente(id).length) throw new ErrorDatos("error_cliente_con_trabajos");
    return _borradoSuave("clientes", id);
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
  config: Config,
  respaldo: Respaldo,
  dinero: Dinero,
  cantidad: Cantidad,
  /* Listas cerradas: las pantallas arman sus menús desde acá, así no aparece
     un tipo o una unidad que la validación después rechaza. */
  tiposCatalogo: TIPOS_CATALOGO,
  unidades: UNIDADES,
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
