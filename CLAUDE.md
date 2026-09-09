# One Stop Heating and Cooling · Guía del proyecto

App de gestión de servicio en campo (field service) para una empresa de HVAC en
California. Clientes, trabajos agendados, equipo de trabajadores. Bilingüe ES/EN,
inglés por defecto.

---

## 1. Estructura

```
OneStop-HVAC/
├── index.html             ← TODO: markup + CSS + lógica de pantallas (~3400 líneas)
├── data.js                ← capa de datos (hoy localStorage, mañana fetch al Worker)
├── i18n.js                ← traducciones ES/EN (ningún texto suelto en el HTML)
├── service-worker.js      ← PWA: red-primero para HTML, caché para estáticos
├── manifest.webmanifest
├── _headers               ← no-cache para el service worker y el manifest
├── assets/                ← íconos PWA (192, 512, maskable, apple-touch)
├── CLAUDE.md              ← este archivo
├── README.md
├── datos-ejemplo.json     ← 50 clientes y 70 productos inventados (se baja solo al tocar el botón)
├── logo resolucion.png    ← logo original en alta (fuente de los íconos)
└── worker-d1/             ← el backend (Cloudflare Worker, cuenta de Rene)
    ├── src/index.js       ← lector de mensajes con IA (POST /api/leer-cliente)
    ├── wrangler.toml      ← config del Worker + orígenes permitidos
    ├── README.md          ← cómo desplegarlo y cargar la clave
    └── schema.sql         ← esquema de D1, escrito de antemano (todavía sin desplegar)
```

**La carpeta se llama `worker-d1` desde antes de que hubiera Worker.** Es el mismo
Worker que va a servir D1 más adelante; el nombre cobra sentido en ese momento.

**La app va en la raíz a propósito.** Así se publica sin configurar nada: GitHub
Pages sirve desde la raíz, y Cloudflare Pages también (carpeta de salida `/`).
No mover estos archivos a una subcarpeta sin actualizar la publicación primero.

**Sin build, sin dependencias, sin npm.** Se abre el HTML y funciona. No introducir
un bundler salvo que el proyecto lo pida de verdad.

---

## 2. Reglas del proyecto (no romper)

1. **Ninguna pantalla toca `localStorage` directamente.** Todo pasa por `DB.*`
   (`DB.clientes`, `DB.trabajos`, `DB.usuarios`, `DB.categoriasClientes`,
   `DB.catalogo`, `DB.proveedores`, `DB.cotizaciones`, `DB.conversiones`, `DB.combos`,
   `DB.archivos`, `DB.config`). Ese es el contrato que permite cambiar a D1 sin tocar la UI.
2. **La plata SIEMPRE en centavos enteros** (`precio_centavos`, `costo_centavos`).
   Nunca decimales: los flotantes no representan `0.10` exacto y los reportes
   terminan sin cuadrar. Convertir con `DB.dinero.aCentavos()` / `.aTexto()` /
   `.formato()`. Un campo de dinero nuevo se llama `*_centavos`, sin excepción.
