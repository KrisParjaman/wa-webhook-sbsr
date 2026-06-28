// context.cjs — Context factory for SBSR bot engine.
// Creates a single ctx object per message turn. All handler functions
// receive this ctx instead of scattered (from, text, draft) params.
//
// Design principles:
//   1. Lazy accessors — expensive ops (catalog, memory) only run if handler uses them
//   2. Single output channel — ctx.reply(), ctx.notifyAdmin() instead of direct WA calls
//   3. State isolation — handlers mutate ctx.state, framework saves to disk
//   4. No dependency injection — ctx carries everything the handler needs

'use strict';

const fs = require('fs');

// ── Injected service references (set by server.js at startup) ──────
let _services = null;

/**
 * Register the live service functions server.js uses.
 * Called once at startup after all services are defined.
 */
function init(services) {
  _services = services;
}

// ── Factory ─────────────────────────────────────────────────────────

/**
 * Create a fresh context for one message turn.
 * @param {object} opts
 * @param {string} opts.from         — customer phone number
 * @param {string} opts.messageId    — WhatsApp message ID
 * @param {string} opts.contactName  — display name from WA profile
 * @param {string} opts.rawText      — sanitized text body (or synthetic for images)
 * @param {string} opts.msgType      — 'text' | 'image' | 'button' | 'location' | 'reaction'
 * @param {object} [opts.rawMsg]     — full Meta webhook message object (for image handling etc)
 * @returns {object} ctx
 */
function createContext(opts) {
  const { from, messageId, contactName, rawText, msgType, rawMsg } = opts;

  // ── Draft (loaded lazily, saved explicitly) ──────────────────────
  let _draft = null;
  let _draftLoaded = false;

  const ctx = {
    // ── Immutable turn identity ────────────────────────────────────
    from,
    messageId,
    contactName: contactName || from,
    text: rawText || '',
    type: msgType || 'text',
    rawMsg: rawMsg || null,

    // ── Timestamp helpers ───────────────────────────────────────────
    now: new Date(),
    nowISO: new Date().toISOString(),
    nowJakartaISO: _srvNowJakartaISO,

    // ── Draft accessors (lazy load from disk) ──────────────────────
    get draft() {
      if (!_draftLoaded) {
        _draft = _srvLoadDraft(from) || { phone: from };
        _draftLoaded = true;
      }
      return _draft;
    },

    get state() {
      return String(this.draft.state || '').trim().toLowerCase();
    },

    /** Merge partial fields into in-memory draft. Call saveDraft() to persist. */
    updateDraft(patch) {
      _draft = { ...this.draft, ...patch };
    },

    /** Persist in-memory draft to disk immediately. */
    saveDraft() {
      _srvSaveDraft(from, _draft);
    },

    // ── Shortcuts for common draft fields ───────────────────────────
    get customerName() { return this.draft.customer_name || ''; },
    get cart() { return Array.isArray(this.draft.items) ? this.draft.items : []; },
    get useCase() { return this.draft.use_case || ''; },
    get deliveryMode() { return this.draft.delivery_mode || ''; },
    get destination() { return this.draft.destination || null; },

    // ── Output: WhatsApp messaging ──────────────────────────────────
    /** Send a text reply to the customer. */
    reply(text) {
      return _srvSendMessage(from, text);
    },

    /** Send catalog with optional body + footer. */
    replyWithCatalog(bodyText, footerText) {
      return _srvSendCatalog(from, bodyText, footerText);
    },

    /** Send location request prompt. */
    replyWithLocationRequest(bodyText) {
      return _srvSendLocationRequest(from, bodyText);
    },

    /** Notify finance/admin team. */
    notifyAdmin(summary, logTag) {
      return _srvNotifyAdmin(summary, logTag);
    },

    /** Send reaction emoji on a message. */
    react(emoji) {
      return _srvSendReaction(from, messageId, emoji);
    },

    // ── Output: LLM ─────────────────────────────────────────────────
    /** Call the LLM (OpenClaw) with a prompt, return raw reply text. */
    async askLLM(prompt, tag) {
      const id = (tag || 'llm') + '-' + Date.now() + '-' + from;
      return _srvSendToOpenClaw(id, prompt);
    },

    // ── Lazy: Catalog data ──────────────────────────────────────────
    _catalogSnapshot: null,
    get catalog() {
      if (!this._catalogSnapshot) {
        this._catalogSnapshot = _srvGetCatalog();
      }
      return this._catalogSnapshot;
    },

    // ── Lazy: Customer memory (Qdrant) ──────────────────────────────
    _memoryContext: null,
    _memoryLoaded: false,
    async memory() {
      if (!_memoryLoaded) {
        this._memoryContext = await _srvRetrieveMemory(from, this.text);
        _memoryLoaded = true;
      }
      return this._memoryContext;
    },

    // ── Logging ─────────────────────────────────────────────────────
    log(tag, msg) {
      _srvLog(tag, msg);
    },

    // ── Flow control ────────────────────────────────────────────────
    /** Set by handlers to indicate "I handled this, don't fall through" */
    handled: false,
    /** Handler can set a specific reply before returning */
    replyText: null,
  };

  return ctx;
}

// ── Private service accessors (initialized by init()) ──────────────

function _srvNowJakartaISO() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date());
  return parts.replace(/, /, 'T') + '+07:00';
}

function _srvLoadDraft(from) {
  try {
    const dir = _services.SBSR_DRAFTS_DIR;
    const safe = String(from).replace(/[^0-9]/g, '');
    const p = dir + '/' + safe + '.json';
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {}
  return { phone: from };
}

function _srvSaveDraft(from, draft) {
  try {
    const dir = _services.SBSR_DRAFTS_DIR;
    const safe = String(from).replace(/[^0-9]/g, '');
    fs.mkdirSync(dir, { recursive: true });
    const tmp = dir + '/' + safe + '.tmp.' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify({ ...draft, updated_at: new Date().toISOString() }, null, 2));
    fs.renameSync(tmp, dir + '/' + safe + '.json');
  } catch (e) {
    console.error('[ctx] saveDraft failed:', e.message);
  }
}

function _srvSendMessage(to, text) {
  if (!text) return Promise.resolve();
  return (_services.sendWhatsAppMessage || Promise.resolve)(to, text);
}

function _srvSendCatalog(to, body, footer) {
  return (_services.sendWhatsAppCatalog || Promise.resolve)(to, body, footer);
}

function _srvSendLocationRequest(to, body) {
  return (_services.sendWhatsAppLocationRequest || Promise.resolve)(to, body);
}

function _srvNotifyAdmin(summary, logTag) {
  return (_services.notifySbsrAdminsText || Promise.resolve)(summary, logTag);
}

function _srvSendReaction(to, msgId, emoji) {
  return (_services.sendReaction || Promise.resolve)(to, msgId, emoji);
}

function _srvSendToOpenClaw(id, prompt) {
  return (_services.sendToOpenClaw || (() => Promise.resolve('')))(id, prompt);
}

function _srvGetCatalog() {
  try {
    if (_services.getCatalogSnapshot) return _services.getCatalogSnapshot();
    const p = '/docker/wa-webhook-sbsr/products.json';
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {}
  return { categories: [], addons: [], faq: [] };
}

function _srvRetrieveMemory(from, text) {
  return (_services.sbsrRetrieveMemoryContext || (() => Promise.resolve('')))(from, text);
}

function _srvLog(tag, msg) {
  try {
    (_services.log || console.log)(tag, msg);
  } catch (_) {}
}

module.exports = { init, createContext };
