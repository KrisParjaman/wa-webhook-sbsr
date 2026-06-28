# Codebase Notes — wa-webhook-sbsr

> Terakhir diupdate: 2026-06-28

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

| Var | Keterangan |
|---|---|
| `WA_CATALOG_ID` | ID katalog WA Business (hardcoded fallback: `1477386560782761`) |
| `SBSR_FINANCE_PHONES` | Nomor admin yang menerima notif (comma-separated) |
| `SBSR_KITCHEN_PHONES` | Nomor dapur (bypass rate limit & killswitch) |
| `SBSR_PAUSE` | `1` = mode maintenance, semua pesan dibalas teks maintenance |
| `SBSR_OPS_ESCALATION_PHONE` | Nomor ops untuk escalation saat PAUSE mode |
| `SBSR_DAILY_LLM_CAP_USD` | Batas biaya LLM harian (default $5) |

---

## Katalog Produk — Alur Data

```
WA Business Catalog API (live, sync tiap 5 menit)
   catalogMap      → SKU → nama produk
   catalogPrices   → SKU → harga (Rp)
   catalogAvailability → SKU → stok status
         │
         ▼
   formatCatalogForLLM()   — konteks LLM, harga live
   formatSbsrFullMenuText() — teks menu ke customer
         │
   products.json (FALLBACK jika WA API gagal)
         │   digunakan untuk:
         │   - p.store.kurir, p.store.location (metadata toko)
         │   - p.faq (FAQ)
         │   - variants/prices jika catalogPrices kosong
         │
   catalog-map.json (STATIC, selalu loaded)
         │   digunakan untuk:
         │   - SKU → nama saat WA API belum sync
         │   - Order parsing fallback
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
