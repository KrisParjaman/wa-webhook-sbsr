# Codebase Notes — wa-webhook-sbsr

> Terakhir diupdate: 2026-06-28 (dedup fix + PostgreSQL catalog/conversations)

## Arsitektur Umum

```
WhatsApp Cloud API (Meta)
        │  webhook POST /webhook
        ▼
   server.js  ─── handleMessage()
        │
        ├── Interceptors (deterministic, dijalankan berurutan)
        │     tryHandleAddressPinConfirm → tryHandleAddressTextCapture
        │     tryHandleAddressAndQuote  → tryHandleFrozenCourierChoice
        │     tryHandleEscalation       → tryHandleAdminHandoff
        │     tryHandleInvoiceOk        → tryHandleWrongInputInLocationStates
        │     ...dst
        │
        ├── llm-router.js  — LLM-first intent classifier (before deterministic, for early states)
        │
        └── sendToOpenClaw()  — WebSocket ke OpenClaw LLM gateway
                                (fallback / natural language reply)
```

### File Utama

| File | Fungsi |
|---|---|
| `server.js` | Entry point: webhook handler, state machine checkout, semua logika bisnis |
| `admin.js` | Admin panel UI — seluruh HTML/CSS/JS dalam template literal `const HTML = \`...\`` |
| `llm-router.js` | LLM-first router — intercept early states sebelum deterministic handler |
| `catalog-map.json` | Static SKU → nama produk mapping (fallback jika WA Catalog API lambat) |
| `products.json` | Store metadata (nama toko, lokasi, kurir, FAQ) + fallback catalog |

### lib/ — Modul Keamanan & Parsing

| File | Fungsi |
|---|---|
| `lib/prompt-sanitizer.cjs` | Sanitasi input user (XSS, prompt injection) |
| `lib/rate-limiter.cjs` | Rate limiting per nomor HP (max msg/menit) |
| `lib/cost-guard.cjs` | Daily cap biaya LLM (env `SBSR_DAILY_LLM_CAP_USD`) |
| `lib/draft-policy.cjs` | Predikat reset draft — kapan wipe data customer lama |
| `lib/courier-choice-parser.cjs` | Parse pilihan kurir dengan negasi ("bukan paxel, gojek aja") |

Semua lib di-require di `server.js` dalam blok `try { secLib = {...} }` — jika gagal load, sistem tetap jalan (fail-open) tanpa security layer.

---

## Infra & Deploy

- **Server**: DigitalOcean droplet `206.189.34.228`
- **Reverse proxy**: Caddy → `production.biks.ai` → `localhost:3001`
- **Process manager**: PM2 (`wa-bridge-sbsr`)
- **CI/CD**: GitHub Actions → push ke `master` → SSH deploy → `pm2 restart wa-bridge-sbsr`
- **SSH key**: `~/Documents/Credentials/cristian.anggita.parjaman@gmail.com`
- **Log**: `pm2 logs wa-bridge-sbsr --lines 80 --nostream`
- **Server path**: `/docker/wa-webhook-sbsr/`

### Env Vars Penting

| Var | Default | Keterangan |
|---|---|---|
| `WA_CATALOG_ID` | `1477386560782761` | ID katalog WA Business |
| `SBSR_FINANCE_PHONES` | — | Nomor admin yang menerima notif (comma-separated) |
| `SBSR_KITCHEN_PHONES` | — | Nomor dapur (bypass rate limit & killswitch) |
| `SBSR_PAUSE` | — | `1` = mode maintenance, semua pesan dibalas teks maintenance |
| `SBSR_OPS_ESCALATION_PHONE` | — | Nomor ops untuk escalation saat PAUSE mode |
| `SBSR_DAILY_LLM_CAP_USD` | `5` | Batas biaya LLM harian (USD) |
| `SBSR_IDEMPOTENT` | **ON** | Webhook dedup. Set `false` untuk disable (tidak disarankan) |
| `POSTGRES_URL` | — | Connection string PostgreSQL (`postgresql://sbsr:...@127.0.0.1:5432/sbsr`) |
| `WA_MSG_RETENTION_DAYS` | `90` | Berapa hari pesan disimpan di `wa_messages` sebelum dihapus |
| `WA_MSG_MAX_PER_PHONE` | `500` | Maks pesan tersimpan per nomor di PostgreSQL |

