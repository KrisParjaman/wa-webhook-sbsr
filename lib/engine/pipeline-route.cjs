// pipeline-route.cjs — State-based handler routing.
// Maps draft.state → handler function. Each handler receives ctx.
//
// Phase 1: Handlers are the EXISTING tryHandle* functions from server.js.
// Phase 2+: Handlers become standalone ctx-based modules in lib/handlers/.
//
// Handler signature: async (ctx) => ctx (mutated in-place: ctx.handled, ctx.replyText)

'use strict';

// ── Handler registry ────────────────────────────────────────────────
// Each entry: { match: (state, ctx) => bool, handler: async (ctx) => ctx }
//
// Handlers are tried in order. First match wins.
// match() checks: exact state, state pattern, or message content.

const handlers = [];

/** Register a handler. Called by server.js to wire up existing functions. */
function registerHandler(match, handler) {
  handlers.push({ match, handler });
}

/** Remove all handlers (for testing). */
function clearHandlers() {
  handlers.length = 0;
}

// ── Auto-register handlers ──────────────────────────────────────────
// Load handler modules. Each exports { match, handler }.
// Handlers are tried in registration order.
(function autoLoadHandlers() {
  const handlerFiles = [
    '../handlers/handler-cancel.cjs',
    '../handlers/handler-greeting.cjs',
  ];
  for (const f of handlerFiles) {
    try {
      const h = require(f);
      if (h && h.match && h.handler) {
        registerHandler(h.match, h.handler);
      }
    } catch (e) {
      console.error('[pipeline-route] failed to load handler ' + f + ': ' + e.message);
    }
  }
})();

// ── Main route stage ────────────────────────────────────────────────

module.exports = async function pipelineRoute(ctx, next) {
  const state = ctx.state;
  ctx.log('route', 'state=' + (state || 'initial') + ' text=' + ctx.text.slice(0, 60));

  for (const { match, handler } of handlers) {
    try {
      if (match(state, ctx)) {
        ctx.log('handler', handler.name || 'anonymous');

        await handler(ctx);

        if (ctx.handled) {
          return; // handler took care of everything
        }
        // Handler didn't set handled=true → try next matching handler
      }
    } catch (err) {
      ctx.log('handler-err', (handler.name || '?') + ': ' + err.message);
      // Continue to next handler on error (fail-open)
    }
  }

  // No handler matched — generic default reply
  if (!ctx.handled && !ctx.replyText) {
    const s = state || 'initial';
    if (s === 'initial' || s === 'none' || s === '' || s === 'main_menu') {
      ctx.replyText =
        'Halo Kak! Selamat datang di Sentuh Rasa — Risoles Otentik! 🤍\n\n' +
        'Mintu siap bantu Kakak. Mau...\n' +
        '*1.* Lihat menu & harga\n' +
        '*2.* Order langsung — sebut aja produk yang diinginkan\n' +
        '*3.* Tanya-tanya dulu\n\n' +
        'Ketik aja ya Kak, ngobrol santai aja sama Mintu.';
    } else {
      ctx.replyText =
        'Hmm, Mintu kurang yakin gimana lanjutinnya nih 🤍\n' +
        'Ketik *menu* buat lihat katalog atau *cancel* buat mulai ulang.';
    }
    ctx.handled = true;
  }

  next();
};

// ── Helpers for match functions ─────────────────────────────────────

/** Match exact state name. */
function stateIs(name) {
  return (state) => state === name;
}

/** Match any of the given state names. */
function stateIn(...names) {
  return (state) => names.includes(state);
}

/** Match if state starts with prefix */
function stateStartsWith(prefix) {
  return (state) => state.startsWith(prefix);
}

/** Always matches — for catch-all handlers. */
function always() {
  return () => true;
}

module.exports.registerHandler = registerHandler;
module.exports.clearHandlers = clearHandlers;
module.exports.stateIs = stateIs;
module.exports.stateIn = stateIn;
module.exports.stateStartsWith = stateStartsWith;
module.exports.always = always;
