"use strict";

require("dotenv").config();
const { App, ExpressReceiver } = require("@slack/bolt");
const OpenAI = require("openai");

// ─────────────────────────────────────────────────────────────────────────────
// ENV / CONFIG
// ─────────────────────────────────────────────────────────────────────────────

const REQUIRED_ENV = [
  "SLACK_SIGNING_SECRET",
  "SLACK_BOT_TOKEN",
  "NOTION_API_KEY",
  "NOTION_DB_ID",
];

for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
}

const PORT = Number(process.env.PORT || 3000);
const NODE_ENV = process.env.NODE_ENV || "development";

const OPENAI_ENABLED = Boolean(process.env.OPENAI_API_KEY);
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";

const INVENTORY_CACHE_TTL_MS = Number(process.env.INVENTORY_CACHE_TTL_MS || 5 * 60 * 1000);
const MAX_NOTION_PAGE_SIZE = Math.min(Number(process.env.MAX_NOTION_PAGE_SIZE || 100), 100);
const THREAD_MEMORY_MAX_ITEMS = Math.max(Number(process.env.THREAD_MEMORY_MAX_ITEMS || 12), 6);
const DEFAULT_RESULT_COUNT = Math.min(Number(process.env.DEFAULT_RESULT_COUNT || 3), 10);
const MORE_RESULT_COUNT = Math.min(Number(process.env.MORE_RESULT_COUNT || 6), 12);

// ─────────────────────────────────────────────────────────────────────────────
// CLIENTS
// ─────────────────────────────────────────────────────────────────────────────

const openai = OPENAI_ENABLED
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  processBeforeResponse: true,
});

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver,
});

// ─────────────────────────────────────────────────────────────────────────────
// GLOBAL STATE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Thread state:
 * {
 *   history: [{ role: "user"|"assistant", content: string }],
 *   lastIntent: object | null,
 *   lastResults: Array<object>,
 *   shownIds: Set<string>
 * }
 */
const threadStore = new Map();

let inventoryCache = {
  fetchedAt: 0,
  data: [],
};

// ─────────────────────────────────────────────────────────────────────────────
// LOGGING
// ─────────────────────────────────────────────────────────────────────────────

function log(...args) {
  console.log(new Date().toISOString(), "-", ...args);
}

function logError(context, error) {
  console.error(new Date().toISOString(), "-", context, error?.stack || error);
}

// ─────────────────────────────────────────────────────────────────────────────
// BASIC HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function now() {
  return Date.now();
}

function normalizeText(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return normalizeText(value).toLowerCase();
}

function removeDiacritics(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function comparable(value) {
  return removeDiacritics(lower(value));
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function uniq(items) {
  return [...new Set(items)];
}

function safeNumber(value) {
  if (value === null || value === undefined || value === "") return null;

  if (typeof value === "number" && Number.isFinite(value)) return value;

  const raw = String(value).trim();
  if (!raw) return null;

  const normalized = raw.replace(/,/g, "");
  const num = Number(normalized);

  return Number.isFinite(num) ? num : null;
}

function isValidHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || "").trim());
}

function firstValidUrl(...values) {
  for (const value of values) {
    if (isValidHttpUrl(value)) return value;
  }
  return "";
}

