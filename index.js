require("dotenv").config();
const { App, ExpressReceiver } = require("@slack/bolt");
const OpenAI = require("openai");

// ─────────────────────────────────────────────────────────────
// Validación de variables de entorno
// ─────────────────────────────────────────────────────────────
const requiredEnv = [
  "OPENAI_API_KEY",
  "SLACK_SIGNING_SECRET",
  "SLACK_BOT_TOKEN",
  "NOTION_API_KEY",
];

for (const key of requiredEnv) {
  if (!process.env[key]) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
}

// ─────────────────────────────────────────────────────────────
// Clientes
// ─────────────────────────────────────────────────────────────
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
});

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver,
});

// ─────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────
const NOTION_DB_ID = process.env.NOTION_DB_ID || "7a404c1a39bf8287a92e8124aeca4b2a";
const PORT = Number(process.env.PORT || 3000);
const MAX_HISTORY_MESSAGES = 8;
const MAX_NOTION_PAGE_SIZE = 100;
const MAX_RESULTS_TO_SHOW = 5;

// ─────────────────────────────────────────────────────────────
// Historial por thread
// ─────────────────────────────────────────────────────────────
const conversations = new Map();

function getHistory(threadId) {
  if (!conversations.has(threadId)) {
    conversations.set(threadId, []);
  }
  return conversations.get(threadId);
}

function pushHistory(threadId, role, content) {
  const history = getHistory(threadId);
  history.push({ role, content });

  if (history.length > MAX_HISTORY_MESSAGES) {
    history.splice(0, history.length - MAX_HISTORY_MESSAGES);
  }
}

// ─────────────────────────────────────────────────────────────
// Utilidades
// ─────────────────────────────────────────────────────────────
function normalizeText(value) {
  return String(value || "").trim();
}

function lower(value) {
  return normalizeText(value).toLowerCase();
}

function safeNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function detectUserLanguage(text) {
  const t = String(text || "");
  const looksSpanish =
    /[áéíóúñ¿¡]/i.test(t) ||
    /\b(hola|quiero|busco|cartagena|medellin|personas|piscina|casa|villa|centro|playa|precio|opciones)\b/i.test(t);

  return looksSpanish ? "es" : "en";
}

function detectRequestedLanguage(text) {
  const t = lower(text);

  if (
    t.includes("answer in english") ||
    t.includes("respond in english") ||
    t.includes("english please") ||
    t.includes("first language be english") ||
    t.includes("primer idioma sea ingles") ||
    t.includes("en inglés") ||
    t.includes("ingles")
  ) {
    return "en";
  }

  if (
    t.includes("en español") ||
    t.includes("in spanish") ||
    t.includes("respond in spanish")
  ) {
    return "es";
  }

  return detectUserLanguage(text);
}

function extractNumericIntent(text) {
  const matches = String(text || "").match(/\b\d+\b/g) || [];
  return matches.map(Number).filter(Number.isFinite);
}

function compactPropertyForPrompt(p) {
  return {
    name: p.name,
    itemType: p.itemType,
    city: p.city,
    neighborhood: p.neighborhood,
    bedrooms: p.bedrooms,
    bathrooms: p.bathrooms,
    maxPax: p.maxPax,
    amenities: p.amenities,
    clientPrice: p.clientPrice,
    priceRange: p.priceRange,
    checkInTime: p.checkInTime,
    checkOutTime: p.checkOutTime,
    cancellationPolicy: p.cancellationPolicy,
    description: p.description,
    website: p.website,
    airbnb: p.airbnb,
  };
}

function chooseBestLink(property) {
  if (property.website && /^https?:\/\//i.test(property.website)) {
    return property.website;
  }
  if (property.airbnb && /^https?:\/\//i.test(property.airbnb)) {
    return property.airbnb;
  }
  return "";
}