3. **Nada se borra de verdad.** `remove()` marca `eliminado` (epoch ms) y
   `eliminado_por`. Toda lectura filtra los eliminados. Un trabajo tiene precio y
   costo: borrarlo sería borrar plata del historial de la empresa.

   3b. **Al llevar un producto del catálogo a una cotización o un trabajo se
   COPIA el precio, nunca se apunta al catálogo.** Si se apuntara, subir un
   precio hoy cambiaría el total de una cotización que el cliente ya firmó. El
   `catalogo_id` se guarda igual, pero solo para reportes. Las fotos del pasado
   no se recalculan.

   3c. **Las cantidades van en centésimas enteras** (`*_centesimas`), por la
   misma razón que la plata: 12.5 pies se guarda como `1250`. Multiplicar
   cantidad por precio se hace **siempre** con `DB.cantidad.porPrecio()`.

   3d. **Los totales no se guardan, se calculan** — y con **una sola función**
   (`DB.cotizaciones.totales()`). Guardar un total además de los renglones es
   tener dos verdades que tarde o temprano dejan de coincidir. La misma
   función alimenta la pantalla y el guardado.

   3e. **El impuesto se guarda en la cotización, no en configuración**
   (`impuesto_centesimas`, 7.25% = `725`). Si viviera en configuración,
   cambiar la tasa mañana alteraría el total de una cotización ya firmada.

   3g. **El ojo del PDF esconde el renglón, NO le quita la plata al total.**
   `en_pdf = 0` saca el renglón de la lista impresa, pero
   `DB.cotizaciones.totales()` sigue sumando TODOS los renglones. Es a
   propósito y es como lo hace DES: sirve para no mostrarle al cliente el
   desglose interno (permisos, acarreo) sin dejar de cobrarlo. **Consecuencia
   que hay que tener presente: si el cliente suma los renglones que ve, le va
   a dar menos que el total.**

   3i. **Los colores del PDF salen del logo, medidos, no elegidos a ojo.**
   Marino `#104070`, rojo `#D02020` y gris `#909090` son los tres colores que
   más pixeles ocupan en `logo resolucion.png`. Antes la hoja usaba un azul y
   un naranja *parecidos pero distintos*, y esa casi-coincidencia es lo que se
   veía mal. Si el logo cambia, se vuelven a medir.

   3k. **La hoja se ordena con líneas finas, no con recuadros rellenos.**
   Medido contra la cotización de DES: ahí no hay ni un bloque relleno fuera
   de la banda del total. Los dos recuadros que tenía el encabezado pesaban
   más que todo el resto junto. Dos proporciones que se copiaron y hay que
   respetar: una fila de la tabla ocupa **3.4% del ancho de la hoja** y la
   banda del total mide **el doble de una fila**.

   3j. **Los precios por renglón en el PDF NO se eligen: los decide el ojo.**
   `DB.cotizaciones.mostrarPrecios(cot)` es la única función que lo resuelve
   —igual que con los totales, si la pantalla y el PDF lo calcularan cada uno
   por su lado terminarían discrepando—. Con **un solo renglón escondido, los
   precios por renglón desaparecen** y la plata sale una vez abajo. El motivo
   es aritmético: el escondido se sigue cobrando (regla 3g), así que mostrar
   los precios de los demás le da al cliente una suma que no llega al total.
   Antes esto era un check a mano y podían quedar las dos cosas juntas.
   `mostrar_precios` en `null` significa automático. Un 0 o un 1 guardado gana
   sobre el cálculo: son las cotizaciones que ya se enviaron antes de sep 2026,
   y una cotización que el cliente recibió no puede cambiar de forma sola —ni
   siquiera para quedar más coherente—. Las que estaban en borrador pasaron a
   automático.

   3l. **Aprobar una cotización NO crea el trabajo solo: abre el formulario.**
   La pantalla llena lo que sale de la cotización (cliente, título, notas,
   subtotal, costo y la dirección del cliente) y la persona completa fecha,
   horario y técnicos. La cotización queda aprobada y enlazada recién cuando el
   trabajo se **guarda**, con `DB.cotizaciones.enlazarTrabajo()`. Si se cancela,
   nada cambia y el botón sigue estando. `aprobar()` —que crea el trabajo solo—
   queda para la carga de datos de ejemplo, que crea muchos de una vez.

   3m. **Un cliente tiene DOS estados, no uno.** `relacion` dice si es lead
   (todavía no compró) o cliente (ya le vendimos); `estado` dice si está
   activo o inactivo. Son cosas distintas y se cruzan: un lead puede estar
   activo (lo estamos persiguiendo) y un cliente puede estar inactivo (hace
   años que no llama). Los dos, más la categoría, se cambian **desde la propia
   lista** con `cambiarCampoCliente()`, sin abrir el formulario. Las fichas
   que ya existían quedaron en "cliente" al migrar, no en "lead": la app las
   venía tratando así y muchas tienen trabajos cobrados.

   3n. **Cada paso de lead a cliente es una FILA en `conversiones`**, no un
   campo "fecha en que se hizo cliente". Ese campo guarda solo la última vez
   y pierde el historial si la ficha va y viene; con una fila por cambio,
   "cuántos leads convertimos en septiembre" se responde aunque después
   alguien haya tocado la ficha. La escribe `Clientes.create` / `.update`
   **dentro de la capa de datos**, para que quede grabado venga de donde
   venga —la lista, el formulario o una importación— y ninguna pantalla nueva
   pueda olvidarse. `desde = null` significa que la ficha nació ya como
   cliente. Un evento pasado **no se edita ni se borra**: es lo que hace que
   el reporte de marzo siga diciendo lo mismo dentro de dos años, y por eso
   el módulo no tiene `update` ni `remove`.
   ⚠️ **El historial arranca el 8 sep 2026.** Las fichas anteriores no tienen
   fecha de conversión porque ese dato nunca se guardó, y no se inventó
   ninguna: un reporte con fechas estimadas miente. La pantalla lo dice con
   todas las letras ("la ficha es anterior al registro").

   3o. **Un renglón de combo ES un renglón de cotización.** Mismas columnas,
   misma validación (`Validar.comboItem` llama a `cotizacionItem`), mismo HTML
   (`filasComoHTML`), mismo editor, mismo ojo y mismo arrastre. No es ahorro de
   líneas: es la única forma de que sigan siendo iguales dentro de seis meses.
   El editor sabe sobre qué lista trabaja por `ctxRenglones` (`CTX_COTIZACION`
   o `CTX_COMBO`), que se fija al tocar. `filas` es una **función** y no el
   arreglo, porque los dos se reemplazan enteros al cargar y una referencia
   guardada apuntaría al arreglo viejo.
   El combo guarda su propio precio, no apunta al catálogo, y al jalarlo se
   copia TODO tal cual quedó —nombre, descripción, unidad, cantidad, precio,
   costo y el ojo del PDF—. Un combo **no tiene precio propio de paquete**:
   `totales()` suma sus renglones y no se guarda (regla 3d).
   ⚠️ **Consecuencia: el combo no se entera si cambia el precio en el
   catálogo.** Es a propósito; refrescar solo pisaría un precio de paquete
   puesto a mano. La pantalla avisa cuántos renglones difieren y ofrece
   "Traer precios del catálogo", que **pide confirmación** porque pisa datos
   sin vuelta atrás.

   3p. **Lo que manda el catálogo no se edita en el renglón.** Si el renglón
   vino del catálogo (`catalogo_id`), el **precio de compra** y la **unidad**
   se ven pero están cerrados: cambiarlos ahí dejaría la cotización diciendo
   una cosa y el catálogo otra sin que nadie se entere. Se editan en Catálogo,
   que es donde viven. El **precio de venta** sí queda abierto —un descuento
   en un trabajo puntual es normal y no contradice al catálogo— igual que la
   cantidad, el nombre, el detalle y el ojo. Un renglón **escrito a mano** no
   tiene catálogo detrás: ahí se edita todo.
   ⚠️ Cerrar el campo no alcanza: los botones − y + de `.num-paso` seguían
   moviendo el número aunque el campo estuviera gris. El manejador ignora los
   campos `readOnly`/`disabled`, y al guardar el valor sale de `renglonBase`,
   no de lo que quedó en pantalla.
   Los nombres son **precio de compra** y **precio de venta**, iguales en la
   cotización, en el combo y en el catálogo: si en un lado se llaman distinto,
   vuelve la confusión que esto vino a arreglar.
   **Cerrado siempre, sin excepción para desbloquear.** Se le ofreció a Rene un
   candadito para el caso de haber comprado más caro que lo que dice el
   catálogo, y lo descartó (9 sep 2026). El costo de esa decisión, por si algún
   día aparece el problema: la ganancia de ese trabajo sale con el costo del
   catálogo, no con el que se pagó de verdad. El arreglo correcto en ese caso
   es actualizar el producto en Catálogo, no abrir el campo.

   3h. **El orden de los renglones lo manda la persona, no el código.** `orden`
   se guarda con la posición en que quedaron después de arrastrar, y es el
   orden en que salen en el PDF. Nunca reordenar por nombre ni por precio.

   3f. **El impuesto NO es ganancia.** Al aprobar una cotización, al trabajo va
   el **subtotal sin impuesto**: el impuesto se cobra y se entrega, no es plata
   de la empresa. Si fuera al precio del trabajo, `DB.trabajos.ganancia()` lo
   contaría como ganancia y todos los reportes saldrían inflados por la tasa.
   El total con impuesto vive en la cotización, que es el papel del cliente.