function splitCsvLike(text) {
  return normalizeText(text)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function compactWhitespace(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function includesAny(text, options) {
  const t = comparable(text);
  return options.some((option) => t.includes(comparable(option)));
}

function parseBooleanLike(value) {
  const v = comparable(value);
  return ["yes", "true", "si", "sí", "available", "active"].includes(v);
}

function truncate(text, maxLen = 2900) {
  const s = String(text || "");
  return s.length <= maxLen ? s : `${s.slice(0, maxLen - 3)}...`;
}

// ─────────────────────────────────────────────────────────────────────────────
// THREAD MEMORY
// ─────────────────────────────────────────────────────────────────────────────

function getThreadState(threadId) {
  if (!threadStore.has(threadId)) {
    threadStore.set(threadId, {
      history: [],
      lastIntent: null,
      lastResults: [],
      shownIds: new Set(),
    });
  }
  return threadStore.get(threadId);
}

function pushHistory(threadId, role, content) {
  const state = getThreadState(threadId);

  state.history.push({
    role,
    content: String(content || ""),
  });

  if (state.history.length > THREAD_MEMORY_MAX_ITEMS) {
    state.history.splice(0, state.history.length - THREAD_MEMORY_MAX_ITEMS);
  }
}

function resetShownIds(threadId) {
  const state = getThreadState(threadId);
  state.shownIds = new Set();
}

// ─────────────────────────────────────────────────────────────────────────────
// LANGUAGE
// ─────────────────────────────────────────────────────────────────────────────

function inferLanguage(text) {
  const t = lower(text);

  if (
    includesAny(t, [
      "answer in english",
      "respond in english",
      "english please",
      "first language english",
      "primer idioma ingles",
      "primer idioma sea ingles",
      "please reply in english",
    ])
  ) {
    return "en";
  }

  if (
    includesAny(t, [
      "en español",
      "en espanol",
      "respond in spanish",
      "answer in spanish",
      "reply in spanish",
    ])
  ) {
    return "es";
  }

  const looksSpanish =
    /[áéíóúñ¿¡]/i.test(text) ||
    includesAny(t, [
      "hola",
      "quiero",
      "busco",
      "cartagena",
      "medellin",
      "piscina",
      "precio",
      "opciones",
      "personas",
      "habitaciones",
      "baños",
      "bano",
      "centro",
      "playa",
      "muéstrame",
      "muestrame",
      "más",
      "mas",
      "venue",
      "bodas",
      "boda",
      "lugar",
      "evento",
    ]);

  return looksSpanish ? "es" : "en";
}

function t(lang, es, en) {
  return lang === "es" ? es : en;
}

// ─────────────────────────────────────────────────────────────────────────────
// PARSE PRICE TEXT
// ─────────────────────────────────────────────────────────────────────────────

function parsePriceCandidates(text) {
  if (!text) return [];

  const raw = comparable(text);
  const matches = [...raw.matchAll(/(?:usd|cop|\$)?\s*([\d]{1,3}(?:[.,]\d{3})*(?:[.,]\d+)?|\d+(?:\.\d+)?)/g)];

  const numbers = matches
    .map((m) => m[1])
    .map((v) => v.replace(/\./g, "").replace(",", "."))
    .map(Number)
    .filter(Number.isFinite);

  return numbers;
}

function deriveComparablePrice(property) {
  const texts = [property.clientPrice, property.priceRange].filter(Boolean);

  for (const text of texts) {
    const nums = parsePriceCandidates(text);
    if (nums.length) {
      return Math.min(...nums);
    }
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// NOTION PROPERTY READER
// ─────────────────────────────────────────────────────────────────────────────

function getNotionValue(props, key) {
  const prop = props?.[key];
  if (!prop) return "";

  switch (prop.type) {
    case "title":
      return prop.title?.map((x) => x.plain_text).join("") || "";

    case "rich_text":
      return prop.rich_text?.map((x) => x.plain_text).join("") || "";

    case "select":
      return prop.select?.name || "";

    case "multi_select":
      return prop.multi_select?.map((x) => x.name).join(", ") || "";

    case "number":
      return prop.number ?? "";

    case "url":
      return prop.url || "";

    case "email":
      return prop.email || "";

    case "phone_number":
      return prop.phone_number || "";

    case "checkbox":
      return prop.checkbox ? "Yes" : "No";

    case "status":
      return prop.status?.name || "";

    case "formula":
      if (!prop.formula) return "";
      if (prop.formula.type === "string") return prop.formula.string || "";
      if (prop.formula.type === "number") return prop.formula.number ?? "";
      if (prop.formula.type === "boolean") return prop.formula.boolean ? "Yes" : "No";
      return "";

    default:
      return "";
  }
}

async function queryNotionPage(startCursor = null) {
  const response = await fetch(`https://api.notion.com/v1/databases/${process.env.NOTION_DB_ID}/query`, {
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

async function fetchAllNotionRows() {
  const results = [];
  let hasMore = true;
  let cursor = null;

  while (hasMore) {
    const data = await queryNotionPage(cursor);
    results.push(...toArray(data.results));
    hasMore = Boolean(data.has_more);
    cursor = data.next_cursor || null;
  }

  return results;
}

function normalizeProperty(page) {
  const props = page.properties || {};

  const property = {
    id: page.id,

    // Core
    name: normalizeText(getNotionValue(props, "Name")),
    itemType: normalizeText(getNotionValue(props, "Item Type")),
    city: normalizeText(getNotionValue(props, "City")),
    neighborhood: normalizeText(getNotionValue(props, "Neighborhood")),
    neighborhoodSummary: normalizeText(getNotionValue(props, "Neighborhood Summary")),
    location: normalizeText(getNotionValue(props, "Location")),

    // Capacity
    bedrooms: normalizeText(getNotionValue(props, "Bedrooms")),
    bathrooms: normalizeText(getNotionValue(props, "Bathrooms")),
    beds: normalizeText(getNotionValue(props, "Beds")),
    maxPax: safeNumber(getNotionValue(props, "Max Pax")) || 0,
    capacity: normalizeText(getNotionValue(props, "Capacity")),
    feet: normalizeText(getNotionValue(props, "Feet")),

    // Links
    photosLink: normalizeText(getNotionValue(props, "Photos Link")),
    airbnbLink: normalizeText(getNotionValue(props, "Airbnb Link")),
    twpTravelWebpage: normalizeText(getNotionValue(props, "Twp Travel Webpage")),

    // Pricing
    clientPrice: normalizeText(getNotionValue(props, "Client Price")),
    priceRange: normalizeText(getNotionValue(props, "Price Range")),

    // Contacts
    contactName: normalizeText(getNotionValue(props, "Contact Name")),
    contact: normalizeText(getNotionValue(props, "Contact")),
    contactPhone: normalizeText(getNotionValue(props, "Contact Phone")),

    // Content
    notes: normalizeText(getNotionValue(props, "Notes")),
    description: normalizeText(getNotionValue(props, "Description")),
    venueType: normalizeText(getNotionValue(props, "Venue Type")),
    amenities: normalizeText(getNotionValue(props, "Amenities")),
    cancellationPolicy: normalizeText(getNotionValue(props, "Cancellation Policy")),
    checkInTime: normalizeText(getNotionValue(props, "Check-in Time")),
    checkOutTime: normalizeText(getNotionValue(props, "Check-out Time")),
    status: normalizeText(getNotionValue(props, "Status")),

    notionPageUrl: page.url || "",
  };

  property.comparablePrice = deriveComparablePrice(property);

  property.searchBlob = comparable(
    [
      property.name,
      property.itemType,
      property.city,
      property.neighborhood,
      property.neighborhoodSummary,
      property.location,
      property.bedrooms,
      property.bathrooms,
      property.beds,
      property.maxPax,
      property.capacity,
      property.feet,
      property.clientPrice,
      property.priceRange,
      property.description,
      property.venueType,
      property.amenities,
      property.notes,
      property.status,
    ].join(" | ")
  );

  return property;
}

function isValidInventoryItem(property) {
  return Boolean(property.name);
}

async function getInventory({ forceRefresh = false } = {}) {
  if (
    !forceRefresh &&
    inventoryCache.data.length > 0 &&
    now() - inventoryCache.fetchedAt < INVENTORY_CACHE_TTL_MS
  ) {
    return inventoryCache.data;
  }

  const rows = await fetchAllNotionRows();
  const inventory = rows.map(normalizeProperty).filter(isValidInventoryItem);

  inventoryCache = {
    fetchedAt: now(),
    data: inventory,
  };

  log(`Inventory refreshed with ${inventory.length} items.`);
  return inventory;
}

// ─────────────────────────────────────────────────────────────────────────────
// INTENT DETECTION
// ─────────────────────────────────────────────────────────────────────────────

function extractFirstInteger(text) {
  const match = String(text || "").match(/\b(\d{1,3})\b/);
  if (!match) return null;

  const num = Number(match[1]);
  return Number.isFinite(num) ? num : null;
}

function extractBedroomsIntent(text) {
  const t = comparable(text);

  const match =
    t.match(/\b(\d+)\s*(bedroom|bedrooms|br)\b/) ||
    t.match(/\b(\d+)\s*(habitacion|habitaciones|hab)\b/) ||
    t.match(/\bwith\s+(\d+)\s*(bedroom|bedrooms)\b/) ||
    t.match(/\bde\s+(\d+)\s*(habitacion|habitaciones)\b/);

  if (!match) return null;

  const num = Number(match[1]);
  return Number.isFinite(num) ? num : null;
}

function extractBathroomsIntent(text) {
  const t = comparable(text);

  const match =
    t.match(/\b(\d+)\s*(bathroom|bathrooms|bath)\b/) ||
    t.match(/\b(\d+)\s*(bano|banos|baño|baños)\b/);

  if (!match) return null;

  const num = Number(match[1]);
  return Number.isFinite(num) ? num : null;
}

function extractBudgetIntent(text) {
  const t = comparable(text);

  const match =
    t.match(/\b(?:under|below|less than|max|hasta|menos de)\s*\$?\s*([\d.,]+)\s*(usd|cop)?\b/) ||
    t.match(/\b\$([\d.,]+)\s*(usd|cop)?\b/);

  if (!match) return null;

  const amount = Number(String(match[1]).replace(/,/g, ""));
  if (!Number.isFinite(amount)) return null;

  return {
    max: amount,
    currency: (match[2] || "").toUpperCase() || null,
  };
}

function detectItemTypeHints(text) {
  const t = comparable(text);

  return {
    wantsVilla: includesAny(t, ["villa", "villas"]),
    wantsHouse: includesAny(t, ["house", "home", "casa", "casa completa"]),
    wantsApartment: includesAny(t, ["apartment", "apartamento", "apt", "condo"]),
    wantsHotel: includesAny(t, ["hotel", "suite", "room"]),
    wantsWeddingVenue: includesAny(t, ["wedding venue", "wedding", "venue", "boda", "bodas", "evento", "event venue"]),
    wantsBoat: includesAny(t, ["boat", "yacht", "catamaran", "catamaran", "bote", "lancha"]),
    wantsExperience: includesAny(t, ["tour", "experience", "activity", "actividad", "plan"]),
  };
}

function detectLocationHints(text) {
  const t = comparable(text);

  const wantsHistoricCenter = includesAny(t, [
    "historic center",
    "old city",
    "walled city",
    "centro historico",
    "centro histórico",
    "centro",
  ]);

  let city = null;

  if (includesAny(t, ["cartagena"])) city = "cartagena";
  if (includesAny(t, ["medellin", "medellín"])) city = "medellin";
  if (includesAny(t, ["bogota", "bogotá"])) city = "bogota";
  if (includesAny(t, ["tulum"])) city = "tulum";
  if (includesAny(t, ["mexico city", "cdmx", "ciudad de mexico", "ciudad de méxico"])) city = "mexico city";

  return {
    city,
    wantsHistoricCenter,
  };
}

function detectAmenityHints(text) {
  const t = comparable(text);

  return {
    wantsPool: includesAny(t, ["pool", "piscina"]),
    wantsPrivatePool: includesAny(t, ["private pool", "piscina privada"]),
    wantsBeach: includesAny(t, ["beach", "playa"]),
    wantsBeachfront: includesAny(t, ["beachfront", "frente al mar", "oceanfront", "sea view", "ocean view"]),
    wantsPetFriendly: includesAny(t, ["pet friendly", "pets", "dog", "cat", "mascotas"]),
    wantsLuxury: includesAny(t, ["luxury", "premium", "high end", "lujo"]),
    wantsCheap: includesAny(t, ["cheap", "budget", "economical", "económico", "economico"]),
  };
}

function isMoreRequest(text) {
  return includesAny(text, [
    "show more",
    "more options",
    "other options",
    "show me more",
    "more",
    "mas opciones",
    "más opciones",
    "otras opciones",
    "muestrame mas",
    "muéstrame más",
    "mas",
    "más",
    "siguientes",
  ]);
}

function isResetRequest(text) {
  return includesAny(text, [
    "start over",
    "reset",
    "new search",
    "otra busqueda",
    "otra búsqueda",
    "empezar de nuevo",
    "nueva búsqueda",
  ]);
}

function buildIntent(userText, previousIntent = null) {
  const lang = inferLanguage(userText);
  const itemTypeHints = detectItemTypeHints(userText);
  const locationHints = detectLocationHints(userText);
  const amenityHints = detectAmenityHints(userText);

  const intent = {
    language: lang,

    city: locationHints.city,
    wantsHistoricCenter: locationHints.wantsHistoricCenter,

    ...itemTypeHints,
    ...amenityHints,

    wantedPax: extractFirstInteger(userText),
    wantedBedrooms: extractBedroomsIntent(userText),
    wantedBathrooms: extractBathroomsIntent(userText),
    budget: extractBudgetIntent(userText),

    requestMore: isMoreRequest(userText),
    requestReset: isResetRequest(userText),

    rawText: userText,
  };

  // Inherit context on follow-ups
  if (previousIntent && intent.requestMore) {
    intent.city = intent.city || previousIntent.city || null;
    intent.wantsHistoricCenter = intent.wantsHistoricCenter || previousIntent.wantsHistoricCenter || false;

    intent.wantsVilla = intent.wantsVilla || previousIntent.wantsVilla || false;
    intent.wantsHouse = intent.wantsHouse || previousIntent.wantsHouse || false;
    intent.wantsApartment = intent.wantsApartment || previousIntent.wantsApartment || false;
    intent.wantsHotel = intent.wantsHotel || previousIntent.wantsHotel || false;
    intent.wantsWeddingVenue = intent.wantsWeddingVenue || previousIntent.wantsWeddingVenue || false;
    intent.wantsBoat = intent.wantsBoat || previousIntent.wantsBoat || false;
    intent.wantsExperience = intent.wantsExperience || previousIntent.wantsExperience || false;

    intent.wantsPool = intent.wantsPool || previousIntent.wantsPool || false;
    intent.wantsPrivatePool = intent.wantsPrivatePool || previousIntent.wantsPrivatePool || false;
    intent.wantsBeach = intent.wantsBeach || previousIntent.wantsBeach || false;
    intent.wantsBeachfront = intent.wantsBeachfront || previousIntent.wantsBeachfront || false;
    intent.wantsPetFriendly = intent.wantsPetFriendly || previousIntent.wantsPetFriendly || false;
    intent.wantsLuxury = intent.wantsLuxury || previousIntent.wantsLuxury || false;
    intent.wantsCheap = intent.wantsCheap || previousIntent.wantsCheap || false;

    intent.wantedPax = intent.wantedPax || previousIntent.wantedPax || null;
    intent.wantedBedrooms = intent.wantedBedrooms || previousIntent.wantedBedrooms || null;
    intent.wantedBathrooms = intent.wantedBathrooms || previousIntent.wantedBathrooms || null;
    intent.budget = intent.budget || previousIntent.budget || null;
  }

  return intent;
}

// ─────────────────────────────────────────────────────────────────────────────
// SCORING
// ─────────────────────────────────────────────────────────────────────────────

function scoreByCity(property, intent) {
  if (!intent.city) return 0;

  const city = comparable(property.city);
  const blob = property.searchBlob;

  if (city.includes(intent.city) || blob.includes(intent.city)) return 20;
  return -14;
}

function scoreByHistoricCenter(property, intent) {
  if (!intent.wantsHistoricCenter) return 0;

  const neighborhood = comparable(property.neighborhood);
  const blob = property.searchBlob;

  if (
    includesAny(neighborhood, ["centro", "historic", "old city", "walled"]) ||
    includesAny(blob, ["historic center", "old city", "walled city", "centro historico"])
  ) {
    return 15;
  }

  return -5;
}

function scoreByItemType(property, intent) {
  const itemType = comparable(property.itemType);
  const venueType = comparable(property.venueType);
  let score = 0;

  if (intent.wantsVilla) {
    if (includesAny(itemType, ["villa", "house", "casa"])) score += 12;
    else score -= 5;
  }

  if (intent.wantsHouse) {
    if (includesAny(itemType, ["house", "casa", "home"])) score += 10;
    else score -= 4;
  }

  if (intent.wantsApartment) {
    if (includesAny(itemType, ["apartment", "apart", "condo"])) score += 10;
    else score -= 4;
  }

  if (intent.wantsHotel) {
    if (includesAny(itemType, ["hotel", "suite", "room"])) score += 10;
    else score -= 4;
  }

  if (intent.wantsWeddingVenue) {
    if (
      includesAny(itemType, ["wedding venue", "venue"]) ||
      includesAny(venueType, ["wedding", "event", "venue"])
    ) {
      score += 15;
    } else {
      score -= 5;
    }
  }

  if (intent.wantsBoat) {
    if (includesAny(itemType, ["boat", "yacht", "catamaran", "catamarán", "lancha"])) {
      score += 12;
    } else {
      score -= 4;
    }
  }

  if (intent.wantsExperience) {
    if (includesAny(itemType, ["tour", "experience", "activity"])) {
      score += 10;
    } else {
      score -= 4;
    }
  }

  return score;
}

function scoreByCapacity(property, intent) {
  let score = 0;

  if (intent.wantedPax) {
    if (property.maxPax >= intent.wantedPax) {
      score += 20;
      const diff = Math.abs(property.maxPax - intent.wantedPax);

      if (diff === 0) score += 8;
      else if (diff <= 2) score += 5;
      else if (diff <= 4) score += 3;
      else if (diff <= 8) score += 1;
    } else {
      score -= 20;
    }
  }

  if (intent.wantedBedrooms) {
    const bedrooms = safeNumber(property.bedrooms);

    if (bedrooms !== null) {
      if (bedrooms >= intent.wantedBedrooms) score += 8;
      else score -= 6;
    }
  }

  if (intent.wantedBathrooms) {
    const bathrooms = safeNumber(property.bathrooms);

    if (bathrooms !== null) {
      if (bathrooms >= intent.wantedBathrooms) score += 6;
      else score -= 4;
    }
  }

  return score;
}

function scoreByAmenities(property, intent) {
  const blob = property.searchBlob;
  let score = 0;

  if (intent.wantsPool) {
    if (includesAny(blob, ["pool", "piscina"])) score += 12;
    else score -= 6;
  }

  if (intent.wantsPrivatePool) {
    if (includesAny(blob, ["private pool", "piscina privada"])) score += 8;
  }

  if (intent.wantsBeach) {
    if (includesAny(blob, ["beach", "playa", "ocean", "sea"])) score += 8;
  }

  if (intent.wantsBeachfront) {
    if (includesAny(blob, ["beachfront", "frente al mar", "oceanfront", "sea view", "ocean view"])) {
      score += 8;
    }
  }

  if (intent.wantsPetFriendly) {
    if (includesAny(blob, ["pet friendly", "pets", "mascotas"])) score += 5;
  }

  if (intent.wantsLuxury) {
    if (includesAny(blob, ["luxury", "lujo", "premium", "high end"])) score += 5;
  }

  return score;
}

function scoreByBudget(property, intent) {
  if (!intent.budget?.max) return 0;
  if (!property.comparablePrice) return 0;

  if (property.comparablePrice <= intent.budget.max) return 8;

  const overBy = property.comparablePrice - intent.budget.max;
  if (overBy <= intent.budget.max * 0.15) return -2;
  return -8;
}

function scoreByCompleteness(property) {
  let score = 0;
  if (property.twpTravelWebpage) score += 2;
  if (property.airbnbLink) score += 1;
  if (property.photosLink) score += 1;
  if (property.description) score += 1;
  if (property.amenities) score += 1;
  if (property.clientPrice || property.priceRange) score += 1;
  return score;
}

function totalScore(property, intent) {
  return (
    scoreByCity(property, intent) +
    scoreByHistoricCenter(property, intent) +
    scoreByItemType(property, intent) +
    scoreByCapacity(property, intent) +
    scoreByAmenities(property, intent) +
    scoreByBudget(property, intent) +
    scoreByCompleteness(property)
  );
}

function rankInventory(inventory, intent) {
  return inventory
    .map((property) => ({
      property,
      score: totalScore(property, intent),
    }))
    .filter((entry) => entry.score > -10)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;

      // smaller capacity delta preferred when pax requested
      if (intent.wantedPax) {
        const deltaA = Math.abs((a.property.maxPax || 999) - intent.wantedPax);
        const deltaB = Math.abs((b.property.maxPax || 999) - intent.wantedPax);
        if (deltaA !== deltaB) return deltaA - deltaB;
      }

      return a.property.name.localeCompare(b.property.name);
    })
    .map((entry) => entry.property);
}

function broadenIfNeeded(inventory, results, intent) {
  if (results.length >= DEFAULT_RESULT_COUNT) return results;

  const broader = inventory.filter((property) => {
    if (intent.city && !comparable(property.city).includes(intent.city)) return false;
    if (intent.wantedPax && property.maxPax && property.maxPax < intent.wantedPax) return false;
    return true;
  });

  return broader.length ? broader : results;
}

// ─────────────────────────────────────────────────────────────────────────────
// DISPLAY HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function formatField(value, lang) {
  return normalizeText(value) || t(lang, "No especificado", "Not specified");
}

function formatAmenities(amenities, lang, maxItems = 5) {
  const items = splitCsvLike(amenities).slice(0, maxItems);
  if (!items.length) return t(lang, "No especificados", "Not specified");
  return items.join(", ");
}

function bestPublicLink(property) {
  return firstValidUrl(
    property.twpTravelWebpage,
    property.airbnbLink,
    property.photosLink
  );
}

function formatPropertySummary(property, lang) {
  const location = [property.neighborhood, property.city].filter(Boolean).join(", ");
  const link = bestPublicLink(property);
  const price = formatField(property.clientPrice || property.priceRange, lang);

  if (lang === "es") {
    return [
      `*${property.name}*`,
      location ? `Ubicación: ${location}` : null,
      `Tipo: ${formatField(property.itemType, lang)}`,
      `Habitaciones: ${formatField(property.bedrooms, lang)} | Baños: ${formatField(property.bathrooms, lang)} | Capacidad: ${property.maxPax || "No especificado"}`,
      `Amenities: ${formatAmenities(property.amenities, lang)}`,
      `Precio: ${price}`,
      link ? `Link: ${link}` : `Link: No disponible`,
    ]
      .filter(Boolean)
      .join("\n");
  }

  return [
    `*${property.name}*`,
    location ? `Location: ${location}` : null,
    `Type: ${formatField(property.itemType, lang)}`,
    `Bedrooms: ${formatField(property.bedrooms, lang)} | Bathrooms: ${formatField(property.bathrooms, lang)} | Capacity: ${property.maxPax || "Not specified"}`,
    `Amenities: ${formatAmenities(property.amenities, lang)}`,
    `Price: ${price}`,
    link ? `Link: ${link}` : `Link: Not available`,
  ]
    .filter(Boolean)
    .join("\n");
}

function buildPlainFallbackReply(lang, results) {
  if (!results.length) {
    return t(
      lang,
      "No encontré opciones relevantes con esos criterios en el inventario actual. Si quieres, puedo ampliar la búsqueda con menos filtros.",
      "I couldn’t find relevant options with those criteria in the current inventory. I can broaden the search if you'd like."
    );
  }

  const intro = t(
    lang,
    "Estas son algunas opciones reales del inventario que podrían servirte:",
    "Here are a few real inventory options that could be a good fit:"
  );

  const body = results.map((property) => formatPropertySummary(property, lang)).join("\n\n");

  const outro = t(
    lang,
    "Si quieres, puedo mostrarte más opciones o afinar la búsqueda.",
    "If you'd like, I can show more options or refine the search."
  );

  return `${intro}\n\n${body}\n\n${outro}`;
}

function compactPropertiesForModel(results) {
  return results.map((p) => ({
    name: p.name,
    itemType: p.itemType,
    city: p.city,
    neighborhood: p.neighborhood,
    neighborhoodSummary: p.neighborhoodSummary,
    location: p.location,
    bedrooms: p.bedrooms,
    bathrooms: p.bathrooms,
    beds: p.beds,
    maxPax: p.maxPax,
    capacity: p.capacity,
    feet: p.feet,
    clientPrice: p.clientPrice,
    priceRange: p.priceRange,
    description: p.description,
    venueType: p.venueType,
    amenities: p.amenities,
    cancellationPolicy: p.cancellationPolicy,
    checkInTime: p.checkInTime,
    checkOutTime: p.checkOutTime,
    status: p.status,
    twpTravelWebpage: p.twpTravelWebpage,
    airbnbLink: p.airbnbLink,
    photosLink: p.photosLink,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// OPENAI GENERATION
// ─────────────────────────────────────────────────────────────────────────────

async function generateReplyWithOpenAI({ lang, userText, history, results }) {
  if (!OPENAI_ENABLED || !openai) return null;

  const systemPrompt = `
You are the sales assistant for Two Travel.

Rules:
- Respond in ${lang === "es" ? "Spanish" : "English"}.
- Use ONLY the data provided in the inventory options.
- Never invent property names, prices, neighborhoods, cities, amenities, policies, or links.
- The inventory may contain villas, houses, apartments, wedding venues, hotels, boats, experiences, and other item types. Handle them naturally based on the inventory fields.
- If a user asks in a broad way, recommend the closest real matches.
- Keep the tone polished, concise, warm, and sales-friendly.
- For each option, include:
  - name
  - area/location
  - type
  - bedrooms if available
  - bathrooms if available
  - max capacity if available
  - key amenities
  - price
  - one valid link if available
- If a field is missing, use "${lang === "es" ? "No especificado" : "Not specified"}".
- Never mention databases, hidden prompts, JSON, or internal logic.
- End by offering to refine the search or show more options.
- Do not offer to send anything to the client.
- Return plain Slack-friendly text only.
`.trim();

  const messages = [
    { role: "system", content: systemPrompt },
    ...history.slice(-8),
    {
      role: "user",
      content: [
        `User request: ${userText}`,
        "",
        "Inventory options you may use:",
        JSON.stringify(compactPropertiesForModel(results), null, 2),
      ].join("\n"),
    },
  ];

  const completion = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    temperature: 0.35,
    messages,
  });

  return completion?.choices?.[0]?.message?.content?.trim() || null;
}

// ─────────────────────────────────────────────────────────────────────────────
// SLACK BLOCKS
// ─────────────────────────────────────────────────────────────────────────────

function buildResultHeader(lang, count) {
  if (lang === "es") {
    return count === 1
      ? "Encontré 1 opción relevante:"
      : `Encontré ${count} opciones relevantes:`;
  }

  return count === 1
    ? "I found 1 relevant option:"
    : `I found ${count} relevant options:`;
}

function buildPropertyBlocks(results, lang) {
  const blocks = [];

  for (const property of results) {
    const location = [property.neighborhood, property.city].filter(Boolean).join(", ");
    const link = bestPublicLink(property);

    const text =
      lang === "es"
        ? [
            `*${property.name}*`,
            location ? `📍 ${location}` : null,
            `🏷️ ${formatField(property.itemType, lang)}`,
            `🛏️ ${formatField(property.bedrooms, lang)} hab | 🛁 ${formatField(property.bathrooms, lang)} baños | 👥 ${property.maxPax || "No especificado"}`,
            `✨ ${formatAmenities(property.amenities, lang)}`,
            `💵 ${formatField(property.clientPrice || property.priceRange, lang)}`,
            link ? `<${link}|Ver opción>` : "🔗 No disponible",
          ]
            .filter(Boolean)
            .join("\n")
        : [
            `*${property.name}*`,
            location ? `📍 ${location}` : null,
            `🏷️ ${formatField(property.itemType, lang)}`,
            `🛏️ ${formatField(property.bedrooms, lang)} beds | 🛁 ${formatField(property.bathrooms, lang)} baths | 👥 ${property.maxPax || "Not specified"}`,
            `✨ ${formatAmenities(property.amenities, lang)}`,
            `💵 ${formatField(property.clientPrice || property.priceRange, lang)}`,
            link ? `<${link}|View option>` : "🔗 Not available",
          ]
            .filter(Boolean)
            .join("\n");

    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: truncate(text, 2900),
      },
    });

    blocks.push({ type: "divider" });
  }

  if (blocks.length && blocks[blocks.length - 1].type === "divider") {
    blocks.pop();
  }

  return blocks;
}

function buildSlackBlocks({ lang, results, fallbackText }) {
  if (!results.length) {
    return [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: fallbackText,
        },
      },
    ];
  }

  return [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: buildResultHeader(lang, results.length),
        emoji: true,
      },
    },
    ...buildPropertyBlocks(results, lang),
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: t(
            lang,
            "Puedo mostrarte más opciones o afinar la búsqueda.",
            "I can show more options or refine the search."
          ),
        },
      ],
    },
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// QUERY FLOW
// ─────────────────────────────────────────────────────────────────────────────

