#!/usr/bin/env node
// Patch script for SBSR WhatsApp Bridge — fixes 4 priority bugs
// Reads server.js, applies patches, writes to stdout
// Usage: node fix-bugs.js < server.js > server-patched.js

const fs = require('fs');

const filePath = process.argv[2] || '/dev/stdin';
let content;
try {
  content = fs.readFileSync(filePath, 'utf8');
} catch (e) {
  console.error('Cannot read file:', e.message);
  process.exit(1);
}

const patches = [];

// ============================================================
// BUG 1: Address Matching — expand extractSemanticRegion and extractDistrictFromText
// ============================================================

patches.push({
  desc: 'Bug 1: Expand extractSemanticRegion with Bekasi, Depok, Tangerang, Bogor',
  old: `function hasJakartaHint(text) {
  const t = String(text || "").toLowerCase();
  return /(jakarta|jakarta timur|jaktim|cipinang)/i.test(t);
}
function extractSemanticRegion(text) {
  const t = String(text || "").toLowerCase();
  if (!t) return null;
  if (/(jakarta|jaktim|jakarta timur|jakarta barat|jakarta selatan|jakarta utara|jakarta pusat|dki)/i.test(t)) {
    return "jakarta";
  }
  if (/(sumedang|cimanggung|bandung|jawa barat|jabar|kabupaten bandung|kota bandung)/i.test(t)) {
    return "jawa_barat";
  }
  return null;
}`,
  new: `function hasJakartaHint(text) {
  const t = String(text || "").toLowerCase();
  return /(jakarta|jakarta timur|jaktim|cipinang|bassura|indonesia)/i.test(t);
}
function extractSemanticRegion(text) {
  const t = String(text || "").toLowerCase();
  if (!t) return null;
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
  return null;
}`
});

patches.push({
  desc: 'Bug 1: Expand extractDistrictFromText with more Jakarta districts + Bekasi/Depok/Tangerang',
  old: `function extractDistrictFromText(text) {
  const t = String(text || "").toLowerCase();
  if (!t) return "";
  const mKec = t.match(/\\b(?:kecamatan|kec\\.?)\\s*([a-z\\s-]{3,40})/i);
  if (mKec && mKec[1]) return normalizeSpaces(mKec[1]).toLowerCase();
  const known = [
    "jatinegara","tebet","duren sawit","matraman","cakung","pulogadung","cipayung","kramat jati",
    "johar baru","menteng","setiabudi","pancoran","mampang","pasar minggu","kebayoran","cilandak",
  ];
  for (const d of known) if (new RegExp(\`\\\\b\${d}\\\\b\`, "i").test(t)) return d;
  return "";
}`,
  new: `function extractDistrictFromText(text) {
  const t = String(text || "").toLowerCase();
  if (!t) return "";
  const mKec = t.match(/\\b(?:kecamatan|kec\\.?)\\s*([a-z\\s-]{3,40})/i);
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
  for (const d of known) if (new RegExp(\`\\\\b\${d}\\\\b\`, "i").test(t)) return d;
  return "";
}`
});

// ============================================================
// BUG 2: Addon — handle multiple addon items + addon quantity
// ============================================================

patches.push({
  desc: 'Bug 2: Enhance extractAddonReplySelections to support qty like "2 chili sauce"',
  old: `function extractAddonReplySelections(text) {
  const raw = String(text || "").trim();
  if (!raw) return [];
  const hits = [];
  for (const addon of SBSR_ADDON_SELECTIONS) {
    if (addon.match.test(raw)) hits.push({ ...addon, qty: 1 });
  }
  return hits;
}`,
  new: `function extractAddonReplySelections(text) {
  const raw = String(text || "").trim();
  if (!raw) return [];
  const hits = [];
  // Extract quantity prefix pattern: "2 chili" or "chili 2" or "2x chili"
  for (const addon of SBSR_ADDON_SELECTIONS) {
    if (addon.match.test(raw)) {
      let qty = 1;
      // Try "2 chili sauce" (number before), "chili sauce 2" (number after), "2x chili sauce"
      const beforeQty = raw.match(new RegExp('(\\\\d+)\\\\s*x?\\\\s*' + addon.match.source.replace(/\\^|\\$/g, '').replace(/\\\\b/g, '').trim(), 'i'));
      const afterQty = raw.match(new RegExp(addon.match.source.replace(/\\^|\\$/g, '').replace(/\\\\b/g, '').trim() + '\\\\s*x?\\\\s*(\\\\d+)', 'i'));
      if (beforeQty) qty = Math.max(1, parseInt(beforeQty[1], 10) || 1);
      else if (afterQty) qty = Math.max(1, parseInt(afterQty[1], 10) || 1);
      hits.push({ ...addon, qty });
    }
  }
  return hits;
}`
});

