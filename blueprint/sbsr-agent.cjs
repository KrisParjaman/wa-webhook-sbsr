/**
 * sbsr-agent.cjs — CommonJS wrapper for sbsr-agent.mjs
 *
 * Dynamically imports the ESM agent module and re-exports its runAgent() function
 * so it can be require()'d from server.js (CommonJS).
 *
 *   const { runAgent } = require('./blueprint/sbsr-agent.cjs');
 *   const { reply, order, messages } = await runAgent(state, "risol ayam 6pcs goreng");
 */
'use strict';

let _agentModule = null;

async function _loadAgent() {
  if (_agentModule) return _agentModule;
  // Dynamic import of the ESM module — works from CommonJS in Node 18+
  _agentModule = await import('./sbsr-agent.mjs');
  return _agentModule;
}

/**
 * Call the blueprint agent. Same signature as runAgent in sbsr-agent.mjs.
 * @param {object} state - { messages: [...], order: { cart: [...] } }
 * @param {string} userText - raw customer message
 * @returns {Promise<{reply: string, order: object, messages: object[], error?: string}>}
 */
async function runAgent(state, userText) {
  const mod = await _loadAgent();
  return mod.runAgent(state, userText);
}

module.exports = { runAgent };