---

## Katalog Produk — Alur Data

> **Setelah branch `feat/postgres-catalog`:** sumber data utama pindah ke PostgreSQL.
> `catalog-map.json` dan `products.json` tidak lagi dibaca oleh `server.js` (tetap ada sebagai referensi historis).
> Lihat detail di [`docs/postgres-catalog.md`](postgres-catalog.md).

```
PostgreSQL: catalog_products (warmup saat startup)
   catalogMap      → SKU → nama produk
   catalogPrices   → SKU → harga (Rp)
   catalogAvailability → SKU → stok status
         │
         ▼
WA Business Catalog API (sync tiap 5 menit)
   → Update in-memory catalogMap/catalogPrices/catalogAvailability
   → UPSERT balik ke catalog_products
         │
         ▼
   formatCatalogForLLM()    — konteks LLM, harga live
   formatSbsrFullMenuText() — teks menu ke customer

PostgreSQL: store_config (warmup saat startup)
   key=store_info  → nama toko, lokasi, kurir, addons
   key=categories  → daftar kategori + variants
   key=faq         → FAQ Mintu
         │
         ▼
   loadProductCatalog()  — return _productCatalogCache dari PG
```

### SKU Scheme (catalog-map.json)

| Prefix | Varian | Ukuran |
|---|---|---|
| `RA` | Ayam Sayur | 3, 6, 12, FRZ |
| `RR` | Ragout Creamy | 3, 6, 12, FRZ |
| `RM` | Smoked Beef Mayo | 3, 6, 12, FRZ |
| `RAM` | Ayam Mercon Chili Oil 🔥 | 3, 6, 12, FRZ |
| `RAP` | Ayam Sayur Pedas | 3, 6, 12, FRZ |
| `MIX` | Mix Risol (pilih varian di chat) | 3, 6, 12 |
| `ADD-CHILI` | Homemade Signature Chili Sauce 50ml | — |
| `ADD-ICE-TEA` | Iced Java Tea 250ml | — |
| `ADD-MATCHA` | Iced Matcha 250ml | — |

---

## State Machine Checkout

```
initial / none
   └─► awaiting_usecase            (goreng / frozen / pickup?)
          └─► awaiting_product_selection
                 └─► awaiting_addon_reply
                        └─► awaiting_name
                               └─► awaiting_delivery_method  (delivery / pickup)
                                      └─► awaiting_address
                                             └─► awaiting_address_pin_confirm  (1/2/3)
                                                    └─► awaiting_courier_choice
                                                           └─► awaiting_invoice_confirm
                                                                  └─► awaiting_proof
                                                                         └─► pending_finance
                                                                                └─► approved / booked / delivered
```

### States yang Trigger WA Location Request Button

`awaiting_address`, `awaiting_location_retry`, `awaiting_location`
(bukan `awaiting_pin_confirm` — di sana customer reply 1/2/3, bukan share pin)

---

## Admin Panel (admin.js)

### ⚠️ Aturan Wajib: Double-Escape di Template Literal

Semua JS/CSS/HTML ada dalam `const HTML = \`...\`` di `admin.js`. Setiap regex **harus double-escape**:

| Tulis di kode | Artinya |
|---|---|
| `\\s` | `\s` (whitespace) |
| `\\.` | `\.` (literal dot) |
| `\\/` | `\/` (slash) |
| `\\[` | `\[` (bracket) |
| `\\d` | `\d` (digit) |

### setInterval (5 detik)

