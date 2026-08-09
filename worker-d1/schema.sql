-- =========================================================================
-- One Stop Heating and Cooling · Esquema de D1
-- -------------------------------------------------------------------------
-- Este archivo es el ESPEJO EXACTO de onestop-web/data.js. Cada columna de
-- acá es un campo de allá, con el mismo nombre. Campo nuevo = se agrega en
-- los dos lados, en el mismo cambio. Cuando se conecte D1, las funciones de
-- data.js cambian de "leer localStorage" a "hacer fetch al Worker" — pero la
-- forma de los datos no cambia en nada.
--
-- A diferencia de Bóveda (que guarda filas cifradas ilegibles porque es
-- zero-knowledge), acá los campos van SIN cifrar y normalizados: esta app
-- necesita poder sumar dinero por proyecto, filtrar clientes, buscar por
-- categoría, etc. — cosas imposibles sobre un blob opaco.
--
-- Convenciones de todo el esquema:
--   · id            TEXT, un UUID (crypto.randomUUID). Nunca autoincremental:
--                   así dos dispositivos sin señal pueden crear registros sin
--                   pisarse cuando sincronizan.
--   · DINERO        SIEMPRE en centavos enteros (INTEGER), nunca REAL.
--                   $250.50 se guarda como 25050. Los decimales flotantes no
--                   representan 0.10 exacto y los reportes terminan sin cuadrar.
--   · fechas de auditoría   epoch ms (INTEGER), no texto.
--   · fechas de agenda      TEXT 'YYYY-MM-DD' y 'HH:MM' 24h, hora local de la
--                           empresa (California). Si algún día hay sucursales en
--                           otro huso, hay que agregar la zona horaria.
--   · BORRADO SUAVE  nada se borra de verdad. `eliminado` (epoch ms) en NULL
--                    significa vivo. Toda consulta filtra `eliminado IS NULL`.
--                    Un trabajo tiene precio y costo: borrarlo de verdad sería
--                    borrar plata del historial de la empresa.
--   · AUDITORÍA      creado_por / actualizado_por / eliminado_por en todas las
--                    tablas de negocio: quién tocó qué, sobre todo los montos.
-- =========================================================================

PRAGMA foreign_keys = ON;

-- ---- Usuarios del sistema (directorio + roles) ----
-- Nota: hoy es solo directorio/etiquetas. El login real (hash de contraseña,
-- sesiones, permisos aplicados de verdad) se arma junto con este esquema:
-- una API abierta sin login expondría la base de clientes entera.
CREATE TABLE IF NOT EXISTS usuarios (
  id TEXT PRIMARY KEY,
  nombre TEXT NOT NULL,
  telefono TEXT NOT NULL DEFAULT '',
  email TEXT,
  rol TEXT NOT NULL CHECK (rol IN ('dueno','administrador','tecnico')),
  activo INTEGER NOT NULL DEFAULT 1,
  creado INTEGER NOT NULL,
  creado_por TEXT REFERENCES usuarios(id),
  actualizado INTEGER NOT NULL,
  actualizado_por TEXT REFERENCES usuarios(id),
  eliminado INTEGER,
  eliminado_por TEXT REFERENCES usuarios(id)
);
-- Un email solo puede repetirse si el usuario anterior está eliminado.
CREATE UNIQUE INDEX IF NOT EXISTS idx_usuarios_email ON usuarios(email) WHERE eliminado IS NULL AND email IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_usuarios_vivos ON usuarios(eliminado);

-- ---- Categorías de clientes (editables: crear/renombrar/borrar) ----
CREATE TABLE IF NOT EXISTS categorias_clientes (
  id TEXT PRIMARY KEY,
  nombre TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#2E8FD9',
  orden INTEGER NOT NULL DEFAULT 0,
  creado INTEGER NOT NULL,
  creado_por TEXT REFERENCES usuarios(id),
  actualizado INTEGER NOT NULL,
  actualizado_por TEXT REFERENCES usuarios(id),
  eliminado INTEGER,
  eliminado_por TEXT REFERENCES usuarios(id)
);

