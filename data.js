/* =========================================================================
   One Stop Heating and Cooling · Capa de datos (repositorio)
   -------------------------------------------------------------------------
   HOY: cada función lee/escribe localStorage.
   MAÑANA (cuando digamos "creá la base en D1"): estas mismas funciones pasan
   a hacer fetch() al Worker. Ninguna pantalla se toca — todas llaman a DB.*,
   nunca a localStorage directamente. Los campos de cada objeto son
   EXACTAMENTE los mismos que las columnas de worker-d1/schema.sql.

   Convención de IDs: crypto.randomUUID() (igual que en D1, TEXT PRIMARY KEY).
   Convención de fechas: epoch ms (Date.now()), igual que "creado"/"actualizado"
   en las tablas SQL.
   ========================================================================= */

const OS_KEYS = {
  clientes: "os_clientes_v1",
  categoriasClientes: "os_categorias_clientes_v1",
  usuarios: "os_usuarios_v1",
  config: "os_config_v1",
};

function _leer(key, porDefecto) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : porDefecto;
  } catch (e) {
    console.error("Error leyendo", key, e);
    return porDefecto;
  }
}
function _escribir(key, valor) {
  localStorage.setItem(key, JSON.stringify(valor));
}
function _uuid() {
  return (crypto.randomUUID ? crypto.randomUUID() : "id-" + Date.now() + "-" + Math.random().toString(16).slice(2));
}

/* ---------------- Semillas (primera vez que se abre la app) ---------------- */
function _sembrarSiVacio() {
  if (localStorage.getItem(OS_KEYS.categoriasClientes) === null) {
    const ahora = Date.now();
    _escribir(OS_KEYS.categoriasClientes, [
      { id: _uuid(), nombre: "Residencial", color: "#2E8FD9", orden: 0, creado: ahora },
      { id: _uuid(), nombre: "Comercial", color: "#E8622C", orden: 1, creado: ahora },
      { id: _uuid(), nombre: "Mantenimiento", color: "#3AA76D", orden: 2, creado: ahora },
    ]);
  }
  if (localStorage.getItem(OS_KEYS.clientes) === null) _escribir(OS_KEYS.clientes, []);
  if (localStorage.getItem(OS_KEYS.usuarios) === null) _escribir(OS_KEYS.usuarios, []);
  if (localStorage.getItem(OS_KEYS.config) === null) _escribir(OS_KEYS.config, {});
}
_sembrarSiVacio();

/* ---------------- Clientes ---------------- */
const Clientes = {
  getAll() {
    return _leer(OS_KEYS.clientes, []).sort((a, b) => a.nombre.localeCompare(b.nombre));
  },
  get(id) {
    return this.getAll().find((c) => c.id === id) || null;
  },
  create(datos) {
    const ahora = Date.now();
    const item = {
      id: _uuid(),
      nombre: datos.nombre.trim(),
      empresa: datos.empresa?.trim() || "",
      telefono: datos.telefono?.trim() || "",
      email: datos.email?.trim() || "",
      direccion: datos.direccion?.trim() || "",
      lat: typeof datos.lat === "number" ? datos.lat : null,
      lng: typeof datos.lng === "number" ? datos.lng : null,
      categoria_id: datos.categoria_id || null,
      notas: datos.notas?.trim() || "",
      estado: datos.estado === "inactivo" ? "inactivo" : "activo",
      creado: ahora,
      actualizado: ahora,
    };
    const todos = _leer(OS_KEYS.clientes, []);
    todos.push(item);
    _escribir(OS_KEYS.clientes, todos);
    return item;
  },
  update(id, datos) {
    const todos = _leer(OS_KEYS.clientes, []);
    const idx = todos.findIndex((c) => c.id === id);
    if (idx === -1) return null;
    todos[idx] = {
      ...todos[idx],
      nombre: datos.nombre?.trim() ?? todos[idx].nombre,
      empresa: datos.empresa?.trim() ?? todos[idx].empresa,
      telefono: datos.telefono?.trim() ?? todos[idx].telefono,
      email: datos.email?.trim() ?? todos[idx].email,
      direccion: datos.direccion?.trim() ?? todos[idx].direccion,
      lat: datos.lat !== undefined ? datos.lat : todos[idx].lat,
      lng: datos.lng !== undefined ? datos.lng : todos[idx].lng,
      categoria_id: datos.categoria_id !== undefined ? datos.categoria_id : todos[idx].categoria_id,
      notas: datos.notas?.trim() ?? todos[idx].notas,
      estado: datos.estado ?? todos[idx].estado,
      actualizado: Date.now(),
    };
    _escribir(OS_KEYS.clientes, todos);
    return todos[idx];
  },
  remove(id) {
    const todos = _leer(OS_KEYS.clientes, []).filter((c) => c.id !== id);
    _escribir(OS_KEYS.clientes, todos);
  },
};

