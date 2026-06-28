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
- [x] **Phase 1: Dead code removal** — hapus 5 file (-712 lines): fix-bugs.js, patch-llm.js, patch-callers.js, patch-server.js, llm-router.js
- [x] **Phase 2: Extract shared libs** — 3 module baru:
  - `lib/address-matcher.cjs` (240 lines, 14 fungsi, DI: sendToOpenClaw)
  - `lib/addon-parser.cjs` (114 lines, 7 fungsi, pure)
  - `lib/qdrant-memory.cjs` (247 lines, 15 fungsi, DI: log)
- [x] **Phase 3: Engine v2 (context + pipeline)** — arsitektur baru:
  - `lib/engine/context.cjs` — ctx factory (single object per turn)
  - `lib/engine/pipeline.cjs` — middleware chain (route → handle → reply → save)
  - `lib/engine/pipeline-route.cjs` — state-based handler registry
- [x] **Phase 4: Handler extraction** — 4 handler ctx-based:
  - `lib/handlers/handler-cancel.cjs` — cancel/restart/reset escape hatches
  - `lib/handlers/handler-faq.cjs` — deterministic FAQ matching (10 patterns)
  - `lib/handlers/handler-ooc.cjs` — out-of-context detection + smart LLM reply
  - `lib/handlers/handler-greeting.cjs` — welcome + menu routing

### Final stats
- `server.js`: 11,781 → **11,474 lines** (-307)
- Dead files removed: **5 files, -712 lines**
- New modules: **10 files, +1,404 lines** (engine + handlers + libs)
- Total module count: **16 lib files**
- Syntax check: **ALL 15 FILES PASSED**

### Architecture
```
server.js (11,474 lines — webhook entry + existing handlers)
│
├── lib/engine/          ← v2 pipeline (3 files, 412 lines)
│   ├── context.cjs      ← ctx factory
│   ├── pipeline.cjs     ← middleware chain
│   └── pipeline-route.cjs ← handler registry
│
├── lib/handlers/        ← ctx-based handlers (4 files, 420 lines)
│   ├── handler-cancel.cjs
│   ├── handler-faq.cjs
│   ├── handler-greeting.cjs
│   └── handler-ooc.cjs
│
├── lib/                 ← shared modules (8 files, 1,172 lines)
│   ├── address-matcher.cjs  ← region/district matching
│   ├── addon-parser.cjs     ← addon parsing
│   ├── qdrant-memory.cjs    ← vector memory
│   ├── prompt-sanitizer.cjs ← security sanitization
│   ├── rate-limiter.cjs     ← rate limiting
│   ├── cost-guard.cjs       ← LLM cost guard
│   ├── draft-policy.cjs     ← draft reset predicates
│   └── courier-choice-parser.cjs ← courier parsing
│
└── reva-fix.md          ← these notes
```

### Pattern: ctx-based handler
```js
module.exports = {
  match: (state, ctx) => CANCEL_RE.test(ctx.text),
  handler: async (ctx) => {
    ctx.updateDraft({ state: 'initial', items: [] });
    ctx.replyText = 'Siap Kak, dibatalkan 🤍';
    ctx.handled = true;
  },
};
```

### Next steps (future PRs)
- Migrate remaining ~35 tryHandle* functions to ctx pattern
- Move security guards (rate-limit, sanitize) from handleMessage to pipeline-guard
- Add unit tests for each handler (mock ctx)
- Extract maps/geocode utilities into lib/maps-geocode.cjs
- Extract catalog formatting into lib/catalog-formatter.cjs
- Reduce server.js to ~300 lines (webhook + init only)