Auto-refresh chat. **Guard conditions** (jika salah satu true → skip rebuild DOM):
1. `pendingAttachment` — user sedang compose attachment
2. `_ta.value.trim() || activeElement === _ta` — user sedang mengetik
3. `_vid && !_vid.paused` — video sedang diputar
4. `!hasNewMsgs` — tidak ada pesan baru

### Media Flow Admin → Customer

```
📎 klik → popup pilihan
   ├── Foto/Video → imgInput (image/*, video/*) → POST /admin-send-image
   │     └── isVideo? sendWhatsAppVideo() : sendWhatsAppImage()
   │           log: "[video: URL]" atau "[image: URL]"
   └── Dokumen → docInput (.pdf,.doc,.xlsx,...) → POST /admin-send-document
         └── MIME dari extension server-side (csv → text/plain)
               log: "[doc: URL (filename)]"
```

### WA MIME Whitelist (penting)

- CSV: kirim sebagai `text/plain` (WA tolak `text/csv`)
- RAR: tidak didukung — hapus dari accept list
- Video: `mp4/webm/mov/3gpp` → type `video`, bukan `image`

---

## Admin Notification System

Notif ke admin via `SBSR_FINANCE_PHONES` terpicu pada:

| Event | Fungsi |
|---|---|
| Pesan baru masuk (non-admin) | `_adminNotifLastSent` — cooldown 30 menit per customer |
| Customer minta admin handoff | `tryHandleAdminHandoff()` |
| LLM deteksi eskalasi | `tryHandleEscalation()` |
| Customer pilih "sambungkan admin" di flow pin | `notifySbsrAdminsText()` |
| Bukti bayar masuk | `notifyPaymentProofAdmins()` |

> **⚠️ 24h Window**: Notif hanya terkirim jika nomor admin sudah chat ke bot dalam 24 jam terakhir. Minta admin kirim pesan apapun ke bot untuk buka window. Solusi permanen: WA Message Template.

---

## Goreng/Frozen Loop — Root Cause & Fix

### Root Cause (Split-Brain State)

Bot punya dua "otak" yang state-nya tidak tersinkronisasi:
- **Bridge deterministic** — simpan state di draft file via `saveSbsrDraft()` (116 call)
- **OpenClaw LLM** — session memory sendiri, tidak tahu apa yang bridge tulis ke draft

Loop terjadi karena gap antara Gate yang tanya dan handler yang nulis jawaban:

```
Gate #1 (line ~3687, tryHandleAddressAndQuote):
  ambiguousRisol = items.filter(it => !it.form)  →  tanya "goreng atau frozen?"
  setPendingBridgeContext(...)  →  return true (tunggu jawaban)

Customer jawab "goreng"
  → LLM klasifikasi sebagai choose_option/place_order
  → LLM reply natural: "Oke Kak, risol goreng ya!"
  → TIDAK ADA yang menulis it.form = 'goreng' ke draft items
  → Gate #1 ketemu lagi → tanya lagi → loop ♾️
```

Gate #2 (line ~6670, WA location handler) punya pola yang persis sama.

### Fix: `tryHandleFormClarification()`

Handler deterministic baru yang jalan **sebelum** LLM classifier. Logika:
1. Cek apakah ada Risol items dengan `form === null` di draft
2. Match jawaban customer: `goreng|frozen|matang|mentah|siap makan`
3. Bulk-update semua null-form items dengan form yang dijawab
4. Hapus `pending_bridge_context`
5. Kirim konfirmasi ke customer
6. Re-trigger `tryHandleAddressAndQuote()` jika alamat sudah ada di draft

Tidak mengubah gate, state machine, atau LLM path — hanya menutup gap yang ada.

### Yang Belum Diselesaikan (Long-Term)

Fix ini menutup gap paling umum, tapi root cause sejati adalah arsitektur dua-otak.
Solusi permanen: rebuild ke **one-brain agent+tools pattern** (Rosalie pattern) —
satu agen yang owns state dan conversation, tools deterministic untuk hitung harga/ongkir.
Lihat `CRITICAL-FINDINGS-sbsr.md` untuk detail.

