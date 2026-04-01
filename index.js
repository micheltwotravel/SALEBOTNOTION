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
      `${get("Twp Travel Webpage") ? `Website: ${get("Twp Travel Webpage")}` : ""}`,
`${get("Airbnb Link") ? `Airbnb: ${get("Airbnb Link")}` : ""}`,
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
const SYSTEM_PROMPT = `You are the sales assistant for Two Travel, a luxury concierge and villa rental company in Cartagena, Colombia.

IMPORTANT RULES:
- Always respond in the same language as the user.
- If the user writes in Spanish, respond in Spanish.
- If the user writes in English, respond in English.
- Only recommend properties that appear EXACTLY in the provided inventory.
- Do NOT invent property names, prices, locations, amenities, or links.
- If a property is not explicitly listed in the inventory, do not mention it.
- Always use the exact property names as written in the inventory.
- Never say you have properties that are not in the inventory.

RECOMMENDATION RULES:
- When the user asks for properties, recommend only real options from the inventory.
- If there is no exact match, do NOT stop there.
- Instead, suggest the closest available options from the inventory.
- Prioritize in this order:
  1. Guest capacity
  2. Location
  3. Key amenities
  4. Property type
  5. Budget, if provided
- Clearly explain what matches and what does not match.
- If key details are missing, ask follow-up questions such as:
  - number of guests
  - travel dates
  - preferred area
  - must-have amenities
  - budget

FORMAT AND TONE:
- Keep the tone warm, polished, natural, and sales-oriented.
- Write like a concierge or villa sales advisor.
- Do NOT use heavy bullet points or long numbered lists unless truly necessary.
- Prefer short, clean paragraphs that are easy to send in Slack or WhatsApp.
- For each recommended property, include when available:
  - property name
  - area / neighborhood
  - bedrooms
  - bathrooms
  - max guest capacity
  - standout amenities
  - price
  - property link
- If the inventory includes both an Airbnb link and a website link, prefer the website link first, then the Airbnb link.
- Never invent links. Only use links that appear in the inventory.

CLOSING:
- After sharing options, end with a helpful sales-style question.
- Examples:
  - "Would you like me to send these to the client?"
  - "Should I share these options with the client?"
  - "If you'd like, I can also help draft the message for the client."

Your job is to help the team recommend the best real options from inventory while sounding helpful, accurate, and professional.`;
// ── Llamada a OpenAI ──────────────────────────────────────────────────────────
async function askOpenAI(userMessage, threadId) {
  const history = getHistory(threadId);
  const inventory = await searchNotion();

  // 🔥 CREA propertyNames DESDE EL INVENTARIO
  const propertyNames = inventory
    .split("\n")
    .filter(line => line.startsWith("Nombre:"))
    .map(line => line.replace("Nombre: ", ""))
    .join(", ");

  if (history.length > 16) history.splice(0, history.length - 16);
  history.push({ role: "user", content: userMessage });

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },

    { role: "system", content: `VALID PROPERTY NAMES:\n${propertyNames}` },

    { role: "system", content: `INVENTARIO TWO TRAVEL...\n${inventory}` },

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
