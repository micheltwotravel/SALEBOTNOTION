# 🏖️ Two Travel Slack Bot

Asistente de ventas para Slack conectado al inventario de Two Travel en Notion.

---

## Paso 1 — Crear la Slack App

1. Ve a **https://api.slack.com/apps** → "Create New App" → "From scratch"
2. Nombre: `Two Travel Assistant` · Workspace: el de tu empresa
3. En el menú izquierdo → **"OAuth & Permissions"**
   - En **Bot Token Scopes** agrega:
     - `app_mentions:read`
     - `chat:write`
     - `im:history`
     - `im:read`
     - `im:write`
     - `channels:history`
4. Clic en **"Install to Workspace"** → copia el **Bot User OAuth Token** (`xoxb-...`)
5. Ve a **"Basic Information"** → copia el **Signing Secret**
6. Ve a **"Event Subscriptions"** → actívalo
   - En **Request URL** pega: `https://TU-APP.onrender.com/slack/events`
   - En **Subscribe to bot events** agrega: `app_mention`, `message.im`
7. Guarda los cambios

---

## Paso 2 — Crear la integración en Notion

1. Ve a **https://www.notion.so/profile/integrations** → "New integration"
2. Nombre: `Two Travel Bot` · Workspace: el tuyo
3. Copia el **Internal Integration Token** (`secret_...`)
4. Abre la base de datos `Two_Travel_Master_Inventory` en Notion
5. Clic en los tres puntos `...` arriba a la derecha → "Connections" → conecta `Two Travel Bot`

---

## Paso 3 — Subir a GitHub

```bash
git init
git add .
git commit -m "Two Travel Slack Bot"
git branch -M main
git remote add origin https://github.com/TU-USUARIO/two-travel-bot.git
git push -u origin main
```

---

## Paso 4 — Deploy en Render

1. Ve a **https://render.com** → "New Web Service"
2. Conecta tu repositorio de GitHub
3. Configuración:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Free (para empezar)
4. En **"Environment Variables"** agrega las 4 variables de `.env.example`:
   - `SLACK_BOT_TOKEN` → el token `xoxb-...`
   - `SLACK_SIGNING_SECRET` → el signing secret
   - `ANTHROPIC_API_KEY` → tu key de Anthropic
   - `NOTION_MCP_TOKEN` → el token `secret_...` de Notion
5. Clic en **"Create Web Service"**
6. Espera ~2 minutos a que termine el deploy
7. Copia la URL de tu app (ej: `https://two-travel-bot.onrender.com`)

---

## Paso 5 — Conectar Slack con Render

1. Vuelve a tu Slack App → "Event Subscriptions"
2. En **Request URL** pega: `https://two-travel-bot.onrender.com/slack/events`
3. Slack enviará un challenge — Render responderá automáticamente ✅
4. Guarda los cambios

---

## Paso 6 — Invitar el bot a un canal

En Slack, en el canal de ventas:
```
/invite @Two Travel Assistant
```

---

## ✅ Listo — cómo usarlo

- Menciona al bot en cualquier canal: `@Two Travel Assistant casas con piscina para 12 en Bocagrande`
- O escríbele por mensaje directo (DM)
- Responde en español o inglés según el idioma del mensaje

---

## Ejemplos de preguntas

- `@Two Travel Assistant necesito villa con jacuzzi y rooftop para 15 personas`
- `@Two Travel Assistant qué hay disponible en Ciudad Amurallada?`
- `@Two Travel Assistant properties pet friendly near Getsemani`
- `@Two Travel Assistant cuál es la política de cancelación de Casa Siete?`
