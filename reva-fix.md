# reva-fix.md — SBSR Debloat Notes

Branch: `sbsr-debloat`
Started: 2026-06-28
Author: Reva

---

## 1. Ringkasan Analisis Awal

`server.js` adalah monolith ~11,781 baris. Setelah ditelusuri, hubungannya dengan file-file sekitar:

### Dependency aktif (production path)
| File | Used at | Role |
|---|---|---|
| `lib/prompt-sanitizer.cjs` | L26, L9772, L9778 | Sanitasi input user (injection, template marker, role-swap) |
| `lib/rate-limiter.cjs` | L27, L38 | Token bucket rate limiter per scope (msg/ocr/order) |
| `lib/cost-guard.cjs` | L28, L39, L11229-11276 | Daily LLM cap + soft cap, `canSpend()` + `record()` |
| `lib/draft-policy.cjs` | L31, L9902 | Predikat reset draft customer stale (>6 jam) |
| `lib/courier-choice-parser.cjs` | L35, L5850 | Clause-aware courier parser (fix "bukan paxel, gojek aja") |
| `products.json` | L163 | Catalog/addon/FAQ fallback (secondary, API-based primary) |

### Artefak historis (patch scripts — SUDAH DIAPPLY)
| File | Status |
|---|---|
| `patch-server.js` | Layer 1 — LLM wrapper insert + async extractSemanticRegion. Applied. |
| `patch-callers.js` | Layer 2 — await call sites (5 locations). Applied. |
| `patch-llm.js` | Layer 3 — child_process → sendToOpenClaw. Applied. |
| `fix-bugs.js` | 4 priority bugs (region matching + addon qty + OOC detection + pickup). Applied. |


## Notes Tambahan

### Pattern yang harus dipertahankan
- `try/catch` fail-open: tiap module `lib/` di-load dengan fallback no-op
- Logging via `console.log(JSON.stringify({ts, level, msg, ...}))` — structured logging
- Environment variable prefix: `SBSR_*`, `LLM_*`, `OPENCLAW_*`, `WA_*`
- `secLib` wrapper object (L43) — abstraction untuk security libs

### Yang nggak boleh diubah tanpa koordinasi
- `sendToOpenClaw()` — core communication ke OpenClaw LLM gateway (WebSocket v3 protocol)
- `sendWhatsAppMessage()` — core output ke WhatsApp API
- `loadSbsrDraft()` / `saveSbsrDraft()` — state persistence
- `handleMessage()` — entry point utama webhook

### PR target
Branch ini target ke `master`. Semua perubahan harus backward compatible — tidak boleh break production flow.

---

## 1. Log Perubahan

### 2026-06-28
- [x] Branch `sbsr-debloat` dibuat dari master
- [x] `reva-fix.md` dibuat sebagai shared notes