-- ---- Clientes ----
CREATE TABLE IF NOT EXISTS clientes (
  id TEXT PRIMARY KEY,
  nombre TEXT NOT NULL,
  empresa TEXT NOT NULL DEFAULT '',
  telefono TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  direccion TEXT NOT NULL DEFAULT '',     -- dirección del cliente (su casa/sede)
  direccion_2 TEXT NOT NULL DEFAULT '',   -- piso, apartamento, suite, etc.
  lat REAL,
  lng REAL,
  fact_igual INTEGER NOT NULL DEFAULT 1,  -- 1 = facturar a la misma dirección
  direccion_fact TEXT NOT NULL DEFAULT '',   -- dirección de facturación (si fact_igual = 0)
  direccion_fact_2 TEXT NOT NULL DEFAULT '', -- piso/apto/suite de facturación
  categoria_id TEXT REFERENCES categorias_clientes(id) ON DELETE SET NULL,
  notas TEXT NOT NULL DEFAULT '',
  estado TEXT NOT NULL DEFAULT 'activo' CHECK (estado IN ('activo','inactivo')),
  creado INTEGER NOT NULL,
  creado_por TEXT REFERENCES usuarios(id),
  actualizado INTEGER NOT NULL,
  actualizado_por TEXT REFERENCES usuarios(id),
  eliminado INTEGER,
  eliminado_por TEXT REFERENCES usuarios(id)
);
CREATE INDEX IF NOT EXISTS idx_clientes_categoria ON clientes(categoria_id);
CREATE INDEX IF NOT EXISTS idx_clientes_estado ON clientes(estado);
CREATE INDEX IF NOT EXISTS idx_clientes_vivos ON clientes(eliminado);

-- ---- Trabajos (jobs) ----
-- El corazón del negocio. Todo trabajo pertenece a un cliente (para buscar
-- historial y armar reportes de cuánto compró / cuánto se ganó por cliente).
CREATE TABLE IF NOT EXISTS trabajos (
  id TEXT PRIMARY KEY,
  numero INTEGER NOT NULL UNIQUE,  -- consecutivo legible: "Trabajo #1042".
                                   -- El UUID es para la máquina; este es el que
                                   -- se dice por teléfono. Nunca se reusa.
  cliente_id TEXT NOT NULL REFERENCES clientes(id),
  titulo TEXT NOT NULL,
  descripcion TEXT NOT NULL DEFAULT '',
  estado TEXT NOT NULL DEFAULT 'por_agendar'
    CHECK (estado IN ('por_agendar','agendado','en_curso','terminado','cancelado')),
  fecha TEXT,                      -- YYYY-MM-DD (NULL si está por agendar)
  hora_inicio TEXT NOT NULL DEFAULT '',  -- HH:MM (24h)
  hora_fin TEXT NOT NULL DEFAULT '',     -- HH:MM (24h)
  direccion TEXT NOT NULL DEFAULT '',    -- por defecto la del cliente, ajustable por trabajo
  direccion_2 TEXT NOT NULL DEFAULT '',
  lat REAL,
  lng REAL,
  precio_centavos INTEGER NOT NULL DEFAULT 0 CHECK (precio_centavos >= 0), -- lo que se cobra al cliente
  costo_centavos  INTEGER NOT NULL DEFAULT 0 CHECK (costo_centavos  >= 0), -- materiales + mano de obra
  -- ganancia = precio_centavos - costo_centavos (no se guarda: se calcula,
  -- así nunca queda desactualizada respecto de sus dos fuentes)
  creado INTEGER NOT NULL,
  creado_por TEXT REFERENCES usuarios(id),
  actualizado INTEGER NOT NULL,
  actualizado_por TEXT REFERENCES usuarios(id),
  eliminado INTEGER,
  eliminado_por TEXT REFERENCES usuarios(id)
);
CREATE INDEX IF NOT EXISTS idx_trabajos_cliente ON trabajos(cliente_id);
CREATE INDEX IF NOT EXISTS idx_trabajos_fecha ON trabajos(fecha);
CREATE INDEX IF NOT EXISTS idx_trabajos_estado ON trabajos(estado);
CREATE INDEX IF NOT EXISTS idx_trabajos_vivos ON trabajos(eliminado);

