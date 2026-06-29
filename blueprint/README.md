# SBSR Bot — Single-Agent Blueprint (proven, runnable)

The smart rebuild: ONE LLM agent that converses, knows the products (sells), and
calls DETERMINISTIC tools for the cart — so it's smart AND can't hallucinate money.
Mirrors Rosalie's `rearch/agent` pattern. Fixes every bug in the production complaint.

## Files
- `sbsr-catalog.mjs` — single source of truth (real menu: goreng 3/6/12, frozen 6, 5 variants).
- `sbsr-agent.mjs` — the brain (DeepSeek tool-calling): persona = `customer-service-excellence.md`,
  tools add/view/update/remove cart + checkout. LLM never computes price/total.
- `sbsr-agent-sim.mjs` — chat offline.
- `customer-service-excellence.md` — the CS/sales persona baked into the system prompt.
- `CRITICAL-FINDINGS-sbsr.md` — why the current bot fails + the fix path.
- `TASK-BOARD-sbsr.html` — who builds what, deadlines.

## Try it
```bash
DEEPSEEK_API_KEY=sk-... node blueprint/sbsr-agent-sim.mjs --demo
DEEPSEEK_API_KEY=sk-... node blueprint/sbsr-agent-sim.mjs        # interactive
```

## Verified live (DeepSeek) — all production bugs fixed
- "apa yang favorit?" → real recommendation + sells (was: generic greeting)
- "Risol ayam 6pcs goreng" → Rp55.000 correct (was: wrong "3pcs Rp29.000")
- "pesanan saya apa aja?" → lists cart accurately (was: "kurang yakin")
- "tambah X" mid-order → cart intact; goreng/frozen asked ONCE

## Integrate (do NOT start from zero — mirror this)
1. Webhook → `runAgent({messages, order})` → reply. Persist `messages`+`order` per phone (Postgres = one source of truth).
2. Add checkout tools: location→ongkir (Biteship), invoice, QRIS, payment-proof→admin.
3. One instance per number; dedup default-on.

## Full checkout (added)
- `sbsr-shipping.mjs` — deterministic ongkir (Biteship; distance-estimate fallback) + invoice.
- `sbsr-agent-bridge.mjs` — production webhook: text→agent, **location→ongkir→invoice→QRIS**,
  payment image→admin, dedup ON by default, fast ack, per-phone state. Run: `node blueprint/sbsr-agent-bridge.mjs`.

Verified E2E (sim + live DeepSeek): recommend → order (2× Ayam Sayur goreng 6pcs = Rp110.000)
→ dikirim → nama+alamat → location → ongkir Rp12.000 → invoice **TOTAL Rp122.000** → QRIS →
payment proof → admin notified. Set `SBSR_ORIGIN_LAT/LNG` to the real store coords before live.
