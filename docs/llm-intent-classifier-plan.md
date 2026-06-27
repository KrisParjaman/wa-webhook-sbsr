# LLM-First Intent Classifier — Implementation Plan

> **Goal**: Replace regex-based intent detection with LLM classifier that translates natural language → structured intent. Output messages stay template-based. Regex pipeline kept as fallback.

## Why

Saat ini bot pakai ~20+ regex buat deteksi intent user. Masalah: regex nggak ngerti konteks.

Contoh nyata dari production log:
- `"Oke sudah aman kak"` → kena `SBSR_RESTART_INTENT_RE` karena ada kata `oke`, session ke-reset
- `"ulang tahun"` → kena `SBSR_CANCEL_INTENT_RE` karena ada kata `ulang`, order ke-cancel
- `"test 123, Hi kak"` → kena `SBSR_SESSION_REENTRY_RE` karena ada kata `test`

**Solusi**: LLM baca natural language → output JSON intent → route ke template handler yang sesuai. Kalau classifier gagal/nggak confident → fallback ke regex pipeline yang sudah ada.

## Architecture Overview

```
WhatsApp message masuk
  ↓
[Classifier skip check] ← skip untuk input terstruktur ("1", "ya", maps URL)
  ↓
[LLM Classifier] ← panggil OpenClaw, minta klasifikasi intent
  ↓ (confidence=high)              ↓ (confidence=medium/low/error)
[Intent Router]                    [Existing Regex Pipeline]
  ↓                                  ↓
[Template Handler]                  [State Router + General Interceptors]
  ↓                                  ↓
[Kirim balasan template]            [LLM fallback main]
```

## Intent Taxonomy (15 intents)

| Intent | Deskripsi | Contoh |
|---|---|---|
| `greeting` | Sapaan | "halo", "pagi kak", "assalamualaikum", "test 123" |
| `request_menu` | Minta katalog | "menu dong", "ada varian apa?", "kirim pricelist" |
| `place_order` | Mau pesan | "mau risol ayam sayur 6pcs", "order dong", "beli frozen" |
| `cancel_order` | Batal pesan | "cancel", "ga jadi mesen", "batalin ya" |
| `confirm` | Setuju/lanjut | "ya", "ok", "sip", "lanjut", "betul", "gass" |
| `deny` | Tolak | "tidak", "gak", "salah", "bukan", "nggak jadi" |
| `provide_name` | Kasih nama | "atas nama Budi", "saya Andi", "jokowi" |
| `provide_address` | Alamat teks | "Jl Merdeka 12", "Perum Citra Blok A no 5" |
| `provide_location` | Share pin | Google Maps URL, WhatsApp location share |
| `choose_option` | Pilih opsi | "1", "delivery", "goreng", "paxel", "pickup" |
| `ask_question` | Tanya | "halal ga?", "ongkir berapa?", "beda goreng frozen apa?" |
| `add_more` | Tambah pesanan | "nambah dong", "tambah chili sauce", "add more" |
| `change_order` | Ubah pesanan | "ganti varian", "ubah jadi frozen", "revisi" |
| `general_chat` | Di luar konteks | "gimana kabar?", joke, spam, curhat |
| `reset` | Mulai ulang | "reset", "mulai dari awal", "ulang semua" |

## File to Modify

**Hanya 1 file**: `server.js` di `/Users/user/Developer/wa-webhook-sbsr/server.js`

Yang ditambah: ~200 baris (4 fungsi baru + 1 insertion block + constants)
Yang diubah: 0 baris existing code
Yang dihapus: 0

## Step 1: Constants & Config

Tambahkan setelah line ~7344 (dekat intent RE definitions lain):

