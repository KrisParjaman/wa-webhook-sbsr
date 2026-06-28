// address-matcher.cjs — extracted from server.js
// Address (region/district) matching logic for Sentuh Rasa WhatsApp Bridge.
//
// Functions are split into two tiers:
//   Tier 1 — pure deterministic (no I/O):
//     normalizeSpaces, hasWestJavaHint, hasJakartaHint, isJakartaLikeHint,
//     extractRegionKeywords, regionSetsConflict, inferRegionFromCoords,
//     extractDistrictFromText
//   Tier 2 — async with LLM fallback (requires sendToOpenClaw injection):
//     init(sendToOpenClawFn) must be called first, then:
//     extractSemanticRegion, callLlmAddr, callLlmRegion, callLlmDistrict,
//     callLlmCompare, hasSemanticRegionConflict, hasTextOnlyDistrictMismatch
//
// Usage:
//   const am = require('./lib/address-matcher.cjs');
//   am.init(sendToOpenClaw);
//   const region = await am.extractSemanticRegion(alamat);

'use strict';

// ── Injected dependency ────────────────────────────────────────────
let _sendToOpenClaw = null;

/**
 * Inject the core WebSocket send function so LLM fallbacks can work.
 * Call once at startup (e.g. from secLib init block).
 */
function init(sendToOpenClawFn) {
  _sendToOpenClaw = sendToOpenClawFn;
}

// ── Tier 1: Pure helpers ────────────────────────────────────────────

function normalizeSpaces(s) {
  return String(s || "").trim().replace(/[\s ]+/g, " ");
}

function hasWestJavaHint(text) {
  const t = String(text || "").toLowerCase();
  return /(sumedang|bandung|cimanggung|jawa barat)/i.test(t);
}

function hasJakartaHint(text) {
  const t = String(text || "").toLowerCase();
  return /(jakarta|jakarta timur|jaktim|cipinang|bassura|indonesia)/i.test(t);
}

function isJakartaLikeHint(text) {
  const t = String(text || "").toLowerCase();
  return /(jakarta|jaktim|jakarta timur|cipinang|bassura|indonesia|\bid\b)/i.test(t);
}

function extractRegionKeywords(text) {
  const t = String(text || "").toLowerCase();
  const out = new Set();
  if (!t) return out;
  if (/(jakarta timur|jaktim|jatinegara|cipinang|dki jakarta|jakarta)/i.test(t)) out.add("jakarta");
  if (/(bandung|sumedang|cimanggung|jawa barat|jabar|bekasi|depok)/i.test(t)) out.add("jawa_barat");
  if (/(tangerang|banten)/i.test(t)) out.add("banten");
  return out;
}

function regionSetsConflict(aSet, bSet) {
  if (!aSet || !bSet || aSet.size === 0 || bSet.size === 0) return false;
  for (const x of aSet) if (bSet.has(x)) return false;
  return true;
}

function inferRegionFromCoords(lat, lng) {
  const la = Number(lat), lo = Number(lng);
  if (!Number.isFinite(la) || !Number.isFinite(lo)) return null;
  // Rough Jakarta/Jabodetabek envelope
  if (la >= -6.45 && la <= -6.00 && lo >= 106.55 && lo <= 107.15) return "jakarta";
  // Rough Bandung/Sumedang/Jawa Barat belt often seen in wrong pins
  if (la >= -7.35 && la <= -6.50 && lo >= 107.20 && lo <= 108.20) return "jawa_barat";
  return null;
}

function extractDistrictFromText(text) {
  const t = String(text || "").toLowerCase();
  if (!t) return "";
  const mKec = t.match(/\b(?:kecamatan|kec\.?)\s*([a-z\s-]{3,40})/i);
  if (mKec && mKec[1]) return normalizeSpaces(mKec[1]).toLowerCase();
  // Jakarta districts (complete list)
  const known = [
    "jatinegara","tebet","duren sawit","matraman","cakung","pulogadung","cipayung","kramat jati",
    "johar baru","menteng","setiabudi","pancoran","mampang","pasar minggu","kebayoran","cilandak",
    "tanjung priok","koja","kelapa gading","cilincing","pademangan","penjaringan",
    "kemayoran","sawah besar","gambir","senen","cempaka putih","tanah abang",
    "palmerah","grogol petamburan","tambora","taman sari","kebon jeruk","kembangan",
    "pesanggrahan","cilodong","makasar","pasar rebo","ciracas","halim perdanakusuma",
    "kepulauan seribu selatan","kepulauan seribu utara",
    // Bekasi districts
    "mustika jaya","bantar gebang","jatiasih","jatibening","bekasi timur","bekasi barat","bekasi selatan","bekasi utara",
    "rawa lumbu","medan satria","pondok melati","pondok gede",
    // Depok districts
    "pancoran mas","sukmajaya","beji","cimanggis","sawangan","limo","tapos","cinere","cilodong",
    // Tangerang districts
    "pamulang","ciputat","ciputat timur","serpong","serpong utara","bintaro","pondok aren",
    "karang tengah","larangan","pinang","ciledug","karawaci","periuk","cibodas",
    // Bogor districts
    "cibinong","gunung putri","citeureup","cileungsi","sukaraja","babakan madang",
  ];
  for (const d of known) if (new RegExp(`\\b${d}\\b`, "i").test(t)) return d;
  return "";
}

