# wa-bridge/lib — colocated hardening libs

> These `.cjs` files are **mirrors** of [`../scripts/lib/`](../../scripts/lib/) so [`../server.js`](../server.js) can `require('./lib/<name>.cjs')` without a relative path that would break on the VPS (where `wa-bridge/` and `scripts/` are deployed to separate paths).

## Lockstep pattern

The repo already maintains a `.mjs` / `.cjs` lockstep pair under [`scripts/lib/`](../../scripts/lib/) for the same reason — script-side code is ESM, bridge-side is CommonJS. This folder is the **third** mirror, deployed alongside the bridge.

| Canonical (ESM, scripts) | CJS twin (scripts) | Bridge mirror (this folder) |
|---|---|---|
| `scripts/lib/prompt-sanitizer.mjs` | `scripts/lib/prompt-sanitizer.cjs` | `wa-bridge/lib/prompt-sanitizer.cjs` |
| `scripts/lib/rate-limiter.mjs` | `scripts/lib/rate-limiter.cjs` | `wa-bridge/lib/rate-limiter.cjs` |
| `scripts/lib/cost-guard.mjs` | `scripts/lib/cost-guard.cjs` | `wa-bridge/lib/cost-guard.cjs` |

## Update rule

When you change `scripts/lib/<name>.mjs`, you must:

1. Update `scripts/lib/<name>.cjs` (existing rule)
2. Copy the resulting `.cjs` here: `cp scripts/lib/<name>.cjs wa-bridge/lib/<name>.cjs`
3. Re-run `bash scripts/preflight-tests.sh` — same green tests cover all three because they share source.

A future improvement is to make the `.cjs` files thin re-exports of an internal canonical module, eliminating the lockstep. Not doing that today because the `.cjs` files are short enough that drift is easy to spot and the savings don't justify the refactor.