function sliceNewResults(results, shownIds, count) {
  const unseen = results.filter((item) => !shownIds.has(item.id));
  return unseen.slice(0, count);
}

async function searchInventoryForUserMessage(userText, threadId) {
  const state = getThreadState(threadId);

  if (isResetRequest(userText)) {
    state.lastIntent = null;
    state.lastResults = [];
    resetShownIds(threadId);
  }

  const inventory = await getInventory();
  const intent = buildIntent(userText, state.lastIntent);

  let ranked = rankInventory(inventory, intent);
  ranked = broadenIfNeeded(inventory, ranked, intent);

  const resultCount = intent.requestMore ? MORE_RESULT_COUNT : DEFAULT_RESULT_COUNT;

  let selected = [];

  if (intent.requestMore && state.lastResults.length) {
    const followUpPool = ranked.length ? ranked : state.lastResults;
    selected = sliceNewResults(followUpPool, state.shownIds, resultCount);

    if (!selected.length) {
      // If all were shown, reset shown set and show next best batch again
      resetShownIds(threadId);
      selected = sliceNewResults(followUpPool, state.shownIds, resultCount);
    }
  } else {
    selected = ranked.slice(0, resultCount);
    resetShownIds(threadId);
  }

  for (const item of selected) {
    state.shownIds.add(item.id);
  }

  state.lastIntent = intent;
  state.lastResults = ranked;

  return {
    intent,
    results: selected,
    rankedResults: ranked,
  };
}