4. **`data.js` y `worker-d1/schema.sql` van sincronizados.** Los campos de cada
   objeto JS son EXACTAMENTE las columnas de su tabla. Si se agrega un campo, se
   agrega en los dos lados en el mismo cambio.
5. **Ningún texto visible se escribe en `index.html`.** Se usa `data-i18n="clave"`
   (contenido) o `data-i18n-ph="clave"` (placeholder), y la clave se define en
   `i18n.js` **en ES y EN**. Pestaña nueva = claves nuevas, nunca texto suelto.
6. **Los datos se leen de memoria, no del disco.** `DB.iniciar()` (en `init()`) es
   el **único** punto asíncrono de toda la app. Todo lo demás (`getAll`, `get`,
   `create`…) es instantáneo. No agregar `await` en las pantallas: si algo necesita
   ir a la red, va adentro del almacén de `data.js`.
7. **Los errores de datos nunca se pierden.** Los `create`/`update`/`remove` lanzan
   `ErrorDatos` con una clave de i18n. En la UI se envuelven con `conAviso(...)`,
   que muestra el aviso y frena. Un guardado que falla de fondo llega a
   `DB.alFallarGuardado`.
8. **Al publicar, subir la versión del caché** en `service-worker.js`
   (`const CACHE = 'onestop-shell-vNN'`). Hoy va en **v62**. Si no se sube, hay
   usuarios que se quedan pegados en la versión vieja.
