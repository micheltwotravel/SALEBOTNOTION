require("dotenv").config();
const { App, ExpressReceiver } = require("@slack/bolt");
const Anthropic = require("@anthropic-ai/sdk");

// ── Clientes ──────────────────────────────────────────────────────────────────
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
});

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver,
});

// ── Historial por conversación (en memoria) ───────────────────────────────────
const conversations = new Map();

function getHistory(threadId) {
  if (!conversations.has(threadId)) conversations.set(threadId, []);
  return conversations.get(threadId);
}

// ── Prompt del sistema ────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `Eres el asistente de ventas de Two Travel, una empresa de concierge de lujo y propiedades en Cartagena, Colombia.

Tienes acceso al inventario completo de propiedades Two Travel (Two_Travel_Master_Inventory). Cuando alguien pregunte por propiedades, debes buscar en el inventario usando la herramienta de Notion y responder con resultados reales.

El inventario incluye:
- Name: nombre de la propiedad
- Item Type: tipo de propiedad
- City / Neighborhood: ciudad y vecindario (Walled City, Getsemaní, Bocagrande, Provenza, Manila, Rosario Islands, Barú, Manga, Tierra Bomba, Cabrero, etc.)
- Bedrooms, Bathrooms, Beds, Max Pax, Capacity: capacidad
- Amenities: Pool, Jacuzzi, Rooftop, Ocean View, BBQ, Pet Friendly, Sound System, Bachelor Friendly, Chef Included, etc.
- Client Price / Price Range: precios
- Status: Active / Inactive / Under Maintenance / Seasonal Only
- Description, Neighborhood Summary: detalles
- Airbnb Link, Twp Travel Webpage, Photos Link: links útiles
- Check-in Time, Check-out Time, Cancellation Policy

Reglas:
1. Siempre busca en el inventario de Notion cuando te pregunten por propiedades.
2. Solo muestra propiedades con Status = "Active" a menos que te pidan ver otras.
3. Presenta resultados de forma amigable y orientada a ventas: nombre, vecindario, habitaciones/baños, capacidad máxima, amenities destacados, precio si está disponible.
4. Responde en el mismo idioma que el usuario (español o inglés).
5. Si no hay resultados exactos, sugiere las opciones más cercanas.
6. Ofrece siempre afinar la búsqueda o mostrar más opciones.
7. Sé cálido, profesional y orientado al cierre de ventas.

Cuando no tengas suficiente info del cliente, pregunta: ¿cuántas personas? ¿fechas? ¿algún amenity indispensable?`;

// ── Llamada a Claude con MCP de Notion ───────────────────────────────────────
async function askClaude(userMessage, threadId) {
  const history = getHistory(threadId);
  history.push({ role: "user", content: userMessage });

  // Mantener máximo 20 mensajes en historial
  if (history.length > 20) history.splice(0, history.length - 20);

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: history,
    mcp_servers: [
      {
        type: "url",
        url: "https://mcp.notion.com/mcp",
        name: "notion",
        authorization_token: process.env.NOTION_MCP_TOKEN,
      },
    ],
  });

  const reply = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  history.push({ role: "assistant", content: reply });
  return reply;
}

// ── Eventos de Slack ──────────────────────────────────────────────────────────

// Responde cuando mencionan al bot (@Two Travel Assistant)
app.event("app_mention", async ({ event, say }) => {
  try {
    const threadId = event.thread_ts || event.ts;
    const text = event.text.replace(/<@[A-Z0-9]+>/g, "").trim();
    if (!text) {
      await say({ text: "¡Hola! ¿En qué te puedo ayudar? Pregúntame por propiedades, precios o amenities 🏖️", thread_ts: event.ts });
      return;
    }
    const reply = await askClaude(text, threadId);
    await say({ text: reply, thread_ts: event.ts });
  } catch (err) {
    console.error("Error en app_mention:", err);
    await say({ text: "Hubo un error procesando tu consulta. Intenta de nuevo.", thread_ts: event.ts });
  }
});

// Responde mensajes directos (DM)
app.message(async ({ message, say }) => {
  if (message.subtype || message.bot_id) return;
  try {
    const threadId = message.thread_ts || message.ts;
    const reply = await askClaude(message.text, threadId);
    await say({ text: reply, thread_ts: message.ts });
  } catch (err) {
    console.error("Error en message:", err);
    await say({ text: "Hubo un error. Intenta de nuevo.", thread_ts: message.ts });
  }
});

// ── Health check para Render ──────────────────────────────────────────────────
receiver.router.get("/health", (req, res) => res.send("OK"));

// ── Arrancar servidor ─────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
(async () => {
  await app.start(PORT);
  console.log(`⚡ Two Travel Bot corriendo en puerto ${PORT}`);
})();