// ─────────────────────────────────────────────────────────────
// Lectura de propiedades Notion
// ─────────────────────────────────────────────────────────────
function readNotionProperty(props, key) {
  const prop = props?.[key];
  if (!prop) return "";

  switch (prop.type) {
    case "title":
      return prop.title?.map((t) => t.plain_text).join("") || "";
    case "rich_text":
      return prop.rich_text?.map((t) => t.plain_text).join("") || "";
    case "select":
      return prop.select?.name || "";
    case "multi_select":
      return prop.multi_select?.map((s) => s.name).join(", ") || "";
    case "number":
      return prop.number ?? "";
    case "url":
      return prop.url || "";
    case "email":
      return prop.email || "";
    case "phone_number":
      return prop.phone_number || "";
    case "status":
      return prop.status?.name || "";
    case "checkbox":
      return prop.checkbox ? "Yes" : "No";
    default:
      return "";
  }
}

async function queryNotionDatabasePage(startCursor = null) {
  const response = await fetch(`https://api.notion.com/v1/databases/${NOTION_DB_ID}/query`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.NOTION_API_KEY}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      page_size: MAX_NOTION_PAGE_SIZE,
      ...(startCursor ? { start_cursor: startCursor } : {}),
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Notion query failed: ${response.status} ${text}`);
  }

  return response.json();
}

async function getAllNotionPages() {
  const allResults = [];
  let startCursor = null;
  let hasMore = true;

  while (hasMore) {
    const data = await queryNotionDatabasePage(startCursor);
    allResults.push(...(data.results || []));
    hasMore = Boolean(data.has_more);
    startCursor = data.next_cursor || null;
  }

  return allResults;
}

function normalizeProperty(page) {
  const props = page.properties || {};

  const property = {
    id: page.id,
    name: normalizeText(readNotionProperty(props, "Name")),
    itemType: normalizeText(readNotionProperty(props, "Item Type")),
    city: normalizeText(readNotionProperty(props, "City")),
    neighborhood: normalizeText(readNotionProperty(props, "Neighborhood")),
    bedrooms: normalizeText(readNotionProperty(props, "Bedrooms")),
    bathrooms: normalizeText(readNotionProperty(props, "Bathrooms")),
    maxPax: safeNumber(readNotionProperty(props, "Max Pax")) || 0,
    amenities: normalizeText(readNotionProperty(props, "Amenities")),
    clientPrice: normalizeText(readNotionProperty(props, "Client Price")),
    priceRange: normalizeText(readNotionProperty(props, "Price Range")),
    checkInTime: normalizeText(readNotionProperty(props, "Check-in Time")),
    checkOutTime: normalizeText(readNotionProperty(props, "Check-out Time")),
    cancellationPolicy: normalizeText(readNotionProperty(props, "Cancellation Policy")),
    description: normalizeText(readNotionProperty(props, "Description")),
    website: normalizeText(readNotionProperty(props, "Twp Travel Webpage")),
    airbnb: normalizeText(readNotionProperty(props, "Airbnb Link")),
  };

  return property;
}

async function fetchInventory() {
  const pages = await getAllNotionPages();

  return pages
    .map(normalizeProperty)
    .filter((p) => p.name && p.maxPax > 0);
}

// ─────────────────────────────────────────────────────────────
// Filtro inteligente
// ─────────────────────────────────────────────────────────────
function scoreProperty(property, userMessage) {
  const q = lower(userMessage);

  let score = 0;

  const city = lower(property.city);
  const neighborhood = lower(property.neighborhood);
  const itemType = lower(property.itemType);
  const amenities = lower(property.amenities);
  const description = lower(property.description);
  const name = lower(property.name);

  const numbers = extractNumericIntent(q);
  const requestedPax = numbers.length ? numbers[0] : null;

  const wantsCartagena = q.includes("cartagena");
  const wantsMedellin = q.includes("medellin") || q.includes("medellín");
  const wantsPool = q.includes("pool") || q.includes("piscina") || q.includes("private pool");
  const wantsBeach = q.includes("beach") || q.includes("playa") || q.includes("beachfront");
  const wantsCentro =
    q.includes("centro") ||
    q.includes("center") ||
    q.includes("historic center") ||
    q.includes("old city") ||
    q.includes("walled city");
  const wantsVilla = q.includes("villa") || q.includes("villas");
  const wantsHouse = q.includes("house") || q.includes("casa") || q.includes("home");
  const wantsApartment = q.includes("apartment") || q.includes("apartamento") || q.includes("apt");

  if (wantsCartagena && city.includes("cartagena")) score += 6;
  if (wantsMedellin && city.includes("medell")) score += 6;

  if (
    wantsCentro &&
    (
      neighborhood.includes("centro") ||
      neighborhood.includes("historic") ||
      neighborhood.includes("walled") ||
      description.includes("historic") ||
      description.includes("old town")
    )
  ) {
    score += 5;
  }

  if (
    wantsPool &&
    (
      amenities.includes("pool") ||
      amenities.includes("piscina") ||
      description.includes("pool") ||
      description.includes("piscina")
    )
  ) {
    score += 5;
  }

  if (
    wantsBeach &&
    (
      amenities.includes("beach") ||
      description.includes("beach") ||
      description.includes("playa") ||
      neighborhood.includes("beach")
    )
  ) {
    score += 3;
  }

  if (wantsVilla && (itemType.includes("villa") || itemType.includes("house") || itemType.includes("casa"))) {
    score += 4;
  }

  if (wantsHouse && (itemType.includes("house") || itemType.includes("casa") || itemType.includes("home"))) {
    score += 4;
  }

  if (wantsApartment && (itemType.includes("apartment") || itemType.includes("apart"))) {
    score += 4;
  }

  if (requestedPax) {
    if (property.maxPax >= requestedPax) {
      score += 8;

      const diff = Math.abs(property.maxPax - requestedPax);
      if (diff === 0) score += 5;
      else if (diff <= 2) score += 3;
      else if (diff <= 4) score += 1;
    } else {
      score -= 10;
    }
  }

  if (name && q.includes(name)) score += 6;

  return score;
}

function filterInventory(inventory, userMessage) {
  const scored = inventory
    .map((property) => ({
      property,
      score: scoreProperty(property, userMessage),
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored.map((item) => item.property);
}

// ─────────────────────────────────────────────────────────────
// Prompt
// ─────────────────────────────────────────────────────────────
function buildSystemPrompt(responseLanguage) {
  const languageInstruction =
    responseLanguage === "es"
      ? "Respond in Spanish."
      : "Respond in English.";

  return `
You are the sales assistant for Two Travel.

${languageInstruction}

Non-negotiable rules:
- Use only the properties and details explicitly present in the inventory provided.
- Never invent names, prices, locations, amenities, links, or availability.
- If the user asks for recommendations, select the closest real matches.
- If some requested detail is missing or subjective, ignore that constraint and still recommend the closest real matches.
- Be concise, warm, polished, and sales-friendly.
- Do not say you checked a database unless useful.
- Do not offer to send anything to the client.
- If there are relevant results, present the best options clearly.
- For each option include: property name, area/location, bedrooms, bathrooms, max capacity, key amenities, price, and one valid link if available.
- If some field is missing, say "Not specified" or "No especificado" depending on the language.
- End by inviting the user to refine the search or ask for more options.
- If no relevant properties are found, say that clearly and offer a broader search.

Formatting rules:
- Use short paragraphs or bullets.
- Keep it easy to read in Slack.
- Prioritize clarity over hype.
`.trim();
}

// ─────────────────────────────────────────────────────────────
// OpenAI response
// ─────────────────────────────────────────────────────────────
async function generateReplyWithAI({
  userMessage,
  threadId,
  inventoryMatches,
  responseLanguage,
}) {
  const history = getHistory(threadId);

  const inventoryForPrompt = inventoryMatches
    .slice(0, MAX_RESULTS_TO_SHOW)
    .map(compactPropertyForPrompt);

  if (!inventoryForPrompt.length) {
    return responseLanguage === "es"
      ? "No encontré opciones relevantes en el inventario con esos criterios. Si quieres, puedo ampliar la búsqueda con menos filtros."
      : "I couldn’t find relevant options in the inventory with those criteria. I can broaden the search if you'd like.";
  }

  const messages = [
    {
      role: "system",
      content: buildSystemPrompt(responseLanguage),
    },
    ...history,
    {
      role: "user",
      content: `
User request:
${userMessage}

Relevant inventory options:
${JSON.stringify(inventoryForPrompt, null, 2)}
      `.trim(),
    },
  ];

  const completion = await openai.chat.completions.create({
    model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
    temperature: 0.4,
    messages,
  });

  return completion.choices?.[0]?.message?.content?.trim() || "";
}

// ─────────────────────────────────────────────────────────────
// Lógica principal
// ─────────────────────────────────────────────────────────────
async function buildAssistantReply(userMessage, threadId) {
  const responseLanguage = detectRequestedLanguage(userMessage);
  const inventory = await fetchInventory();
  const matches = filterInventory(inventory, userMessage);

  let selected = matches.slice(0, MAX_RESULTS_TO_SHOW);

  if (!selected.length) {
    // fallback amplio por pax o ciudad
    const q = lower(userMessage);
    const numbers = extractNumericIntent(q);
    const requestedPax = numbers.length ? numbers[0] : null;

    selected = inventory
      .filter((p) => {
        if (requestedPax && p.maxPax < requestedPax) return false;
        if (q.includes("cartagena") && !lower(p.city).includes("cartagena")) return false;
        if ((q.includes("medellin") || q.includes("medellín")) && !lower(p.city).includes("medell")) return false;
        return true;
      })
      .sort((a, b) => {
        if (!requestedPax) return b.maxPax - a.maxPax;
        return Math.abs(a.maxPax - requestedPax) - Math.abs(b.maxPax - requestedPax);
      })
      .slice(0, MAX_RESULTS_TO_SHOW);
  }

  const aiReply = await generateReplyWithAI({
    userMessage,
    threadId,
    inventoryMatches: selected,
    responseLanguage,
  });

  if (!aiReply) {
    return responseLanguage === "es"
      ? "Hubo un problema generando la respuesta. Intenta de nuevo."
      : "There was a problem generating the reply. Please try again.";
  }

  return aiReply;
}

// ─────────────────────────────────────────────────────────────
// Slack handlers
// ─────────────────────────────────────────────────────────────
async function handleIncomingText({ text, threadId }) {
  const cleanText = normalizeText(text);
  if (!cleanText) return null;

  pushHistory(threadId, "user", cleanText);

  const reply = await buildAssistantReply(cleanText, threadId);

  pushHistory(threadId, "assistant", reply);

  return reply;
}

app.event("app_mention", async ({ event, say }) => {
  try {
    const threadId = event.thread_ts || event.ts;
    const text = normalizeText(event.text.replace(/<@[A-Z0-9]+>/g, "").trim());

    if (!text) {
      await say({
        text: "Hi! Ask me for villas, apartments, prices, neighborhoods, amenities, or guest capacity 🏝️",
        thread_ts: event.thread_ts || event.ts,
      });
      return;
    }

    const reply = await handleIncomingText({ text, threadId });

    await say({
      text: reply,
      thread_ts: event.thread_ts || event.ts,
    });
  } catch (error) {
    console.error("Error in app_mention:", error);
    await say({
      text: "There was an error processing your request. Please try again.",
      thread_ts: event.thread_ts || event.ts,
    });
  }
});

app.message(async ({ message, say }) => {
  if (message.subtype || message.bot_id) return;

  try {
    const threadId = message.thread_ts || message.ts;
    const text = normalizeText(message.text);

    if (!text) return;

    const reply = await handleIncomingText({ text, threadId });

    if (!reply) return;

    await say({
      text: reply,
      thread_ts: message.thread_ts || message.ts,
    });
  } catch (error) {
    console.error("Error in message handler:", error);
    await say({
      text: "There was an error processing your request. Please try again.",
      thread_ts: message.thread_ts || message.ts,
    });
  }
});

// ─────────────────────────────────────────────────────────────
// Health checks
// ─────────────────────────────────────────────────────────────
receiver.router.get("/", (_req, res) => {
  res.status(200).send("Two Travel Bot is running.");
});

receiver.router.get("/health", (_req, res) => {
  res.status(200).send("OK");
});

// ─────────────────────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────────────────────
(async () => {
  await app.start(PORT);
  console.log(`⚡ Two Travel Bot running on port ${PORT}`);
})();
