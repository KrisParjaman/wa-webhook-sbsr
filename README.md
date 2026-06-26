# wa-bridge-sbsr

> WhatsApp Cloud API bridge untuk **Sentuh Rasa** (SBSR).  
> Berjalan di droplet `biks-droplet` (206.189.34.228) — `/docker/wa-webhook-sbsr/`  
> Reverse proxy: **Caddy** → `https://production.biks.ai/admin`

## Status Proyek — **ACTIVE / PRODUCTION** ✅

Bridge ini udah berjalan di production. Bukan lagi turunan Beeru — banyak patch & fitur tambahan sendiri.

---

## Fitur Admin Panel (`/admin`)

| Fitur | Status |
|---|---|
| **Chat history** — lihat riwayat percakapan per nomor | ✅ |
| **Kirim teks** — balas chat dari panel admin | ✅ |
| **Kirim gambar** — upload & kirim gambar ke WhatsApp | ✅ |
| **Preview gambar** — thumbnail preview di chat thread (incoming & outgoing) | ✅ |
| **Image composer** — pilih gambar 📷 → preview muncul di atas textarea → ketik caption → kirim | ✅ |
| **Smart scroll** — scroll-to-bottom cuma kalo user di bottom; kalo lagi liat history, ga ke-scroll paksa | ✅ |
| **Real-time refresh** — chat otomatis refresh tiap 5 detik, tapi skip kalo user lagi ngetik/nge-select gambar | ✅ |
| **CSRF protection** — header `x-admin-request` | ✅ |
| **Basic auth** — username/password | ✅ |

## Endpoint API

| Method | Path | Fungsi |
|---|---|---|
| `GET` | `/admin` | Panel admin UI |
| `GET` | `/admin/api/chats` | List semua chat |
| `GET` | `/admin/api/chat/:phone` | Detail chat per nomor (JSON) |
| `POST` | `/admin/api/send` | Kirim pesan teks |
| `POST` | `/admin-send-image` | Kirim gambar (base64 JSON body) |
| `GET` | `/admin/api/stats` | Statistik |
| `POST` | `/admin/api/pause` | Pause/resume bot |
| `POST` | `/admin/api/mark-read` | Tandai chat sudah dibaca |

---

## Struktur Folder

```
/docker/wa-webhook-sbsr/
├── admin.js            # Frontend admin panel (HTML + CSS + JS inline)
├── server.js           # Backend (Express, WhatsApp API, routing)
├── .env                # Environment variables (WA creds, dll)
├── .gitignore
├── package.json
├── chats/              # Data chat per nomor (JSON files)
├── receipts/           # Gambar receipt customer (dari webhook)
├── assets/             # Static assets
├── lib/                # Library files
├── scripts/            # Utility scripts
├── tools/
└── node_modules/
```

### Path Gambar

- **Customer receipts** → `receipts/` (di-serve Caddy via `https://production.biks.ai/receipts/`)
- **Admin outgoing images** → disimpan di `/docker/openclaw-sbsr/data/sentuhrasa-pdf/uploads/` dengan prefix `ADMIN-IMG-`
- Format log di chat: `[image: URL_public] caption`

---

## Deployment

```bash
# Path server
/docker/wa-webhook-sbsr/

# PM2 process
pm2 start server.js --name wa-bridge-sbsr

# Reverse proxy (Caddy)
production.biks.ai {
    handle /admin* {
        reverse_proxy 127.0.0.1:3001
    }
    handle /receipts/* {
        root * /docker/openclaw-sbsr/data/sentuhrasa-pdf/uploads
        file_server
    }
    handle {
        reverse_proxy 127.0.0.1:3001
    }
}
```

## Catatan Penting

1. **port:** 3001 (Caddy → proxy ke localhost:3001)
2. **admin.js** — semua kode frontend di-embed dalam template literal `const HTML = \`...\`;` di Node.js. Hati-hati pake backslash (double-escape untuk regex!)
3. **Double-escape:** Di dalam template literal, `\s` harus ditulis `\\s`, `\.` → `\\.`, `\/` → `\\/`
4. **Image sending** pake base64 JSON (bukan multipart form-data) biar lebih reliable
5. **File upload limit:** 15mb (server-side JSON body parser)

## Dev Notes

- Origin: turunan dari Beeru (`/docker/wa-webhook-beeru/`), tapi sekarang banyak perbedaan
- Repository GitHub: https://github.com/KrisParjaman/wa-webhook-sbsr
- Terakhir update: **26 Juni 2026** — image preview, smart scroll, send image, fix double-escape