```javascript
// === LLM-FIRST INTENT CLASSIFIER CONFIG ===
const SBSR_LLM_CLASSIFIER = process.env.SBSR_LLM_CLASSIFIER !== "0";  // default ON
const CLASSIFIER_TIMEOUT_MS = 4000;  // 4 detik — lebih cepat dari main LLM (240s)
const CLASSIFIER_VALID_INTENTS = new Set([
  "greeting", "request_menu", "place_order", "cancel_order",
  "confirm", "deny", "provide_name", "provide_address",
  "provide_location", "choose_option", "ask_question",
  "add_more", "change_order", "general_chat", "reset"
]);
// Skip classifier untuk input yang sudah terstruktur & pasti dihandle regex dengan benar
const CLASSIFIER_SKIP_RE = /^(?:ok|oke|okay|ya|iya|tidak|gak|nggak|no|yes|sip|siap|deal|lanjut|sudah|1|2|3|4|\d+)\s*$/i;
// Raw Maps URL — sudah dihandle tryHandleBareMapsUrl
const CLASSIFIER_MAPS_SKIP_RE = /^https?:\/\/.*(?:google\.com\/maps|maps\.google|goo\.gl\/maps|maps\.app\.goo\.gl)/i;
```

## Step 2: `buildClassifierPrompt()` function

Tambahkan sebelum `handleMessage()` function (~line 9090). Prompt harus **minimal** (~500 tokens) biar latency rendah. JANGAN masukin full catalog — terlalu berat buat klasifikasi.

```javascript
function buildClassifierPrompt(from, userText, draft, bridgeContext) {
  const state = String(draft?.state || "none").trim().toLowerCase();
  const customerName = String(draft?.customer_name || "");
  const useCase = String(draft?.use_case || "");
  const deliveryMode = String(draft?.delivery_mode || "");
  const items = Array.isArray(draft?.items) ? draft.items : [];
  const cartSummary = items.length > 0
    ? items.map(it => `${it.qty || 1}x ${it.name || "?"} (${it.form || "?"})`).join(", ")
    : "(kosong)";

  return [
    "Kamu adalah classifier intent chat untuk toko Risol Sentuh Rasa.",
    "Tugasmu HANYA mengklasifikasikan intent pesan customer dalam Bahasa Indonesia.",
    "JANGAN menghasilkan teks balasan — output JSON SAJA.",
    "",
    "=== STATUS PELANGGAN ===",
    "State saat ini: " + state,
    "Nama: " + (customerName || "(belum diisi)"),
    "Use case: " + (useCase || "(belum dipilih)"),
    "Delivery mode: " + (deliveryMode || "(belum dipilih)"),
    "Isi cart: " + cartSummary,
    "",
    "=== KONTEKS PERCAKAPAN (apa yang terakhir bot katakan ke customer) ===",
    bridgeContext || "(tidak ada — ini pesan pertama atau setelah reset)",
    "",
    "=== DAFTAR INTENT ===",
    "Pilih SATU intent yang paling tepat:",
    "",
    "greeting — customer menyapa. Contoh: 'halo', 'pagi', 'assalamualaikum', 'test 123'",
    "request_menu — minta lihat menu/katalog. Contoh: 'menu dong', 'kirim katalognya', 'ada varian apa?'",
    "place_order — mau pesan/order produk. Contoh: 'mau risol 6pcs ayam sayur', 'order dong', 'beli frozen'",
    "cancel_order — membatalkan pesanan yang sedang berjalan. Contoh: 'cancel', 'batalin ya', 'ga jadi mesen'",
    "confirm — konfirmasi setuju/lanjut. Contoh: 'ya', 'ok', 'sip', 'lanjut', 'betul', 'gass'",
    "deny — menolak/tidak setuju. Contoh: 'tidak', 'gak', 'salah', 'bukan', 'nggak jadi'",
    "provide_name — memberikan nama. Contoh: 'atas nama Budi', 'saya Andi', 'jokowi'",
    "provide_address — memberikan alamat teks. Contoh: 'Jl Merdeka No 12', 'Perum Citra Blok A'",
    "provide_location — share Google Maps URL atau WhatsApp location pin",
    "choose_option — memilih dari opsi yang ditawarkan. Contoh: '1', 'delivery', 'goreng', 'paxel'",
    "ask_question — bertanya tentang produk/harga/cara pesan/dll. Contoh: 'halal ga?', 'ongkir berapa?', 'berapa harga?'",
    "add_more — mau tambah pesanan. Contoh: 'nambah dong', 'tambah chili sauce', 'add more'",
    "change_order — mau ubah/ganti/revisi pesanan. Contoh: 'ganti varian', 'ubah jadi frozen'",
    "general_chat — percakapan di luar konteks pemesanan. Contoh: 'gimana kabar?', joke, spam, curhat, 'aku galau'",
    "reset — minta reset/mulai ulang. Contoh: 'reset', 'mulai dari awal', 'start over'",
    "",
    "=== FORMAT OUTPUT (JSON SAJA, tanpa markdown) ===",
    "{",
    '  "intent": "<salah satu dari daftar di atas>",',
    '  "confidence": "high" | "medium" | "low"',
    "}",
    "",
    "=== PESAN CUSTOMER ===",
    userText,
  ].join("\n");
}
```