9. **IDs**: `crypto.randomUUID()`. **Fechas de auditoría**: epoch ms (`Date.now()`)
   en `creado`/`actualizado`/`eliminado`. **Fechas de agenda**: string `YYYY-MM-DD`
   en `fecha`, `HH:MM` 24h en `hora_inicio`/`hora_fin`.
10. **Escapar siempre** lo que venga del usuario al armar HTML: `esc(valor)`.
11. **Hosting: Cloudflare.** Pages para el estático, Workers + D1 + R2 para los datos.
12. **El PDF se arma con HTML + `window.print()`**, igual que DES. Sin librerías.
    Lo fijo (empresa, presentación, términos, firma) vive en `DB.config` y se
    escribe una vez; lo variable sale de la cotización. Todo lo que venga del
    usuario pasa por `textoAHtml()`, que escapa y respeta los saltos de línea:
    un `<` pegado en los términos rompería el documento entero.

### Cambiar la forma de los datos

Si hace falta agregar o renombrar un campo: subir `ESQUEMA_VERSION` en `data.js`,
escribir la migración en `_migrar()` (tiene que poder correr dos veces sin romper
nada) y actualizar `schema.sql` en el mismo cambio.

---

## 3. Estado real (28 ago 2026)

| Módulo | Estado |
|---|---|
| Shell, navegación, PWA, ES/EN, logo configurable | ✅ terminado |
| **Clientes** (alta/edición/borrado, categorías, filtros, búsqueda, Google Maps + autocompletado) | ✅ terminado |
| **Trabajos** (calendario mensual, "por agendar", modal completo, precio/costo, asignar trabajadores) | ✅ terminado |
| **Equipo** (alta de trabajadores, roles, usuario del dispositivo) | ✅ terminado, sin login real |
| **Capa de datos** (centavos, borrado suave, auditoría, validación, número de trabajo, respaldo) | ✅ terminado (esquema v12) |
| **Lector de mensajes** (captura/PDF → campos del cliente, con Claude) | ✅ programado; falta desplegar el Worker |
| **Catálogo** (equipos/materiales/servicios, proveedores, filtros para reportes) | ✅ terminado (esquema v3) |
| **Cotizaciones** (renglones editables uno por uno, renglón a mano, ojo del PDF, reordenar arrastrando, impuesto, aprobar → crea el trabajo) | ✅ terminado (esquema v12) |
| **Cotización impresa / PDF** (datos de empresa, presentación, términos, firma) | ✅ terminado · igual que DES: HTML + impresión del navegador |
| **Worker en Cloudflare** | ✅ desplegado en la cuenta de Rene · hoy sirve el lector de mensajes |
| **Base de datos D1** | ⛔ `schema.sql` escrito y al día (v12), pero todavía sin desplegar |
| **R2** | ⛔ la tabla `archivos` y `DB.archivos` ya existen; falta el bucket. Hoy solo lo usa el logo |
| **Login / permisos reales** | ⛔ hoy los roles son solo etiquetas de interfaz |
| **Conversiones** (historial de lead → cliente, para reportes) | ✅ se registra solo (esquema v12) · la pantalla de reportes lo usará |
| **Combos** (recetas de productos que se cotizan juntos) | ✅ terminado (esquema v12) |
| **Reportes** (cuánto se ganó por cliente / por mes, conversiones) | ⛔ los datos ya están, falta la pantalla |

