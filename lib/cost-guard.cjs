// cost-guard.cjs — CommonJS twin of cost-guard.mjs.
// Keep in lockstep with lib/cost-guard.mjs — see that file for design notes.

const { readFileSync, writeFileSync, mkdirSync, renameSync } = require('node:fs');
const { dirname } = require('node:path');

function readJSON(path, fallback = null) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { return fallback; }
}
function writeJSON(path, obj) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + '.tmp.' + process.pid;
  writeFileSync(tmp, JSON.stringify(obj, null, 2));
  renameSync(tmp, path);
}
function log(level, msg, fields = {}) {
  const rec = { ts: new Date().toISOString(), level, msg, ...fields };
  console.log(JSON.stringify(rec));
}

const defaultPricing = Object.freeze({
  'openrouter:google/gemini-2.5-flash':       { in: 0.0003, out: 0.0025 },
  'openrouter:anthropic/claude-haiku-4-5':    { in: 0.0010, out: 0.0050 },
  'openrouter:google/gemini-2.5-flash-ocr':   { in: 0.0003, out: 0.0025 },
  'unknown':                                   { in: 0.0010, out: 0.0050 },
});

function tzDateKey(now = new Date(), tz = process.env.TZ || 'Asia/Jakarta') {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  return fmt.format(now);
}

const LEDGER_KEEP_DAYS = 90;

class CostGuard {
  constructor(storePath, opts = {}) {
    this.storePath = storePath;
    this.dailyCapUsd = opts.dailyCapUsd ?? 5.00;
    this.softCapUsd  = opts.softCapUsd  ?? 3.50;
    this.pricing     = opts.pricing     ?? defaultPricing;
    this.now         = opts.now         ?? (() => new Date());
  }

  _read() { return readJSON(this.storePath, {}); }
  _write(state) {
    const cutoff = new Date(this.now().getTime() - LEDGER_KEEP_DAYS * 86400_000);
    const cutoffKey = tzDateKey(cutoff);
    const out = {};
    for (const [k, v] of Object.entries(state)) if (k >= cutoffKey) out[k] = v;
    writeJSON(this.storePath, out);
  }

  today() {
    const k = tzDateKey(this.now());
    const stored = this._read()[k] || {};
    const num = (v) => Number.isFinite(v) ? v : 0;
    return {
      date: k,
      spend_usd:  num(stored.spend_usd),
      requests:   num(stored.requests),
      tokens_in:  num(stored.tokens_in),
      tokens_out: num(stored.tokens_out),
      by_kind:    (stored.by_kind && typeof stored.by_kind === 'object') ? stored.by_kind : {},
    };
  }

  estimate({ model = 'unknown', tokensIn = 0, tokensOut = 0 } = {}) {
    const p = this.pricing[model] || this.pricing['unknown'];
    return (tokensIn / 1000) * p.in + (tokensOut / 1000) * p.out;
  }

  canSpend(expectedUsd) {
    const t = this.today();
    return (t.spend_usd + expectedUsd) <= this.dailyCapUsd;
  }

  record({ kind = 'chat', model = 'unknown', tokensIn = 0, tokensOut = 0, costUsd = null } = {}) {
    if (!Number.isFinite(tokensIn)  || tokensIn  < 0) throw new Error(`invalid tokensIn: ${tokensIn}`);
    if (!Number.isFinite(tokensOut) || tokensOut < 0) throw new Error(`invalid tokensOut: ${tokensOut}`);
    let usd;
    if (costUsd != null) {
      usd = Number(costUsd);
      if (!Number.isFinite(usd)) throw new Error(`invalid costUsd: ${costUsd}`);
    } else {
      usd = this.estimate({ model, tokensIn, tokensOut });
    }

    const k = tzDateKey(this.now());
    const state = this._read();
    const stored = state[k] || {};
    const num = (v) => Number.isFinite(v) ? v : 0;
    const day = {
      spend_usd:  num(stored.spend_usd),
      requests:   num(stored.requests),
      tokens_in:  num(stored.tokens_in),
      tokens_out: num(stored.tokens_out),
      by_kind:    (stored.by_kind && typeof stored.by_kind === 'object') ? stored.by_kind : {},
    };
    day.spend_usd  = +(day.spend_usd + usd).toFixed(6);
    day.requests  += 1;
    day.tokens_in += tokensIn;
    day.tokens_out += tokensOut;
    day.by_kind[kind] = +(num(day.by_kind[kind]) + usd).toFixed(6);
    state[k] = day;
    this._write(state);

    if (day.spend_usd >= this.dailyCapUsd) {
      log('error', 'cost-cap-hit', { date: k, spend_usd: day.spend_usd, cap: this.dailyCapUsd });
    } else if (day.spend_usd >= this.softCapUsd) {
      log('warn', 'cost-soft-cap', { date: k, spend_usd: day.spend_usd, soft: this.softCapUsd, cap: this.dailyCapUsd });
    }
    return day;
  }

  history(days = 7) {
    const state = this._read();
    const out = [];
    for (let i = 0; i < days; i++) {
      const d = new Date(this.now().getTime() - i * 86400_000);
      const k = tzDateKey(d);
      out.push({ date: k, ...(state[k] || { spend_usd: 0, requests: 0 }) });
    }
    return out;
  }

  resetToday(reason = 'manual') {
    const k = tzDateKey(this.now());
    const state = this._read();
    delete state[k];
    this._write(state);
    log('warn', 'cost-reset-today', { date: k, reason });
  }
}

module.exports = { CostGuard, defaultPricing };
