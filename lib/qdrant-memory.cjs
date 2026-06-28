// qdrant-memory.cjs — extracted from server.js
// Qdrant vector memory for Sentuh Rasa: customer preferences, conversation
// history, product knowledge, admin-validated training data.
// Fail-open: if QDRANT_URL is not set, all functions become no-ops.

'use strict';

const https = require("https");
const http = require("http");

// ── Config (from env) ──────────────────────────────────────────────

const SBSR_QDRANT_URL = String(process.env.SBSR_QDRANT_URL || process.env.QDRANT_URL || "").trim().replace(/\/+$/, "");
const SBSR_QDRANT_API_KEY = String(process.env.SBSR_QDRANT_API_KEY || process.env.QDRANT_API_KEY || "").trim();
const SBSR_MEMORY_ENABLED = process.env.SBSR_MEMORY_ENABLED !== "0";
const SBSR_MEMORY_COLLECTIONS = {
  customer: "sbsr_customer_memory",
  conversation: "sbsr_conversation_memory",
  product: "sbsr_product_knowledge",
  training: "sbsr_admin_validated_training_data",
};
const sbsrQdrantCollectionReady = new Set();

// ── Injected logger ────────────────────────────────────────────────
let _log = function(tag, msg) { console.log(JSON.stringify({ ts: new Date().toISOString(), level: "info", tag, msg })); };
function init(logFn) { if (typeof logFn === "function") _log = logFn; }

// ── Core helpers ───────────────────────────────────────────────────

function sbsrMemoryEnabled() {
  return SBSR_MEMORY_ENABLED && !!SBSR_QDRANT_URL;
}

function sbsrQdrantHeaders() {
  const h = { "Content-Type": "application/json" };
  if (SBSR_QDRANT_API_KEY) h["api-key"] = SBSR_QDRANT_API_KEY;
  return h;
}

function sbsrQdrantFetch(method, endpoint, payload, timeoutMs = 5000) {
  return new Promise((resolve) => {
    if (!sbsrMemoryEnabled()) return resolve({ ok: false, status: 0, json: null });
    const u = new URL(SBSR_QDRANT_URL + endpoint);
    const body = payload ? JSON.stringify(payload) : null;
    const mod = u.protocol === "https:" ? https : http;
    const req = mod.request({
      method,
      hostname: u.hostname,
      port: u.port || (u.protocol === "https:" ? 443 : 80),
      path: u.pathname + (u.search || ""),
      headers: { ...sbsrQdrantHeaders(), "Content-Length": body ? Buffer.byteLength(body) : 0 },
      timeout: timeoutMs,
    }, (res) => {
      let data = "";
      res.on("data", (c) => { data += c; });
      res.on("end", () => {
        let json = null;
        try { json = data ? JSON.parse(data) : null; } catch (_) {}
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode || 0, json });
      });
    });
    req.on("timeout", () => { try { req.destroy(); } catch (_) {} resolve({ ok: false, status: 0, json: null }); });
    req.on("error", () => resolve({ ok: false, status: 0, json: null }));
    if (body) req.write(body);
    req.end();
  });
}

async function sbsrEnsureCollection(name) {
  if (!sbsrMemoryEnabled() || sbsrQdrantCollectionReady.has(name)) return;
  const getRes = await sbsrQdrantFetch("GET", `/collections/${encodeURIComponent(name)}`, null, 4000);
  if (!getRes.ok) {
    await sbsrQdrantFetch("PUT", `/collections/${encodeURIComponent(name)}`, {
      vectors: { size: 384, distance: "Cosine" },
    }, 4000);
  }
  sbsrQdrantCollectionReady.add(name);
}

function sbsrTinyVector(text) {
  const s = String(text || "");
  let a = 0, b = 0, c = 0, d = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    a = (a + ch) % 9973;
    b = (b + ch * (i + 1)) % 9967;
    c = (c + (ch % 13)) % 9949;
    d = (d + (ch % 29)) % 9923;
  }
  return [a / 9973, b / 9967, c / 9949, d / 9923];
}

