# SBSR Bot — Critical Findings & Fix Path

**Repo:** `KrisParjaman/wa-webhook-sbsr` (`master`)
**Reviewed:** 2026-06-28 · code read directly (`server.js`, 561 KB)
**Lens:** ponytail (fix root cause, not symptom; delete over add)
**Audience:** engineering team + any AI/LLM agent assisting the fix.

> The production complaint: the bot keeps re-asking "risol goreng atau frozen?" even
> after the customer answers, and sometimes sends the same message 2–3× in a row. The
> admin gave up and placed the GoSend order manually. This document explains exactly why,
> with evidence, and the prioritized path to fix. **It does not touch `master`.**

---

## TL;DR

There are **two root causes**, both already visible in the code (one is even documented in a comment):

1. **Split-brain state** → the *loop*. A deterministic bridge and the OpenClaw LLM keep
   **separate, unsynchronized state**. One brain registers the "goreng" answer; the other
   doesn't — so the bot re-asks.
2. **Webhook dedup is OFF by default** → the *duplicate messages*. WhatsApp delivers
   at-least-once; without dedup, retries are processed twice.

The team's current plan (Postgres catalog + conversation storage) addresses neither.

---

## CRITICAL FINDING #1 — Split-brain state machine (root cause of the loop) 🔴 P0

The architecture runs **two brains** over the same conversation, each with its own state:

- a **deterministic bridge**: `tryHandle*` interceptors that reply directly and `return true`
  (skipping the LLM), persisting to per-phone draft files via `saveSbsrDraft(...)`.
- the **OpenClaw LLM**: its own session memory.

**The team already documented the bug** — `server.js:~2198`:

> "When a tryHandle* interceptor responds to the customer DETERMINISTICALLY (skipping LLM),
> OpenClaw's session has zero record of what the bridge said. The next customer message hits
> the LLM with stale context → it re-asks for info already provided, or fabricates progress."

### Why "goreng atau frozen?" loops
- The quote gate refuses to proceed while any Risol item lacks a `form`:
  `server.js:3604` → `ambiguousRisol = items.filter(it => /Risol/.test(it.name) && !it.form)`.
- The **native-location handler independently re-checks and re-asks** the same question:
  `server.js:6593` → "…cart masih ambigu goreng/frozen…".
- When the customer answers "goreng", the answer is **acknowledged conversationally but not
  reliably written onto the draft items' `.form`** that these gates read (the two brains don't
  sync). So the next gate sees `!it.form` again → re-asks. Forever.

### Severity of the fragmentation (evidence)
- **60** references to the goreng/frozen question across `server.js` (many independent gates).
- **116** `saveSbsrDraft(...)` calls — state is written from dozens of places; no single owner.
- Band-aids already added on top: `_clarify_count` (`server.js:7453`), a "missing-form
  clarification re-parse" path (`server.js:8186`), and the bridge↔LLM "context sync" shim
  (`server.js:~2198`). These treat the symptom, not the cause.

### Fix (root cause)
**One brain, one state.** Collapse to a single agent that owns *both* the conversation and the
order (cart/form/recipient) in one state object, using deterministic **tools** for anything
involving money — exactly the Rosalie `rearch/agent` pattern. There is then nothing to "sync"
because there is only one source of truth. Ponytail: **delete the second brain and the 60 gates**,
do not add gate #61.

---

## CRITICAL FINDING #2 — Webhook dedup OFF by default (duplicate messages) 🔴 P0

`server.js:2155`:

```js
if (process.env.SBSR_IDEMPOTENT !== 'true') return false;   // dedup disabled unless env set
```

WhatsApp Cloud API is **at-least-once** delivery. With dedup off, a retried `message_id` is
processed twice → the customer sees the same prompt 2–3× (visible in the screenshots).

The webhook itself acks fast (`server.js:11559` calls `res.sendStatus(200)` before processing),
so this is **not** a slow-ack problem — it's purely the missing dedup default.

### Fix
1. **Now:** set `SBSR_IDEMPOTENT=true` in the env, restart.
2. **Code:** make dedup **default-on** (invert the guard) so a forgotten env var can't reintroduce it.
3. **Verify ONE instance** answers the number. The team said "production arahin ke branch testing" —
   if both the test branch and prod are wired to the same WhatsApp number's webhook, **every**
   reply doubles regardless of dedup.

---

## CRITICAL FINDING #3 — 561 KB single-file monolith, patched to death 🟠 P1

- `server.js` = **561,729 bytes** in one file.
- Surrounded by `patch-server.js`, `patch-llm.js`, `patch-callers.js`, `fix-bugs.js`.
- 60 goreng/frozen gates, 116 state writes, multiple clarification counters.

Every fix adds another interceptor/patch; root causes are never removed. This is the same
trajectory Rosalie's bridge was on before it was re-architected. Ponytail verdict: the file is
the problem — **stop patching, rebuild small.**

### Fix
Re-architect on the agent pattern (below). SBSR is *simpler* than Rosalie (≈14 Risol SKUs +
add-ons), so the rebuild is smaller than it looks.

---

## CRITICAL FINDING #4 — The current plan (Postgres catalog / memory) does not fix the loop 🟡 P2

- **Postgres for the catalog** — useful for product management, but **irrelevant** to the loop
  (the loop is split-brain state, not catalog storage).
- **Conversation storage in Postgres** — only helps if it becomes the **single source of truth
  for ONE brain.** With two brains, better storage does not synchronize unsynced state; it will
  still loop.
- The "yesterday's conversation still sticks" concern is real but **separate** (stale session);
  a clean per-session state with an explicit reset solves it — which the single-agent
  architecture provides for free.

**Conclusion:** the team is optimizing storage while the actual fire is a split-brain state
machine. Sequence the work accordingly.

---

## Path to fix (prioritized)

| When | Action | Kills |
|---|---|---|
| **Tonight** | `SBSR_IDEMPOTENT=true` + confirm only ONE instance is wired to the number | the duplicate sends |
| **This week** | Make the goreng/frozen answer write to the ONE draft *and* sync to the LLM — OR start collapsing to one brain | the loop |
| **The real fix** | Rebuild on the agent + tools pattern (one brain, one state, deterministic tools for money) | the whole class of bugs |

## Target architecture (the Rosalie pattern that worked)

```
WhatsApp ─webhook→ ONE agent
   Understand → LLM reads natural language (no regex deciding intent)
   Decide/$$  → deterministic TOOLS the agent calls (add_item, set_form, quote_ongkir, invoice)
                ← the ONLY place money/state is computed; single source of truth
   Speak      → LLM writes the reply (warm, sells), money injected from tools
```

Principles (carry these into SBSR):
- **One brain, one state.** No deterministic interceptors holding a parallel state.
- **LLM never computes money.** Prices/ongkir/total come from tools/code only.
- **Regex never decides intent; templates never write the voice.**
- **Dedup on by default.** One instance per number.
- **Ponytail:** remove root causes; do not add gate #61.

---

*Prepared as input for the team. Master branch untouched. Evidence cited as `server.js:<line>`.*