**Dónde viven los datos hoy:** solo en el navegador de cada dispositivo
(`localStorage`, claves `os_*_v1`, y los bytes de archivos bajo `os_bytes_*`).
Dos teléfonos = dos bases distintas, sin sincronizar. Por eso hay **respaldo
exportar/importar** en Configuración → Datos. **La empresa no debería usarla en
serio hasta que exista D1.**

---

## 4. Deuda técnica conocida

- **Clave de Google Maps hardcodeada** en `index.html` (`MAPS_KEY_DEFAULT`). Al ser
  una clave de navegador es pública por diseño, pero **tiene que estar restringida
  por dominio (HTTP referrer) en Google Cloud Console**, si no cualquiera la usa y
  la factura la paga Rene. Verificar antes de publicar.
- **`index.html` pasó las 3.000 líneas** y lleva markup, CSS y la lógica de todas
  las pantallas. Todavía se navega, pero es lo próximo que va a doler. Partirlo
  conviene hacerlo **junto con D1**, no antes: ese cambio ya toca la capa de datos.
- **El botón "Cargar datos de ejemplo"** (Configuración → Datos) y el archivo
  `datos-ejemplo.json` meten 50 clientes, 70 productos, 6 proveedores y 20
  cotizaciones inventadas — y las 9 aprobadas **crean su trabajo**, así que
  también aparecen 9 trabajos. Es para probar. **Sacar los dos antes de que la
  empresa la use de verdad**: un botón que inventa clientes, cotizaciones y
  trabajos no puede estar al alcance con datos reales adentro.
  Las fechas de las cotizaciones se calculan al cargarlas (campo `dias` = hace
  cuántos días), no vienen escritas: así los ejemplos no quedan viejos. Cada
  cliente trae además `rel` (lead/cliente) y `est` (activo/inactivo), con las
  cuatro combinaciones presentes para poder probar los filtros.
  ⚠️ El archivo se pide con `?v=` + la hora: el service worker responde desde
  SU caché y se saltea el `cache: "no-cache"`, así que sin eso el botón sigue
  trayendo la lista vieja cada vez que se agregan ejemplos nuevos.
- **Los botones del pie de los modales miden 37px, no 38.** Está un pixel por
  debajo del mínimo táctil que pide la guía general, y **Rene lo revisó y
  decidió dejarlo así** (8 sep 2026). No "arreglarlo" de oficio: si una
  medición lo vuelve a marcar, es una excepción aceptada, no un defecto.

- **Una colección nueva necesita SU clave en `CLAVES`** (`data.js`). Sin ella
  `localStorage[undefined]` es la misma para todas las que falten y los datos
  salen mezclados. Pasó de verdad: `conversiones` quedó sin clave y no se notó
  porque era la única; al agregar combos, los tres se pisaron. Ahora hay una
  guarda que revienta al arrancar si falta alguna, así no vuelve a pasar en
  silencio.

- **Naming inconsistente**: la pestaña se llama `proyectos` en el HTML pero el módulo,
  la tabla y los textos son "trabajos"/"jobs". Unificar a `trabajos` cuando se toque.
- **El Worker queda con una dirección pública hasta que exista el login.** Se filtra
  por `Origin` (un pedido de otro sitio recibe 403 sin gastar un centavo), pero eso
  no frena a alguien decidido. **La protección real es el tope de gasto mensual del
  workspace en la consola de Claude.** El login lo cierra de verdad.
- **La clave de Claude es la de la organización entera**, compartida con la otra app
  de Rene (DES): lo que gaste esta app le come créditos a aquella. Conviene un
  workspace con tope propio.
- **Sin control de concurrencia.** Dos dispositivos editando el mismo registro: gana
  el último y no avisa. Los campos `actualizado` / `actualizado_por` ya están para
  resolverlo; se aplica cuando exista el Worker (comparar `actualizado` antes de
  escribir y avisar si cambió).
