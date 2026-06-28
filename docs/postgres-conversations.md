# PostgreSQL Conversations — Architecture & Developer Guide

Dokumen ini menjelaskan bagaimana pesan customer disimpan di PostgreSQL, batasan per-user, dan autodelete policy yang diterapkan.

---

## Tabel `wa_messages`

```sql
CREATE TABLE wa_messages (
  id         BIGSERIAL PRIMARY KEY,
  phone      TEXT NOT NULL,
  dir        TEXT NOT NULL CHECK (dir IN ('in', 'out')),
  text       TEXT NOT NULL DEFAULT '',
  ts         BIGINT NOT NULL,       -- epoch milliseconds
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX wa_messages_phone_created ON wa_messages (phone, created_at DESC);
```

| Kolom | Keterangan |
|---|---|
| `phone` | Nomor WA customer tanpa `+`, e.g. `628123456789` |
| `dir` | `in` = pesan masuk dari customer, `out` = pesan keluar dari bot/admin |
| `text` | Isi pesan, max 10.000 karakter |
| `ts` | Timestamp epoch ms (sama dengan storage file `admin.js`) |
| `created_at` | Waktu insert ke PostgreSQL |

Tabel dibuat otomatis (`CREATE TABLE IF NOT EXISTS`) saat server pertama kali start — tidak perlu manual migration.

---

## Konfigurasi Retention

Diatur via environment variable di `/docker/wa-webhook-sbsr/.env`:

```env
# Hapus pesan lebih lama dari N hari (default: 90)
WA_MSG_RETENTION_DAYS=90

# Maksimal pesan tersimpan per nomor telepon (default: 500)
WA_MSG_MAX_PER_PHONE=500
```

---

## Alur Data (Flow Diagram)

```
┌─────────────────────────────────────────────────────────────┐
│                   PESAN MASUK / KELUAR                       │
└─────────────────────────────────────────────────────────────┘
         │
         ▼
   logIncoming(phone, text) / logOutgoing(phone, text)
   [admin.js]
         │
         ├──── fire-and-forget ──────────────────────────────►  PostgreSQL
         │     INSERT INTO wa_messages (phone, dir, text, ts)    wa_messages
         │                                                             │
         └──── serialized via withLock() ──────────────────►  File JSON
               writeChatAtomic(phone, chat)                   /chats/<phone>.json
               (admin panel tetap baca dari sini)


┌─────────────────────────────────────────────────────────────┐
│                   SERVER STARTUP                             │
└─────────────────────────────────────────────────────────────┘
         │
         ├──► ensureWaMessagesTable()
         │         └── CREATE TABLE IF NOT EXISTS wa_messages
         │             CREATE INDEX IF NOT EXISTS ...
         │
         └──► pruneOldMessages()   ◄──── setiap 24 jam
                   │
                   ├── DELETE WHERE created_at < now() - WA_MSG_RETENTION_DAYS days
                   │
                   └── DELETE excess rows WHERE rn > WA_MSG_MAX_PER_PHONE per phone
```

---

## Dual-Write Strategy

PostgreSQL dan file JSON diisi **secara paralel**:

| Storage | Tujuan | Dibaca oleh |
|---|---|---|
| `/chats/<phone>.json` | Admin panel UI (real-time) | `admin.js`, `findNameInChatHistory()` |
| `wa_messages` (PostgreSQL) | Retention, analytics, LLM context future | `server.js` queries |

PG insert adalah **fire-and-forget** — kegagalan insert ke PG tidak memblokir file write dan tidak mengganggu bot.

---

## Autodelete Policy

Cleanup dijalankan oleh `pruneOldMessages()` di `server.js`:

### 1. Time-based (expired messages)
```sql
DELETE FROM wa_messages
WHERE created_at < now() - (WA_MSG_RETENTION_DAYS || ' days')::interval;
```
Default: hapus pesan lebih dari **90 hari**.

### 2. Per-phone row limit (excess messages)
```sql
DELETE FROM wa_messages
WHERE id IN (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (PARTITION BY phone ORDER BY ts DESC) AS rn
    FROM wa_messages
  ) ranked WHERE rn > WA_MSG_MAX_PER_PHONE
);
```
Default: simpan maksimal **500 pesan terbaru** per nomor telepon.

### Kapan dijalankan
- Saat server startup (setelah tabel berhasil dibuat)
- Setiap **24 jam** via `setInterval`

---

## Query Berguna untuk Developer

```sql
-- Lihat percakapan terbaru suatu nomor (50 pesan terakhir)
SELECT dir, text, to_timestamp(ts/1000) AS time
FROM wa_messages
WHERE phone = '628123456789'
ORDER BY ts DESC
LIMIT 50;

-- Hitung total pesan per nomor
SELECT phone, COUNT(*) AS total,
       SUM(CASE WHEN dir='in' THEN 1 ELSE 0 END) AS inbound,
       SUM(CASE WHEN dir='out' THEN 1 ELSE 0 END) AS outbound
FROM wa_messages
GROUP BY phone
ORDER BY total DESC;

-- Cek pesan paling lama yang tersimpan
SELECT MIN(created_at), MAX(created_at), COUNT(*) FROM wa_messages;

-- Manual prune (jalankan jika perlu segera)
DELETE FROM wa_messages WHERE created_at < now() - interval '90 days';
```

---

## Catatan Penting

- File JSON di `/chats/` **tidak dihapus** oleh autodelete policy ini — itu storage terpisah untuk admin panel.
- Jika ingin mengubah retention tanpa restart, update `.env` lalu `pm2 restart wa-bridge-sbsr`.
- `wa_messages` belum digunakan sebagai sumber LLM context — saat ini `findNameInChatHistory()` masih baca file JSON. Integrasi LLM context dari PG bisa ditambahkan sebagai next step.