-- ---- Trabajadores asignados a cada trabajo (varios por trabajo) ----
-- En data.js esto vive como trabajos.trabajador_ids (arreglo de IDs).
CREATE TABLE IF NOT EXISTS trabajos_trabajadores (
  trabajo_id TEXT NOT NULL REFERENCES trabajos(id) ON DELETE CASCADE,
  usuario_id TEXT NOT NULL REFERENCES usuarios(id),
  PRIMARY KEY (trabajo_id, usuario_id)
);
CREATE INDEX IF NOT EXISTS idx_trab_trab_usuario ON trabajos_trabajadores(usuario_id);

-- ---- Archivos (fotos, documentos, firmas, logo) ----
-- Los BYTES viven en R2; acá viven los DATOS del archivo. Meter fotos dentro
-- de la base la infla y la vuelve lenta y cara: R2 está hecho para eso y no
-- cobra por descarga.
--   r2_clave: la ruta dentro del bucket, "<entidad>/<entidad_id>/<id>".
--   El bucket va PRIVADO: se sirve con links firmados que expiran, porque
--   pueden ser fotos del interior de la casa de un cliente.
CREATE TABLE IF NOT EXISTS archivos (
  id TEXT PRIMARY KEY,
  entidad TEXT NOT NULL CHECK (entidad IN ('trabajo','cliente','usuario','empresa')),
  entidad_id TEXT,                 -- NULL cuando es de la empresa (ej. el logo)
  tipo TEXT NOT NULL CHECK (tipo IN ('foto','documento','firma','logo')),
  r2_clave TEXT NOT NULL UNIQUE,
  nombre_original TEXT NOT NULL DEFAULT '',
  mime TEXT NOT NULL DEFAULT '',
  bytes INTEGER NOT NULL DEFAULT 0,
  creado INTEGER NOT NULL,
  creado_por TEXT REFERENCES usuarios(id),
  actualizado INTEGER NOT NULL,
  actualizado_por TEXT REFERENCES usuarios(id),
  eliminado INTEGER,
  eliminado_por TEXT REFERENCES usuarios(id)
);
CREATE INDEX IF NOT EXISTS idx_archivos_entidad ON archivos(entidad, entidad_id);
CREATE INDEX IF NOT EXISTS idx_archivos_vivos ON archivos(eliminado);

-- ---- Proveedores ----
-- A quién le compramos. Tabla propia y no un texto adentro del producto:
-- así un reporte puede agrupar por proveedor, y corregir un teléfono se hace
-- en un solo lugar en vez de en cada producto.
CREATE TABLE IF NOT EXISTS proveedores (
  id TEXT PRIMARY KEY,
  nombre TEXT NOT NULL,
  contacto TEXT NOT NULL DEFAULT '',   -- persona con quien se habla
  telefono TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  sitio_web TEXT NOT NULL DEFAULT '',
  direccion TEXT NOT NULL DEFAULT '',
  notas TEXT NOT NULL DEFAULT '',
  activo INTEGER NOT NULL DEFAULT 1,
  creado INTEGER NOT NULL,
  creado_por TEXT REFERENCES usuarios(id),
  actualizado INTEGER NOT NULL,
  actualizado_por TEXT REFERENCES usuarios(id),
  eliminado INTEGER,
  eliminado_por TEXT REFERENCES usuarios(id)
);
CREATE INDEX IF NOT EXISTS idx_proveedores_vivos ON proveedores(eliminado);

