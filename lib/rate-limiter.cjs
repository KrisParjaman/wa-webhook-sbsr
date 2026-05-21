// rate-limiter.cjs — CommonJS twin of rate-limiter.mjs.
// Bridge (server.js) is CommonJS, hence this twin. Tool scripts use the .mjs.
// Keep the two files in lockstep — change in lib/rate-limiter.mjs must mirror here.
//
// See lib/rate-limiter.mjs for design notes and full doc comments.

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

const defaultLimits = Object.freeze({
  msg:   { capacity: 30, refillPerSec: 30 / 300 },
  ocr:   { capacity: 5,  refillPerSec: 5 / 3600 },
  order: { capacity: 5,  refillPerSec: 5 / 86400 },
});

const _locks = new Map();
async function withLock(phone, fn) {
  const prev = _locks.get(phone) || Promise.resolve();
  let release;
  const next = new Promise(r => { release = r; });
  _locks.set(phone, prev.then(() => next));
  await prev;
  try { return await fn(); }
  finally {
    release();
    if (_locks.get(phone) === next) _locks.delete(phone);
  }
}

class RateLimiter {
  constructor(storePath, limits = defaultLimits) {
    this.storePath = storePath;
    this.limits = limits;
  }
  _read() { return readJSON(this.storePath, {}); }
  _write(state) { writeJSON(this.storePath, state); }

  async take(phone, scope, cost = 1, now = Date.now()) {
    const cfg = this.limits[scope];
    if (!cfg) throw new Error(`unknown rate-limit scope: ${scope}`);
    if (!phone) throw new Error('phone required');
    if (!Number.isFinite(cost) || cost < 0) {
      throw new Error(`invalid cost: ${cost} (must be finite, non-negative)`);
    }

    return withLock(phone, () => {
      const state = this._read();
      const key = `${phone}:${scope}`;
      const raw = state[key];
      const storedTokens = (raw && Number.isFinite(raw.tokens)) ? raw.tokens : cfg.capacity;
      const storedTs     = (raw && Number.isFinite(raw.ts))     ? raw.ts     : now;
      const elapsedSec = Math.max(0, (now - storedTs) / 1000);
      const refilled = Math.max(0, Math.min(cfg.capacity, storedTokens + elapsedSec * cfg.refillPerSec));

      if (refilled < cost) {
        const need = cost - refilled;
        const retryAfterSec = cfg.refillPerSec > 0 ? Math.ceil(need / cfg.refillPerSec) : null;
        state[key] = { tokens: refilled, ts: now };
        this._write(state);
        log('warn', 'rate-limit-throttled', { phone, scope, retryAfterSec, remaining: refilled });
        return { ok: false, retryAfterSec, remaining: refilled };
      }
      const remaining = refilled - cost;
      state[key] = { tokens: remaining, ts: now };
      this._write(state);
      return { ok: true, remaining };
    });
  }

  peek(phone, scope, now = Date.now()) {
    const cfg = this.limits[scope];
    if (!cfg) return null;
    const state = this._read();
    const raw = state[`${phone}:${scope}`];
    if (!raw) return { tokens: cfg.capacity, capacity: cfg.capacity };
    const storedTokens = Number.isFinite(raw.tokens) ? raw.tokens : cfg.capacity;
    const storedTs     = Number.isFinite(raw.ts)     ? raw.ts     : now;
    const elapsedSec = Math.max(0, (now - storedTs) / 1000);
    const tokens = Math.max(0, Math.min(cfg.capacity, storedTokens + elapsedSec * cfg.refillPerSec));
    return { tokens, capacity: cfg.capacity };
  }

  reset(phone, scope = null) {
    const state = this._read();
    if (scope) delete state[`${phone}:${scope}`];
    else for (const k of Object.keys(state)) if (k.startsWith(`${phone}:`)) delete state[k];
    this._write(state);
    log('info', 'rate-limit-reset', { phone, scope });
  }
}

module.exports = { RateLimiter, defaultLimits };