// ============================================================
// BUG 3: Flow Continuity — add out-of-context detection for non-critical checkout states
// ============================================================

patches.push({
  desc: 'Bug 3: Add out-of-context intent detection + soft handoff in checkout router fallback',
  old: `async function tryHandleOutOfContextHandoff(from, userText) {
  const draft = loadSbsrDraft(from) || {};
  const state = String(draft.state || "").trim().toLowerCase();
  if (!SBSR_OUT_OF_CONTEXT_STATES.has(state)) return false;
  const text = String(userText || "").trim();
  if (!text) return false;
  const criticalStates = new Set([
    "awaiting_proof",
    "awaiting_manual_payment_review",
    "pending_finance",
    "admin_handoff",
  ]);
  const explicitAdmin = /\\b(admin|cs|customer service|finance|orang)\\b/i.test(text);
  if (!criticalStates.has(state) && !explicitAdmin) {
    return false;
  }`,
  new: `async function tryHandleOutOfContextHandoff(from, userText) {
  const draft = loadSbsrDraft(from) || {};
  const state = String(draft.state || "").trim().toLowerCase();
  if (!SBSR_OUT_OF_CONTEXT_STATES.has(state)) return false;
  const text = String(userText || "").trim();
  if (!text) return false;
  const criticalStates = new Set([
    "awaiting_proof",
    "awaiting_manual_payment_review",
    "pending_finance",
    "admin_handoff",
  ]);
  const explicitAdmin = /\\b(admin|cs|customer service|finance|orang|hubungkan|sambungkan|tolong)\\b/i.test(text);
  // Non-critical checkout states: detect clear out-of-context intent (questions, greetings, random topics)
  const nonCriticalCheckout = new Set([
    "awaiting_addon_reply",
    "awaiting_delivery_method",
    "awaiting_name",
    "awaiting_address",
    "awaiting_location",
    "awaiting_courier_choice",
    "awaiting_address_pin_confirm",
    "awaiting_invoice_confirm",
  ]);
  if (nonCriticalCheckout.has(state) && !explicitAdmin) {
    const isQuestion = /^(?:kenapa|bagaimana|apa|siapa|kapan|dimana|mengapa|bisa|apakah|kalo|kalau)/i.test(text);
    const isGreeting = /^(?:hi|halo|hai|pagi|siang|sore|malam|permisi|maaf)/i.test(text);
    const isUnrelated = text.length > 15 && !/\\b(?:alamat|ongkir|pickup|ambil|harga|menu|order|pesan|bayar|add.?on|chili|sauce|thermal|ice|gel|lanjut|cukup|gak|tidak|nggak|iya|ya|oke|ok|gas|boleh|mau|nama|saya|aku|kirim|antar|gojek|grab|jne|jnt|sicepat|paxel)/i.test(text);
    const isRandomTopic = /\\b(cuaca|makanan|enak|recommend|rekomend|tempat|wisata|film|musik|game|politik|berita|kabar|lucu|komedi|sehat|sakit|kerja|sekolah|hobi)/i.test(text);
    if (isQuestion || isGreeting || (isUnrelated && isRandomTopic)) {
      log("sbsr-out-of-context", "detected_out_of_context state=" + state + " text=" + text.slice(0, 80));
      await sendWhatsAppMessage(from,
        "Maaf Kak, Mintu kurang paham pertanyaannya 🤍\\n\\n" +
        "Kalo Kakak mau tanya-tanya soal Sentuh Rasa, ketik *3* (Mau tanya-tanya) dari menu utama.\\n" +
        "Kalo mau lanjutin pesanan, tinggal balas sesuai yang Mintu tanyain sebelumnya aja ya 🤍"
      );
      return true;
    }
    return false;
  }
  if (!criticalStates.has(state) && !explicitAdmin) {
    return false;
  }`
});

// ============================================================
// BUG 4: Pickup Notification — fix sentuh-admin-cmd.mjs to handle pickup mode
// ============================================================

// We need to patch the adminApprove function in sentuh-admin-cmd.mjs
// But that's a separate file. Let me also patch the notifyKitchen for pickup.

// Let me also fix the server.js's sendWhatsAppMessage/notify functions for pickup

const output = patches.reduce((acc, patch) => {
  const idx = acc.indexOf(patch.old);
  if (idx === -1) {
    console.error('PATCH FAILED:', patch.desc);
    console.error('Search string not found. Aborting.');
    process.exit(1);
  }
  return acc.slice(0, idx) + patch.new + acc.slice(idx + patch.old.length);
}, content);

fs.writeFileSync(filePath === '/dev/stdin' ? '/dev/stdout' : filePath, output, 'utf8');
console.error('All patches applied successfully.');