---

## Webhook Dedup (Idempotency)

**Aktif secara default.** Meta WA Cloud API bersifat at-least-once delivery — jika bridge tidak ACK dalam ~5 detik, Meta retry dengan `message_id` yang sama. Tanpa dedup, `handleMessage()` dipanggil dua kali → customer menerima reply duplikat.

### Mekanisme

`shouldDedupeMessageId(messageId)` di `server.js` menyimpan `message_id` yang sudah diproses dalam in-memory `Map` dengan TTL 60 detik. Jika `message_id` yang sama datang lagi dalam window tersebut, pesan langsung di-drop.

```js
// Dedup ON secara default — set SBSR_IDEMPOTENT=false untuk disable
if (process.env.SBSR_IDEMPOTENT === 'false') return false;
```

### Catatan Penting

- Dedup berbasis **in-memory** — restart server mengosongkan Map. Ini aman karena TTL Meta retry < 60 detik dan restart bridge biasanya < 5 detik.
- Dedup hanya efektif jika **hanya satu instance** bridge yang terhubung ke nomor WA. Jika ada dua instance (production + testing) pointing ke nomor yang sama, setiap pesan tetap diproses dua kali dari dua proses berbeda.
- Untuk disable sementara (debugging): set `SBSR_IDEMPOTENT=false` di `.env` + restart.

---

## Patch Files (SUDAH DIHAPUS)

File berikut sudah **dihapus** karena one-time migration scripts yang sudah ter-apply ke `server.js`:

| File (dihapus) | Yang dilakukan | Status |
|---|---|---|
| `patch-server.js` | Inject `callLlmRegion/District/Compare`, buat `extractSemanticRegion` async | ✅ Ada di server.js line 2604–2690 |
| `patch-llm.js` | Ganti implementasi callLlm dari child_process → `sendToOpenClaw` | ✅ `callLlmAddr` pakai sendToOpenClaw |
| `patch-callers.js` | Tambah `await` di semua pemanggil fungsi async | ✅ Semua caller sudah await |

---

## Fix-Bugs Log (Notable)

| Tanggal | Bug | Fix |
|---|---|---|
| 2026-06 | HTTP 413 kirim gambar/video besar | Global `express.json()` limit 100kb — skip untuk upload routes |
| 2026-06 | CSV ditolak WA API (400) | WA tolak `text/csv` — derive MIME dari extension, CSV → `text/plain` |
| 2026-06 | Video tersimpan sebagai `.jpg` | Extension detection hanya handle png/gif — tambah video MIME |
| 2026-06 | Video reset saat diputar | `setInterval` rebuild DOM tiap 5s — skip jika video playing atau no new msgs |
| 2026-06 | Location button tidak muncul setelah terima alamat | `sendSbsrLocationPromptMessage` gate pada state — bypass langsung `sendWhatsAppLocationRequest` |
| 2026-06 | "ok/oke" trigger restart session | Hapus ok/oke dari `SBSR_RESTART_INTENT_RE` |
| 2026-06 | Customer terima reply duplikat 2-3x | `SBSR_IDEMPOTENT` default OFF — diinvert jadi default ON; dedup aktif tanpa perlu set env var |
| 2026-06 | Bot loop tanya "goreng atau frozen?" berulang | Gap: Gate #1/#2 tanya tapi tidak ada yang nulis jawaban ke `it.form`. Fix: `tryHandleFormClarification()` — handler deterministic sebelum LLM classifier, bulk-update null-form items |
| 2026-06 | Catalog & store config baca dari file | Migrasi ke PostgreSQL (`catalog_products`, `store_config`) — lihat `docs/postgres-catalog.md` |
| 2026-06 | Conversation history hanya di file JSON | Dual-write ke `wa_messages` PostgreSQL + autodelete policy — lihat `docs/postgres-conversations.md` |
