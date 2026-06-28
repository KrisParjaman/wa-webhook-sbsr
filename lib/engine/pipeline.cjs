// pipeline.cjs — Bot engine pipeline for Sentuh Rasa v2.
// Phase 1: Route → Handle → Reply → Save.
// Guard layer (dedup, killswitch, rate-limit, sanitize) stays in server.js
// for now — it's security-critical and well-tested.
//
// Stages are async (ctx, next) functions. Each stage can:
//   ctx.handled = true      — stop pipeline (reply already sent by handler)
//   ctx.replyText = '...'   — dispatcher will send this text
//   next()                   — continue to next stage
//
// Usage:
//   const { runPipeline } = require('./lib/engine/pipeline.cjs');
//   await runPipeline(ctx);

'use strict';

const routeStage = require('./pipeline-route.cjs');

// ── Pipeline runner ─────────────────────────────────────────────────

async function runPipeline(ctx) {
  try {
    // Stage 1: Route to handler based on state
    await routeStage(ctx, () => {});

    // Stage 2: Dispatch reply if handler set replyText
    if (ctx.replyText) {
      try {
        await ctx.reply(ctx.replyText);
        ctx.log('reply', ctx.replyText.slice(0, 80));
      } catch (err) {
        ctx.log('reply-err', err.message);
      }
    }

    // Stage 3: Persist state
    try {
      ctx.saveDraft();
    } catch (err) {
      ctx.log('save-err', err.message);
    }
  } catch (err) {
    ctx.log('pipeline-crash', err.message);
    try {
      await ctx.reply('Maaf Kak, ada gangguan sebentar 🙏 Coba lagi ya.');
    } catch (_) {}
    try { ctx.saveDraft(); } catch (_) {}
  }

  return ctx;
}

module.exports = { runPipeline };
