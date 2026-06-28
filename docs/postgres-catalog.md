# PostgreSQL Catalog — Architecture & Developer Guide

Dokumen ini menjelaskan bagaimana data katalog produk Sentuh Rasa disimpan di PostgreSQL, di-sync dari Meta Catalog API, dan dikonsumsi oleh LLM (Mintu bot).

---

## Konfigurasi Environment

Connection string PostgreSQL dikonfigurasi via environment variable:

```
POSTGRES_URL=postgresql://sbsr:BiksSecur3Pasan@2026@127.0.0.1:5432/sbsr
```

**Lokasi di server:** `/docker/wa-webhook-sbsr/.env`

File `.env` ini di-load oleh `dotenv` di baris pertama `server.js`:
```js
require("dotenv").config({ path: __dirname + "/.env" });
```

Pool koneksi dibuat di `server.js` setelah require WebSocket:
```js
const { Pool } = require("pg");
const pgPool = new Pool({ connectionString: process.env.POSTGRES_URL });
```

---

## Tabel PostgreSQL

### `catalog_products`
Persistent cache dari Meta WhatsApp Catalog API. Di-upsert setiap kali Meta API berhasil di-poll (setiap 5 menit).

| Kolom | Tipe | Keterangan |
|---|---|---|
| `retailer_id` | TEXT PK | ID produk di Meta Catalog, e.g. `RA-6`, `RM-FRZ` |
| `name` | TEXT | Nama produk, e.g. `Risol Goreng Ayam Sayur 6pcs` |
| `price` | INTEGER | Harga dalam IDR (Rupiah penuh), e.g. `28000` |
| `availability` | TEXT | Status stok dari Meta: `in stock`, `out of stock`, dsb |
| `updated_at` | TIMESTAMPTZ | Timestamp terakhir di-upsert dari Meta API |

### `store_config`
Konfigurasi toko yang menggantikan `products.json`. Berisi data yang jarang berubah.

| Kolom | Tipe | Keterangan |
|---|---|---|
| `key` | TEXT PK | Identifier: `store_info`, `categories`, `faq` |
| `value` | JSONB | Data lengkap dalam format JSON |
| `updated_at` | TIMESTAMPTZ | Timestamp terakhir diupdate |

**Rows yang ada:**
- `store_info` — nama toko, alamat, kurir, add-on (chili sauce, thermal bag)
- `categories` — daftar kategori produk (goreng, frozen) beserta variants, aliases, price tiers
- `faq` — FAQ yang bisa dijawab Mintu tanpa LLM call

---

## Alur Data (Flow Diagram)

```
┌─────────────────────────────────────────────────────────┐
│                     SERVER STARTUP                       │
└─────────────────────────────────────────────────────────┘
         │
         ├──► warmProductCatalogCache()
         │         │
         │         └── SELECT key, value FROM store_config
         │                   │
         │                   └──► _productCatalogCache = { store, categories, faq }
         │
         └──► loadCatalogFromDB()
                   │
                   └── SELECT retailer_id, name, price, availability FROM catalog_products
                             │
                             └──► catalogMap{} + catalogPrices{} + catalogAvailability{}
                                       │
                                       └──► refreshCatalogFromAPI()  ←── setiap 5 menit
                                                 │
                                                 └── GET graph.facebook.com/.../products
                                                           │
                                                           ├──► Update in-memory catalogMap/catalogPrices/catalogAvailability
                                                           │
                                                           └──► UPSERT catalog_products (fire-and-forget)


┌─────────────────────────────────────────────────────────┐
│                  CUSTOMER KIRIM PESAN                    │
└─────────────────────────────────────────────────────────┘
         │
         ▼
   [wa-webhook POST /webhook]
         │
         ▼
   formatCatalogForLLM()
         │
         ├── loadProductCatalog()          → _productCatalogCache (dari store_config PG)
         │       └── store.addons, faq, dsb
         │
         └── catalogMap + catalogPrices    → in-memory (warmup dari catalog_products PG)
                   │
                   ▼
         Context string untuk LLM:
         "===== CATALOG SENTUH RASA (HARGA LIVE DARI META) ====="
         "RA-6: Risol Goreng Ayam Sayur 6pcs = Rp28.000"
         ...
                   │
                   ▼
         [OpenClaw / LLM API]  ←── Mintu menjawab customer berdasarkan catalog ini
```

---

## Fungsi Kunci di `server.js`

| Fungsi | Tipe | Keterangan |
|---|---|---|
| `loadCatalogFromDB()` | async | Startup: load `catalog_products` ke `catalogMap`, `catalogPrices`, `catalogAvailability` |
| `warmProductCatalogCache()` | async | Startup: load `store_config` ke `_productCatalogCache` |
| `refreshCatalogFromAPI()` | async | Setiap 5 menit: poll Meta API, update in-memory, UPSERT ke `catalog_products` |
| `loadProductCatalog()` | sync | Kembalikan `_productCatalogCache` (sudah di-warm dari PG) |
| `formatCatalogForLLM()` | sync | Bangun string konteks produk untuk dikirim ke LLM |
| `lookupProductName(rid)` | sync | Lookup nama produk dari `catalogMap` |
| `lookupProductPrice(rid)` | sync | Lookup harga dari `catalogPrices` |
| `lookupProductAvailability(rid)` | sync | Lookup status stok dari `catalogAvailability` |

---

## Update Data Produk

### Harga / nama produk
Update langsung di Meta WhatsApp Catalog Manager → harga akan otomatis masuk ke PostgreSQL dalam ≤5 menit (saat `refreshCatalogFromAPI()` jalan berikutnya).

### Store info, FAQ, kurir, add-on
Update langsung di PostgreSQL:
```sql
UPDATE store_config
SET value = '{"name":"Sentuh Rasa","location":"...","kurir":[...],"addons":[...]}',
    updated_at = now()
WHERE key = 'store_info';
```
Efektif setelah `pm2 restart wa-bridge-sbsr` (karena `_productCatalogCache` di-warm saat startup).

### Tambah produk baru
1. Tambahkan produk di Meta Catalog Manager → otomatis masuk via `refreshCatalogFromAPI()`
2. Update `categories` di `store_config` jika perlu menambahkan alias atau deskripsi baru

---

## Migrasi dari File ke PostgreSQL

File lama yang sudah **tidak dipakai** sebagai sumber data:
- `catalog-map.json` — digantikan oleh tabel `catalog_products`
- `products.json` — digantikan oleh tabel `store_config`

Kedua file masih ada di repo sebagai referensi historis dan tidak perlu dihapus, tapi `server.js` tidak lagi membacanya.