// ── Tier 2: LLM fallback (requires init) ───────────────────────────

const KNOWN_REGIONS = ['jakarta','bekasi','depok','tangerang','bogor','jawa_barat','banten'];

async function callLlmAddr(prompt, mode) {
  if (!prompt || prompt.length < 5) return mode === 'region' ? null : '';
  if (!_sendToOpenClaw) return mode === 'region' ? null : '';
  try {
    const reply = await _sendToOpenClaw('llm-addr-' + Date.now(), prompt);
    const cleaned = (reply || '').trim().toLowerCase();
    if (mode === 'region') {
      if (KNOWN_REGIONS.includes(cleaned)) return cleaned;
      // Try to extract region name from longer response
      for (const r of KNOWN_REGIONS) {
        if (cleaned.includes(r)) return r;
      }
      return null;
    }
    if (mode === 'district') return cleaned || '';
    if (mode === 'compare') {
      if (cleaned.includes('sama')) return false;
      if (cleaned.includes('beda') || cleaned.includes('berbeda')) return true;
      return null;
    }
    return null;
  } catch(e) {
    return mode === 'region' ? null : '';
  }
}

async function callLlmRegion(text) { return callLlmAddr(text, 'region'); }
async function callLlmDistrict(text) { return callLlmAddr(text, 'district'); }
async function callLlmCompare(a, b) {
  return callLlmAddr(
    'Bandingkan: apakah alamat 1 dan 2 di KOTA yang SAMA atau BERBEDA? Jawab SAMA/BERBEDA saja.\n1: ' + a.substring(0, 150) + '\n2: ' + b.substring(0, 150),
    'compare'
  );
}

async function extractSemanticRegion(text, useLlmFallback) {
  const t = String(text || "").toLowerCase();
  if (!t) return null;
  // Deterministic matching first
  if (/(jakarta|jaktim|jakarta timur|jakarta barat|jakarta selatan|jakarta utara|jakarta pusat|dki|ibu kota)/i.test(t)) {
    return "jakarta";
  }
  if (/(sumedang|cimanggung|bandung|jawa barat|jabar|kabupaten bandung|kota bandung|ciwidey|soreang)/i.test(t)) {
    return "jawa_barat";
  }
  if (/(bekasi|kota bekasi|kabupaten bekasi|cikarang|mustika jaya|bantar gebang)/i.test(t)) {
    return "bekasi";
  }
  if (/(depok|kota depok|pancoran mas|sukmajaya|beji|cimanggis|sawangan|limo)/i.test(t)) {
    return "depok";
  }
  if (/(tangerang|kota tangerang|kabupaten tangerang|tangerang selatan|tangsel|pamulang|ciputat|serpong|bintaro|bsd)/i.test(t)) {
    return "tangerang";
  }
  if (/(bogor|kota bogor|kabupaten bogor|cibinong|gunung putri|citeureup|cileungsi|sukaraja)/i.test(t)) {
    return "bogor";
  }
  if (/(banten)/i.test(t)) {
    return "banten";
  }
  // LLM fallback: jika deterministic tidak dapat menentukan
  if (useLlmFallback !== false) {
    try {
      const llmRegion = await callLlmRegion(text);
      if (llmRegion) return llmRegion;
    } catch(e) {}
  }
  return null;
}

async function hasSemanticRegionConflict(addressText, decodedPlace) {
  const a = await extractSemanticRegion(addressText);
  const b = await extractSemanticRegion(decodedPlace);
  if (!a || !b) {
    // LLM fallback: jika salah satu tidak terdeteksi deterministic
    if (a !== null || b !== null) {
      try {
        const llmResult = await callLlmCompare(addressText, decodedPlace);
        if (llmResult !== null) return llmResult;
      } catch(e) {}
    }
    return false;
  }
  if (a !== b) return true;
  return false;
}

async function hasTextOnlyDistrictMismatch(addressText, decodedPlace) {
  const aDist = extractDistrictFromText(addressText);
  const bDist = extractDistrictFromText(decodedPlace);
  const aReg = await extractSemanticRegion(addressText);
  const bReg = await extractSemanticRegion(decodedPlace);
  if (aReg && bReg && aReg !== bReg) return true;
  if (aDist && bDist && aDist !== bDist) return true;
  // LLM fallback: jika deterministic tidak mendeteksi perbedaan
  if (!aReg && !bReg && !aDist && !bDist) {
    try {
      const llmResult = await callLlmCompare(addressText, decodedPlace);
      if (llmResult === true) return true;
    } catch(e) {}
  }
  return false;
}

// ── Exports ─────────────────────────────────────────────────────────

// Keep normalizeSpaces as a module-level alias so server.js callers that
// previously used the global normalizeSpaces can use it from here.
module.exports = {
  init,
  // pure
  normalizeSpaces,
  hasWestJavaHint,
  hasJakartaHint,
  isJakartaLikeHint,
  extractRegionKeywords,
  regionSetsConflict,
  inferRegionFromCoords,
  extractDistrictFromText,
  // async (require init)
  extractSemanticRegion,
  callLlmAddr,
  callLlmRegion,
  callLlmDistrict,
  callLlmCompare,
  hasSemanticRegionConflict,
  hasTextOnlyDistrictMismatch,
  KNOWN_REGIONS,
};