-- ---- Catálogo: equipos, materiales y servicios ----
-- Una sola tabla con `tipo`, no tres: los tres se buscan, se cotizan y se
-- facturan igual.
--
-- ⚠️ Al llevar un producto a una cotización o un trabajo se COPIA el precio,
-- nunca se apunta acá. Si se apuntara, subir un precio hoy cambiaría el total
-- de una cotización que el cliente ya firmó. Las fotos del pasado no se
-- recalculan.
--
-- capacidad_btu: entero (36000 = 3 toneladas). Permite buscar por capacidad.
-- Los campos de stock existen desde ya para no migrar cuando llegue el
-- control de inventario; hoy la app todavía no los muestra.
CREATE TABLE IF NOT EXISTS catalogo (
  id TEXT PRIMARY KEY,
  tipo TEXT NOT NULL CHECK (tipo IN ('equipo','material','servicio')),
  codigo TEXT NOT NULL DEFAULT '',     -- SKU interno; único entre los vivos
  nombre TEXT NOT NULL,
  descripcion TEXT NOT NULL DEFAULT '',
  marca TEXT NOT NULL DEFAULT '',
  modelo TEXT NOT NULL DEFAULT '',
  capacidad_btu INTEGER,               -- NULL cuando no aplica (materiales, servicios)
  proveedor_id TEXT REFERENCES proveedores(id),
  unidad TEXT NOT NULL DEFAULT 'unidad'
    CHECK (unidad IN ('unidad','pie','libra','galon','hora','juego')),
  costo_centavos INTEGER NOT NULL DEFAULT 0 CHECK (costo_centavos >= 0),
  precio_centavos INTEGER NOT NULL DEFAULT 0 CHECK (precio_centavos >= 0),
  activo INTEGER NOT NULL DEFAULT 1,
  -- Inventario (todavía sin pantalla). Las cantidades van en centésimas
  -- enteras por la misma razón que la plata: 12.5 pies se guarda como 1250.
  controlar_stock INTEGER NOT NULL DEFAULT 0,
  stock_centesimas INTEGER NOT NULL DEFAULT 0,
  stock_minimo_centesimas INTEGER NOT NULL DEFAULT 0,
  ubicacion TEXT NOT NULL DEFAULT '',  -- bodega, camioneta, estante
  creado INTEGER NOT NULL,
  creado_por TEXT REFERENCES usuarios(id),
  actualizado INTEGER NOT NULL,
  actualizado_por TEXT REFERENCES usuarios(id),
  eliminado INTEGER,
  eliminado_por TEXT REFERENCES usuarios(id)
);
-- Índices pensados para los filtros de reportes que pidió Rene
CREATE INDEX IF NOT EXISTS idx_catalogo_vivos ON catalogo(eliminado);
CREATE INDEX IF NOT EXISTS idx_catalogo_tipo ON catalogo(tipo);
CREATE INDEX IF NOT EXISTS idx_catalogo_proveedor ON catalogo(proveedor_id);
CREATE INDEX IF NOT EXISTS idx_catalogo_marca ON catalogo(marca);
-- El código identifica el producto contra la factura del proveedor: repetido
-- vuelve ambiguo el reporte. Único solo entre los vivos, para que un borrado
-- no bloquee reusar el código.
CREATE UNIQUE INDEX IF NOT EXISTS idx_catalogo_codigo
  ON catalogo(codigo) WHERE codigo <> '' AND eliminado IS NULL;

-- ---- Configuración general (clave/valor) ----
-- idioma, logo_tamano, maps_api_key, usuario_actual_id, contador_trabajos,
-- esquema_version, empresa_nombre, empresa_telefono, etc.
CREATE TABLE IF NOT EXISTS configuracion (
  clave TEXT PRIMARY KEY,
  valor TEXT
);