async function buildReply(userText, threadId) {
  const state = getThreadState(threadId);
  const lang = inferLanguage(userText);

  pushHistory(threadId, "user", userText);

  const { results } = await searchInventoryForUserMessage(userText, threadId);

  let replyText = null;

  try {
    replyText = await generateReplyWithOpenAI({
      lang,
      userText,
      history: state.history,
      results,
    });
  } catch (error) {
    logError("OpenAI generation failed", error);
  }

  if (!replyText) {
    replyText = buildPlainFallbackReply(lang, results);
  }

  pushHistory(threadId, "assistant", replyText);

  return {
    lang,
    text: replyText,
    blocks: buildSlackBlocks({
      lang,
      results,
      fallbackText: replyText,
    }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SLACK HANDLERS
// ─────────────────────────────────────────────────────────────────────────────

function cleanSlackMentionText(text) {
  return normalizeText(String(text || "").replace(/<@[A-Z0-9]+>/g, "").trim());
}

async function sendReply({ say, threadTs, reply }) {
  try {
    await say({
      text: truncate(reply.text, 4000),
      blocks: reply.blocks,
      thread_ts: threadTs,
    });
  } catch (error) {
    logError("Failed to send blocks, falling back to text only", error);

    await say({
      text: truncate(reply.text, 4000),
      thread_ts: threadTs,
    });
  }
}

app.event("app_mention", async ({ event, say }) => {
  const threadId = event.thread_ts || event.ts;
  const threadTs = event.thread_ts || event.ts;

  try {
    const text = cleanSlackMentionText(event.text);

    if (!text) {
      await say({
        text: "Hi! Ask me about properties, venues, boats, pricing, neighborhoods, amenities, or guest capacity 🏝️",
        thread_ts: threadTs,
      });
      return;
    }

    const reply = await buildReply(text, threadId);
    await sendReply({ say, threadTs, reply });
  } catch (error) {
    logError("app_mention handler error", error);

    await say({
      text: "There was an error processing your request. Please try again.",
      thread_ts: threadTs,
    });
  }
});

app.message(async ({ message, say }) => {
  if (message.subtype || message.bot_id) return;

  const threadId = message.thread_ts || message.ts;
  const threadTs = message.thread_ts || message.ts;

  try {
    const text = normalizeText(message.text);
    if (!text) return;

    const reply = await buildReply(text, threadId);
    await sendReply({ say, threadTs, reply });
  } catch (error) {
    logError("message handler error", error);

    await say({
      text: "There was an error processing your request. Please try again.",
      thread_ts: threadTs,
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// HEALTH / DEBUG ROUTES
// ─────────────────────────────────────────────────────────────────────────────

receiver.router.get("/", (_req, res) => {
  res.status(200).send("Two Travel sales bot is running.");
});

receiver.router.get("/health", (_req, res) => {
  res.status(200).send("OK");
});

receiver.router.get("/debug/cache", async (_req, res) => {
  try {
    const inventory = await getInventory();
    res.status(200).json({
      ok: true,
      cached: now() - inventoryCache.fetchedAt < INVENTORY_CACHE_TTL_MS,
      fetchedAt: inventoryCache.fetchedAt,
      count: inventory.length,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: String(error?.message || error),
    });
  }
});

receiver.router.post("/debug/refresh", async (_req, res) => {
  try {
    const inventory = await getInventory({ forceRefresh: true });
    res.status(200).json({
      ok: true,
      count: inventory.length,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: String(error?.message || error),
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────────────────────────────────

(async () => {
  await app.start(PORT);
  log(`⚡ Two Travel sales bot running on port ${PORT} (${NODE_ENV})`);
})();
