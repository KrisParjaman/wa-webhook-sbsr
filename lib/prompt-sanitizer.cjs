// prompt-sanitizer.cjs — CommonJS twin of prompt-sanitizer.mjs.
// Keep in lockstep with lib/prompt-sanitizer.mjs — see that file for design notes.

const MAX_LEN = 4000;
const HARD_LEN = 10_000;

const SYNTHETIC_PREFIXES = [
  '[CATALOG ORDER]',
  '[CATALOG ITEM]',
  '[SYSTEM]',
  '[ADMIN]',
  '[FINANCE]',
  '[KITCHEN]',
  '[BRIDGE]',
];

const TEMPLATE_MARKERS = [
  /<\|im_start\|>/gi,
  /<\|im_end\|>/gi,
  /<\|system\|>/gi,
  /<\|user\|>/gi,
  /<\|assistant\|>/gi,
  /<\|endoftext\|>/gi,
  /\[INST\]/gi,
  /\[\/INST\]/gi,
  /<<SYS>>/gi,
  /<<\/SYS>>/gi,
  /<\|begin_of_text\|>/gi,
  /<\|start_header_id\|>/gi,
  /<\|end_header_id\|>/gi,
  /<\|eot_id\|>/gi,
];

const DANGER_PERSONAS = [
  'admin', 'administrator', 'root', 'sysadmin', 'sudo', 'developer',
  'jailbroken', 'jailbreak', 'godmode', 'superuser', 'unrestricted',
  'evil', 'hacker', 'cracker',
  'DAN', 'GPT', 'ChatGPT', 'Claude', 'Bard', 'Gemini', 'Llama',
  'Copilot', 'GPT-4', 'GPT-5',
];
const DANGER_RE = DANGER_PERSONAS.map(s => s.replace(/[-]/g, '\\$&')).join('|');
const ROLE_SWAP_RE = new RegExp(
  `\\b(?:you\\s+are\\s+now|act\\s+as|pretend\\s+to\\s+be|roleplay\\s+as)\\s+(?:an?\\s+)?(?:${DANGER_RE})\\b`,
  'i',
);
const ID_ROLE_SWAP_RE = new RegExp(
  `\\bkamu\\s+(?:sekarang|adalah)\\s+(?:seorang\\s+)?(?:${DANGER_RE})\\b`,
  'i',
);

const INJECTION_PATTERNS = [
  /\bignore\s+(all\s+)?(previous|prior|above)\s+(instructions?|prompts?|rules?)\b/i,
  /\bdisregard\s+(all\s+)?(previous|prior|above)\s+(instructions?|prompts?|rules?)\b/i,
  ROLE_SWAP_RE,
  /\bdeveloper\s+mode\b/i,
  /\bjailbreak\b/i,
  /\bDAN\s+mode\b/i,
  /\bsystem\s+prompt\b/i,
  /\boriginal\s+(instructions?|prompts?)\b/i,
  /\bshow\s+(me\s+)?(your\s+)?(system|hidden|secret)\s+(prompt|instructions?|rules?)\b/i,
  /\brepeat\s+(your|the)\s+(system|original|initial)\s+(prompt|instructions?)\b/i,
  /\babaikan\s+(semua\s+)?(instruksi|aturan|perintah)\s+(sebelumnya|di\s+atas)\b/i,
  /\blupakan\s+(semua\s+)?(instruksi|aturan|perintah)\b/i,
  ID_ROLE_SWAP_RE,
  /\btampilkan\s+(prompt|instruksi)\s+(sistem|asli|awal)\b/i,
  /\btunjukkan\s+(prompt|instruksi)\s+(sistem|asli|rahasia)\b/i,
  /\b(call|invoke|run|exec)\s+(tool|function)\b/i,
  /\bcurl\s+https?:\/\//i,
  /\bcat\s+\.env\b/i,
  /\bprocess\.env\b/i,
];

const SBSR_SHAPED_ATTACKS = [
  /\bapprove\b.*\bSR\d{6,}/i,
  /^\s*\/(approve|reject|cancel|list|help)\b/i,
  /\bORDER\s+CONFIRMED\b/i,
];

function stripControl(s) {
  // C0 control chars except \t (\x09), \n (\x0A), \r (\x0D); plus DEL (\x7F).
  // Using explicit hex escapes to survive any encoding/copy mishap.
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}
function stripInvisible(s) {
  // Zero-width chars + bidirectional/direction-override chars + word-joiner
  // + invisible-operator range + BOM. Common ingredients in homograph and
  // hidden-payload attacks. Using explicit \uNNNN escapes for robustness.
  return s.replace(/[​-‏‪-‮⁠-⁯﻿]/g, '');
}
function defangSyntheticPrefixes(s) {
  let out = s;
  for (const p of SYNTHETIC_PREFIXES) {
    const tokens = p.slice(1, -1).split(' ');
    const inner = tokens.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
    const re = new RegExp('\\[\\s*' + inner + '\\s*\\]', 'gi');
    out = out.replace(re, '⟦' + p.slice(1, -1) + '⟧');
  }
  return out;
}
function defangTemplateMarkers(s) {
  let out = s;
  for (const re of TEMPLATE_MARKERS) out = out.replace(re, '«marker»');
  return out;
}

function sanitizeUserText(input, opts = {}) {
  const flags = [];
  const maxLen = opts.maxLen ?? MAX_LEN;

  if (input == null) return { clean: '', flags: ['empty'], blocked: false, reason: null };
  if (typeof input !== 'string') input = String(input);

  let s = input;
  if (s.length > HARD_LEN) {
    s = s.slice(0, HARD_LEN);
    flags.push('hard_truncated');
  }

  s = stripControl(s);
  s = stripInvisible(s);

  for (const re of TEMPLATE_MARKERS) {
    if (re.test(s)) { flags.push('template_marker'); break; }
  }

  {
    const normalized = s.toUpperCase().replace(/\s+/g, ' ');
    for (const p of SYNTHETIC_PREFIXES) {
      if (normalized.includes(p)) { flags.push('synthetic_prefix_forgery'); break; }
    }
  }

  for (const re of INJECTION_PATTERNS) {
    if (re.test(s)) { flags.push('injection_phrase'); break; }
  }

  if (!opts.allowAdminSyntax) {
    for (const re of SBSR_SHAPED_ATTACKS) {
      if (re.test(s)) { flags.push('sbsr_shaped_attack'); break; }
    }
  }

  s = defangSyntheticPrefixes(s);
  s = defangTemplateMarkers(s);
  s = s.trim();
  if (s.length > maxLen) {
    s = s.slice(0, maxLen) + ' …[truncated]';
    flags.push('soft_truncated');
  }

  let blocked = false, reason = null;
  if (flags.includes('synthetic_prefix_forgery')) {
    blocked = true;
    reason = 'attempted_synthetic_prefix_forgery';
  }

  return { clean: s, flags, blocked, reason };
}

function summarizeFlags(result) {
  return result.flags.length === 0
    ? 'clean'
    : `${result.flags.join('+')}${result.blocked ? ' [BLOCKED]' : ''}`;
}

module.exports = { sanitizeUserText, summarizeFlags };
