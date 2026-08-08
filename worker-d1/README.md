# Worker de One Stop

Acá vive la clave de Claude. La app **nunca** la ve.

```
la app  →  este Worker (guarda la clave)  →  Claude  →  datos del cliente
```

Más adelante este mismo Worker va a servir la base de datos D1 (`schema.sql`).

---

**Ya está desplegado** en `https://onestop-api.renealejandrovalenzuela.workers.dev`
(cuenta de Cloudflare de Rene).

---

## En Windows: usar `npx.cmd`, no `npx`

PowerShell bloquea los scripts `.ps1` por política de seguridad, y `npx` es uno:

```
No se puede cargar el archivo ...\npx.ps1 porque la ejecución de scripts está deshabilitada
```

La solución **no** es cambiar la política de seguridad de Windows. Basta con
agregarle `.cmd` a cada comando: `npx.cmd wrangler ...`.

---

## Autenticarse con un token (no con `wrangler login`)

`npx.cmd wrangler login` abre el navegador y espera la respuesta en
`localhost:8976`. Si algo bloquea ese puerto, falla con
`Timed out waiting for authorization code` y no hay mucho que hacer.

El camino que sí funciona, y no usa el navegador:

1. <https://dash.cloudflare.com/profile/api-tokens> → **Create Token**
2. Plantilla **Edit Cloudflare Workers** → **Use template**
3. **Account Resources**: elegir la cuenta · **Zone Resources**: *All zones*
4. **Continue to summary** → **Create Token** → copiar (se muestra una sola vez)

En la terminal, antes de cualquier comando de wrangler:

```powershell
$env:CLOUDFLARE_API_TOKEN = "el-token"
```

Dura solo mientras esa ventana esté abierta. Si la cerrás, se vuelve a pegar.

---

## Publicar

Desde esta carpeta, con el token ya pegado:

```bash
npx.cmd wrangler deploy
```

Al terminar imprime la dirección. Esa dirección va en la app:
**Configuración → Integraciones → Lector de mensajes**.

Si pregunta si querés instalar *Cloudflare skills*, contestá `n` — no hacen falta.

---

## Cargar la clave de Claude

```bash
npx.cmd wrangler secret put ANTHROPIC_API_KEY
```

Pegá la clave (la de **platform.claude.com**, empieza con `sk-ant-`, **no** el token
de Cloudflare). **La terminal no muestra nada mientras pegás** — es a propósito.

Queda cifrada en Cloudflare, fuera de todo archivo. Eso es lo que evita que la
clave termine en GitHub.

---

## Actualizarlo después de un cambio

```bash
npx.cmd wrangler deploy
```

La clave no hay que volver a cargarla.

---

## Comprobar que quedó bien, sin gastar créditos

```bash
curl -s -X POST https://onestop-api.renealejandrovalenzuela.workers.dev/api/leer-cliente \
  -H "Origin: https://renevalenzuela2114.github.io" \
  -H "content-type: application/json" -d '{"mime":"text/html","datos":"AAA"}'
```

- `{"error":"error_ia_tipo"}` → todo bien, **la clave está cargada**
- `{"error":"error_ia_sin_clave"}` → falta cargar la clave
- `{"error":"error_ia_origen"}` → ese origen no está en `wrangler.toml`

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