/* ---------------- Categorías de clientes ---------------- */
const CategoriasClientes = {
  getAll() {
    return _leer(OS_KEYS.categoriasClientes, []).sort((a, b) => a.orden - b.orden);
  },
  create(nombre, color = "#2E8FD9") {
    const todas = _leer(OS_KEYS.categoriasClientes, []);
    const item = { id: _uuid(), nombre: nombre.trim(), color, orden: todas.length, creado: Date.now() };
    todas.push(item);
    _escribir(OS_KEYS.categoriasClientes, todas);
    return item;
  },
  update(id, datos) {
    const todas = _leer(OS_KEYS.categoriasClientes, []);
    const idx = todas.findIndex((c) => c.id === id);
    if (idx === -1) return null;
    todas[idx] = { ...todas[idx], ...datos };
    _escribir(OS_KEYS.categoriasClientes, todas);
    return todas[idx];
  },
  enUso(id) {
    return _leer(OS_KEYS.clientes, []).some((c) => c.categoria_id === id);
  },
  remove(id) {
    if (this.enUso(id)) return false;
    const todas = _leer(OS_KEYS.categoriasClientes, []).filter((c) => c.id !== id);
    _escribir(OS_KEYS.categoriasClientes, todas);
    return true;
  },
};

/* ---------------- Usuarios (directorio + rol, sin login todavía) ---------------- */
const Usuarios = {
  getAll() {
    return _leer(OS_KEYS.usuarios, []);
  },
  create(datos) {
    const ahora = Date.now();
    const item = {
      id: _uuid(),
      nombre: datos.nombre.trim(),
      email: datos.email?.trim() || "",
      rol: ["dueno", "administrador", "tecnico"].includes(datos.rol) ? datos.rol : "tecnico",
      activo: true,
      creado: ahora,
      actualizado: ahora,
    };
    const todos = _leer(OS_KEYS.usuarios, []);
    todos.push(item);
    _escribir(OS_KEYS.usuarios, todos);
    return item;
  },
  update(id, datos) {
    const todos = _leer(OS_KEYS.usuarios, []);
    const idx = todos.findIndex((u) => u.id === id);
    if (idx === -1) return null;
    todos[idx] = { ...todos[idx], ...datos, actualizado: Date.now() };
    _escribir(OS_KEYS.usuarios, todos);
    return todos[idx];
  },
  remove(id) {
    _escribir(OS_KEYS.usuarios, _leer(OS_KEYS.usuarios, []).filter((u) => u.id !== id));
  },
};

/* ---------------- Configuración (clave/valor) ---------------- */
const Config = {
  get(clave, porDefecto = null) {
    const todo = _leer(OS_KEYS.config, {});
    return clave in todo ? todo[clave] : porDefecto;
  },
  set(clave, valor) {
    const todo = _leer(OS_KEYS.config, {});
    todo[clave] = valor;
    _escribir(OS_KEYS.config, todo);
  },
  getAll() {
    return _leer(OS_KEYS.config, {});
  },
};

const DB = { clientes: Clientes, categoriasClientes: CategoriasClientes, usuarios: Usuarios, config: Config };