## Step 3: `classifyIntentWithLLM()` function

```javascript
async function classifyIntentWithLLM(from, userText, draft, bridgeContext) {
  const t = String(userText || "").trim();

  // Skip untuk input terstruktur — regex handler udah sempurna buat ini
  if (CLASSIFIER_SKIP_RE.test(t)) {
    log("llm-classifier", "skip_structured text=" + t.slice(0, 30));
    return null;
  }

  // Skip untuk raw Maps URL — tryHandleBareMapsUrl udah handle dengan sempurna
  if (CLASSIFIER_MAPS_SKIP_RE.test(t)) {
    log("llm-classifier", "skip_maps_url");
    return null;
  }

  // Skip pesan terlalu pendek — nggak cukup konteks buat LLM
  if (t.length < 3) {
    log("llm-classifier", "skip_short len=" + t.length);
    return null;
  }

  // Skip pesan terlalu panjang — kemungkinan spam/forward
  if (t.length > 500) {
    log("llm-classifier", "skip_long len=" + t.length);
    return null;
  }

  const prompt = buildClassifierPrompt(from, userText, draft, bridgeContext);

  try {
    // Race: LLM vs timeout 4 detik
    const raw = await Promise.race([
      sendToOpenClaw("intent-" + Date.now() + "-" + from, prompt),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Classifier timeout")), CLASSIFIER_TIMEOUT_MS)
      ),
    ]);

    if (!raw || !String(raw).trim()) {
      log("llm-classifier", "empty_response");
      return null;
    }

    // Parse JSON dari response (bisa code-fenced atau raw)
    let cleaned = String(raw).trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```\s*$/i, "");

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      // Coba extract JSON object dari dalam text
      const m = cleaned.match(/\{[\s\S]*"intent"[\s\S]*\}/);
      if (m) {
        try { parsed = JSON.parse(m[0]); } catch (_) {}
      }
      if (!parsed) {
        log("llm-classifier", "json_parse_failed raw=" + cleaned.slice(0, 100));
        return null;
      }
    }

    // Validasi
    if (!parsed || !CLASSIFIER_VALID_INTENTS.has(parsed.intent)) {
      log("llm-classifier", "invalid_intent=" + (parsed?.intent || "?"));
      return null;
    }

    const confidence = ["high", "medium", "low"].includes(parsed.confidence)
      ? parsed.confidence
      : "medium";

    log("llm-classifier", "result intent=" + parsed.intent + " conf=" + confidence);
    return { intent: parsed.intent, confidence };

  } catch (err) {
    log("llm-classifier", "error=" + err.message);
    return null;
  }
}
```

## Step 4: `routeClassifiedIntent()` function

Map intent → existing handler. Return `true` kalau handled, `false` kalau harus fall through ke regex.

```javascript
async function routeClassifiedIntent(from, userText, intent, messageId) {
  const draft = loadSbsrDraft(from) || { phone: from };
  const state = sbsrRouterStateLabel(draft);

  log("llm-classifier", "route intent=" + intent + " state=" + state);

  switch (intent) {

    case "greeting": {
      // Kalau ada active checkout, jangan reset — biarin existing handler yang putusin
      if (isSbsrCheckoutCollectionActive(draft)) return false;
      if (await tryHandleDeterministicGreeting(from, userText)) return true;
      await sendWhatsAppMessage(from, SBSR_FIXED_GREETING_TEXT);
      return true;
    }

    case "request_menu": {
      if (isProtectedPaymentFlowDraft(draft)) {
        // Dalam payment flow → add-more mode, bukan reset
        const d = loadSbsrDraft(from) || {};
        saveSbsrDraft(from, { ...d, add_more_mode: true });
        await sendWhatsAppMessage(from, "Siap Kak, ini katalognya ya \u{1f90d}");
        await sendWhatsAppCatalog(from);
        return true;
      }
      resetSbsrCheckoutState(from);
      await sendWhatsAppMessage(from, formatSbsrFullMenuText());
      await sendWhatsAppCatalog(from);
      await sendSbsrUseCasePrompt(from, { phone: from });
      return true;
    }

    case "place_order": {
      // Coba free-text order parser dulu
      if (typeof tryHandleFreeTextOrder === "function" && await tryHandleFreeTextOrder(from, userText)) {
        return true;
      }
      // Fallback: kasih use-case prompt + catalog
      await sendSbsrUseCasePrompt(from, draft.phone ? draft : { phone: from });
      await sendWhatsAppCatalog(from);
      return true;
    }

    case "cancel_order": {
      if (isCheckoutActiveState(state)) {
        clearSbsrCheckoutForCancel(from);
        await sendWhatsAppMessage(from,
          "Siap Kak, pesanan sebelumnya Mintu batalkan ya \u{1f90d}\n\n" +
          "Mau mulai lagi? Ketik *MENU* untuk lihat katalog atau pilih:\n" +
          "1. Kirimkan menu/pricelist\n2. Mau langsung order\n3. Mau tanya-tanya"
        );
      } else {
        // Nggak ada pesanan aktif — kasih tau user
        await sendWhatsAppMessage(from,
          "Kak, belum ada pesanan aktif yang perlu dibatalkan ya \u{1f90d}\n" +
          "Ketik *MENU* untuk mulai order."
        );
      }
      return true;
    }

    case "confirm": {
      // Route ke state-specific confirm handler
      if (state === "awaiting_invoice_confirm" && await tryHandleInvoiceOk(from, userText)) return true;
      if (state === "awaiting_order_confirm" && await tryHandleOrderConfirm(from, userText)) return true;
      if (state === "awaiting_meeting_package_confirm" && await tryHandleMeetingPackageConfirm(from, userText)) return true;
      if (state === "awaiting_pin_confirm" && await tryHandlePinConfirm(from, userText)) return true;
      // Generic confirm — let existing handlers deal with it
      return false;
    }

    case "deny": {
      if (state === "awaiting_order_confirm" && await tryHandleOrderConfirm(from, userText)) return true;
      if (state === "awaiting_meeting_package_confirm" && await tryHandleMeetingPackageConfirm(from, userText)) return true;
      return false;
    }

    case "provide_name": {
      if (await tryHandleNameCapture(from, userText)) return true;
      // Shadow-capture: simpan nama meskipun handler gagal parse
      const nameRe = /(?:nama|atas\s*nama|saya|aku|gw|gue)\s*:?\s*(.+)/i;
      const m = userText.match(nameRe);
      if (m && m[1].trim().length >= 2) {
        const d = loadSbsrDraft(from) || {};
        saveSbsrDraft(from, { ...d, customer_name: m[1].trim() });
        log("llm-classifier", "shadow_name_capture name=" + m[1].trim());
      }
      return false; // let existing flow continue
    }

    case "provide_address": {
      if (await tryHandleAddressTextCapture(from, userText)) return true;
      return false;
    }

    case "provide_location": {
      if (await tryHandleBareMapsUrl(from, userText)) return true;
      if (await tryHandleAddressAndQuote(from, userText)) return true;
      return false;
    }

    case "choose_option": {
      // Coba semua option handler yang relevan
      if (await tryHandleDeliveryMethodSelection(from, userText)) return true;
      if (await tryHandleUseCaseRouter(from, userText)) return true;
      if (await tryHandleFrozenCourierChoice(from, userText)) return true;
      if (await tryHandlePickupFlow(from, userText)) return true;
      if (await tryHandleAddressPinConfirm(from, userText)) return true;
      return false;
    }

    case "ask_question": {
      if (await tryHandleFaq(from, userText)) return true;
      // FAQ gagal → fall through ke LLM dengan full context
      return false;
    }

    case "add_more": {
      // Harus ada cart aktif
      const d = loadSbsrDraft(from) || {};
      if (!Array.isArray(d.items) || d.items.length === 0) {
        // Nggak ada cart — treat sebagai place_order
        await sendSbsrUseCasePrompt(from, { phone: from });
        await sendWhatsAppCatalog(from);
        return true;
      }
      if (typeof tryHandleGlobalAddMore === "function" && await tryHandleGlobalAddMore(from, userText)) {
        return true;
      }
      // Fallback: manual add-more
      saveSbsrDraft(from, { ...d, add_more_mode: true, state: "awaiting_product_selection" });
      await sendWhatsAppMessage(from, "Siap Kak, silakan pilih dari katalog ya \u{1f90d} nanti totalnya Mintu gabungkan.");
      await sendWhatsAppCatalog(from);
      return true;
    }

    case "change_order": {
      const d = loadSbsrDraft(from) || {};
      if (!Array.isArray(d.items) || d.items.length === 0) {
        await sendWhatsAppMessage(from, "Kak, belum ada pesanan yang bisa diubah. Ketik *MENU* untuk mulai order ya \u{1f90d}");
        return true;
      }
      // Reset cart + buka katalog
      saveSbsrDraft(from, { ...d, items: null, addons: null, subtotal: null, cart: null, state: "awaiting_product_selection" });
      await sendWhatsAppMessage(from, "Siap Kak, pesanan sebelumnya Mintu reset dulu ya. Silakan pilih ulang dari katalog \u{1f90d}");
      await sendWhatsAppCatalog(from);
      return true;
    }

    case "reset": {
      hardResetSbsrSession(from);
      await sendWhatsAppMessage(from, SBSR_FIXED_GREETING_TEXT);
      return true;
    }

    case "general_chat":
    default: {
      // Biarkan existing pipeline + main LLM yang handle
      return false;
    }
  }
}
```

## Step 5: Insertion Point

Cari baris ini di server.js (function `handleMessage`, sekitar line 9577):

```javascript
      } else if (isMenuIntent(userText)) {
```

**Sisipkan** classifier block **SEBELUM** baris tersebut. Result:

```
...active checkout guard block...

      // === LLM-FIRST INTENT CLASSIFIER ===  ← SISIPKAN DARI SINI
      if (SBSR_LLM_CLASSIFIER) {
        let _cfHandled = false;
        try {
          const _cfBridgeCtx = consumePendingBridgeContext(from);
          const _cfResult = await classifyIntentWithLLM(
            from, userText, _preDraftForMenu, _cfBridgeCtx
          );
          if (_cfResult && _cfResult.confidence === "high") {
            log("llm-classifier", "HANDLED intent=" + _cfResult.intent);
            _cfHandled = await routeClassifiedIntent(from, userText, _cfResult.intent, messageId);
            if (_cfHandled) {
              sendReaction(from, messageId, "").catch(() => {});
              return;
            }
            log("llm-classifier", "route_false — fallthrough to regex");
          } else if (_cfResult) {
            log("llm-classifier", "low_conf intent=" + _cfResult.intent + " conf=" + _cfResult.confidence + " — fallthrough");
          }
        } catch (_cfErr) {
          log("llm-classifier", "error=" + _cfErr.message + " — fallthrough");
        }
      }
      // === END LLM-FIRST INTENT CLASSIFIER ===  ← SAMPAI SINI

      } else if (isMenuIntent(userText)) {    ← BARIS EXISTING, TIDAK DIUBAH
```

**PENTING**: Semua kode existing dari `isMenuIntent(userText)` dan seterusnya TIDAK DIUBAH. Classifier hanya menambah di atasnya.

## Step 6: Environment Variable

Tambahkan di `.env`:

```bash
# LLM-FIRST INTENT CLASSIFIER
# 1 = on (default), 0 = off (fallback ke regex pipeline)
SBSR_LLM_CLASSIFIER=1
```

## Safety Mechanisms

1. **Confidence gate**: Hanya `confidence: "high"` yang di-route ke template handler. Medium/low → fall through ke regex
2. **4-second timeout**: Kalau classifier lemot, fall through ke regex (no regression)
3. **Skip list**: Input terstruktur ("1", "ya", "ok") skip classifier — regex udah sempurna buat ini
4. **JSON parse error handling**: Gagal parse → null → fall through
5. **OpenClaw down**: Exception → catch → fall through
6. **Environment toggle**: `SBSR_LLM_CLASSIFIER=0` → semua classifier logic di-skip, identik dengan behaviour sebelum perubahan ini
7. **Existing code unchanged**: Semua regex, state router, general interceptors, dan main LLM fallback tetap jalan

## Verification

### Deploy steps
```bash
# 1. Deploy dengan classifier OFF dulu (pastikan no regression)
SBSR_LLM_CLASSIFIER=0
pm2 restart wa-bridge-sbsr
# Pantau log 15-30 menit → pastikan semua normal

# 2. Enable classifier
SBSR_LLM_CLASSIFIER=1
pm2 restart wa-bridge-sbsr
# Pantau log dengan filter: grep "llm-classifier"
```

### Test scenarios (dari chat log yang bermasalah)

| Input | Expected intent | Expected behaviour |
|---|---|---|
| `oke cancel kak` | `cancel_order` (high) | Cancel flow, bukan 1/2/3 loop |
| `ga jadi mesen kak` | `cancel_order` (high) | Cancel flow |
| `ulang tahun` | `general_chat` (high) | Tidak trigger cancel/restart |
| `Oke sudah aman kak` | `general_chat` (high) | Tidak trigger restart |
| `test 123, Hi kak selamat pag` | `greeting` (high) | Greeting + menu |
| `mau risol ayam sayur 3pcs kak` | `place_order` (high) | Order flow |
| `https://maps.app.goo.gl/xxx` | skipped (maps URL) | Handled by tryHandleBareMapsUrl |
| `1` | skipped (structured) | Handled by existing option handler |
| `ya` | skipped (structured) | Handled by existing confirm handler |
| `menu dong` | `request_menu` (high) | Katalog + use case prompt |

### Log monitoring
```bash
# Lihat classifier activity
tail -f wa-bridge-sbsr-out.log | grep "llm-classifier"

# Pastikan nggak ada yang aneh
tail -f wa-bridge-sbsr-out.log | grep -E "llm-classifier|fallthrough"
```

## Rollback

Kalau ada masalah:
```bash
SBSR_LLM_CLASSIFIER=0
pm2 restart wa-bridge-sbsr
```
Bot langsung balik ke regex-only behaviour.
