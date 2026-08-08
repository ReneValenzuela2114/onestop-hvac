# Worker de One Stop

Acá vive la clave de Claude. La app **nunca** la ve.

```
la app  →  este Worker (guarda la clave)  →  Claude  →  datos del cliente
```

Más adelante este mismo Worker va a servir la base de datos D1 (`schema.sql`).

---

## Publicarlo (una sola vez)

Hace falta Node instalado. Desde esta carpeta:

```bash
npx wrangler login
```

Se abre el navegador → entrás a tu cuenta de Cloudflare → **Allow**.

```bash
npx wrangler secret put ANTHROPIC_API_KEY
```

Pega la clave de Claude cuando la pida. **No se guarda en ningún archivo** — queda
cifrada en Cloudflare. Esto es lo que evita que la clave termine en GitHub.

```bash
npx wrangler deploy
```

Al terminar imprime la dirección, algo como:

```
https://onestop-api.TU-CUENTA.workers.dev
```

Esa dirección se pega en la app: **Configuración → Integraciones → Lector de mensajes**.

---

## Actualizarlo después de un cambio

```bash
npx wrangler deploy
```

La clave no hay que volver a cargarla.

---

## Cambiar desde qué sitios se acepta

En `wrangler.toml`, `ORIGENES_PERMITIDOS` (separados por coma, sin barra final).
Cualquier otro sitio recibe 403 y **no gasta un centavo** de la API.

Al mudar la app a un dominio nuevo hay que agregarlo acá y volver a desplegar.

---

## Costo

Unos **3 centavos de dólar** por cliente leído (Claude Opus 5, esfuerzo bajo).

⚠️ **Poné un tope de gasto mensual** en la consola de Claude
(*Settings → Workspaces → tu workspace → Spend limits*). Mientras no exista el
login, la dirección del Worker es pública: el tope es la protección real contra
un gasto inesperado.