- **Los bytes de los archivos siguen en el navegador** (data URL). Sirve para el
  logo; **las fotos de trabajos esperan a R2**, subirlas ahora reventaría la cuota.

---

## 5. Cómo correr la app localmente

Servidor estático (hace falta uno real: el service worker y el `manifest` no
funcionan abriendo el archivo con `file://`):

```bash
python -m http.server 5173
```

Después, `http://localhost:5173`. También está configurado en `.claude/launch.json`,
así que Claude puede levantarlo y verlo con la herramienta de preview.

---

## 5b. Publicación

**Hoy: GitHub Pages**, desde la raíz de `main`. Se sube con `git push` y queda
publicado solo. El repo es <https://github.com/ReneValenzuela2114/onestop-hvac>.

**Mañana: Cloudflare Pages**, en la cuenta del socio de Rene (no en la de Rene).
Ya está todo preparado — no hay nada que reorganizar, solo conectar:

1. Cloudflare → *Workers & Pages* → *Create* → *Pages* → *Connect to Git*
2. Elegir el repo `onestop-hvac`, rama `main`
3. Framework preset: **None** · Build command: **vacío** · Output directory: **`/`**

Después de conectarlo, cada `git push` se publica solo.

⚠️ **Al cambiar de dominio hay que actualizar la clave de Google Maps.** Está
restringida por sitio (HTTP referrer) en Google Cloud Console: si el dominio nuevo
no se agrega ahí, la app carga pero el mapa no. Es el error que más fácil se pasa
por alto en la mudanza.

⚠️ **Antes de que la empresa la use con clientes reales tiene que existir el login**,
porque una URL pública sin login expone la base de clientes.

---

## 6. Próximos pasos (en orden)

1. ~~**Modelo de datos a nivel producción**~~ ✅ hecho (25 jul 2026): centavos
   enteros, borrado suave, auditoría, validación, número de trabajo, tabla de
   archivos, respaldo.
2. **Git.** `git init` + primer commit, antes de cualquier cambio grande.
3. ~~**Catálogo**~~ ✅ hecho: equipos/materiales/servicios, proveedores como
   tabla propia, y filtros por tipo, proveedor, marca y estado — pensados para
   que los reportes puedan agrupar por lo mismo. Los campos de inventario
   (`controlar_stock`, `stock_centesimas`, `stock_minimo_centesimas`,
   `ubicacion`) **ya existen en el esquema pero no tienen pantalla**: cuando se
   haga el control de inventario no hay que migrar nada.
4. ~~**Cotizaciones**~~ ✅ hecho: renglones tomados del catálogo con el precio
   copiado, impuesto como porcentaje único, y **aprobar crea el trabajo** con
   el total ya puesto. Desde la ficha del cliente se ven sus cotizaciones y
   sus trabajos juntos.
   ⚠️ El impuesto es **un porcentaje sobre todo**. Si algún día la mano de obra
   tiene que quedar exenta (que es lo correcto en California), hace falta una
   marca por renglón — y eso ya es migrar cotizaciones firmadas.
5. **Reportes** de ganancia por cliente / mes (`DB.trabajos.ganancia(tj)`,
   `DB.cotizaciones.totales()`). Los datos ya están y son filtrables por
   cliente, estado, tipo, proveedor y marca.
6. **D1 + Worker + login, todo junto al final.** Implica: `wrangler.toml`, un Worker
   con endpoints `/api/*`, reemplazar `AlmacenLocal` por uno que hable con el Worker,
   y `DB.iniciar()` cargando de la red. Las pantallas no se tocan.
   ⚠️ **El login va en el mismo paso, no después**: una API abierta expone la base
   de clientes (nombres, direcciones y teléfonos de California) a cualquiera.
7. **R2** para fotos de trabajos: bucket **privado** con links firmados que expiran,
   y `Archivos.url()` devolviendo esos links en vez del contenido local.

---

## 7. Cómo trabajar con Rene

Ver la skill `app-builder-pro`: explicaciones cortas y simples, honestidad técnica
antes de hacer un parche, y no arrancar a programar cuando la pregunta es solo una
duda — esperar el "dale".
