// handler-agent.cjs — Agent handler (runs FIRST).
// Routes to the single-brain agent if enabled.
// Agent handles: understand → tools → reply.
// Fallback: if agent doesn't handle, pipeline continues to other handlers.

'use strict';

let _agentCore = null;
let _enabled = true; // toggle via /agent_off

function init(core) { _agentCore = core; }
function disable() { _enabled = false; }
function enable() { _enabled = true; }

function match(state, ctx) {
  // Agent runs for ALL text messages when enabled
  if (!_enabled || !_agentCore) return false;
  const t = ctx.text.trim();
  if (!t || t.length < 2) return false; // too short, let greeting handle
  if (t.startsWith('/')) return false; // admin commands
  return true;
}

async function handler(ctx) {
  if (!_agentCore) return;
  try {
    ctx.log('agent', 'running agent for: ' + ctx.text.slice(0, 60));
    await _agentCore.run(ctx);
    // Agent sets ctx.handled + ctx.replyText internally
  } catch (e) {
    ctx.log('agent', 'error: ' + e.message);
    // Fall through to other handlers
  }
}

module.exports = { init, disable, enable, match, handler };
