// courier-choice-parser.cjs — pure parser for the frozen courier-choice reply.
//
// Extracted from tryHandleFrozenCourierChoice in server.js so the parser can
// be unit-tested without spinning up the bridge or seeding a draft.
//
// 2026-05-07 QA found: "bukan paxel, gojek aja" mis-parsed to courier='paxel'
// because the negation context was ignored. This module fixes that.

'use strict';

// Paxel + Gosend (Gojek) are the only customer-pickable couriers in the
// frozen-choice flow today. Grab Car is force-routed for heavy carts and
// is never a customer choice, so it's intentionally absent.
const COURIER_NAMES = Object.freeze({
  paxel: /\bpaxel\b/i,
  gojek: /\b(gosend|gojek|gojeg)\b/i,
});

// Indonesian + English negation words. Order-sensitive matching: if a
// negation appears WITHIN ~10 chars BEFORE a courier name, that name is
// treated as rejected, and we look for the next mentioned name.
const NEGATION_RE = /\b(?:bukan|jangan|gak|ga|gk|nggak|ngga|engga|enggak|tidak|tdk|ndak|no|nope|don'?t|dont|skip)\b/i;

/**
 * Parse a customer's reply to the "1 or 2?" frozen courier-choice prompt.
 *
 * @param {string} text - the inbound user text
 * @returns {{ kind: 'index', value: number } |
 *           { kind: 'courier', value: 'paxel'|'gojek' } |
 *           { kind: 'ambiguous', reason: string }}
 */
function parseCourierChoice(text) {
  if (!text || typeof text !== 'string') return { kind: 'ambiguous', reason: 'empty' };
  const t = text.trim().toLowerCase();
  if (t.length === 0) return { kind: 'ambiguous', reason: 'empty' };

  // Numeric reply — "1", "2", "pilihan 2" etc. Only accept 1 or 2.
  const nm = t.match(/^(?:pilih(?:an)?\s*)?([12])\b/);
  if (nm) return { kind: 'index', value: Number(nm[1]) };

  // Find ALL courier mentions with their match positions.
  const mentions = [];
  for (const [name, re] of Object.entries(COURIER_NAMES)) {
    let m;
    const g = new RegExp(re.source, 'gi');
    while ((m = g.exec(t)) !== null) {
      mentions.push({ name, index: m.index });
    }
  }
  if (mentions.length === 0) return { kind: 'ambiguous', reason: 'no-courier-name' };

  // For each mention, check if a negation word appears in the SAME CLAUSE
  // before the courier name. A clause is bounded by ',' / '.' / ';' / '!'
  // / '?' / a connective like " aja " " ya " " dong " " kak " — past those,
  // we're in a new clause and the prior negation doesn't apply. Without
  // clause-awareness, "bukan paxel, gojek aja" would mark gojek as negated
  // because "bukan" is in the search window.
  const CLAUSE_BOUNDARY_RE = /[,.;!?]|\b(?:aja|ya|dong|kak|kakak|deh|nih)\b/i;
  for (const mention of mentions) {
    const before = t.slice(0, mention.index);
    // Find the LAST clause boundary in `before`. If none, the search starts
    // from position 0. If found, we look only after the boundary.
    let clauseStart = 0;
    let lastBoundary;
    let searchFrom = 0;
    while ((lastBoundary = CLAUSE_BOUNDARY_RE.exec(before.slice(searchFrom))) !== null) {
      clauseStart = searchFrom + lastBoundary.index + lastBoundary[0].length;
      searchFrom = clauseStart;
      if (searchFrom >= before.length) break;
    }
    const clauseBefore = before.slice(clauseStart);
    mention.negated = NEGATION_RE.test(clauseBefore);
  }

  // First non-negated mention wins.
  const positive = mentions.find(m => !m.negated);
  if (positive) return { kind: 'courier', value: positive.name };

  // All mentions were negated — customer said what they DON'T want but never
  // what they DO want. Treat as ambiguous so the bridge re-prompts.
  return { kind: 'ambiguous', reason: 'all-negated' };
}

module.exports = { parseCourierChoice, COURIER_NAMES, NEGATION_RE };