function sbsrNewPointId(prefix = "m") {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

async function sbsrUpsertMemory(collection, payload, pointId) {
  if (!sbsrMemoryEnabled()) return false;
  await sbsrEnsureCollection(collection);
  const text = JSON.stringify(payload || {});
  const res = await sbsrQdrantFetch("PUT", `/collections/${encodeURIComponent(collection)}/points`, {
    points: [{ id: pointId || sbsrNewPointId("sbsr"), vector: sbsrTinyVector(text), payload }],
  }, 5000);
  return !!res.ok;
}

async function sbsrScrollMemory(collection, filter, limit = 8) {
  if (!sbsrMemoryEnabled()) return [];
  await sbsrEnsureCollection(collection);
  const res = await sbsrQdrantFetch("POST", `/collections/${encodeURIComponent(collection)}/points/scroll`, {
    limit,
    with_payload: true,
    with_vector: false,
    filter,
  }, 5000);
  return Array.isArray(res?.json?.result?.points) ? res.json.result.points : [];
}

function sbsrNormalizeText(v) {
  return String(v || "").toLowerCase().trim();
}

function sbsrExtractStructuredMemory(customerId, userText, draft = {}) {
  const t = sbsrNormalizeText(userText);
  const out = [];
  const createdAt = new Date().toISOString();
  const pushMem = (type, value, confidence = 0.75, source = "chat") => {
    out.push({ customer_id: customerId, type, value, confidence, source, created_at: createdAt });
  };
  if (/\b(gak suka pedas|tidak suka pedas|ga suka pedas|nggak suka pedas)\b/.test(t)) pushMem("taste_preference", "tidak_suka_pedas", 0.9);
  if (/\b(suka pedas|pedas banget|extra pedas)\b/.test(t)) pushMem("taste_preference", "suka_pedas", 0.85);
  if (/\b(alergi|alergy|allergy)\b/.test(t)) pushMem("allergy_note", userText.slice(0, 140), 0.9);
  if (/\b(frozen|stock frozen)\b/.test(t)) pushMem("preferred_product", "frozen_mix", 0.8);
  if (/\b(goreng|makan langsung)\b/.test(t)) pushMem("preferred_product", "goreng", 0.75);
  if (/\b(gojek|gosend)\b/.test(t)) pushMem("delivery_preference", "gojek", 0.7);
  if (/\b(paxel)\b/.test(t)) pushMem("delivery_preference", "paxel", 0.7);
  if (/\b(kecewa|komplain|complain|refund)\b/.test(t)) pushMem("complaint_signal", userText.slice(0, 160), 0.8);
  if (draft?.address_text && draft.address_text.length > 12) pushMem("favorite_address_hint", draft.address_text.slice(0, 180), 0.55, "state");
  return out;
}

async function sbsrRetrieveMemoryContext(customerId, userText) {
  if (!sbsrMemoryEnabled()) return "";
  try {
    const mustPhone = [{ key: "customer_id", match: { value: customerId } }];
    const [customerRows, convoRows, productRows, trainRows] = await Promise.all([
      sbsrScrollMemory(SBSR_MEMORY_COLLECTIONS.customer, { must: mustPhone }, 8),
      sbsrScrollMemory(SBSR_MEMORY_COLLECTIONS.conversation, { must: mustPhone }, 6),
      sbsrScrollMemory(SBSR_MEMORY_COLLECTIONS.product, null, 6),
      sbsrScrollMemory(SBSR_MEMORY_COLLECTIONS.training, null, 4),
    ]);
    const compact = (rows) => rows.map((r) => r?.payload).filter(Boolean).slice(0, 8);
    const payload = {
      customer_memory: compact(customerRows),
      recent_conversation_memory: compact(convoRows),
      product_knowledge: compact(productRows),
      admin_validated_knowledge: compact(trainRows),
      user_text: userText,
    };
    _log("sbsr-memory", "retrieved");
    return JSON.stringify(payload, null, 2);
  } catch (e) {
    _log("sbsr-memory", "retrieve err: " + e.message);
    return "";
  }
}

async function sbsrStoreExtractedMemories(customerId, userText, aiReply, draft = {}) {
  if (!sbsrMemoryEnabled()) return;
  try {
    const extracted = sbsrExtractStructuredMemory(customerId, userText, draft);
    if (extracted.length) _log("sbsr-memory", "extracted");
    for (const mem of extracted) {
      await sbsrUpsertMemory(SBSR_MEMORY_COLLECTIONS.customer, mem, sbsrNewPointId("cust"));
      _log("sbsr-memory", "stored_qdrant");
    }
    const convoPayload = {
      customer_id: customerId,
      type: "conversation_turn",
      input: String(userText || "").slice(0, 400),
      output: String(aiReply || "").slice(0, 400),
      created_at: new Date().toISOString(),
    };
    await sbsrUpsertMemory(SBSR_MEMORY_COLLECTIONS.conversation, convoPayload, sbsrNewPointId("conv"));
  } catch (e) {
    _log("sbsr-memory", "store err: " + e.message);
  }
}

async function sbsrStoreAdminTrainingData(entry = {}) {
  if (!sbsrMemoryEnabled()) return false;
  const payload = {
    type: "admin_validated",
    customer_id: String(entry.phone || "").replace(/[^0-9]/g, ""),
    verdict: entry.verdict || "corrected",
    input_context: String(entry.input_context || "").slice(0, 1200),
    bad_response: String(entry.bad_response || "").slice(0, 1200),
    corrected_response: String(entry.corrected_response || "").slice(0, 1200),
    use_case: String(entry.use_case || "").slice(0, 120),
    created_at: new Date().toISOString(),
  };
  const ok = await sbsrUpsertMemory(SBSR_MEMORY_COLLECTIONS.training, payload, sbsrNewPointId("train"));
  if (ok) {
    _log("sbsr-training-data", "captured");
    _log("sbsr-training-data", "admin_validated");
  }
  return ok;
}

async function sbsrSeedProductKnowledge() {
  if (!sbsrMemoryEnabled()) return;
  const seed = [
    { topic: "addon_makan_langsung", text: "Use case makan langsung: add-on hanya chili sauce." },
    { topic: "addon_stock_frozen", text: "Use case stock frozen: chili sauce, thermal bag, ice gel." },
    { topic: "addon_meeting", text: "Use case meeting: chili sauce, mika bag, minuman." },
    { topic: "addon_gift", text: "Use case gift hampers: greeting card, mika bag, thermal premium, chili sauce." },
  ];
  for (const row of seed) {
    await sbsrUpsertMemory(SBSR_MEMORY_COLLECTIONS.product, {
      type: "product_knowledge",
      ...row,
      created_at: new Date().toISOString(),
    }, `seed-${row.topic}`);
  }
}

module.exports = {
  init,
  SBSR_QDRANT_URL,
  SBSR_QDRANT_API_KEY,
  SBSR_MEMORY_ENABLED,
  SBSR_MEMORY_COLLECTIONS,
  sbsrMemoryEnabled,
  sbsrQdrantHeaders,
  sbsrQdrantFetch,
  sbsrEnsureCollection,
  sbsrTinyVector,
  sbsrNewPointId,
  sbsrUpsertMemory,
  sbsrScrollMemory,
  sbsrNormalizeText,
  sbsrExtractStructuredMemory,
  sbsrRetrieveMemoryContext,
  sbsrStoreExtractedMemories,
  sbsrStoreAdminTrainingData,
  sbsrSeedProductKnowledge,
};
