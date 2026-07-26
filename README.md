# One Stop Heating and Cooling

App de gestión de servicio en campo para una empresa de HVAC en California:
clientes, trabajos agendados y equipo de trabajadores. Bilingüe español/inglés.

Es una **PWA**: se instala como app en el teléfono y en la computadora, y sigue
abriendo sin señal.

## Estructura

```
onestop-web/     la app (esto es lo que se publica)
worker-d1/       esquema de la base de datos, todavía sin desplegar
```

## Publicación

Se publica con **Cloudflare Pages**, apuntando a la carpeta `onestop-web`.
Cada cambio que se sube a `main` se publica solo.

> Al publicar una versión nueva hay que subir el número de caché en
> `onestop-web/service-worker.js` (`const CACHE = 'onestop-shell-vNN'`), si no
> los usuarios se quedan viendo la versión vieja.

## Dónde viven los datos

Por ahora, **solo en el navegador de cada dispositivo** (localStorage). Cada
persona que abre la app tiene su propia información, sin sincronizar. Hay
respaldo para exportar/importar en Configuración → Datos.

Los datos actuales son de prueba. El uso real arranca cuando estén conectados
**D1** (base de datos), **R2** (fotos y documentos) y el **login**.

## Correrlo en tu computadora

Hace falta un servidor de verdad — abrir el archivo con doble clic no alcanza,
porque el service worker y el manifest no funcionan con `file://`.

```bash
python -m http.server 5173 --directory onestop-web
```

Después, abrir `http://localhost:5173`.

---

Para trabajar en el código, leer primero [CLAUDE.md](CLAUDE.md): tiene la
estructura, las reglas que no se rompen y el estado real de cada módulo.
