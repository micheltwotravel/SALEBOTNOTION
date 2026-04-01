require("dotenv").config();
const { App, ExpressReceiver } = require("@slack/bolt");
const OpenAI = require("openai");

// ── Clientes ──────────────────────────────────────────────────────────────────
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
});

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver,
});

// ── Notion API directa ────────────────────────────────────────────────────────
const NOTION_DB_ID = "7a404c1a39bf8287a92e8124aeca4b2a";

async function searchNotion() {
  const res = await fetch("https://api.notion.com/v1/databases/" + NOTION_DB_ID + "/query", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + process.env.NOTION_API_KEY,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      filter: { property: "Status", select: { equals: "Active" } },
      page_size: 50,
    }),
  });
  const data = await res.json();
  if (!data.results) return "No se pudo obtener el inventario.";

  const items = data.results.map((p) => {
    const props = p.properties;
    const get = (key) => {
      const prop = props[key];
      if (!prop) return "";
      if (prop.type === "title") return prop.title?.map(t => t.plain_text).join("") || "";
      if (prop.type === "rich_text") return prop.rich_text?.map(t => t.plain_text).join("") || "";
      if (prop.type === "select") return prop.select?.name || "";
      if (prop.type === "multi_select") return prop.multi_select?.map(s => s.name).join(", ") || "";
      if (prop.type === "number") return prop.number ?? "";
      if (prop.type === "url") return prop.url || "";
      return "";
    };
    return [
      `Nombre: ${get("Name")}`,
      `Tipo: ${get("Item Type")}`,
      `Ciudad: ${get("City")} | Vecindario: ${get("Neighborhood")}`,
      `Habitaciones: ${get("Bedrooms")} | Baños: ${get("Bathrooms")} | Max personas: ${get("Max Pax")}`,
      `Amenities: ${get("Amenities")}`,
      `Precio: ${get("Client Price")} | Rango: ${get("Price Range")}`,
      `Check-in: ${get("Check-in Time")} | Check-out: ${get("Check-out Time")}`,
      `Cancelación: ${get("Cancellation Policy")}`,
      `Descripción: ${get("Description")}`,
      `Web: ${get("Twp Travel Webpage")}`,
    ].filter(l => !l.endsWith(": ") && !l.endsWith(": |  | ")).join("\n");
  });

  return items.join("\n\n---\n\n");
}

// ── Historial por conversación ────────────────────────────────────────────────
const conversations = new Map();
function getHistory(threadId) {
  if (!conversations.has(threadId)) conversations.set(threadId, []);
  return conversations.get(threadId);
}

// ── Prompt del sistema ────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `Eres el asistente de ventas de Two Travel, empresa de concierge de lujo y propiedades en Cartagena, Colombia.

Tienes acceso al inventario completo de propiedades. Usa SOLO la información real del inventario para responder. No inventes propiedades, precios, links ni detalles.

Reglas:
1. Responde en el idioma del usuario.
2. Usa solo propiedades reales del inventario.
3. Cuando recomiendes opciones, hazlo en formato limpio y natural, como mensaje de ventas.
4. NO uses listas numeradas ni demasiados bullets. Prefiere párrafos cortos por propiedad.
5. Para cada propiedad incluye: nombre, zona, habitaciones, baños, capacidad, amenities clave, precio y link si existe.
6. Si no hay match exacto, sugiere las opciones más cercanas.
7. Sé cálido, profesional y orientado al cierre.
8. Si falta información, pregunta por número de personas, fechas y amenity indispensable.
9. Al final, si compartiste opciones, agrega: "Si alguna de estas opciones te interesa, también te puedo ayudar a redactar el mensaje en inglés para enviárselo al cliente."
10. No inventes links. Solo usa los del inventario.`;
// ── Llamada a OpenAI ──────────────────────────────────────────────────────────
async function askOpenAI(userMessage, threadId) {
  const history = getHistory(threadId);
  const inventory = await searchNotion();

  if (history.length > 16) history.splice(0, history.length - 16);
  history.push({ role: "user", content: userMessage });

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "system", content: `INVENTARIO TWO TRAVEL (propiedades Active):\n\n${inventory}` },
    ...history,
  ];

  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    max_tokens: 1024,
    messages,
  });

  const reply = response.choices[0].message.content;
  history.push({ role: "assistant", content: reply });
  return reply;
}

// ── Eventos de Slack ──────────────────────────────────────────────────────────
app.event("app_mention", async ({ event, say }) => {
  try {
    const threadId = event.thread_ts || event.ts;
    const text = event.text.replace(/<@[A-Z0-9]+>/g, "").trim();
    if (!text) {
      await say({ text: "¡Hola! Pregúntame por propiedades, precios o amenities 🏖️", thread_ts: event.ts });
      return;
    }
    const reply = await askOpenAI(text, threadId);
    await say({ text: reply, thread_ts: event.ts });
  } catch (err) {
    console.error("Error app_mention:", err);
    await say({ text: "Hubo un error. Intenta de nuevo.", thread_ts: event.ts });
  }
});

app.message(async ({ message, say }) => {
  if (message.subtype || message.bot_id) return;
  try {
    const threadId = message.thread_ts || message.ts;
    const reply = await askOpenAI(message.text, threadId);
    await say({ text: reply, thread_ts: message.ts });
  } catch (err) {
    console.error("Error message:", err);
    await say({ text: "Hubo un error. Intenta de nuevo.", thread_ts: message.ts });
  }
});

// ── Health check para Render ──────────────────────────────────────────────────
receiver.router.get("/health", (req, res) => res.send("OK"));

// ── Arrancar ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
(async () => {
  await app.start(PORT);
  console.log(`⚡ Two Travel Bot corriendo en puerto ${PORT}`);
})();
