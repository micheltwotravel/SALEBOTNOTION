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
const SYSTEM_PROMPT = `You are the sales assistant for Two Travel.

Rules:
- Respond in the same language as the user.
- Use only the properties that appear in the provided inventory.
- Never invent property names, prices, locations, amenities, or links.
- If the user asks for options, always recommend the closest real matches from the inventory.
- If one detail is subjective or unavailable, like "modern style", ignore it and still recommend the closest real options.
- Do not ask follow-up questions if the user already gave enough information to search.
- For each option, include: property name, area, bedrooms, bathrooms, max capacity, key amenities, price, and website link or Airbnb link if available.
- Keep the response short, clean, and sales-friendly.
- End with: "Would you like me to send these to the client?"`;
// ── Llamada a OpenAI ──────────────────────────────────────────────────────────
async function askOpenAI(userMessage, threadId) {
  const inventory = await searchNotion();

  const properties = inventory
    .split("\n\n---\n\n")
    .map(block => {
      const lines = block.split("\n");
      const getVal = (prefix) =>
        lines.find(l => l.startsWith(prefix))?.replace(prefix, "").trim() || "";

      const cityLine = getVal("Ciudad: ");
const cityParts = cityLine.split("|");
const cityPart = (cityParts[0] || "").trim();
const neighborhoodPart = (cityParts[1] || "").trim();

const roomsLine = lines.find(l => l.startsWith("Habitaciones:")) || "";
const roomsMatch = roomsLine.match(/Habitaciones:\s*(.*?)\s*\|\s*Baños:\s*(.*?)\s*\|\s*Max personas:\s*(.*)/);

return {
  raw: block,
  name: getVal("Nombre: "),
  type: getVal("Tipo: "),
  city: cityPart.replace("Ciudad:", "").trim(),
  neighborhood: neighborhoodPart.replace("Vecindario:", "").trim(),
  amenities: getVal("Amenities: ").toLowerCase(),
  price: getVal("Precio: "),
  description: getVal("Descripción: ").toLowerCase(),
  website: getVal("Website: "),
  airbnb: getVal("Airbnb: "),
  bedrooms: roomsMatch ? roomsMatch[1].trim() : "",
  bathrooms: roomsMatch ? roomsMatch[2].trim() : "",
  maxPax: roomsMatch ? parseInt(roomsMatch[3]) || 0 : 0,
};
    })
    .filter(p => p.name);

  const q = userMessage.toLowerCase();

  const wantsCartagena = q.includes("cartagena");
  const wantsCentro = q.includes("centro") || q.includes("center") || q.includes("historic center");
  const wantsPool = q.includes("pool") || q.includes("piscina");
  const wantsVilla = q.includes("villa") || q.includes("villas");
  const paxMatch = q.match(/\b(\d+)\b/);
  const wantedPax = paxMatch ? parseInt(paxMatch[1]) : 0;

  let filtered = properties.filter(p => {
    let ok = true;

    if (wantsCartagena) {
      ok = ok && (
        p.city.toLowerCase().includes("cartagena") ||
        p.neighborhood.toLowerCase().includes("cartagena")
      );
    }

    if (wantsCentro) {
      ok = ok && (
        p.neighborhood.toLowerCase().includes("centro") ||
        p.neighborhood.toLowerCase().includes("historic") ||
        p.neighborhood.toLowerCase().includes("walled city")
      );
    }

    if (wantedPax) {
      ok = ok && p.maxPax >= wantedPax;
    }

    if (wantsPool) {
      ok = ok && (
        p.amenities.includes("pool") ||
        p.amenities.includes("piscina") ||
        p.description.includes("pool") ||
        p.description.includes("piscina")
      );
    }

    if (wantsVilla) {
      ok = ok && (
        p.type.toLowerCase().includes("villa") ||
        p.type.toLowerCase().includes("house") ||
        p.type.toLowerCase().includes("casa")
      );
    }

    return ok;
  });

  if (!filtered.length) {
    filtered = properties.filter(p => {
      let score = 0;
      if (wantsCartagena && (p.city.toLowerCase().includes("cartagena") || p.neighborhood.toLowerCase().includes("cartagena"))) score += 3;
      if (wantsCentro && p.neighborhood.toLowerCase().includes("centro")) score += 3;
      if (wantedPax && p.maxPax >= wantedPax) score += 4;
      if (wantsPool && (p.amenities.includes("pool") || p.amenities.includes("piscina") || p.description.includes("pool") || p.description.includes("piscina"))) score += 3;
      return score > 0;
    });
  }

  filtered = filtered
    .sort((a, b) => b.maxPax - a.maxPax)
    .slice(0, 3);

 if (!filtered.length) {
  return `Connected to inventory. Total properties found: ${properties.length}. Matches found: ${filtered.length}.`;
}

  const isSpanish = /[áéíóúñ¿¡]|\b(casas|cartagena|personas|piscina|centro)\b/i.test(userMessage);

  if (isSpanish) {
    const intro = "Estas son algunas opciones reales del inventario que podrían servirte:\n\n";
    const body = filtered.map(p => {
      const link = p.website || p.airbnb;
      return `*${p.name}* en ${p.neighborhood || p.city}. Tiene ${p.bedrooms} habitaciones, ${p.bathrooms} baños y capacidad para ${p.maxPax} personas. Amenities: ${p.amenities || "No especificados"}. Precio: ${p.price || "No especificado"}. ${link ? `Link: ${link}` : ""}`;
    }).join("\n\n");
    return `${intro}${body}\n\n¿Quieres que se las envíe al cliente?`;
  } else {
    const intro = "Here are a few real inventory options that could be a good fit:\n\n";
    const body = filtered.map(p => {
      const link = p.website || p.airbnb;
      return `*${p.name}* in ${p.neighborhood || p.city}. It has ${p.bedrooms} bedrooms, ${p.bathrooms} bathrooms, and accommodates up to ${p.maxPax} guests. Amenities: ${p.amenities || "Not specified"}. Price: ${p.price || "Not specified"}. ${link ? `Link: ${link}` : ""}`;
    }).join("\n\n");
    return `${intro}${body}\n\nWould you like me to send these to the client?`;
  }
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
