// ocr-utils.cjs — Receipt OCR utilities.
// Calls external OCR service, formats results for bot consumption.

'use strict';

let _log;

function init(opts) { _log = opts.log || (() => {}); }

function formatForBot(ocr) {
  if (!ocr) return '';
  const lines = [];
  const m = ocr.merchant, t = ocr.total, d = ocr.date, b = ocr.bank;
  if (m) lines.push('Merchant: ' + m);
  if (t) lines.push('Total: ' + t);
  if (d) lines.push('Date: ' + d);
  if (b) lines.push('Bank: ' + b);
  if (!lines.length) return '';
  return '--- OCR RESULT (from read-receipt.js) ---\n' + lines.join('\n');
}

function runOnce(imageUrl) {
  const cp = require('child_process');
  return new Promise((resolve) => {
    const c = cp.spawn('node', ['/docker/wa-webhook-sbsr/scripts/read-receipt.cjs', imageUrl], { timeout: 15000, cwd: '/docker/wa-webhook-sbsr' });
    let o = '', e = '';
    c.stdout.on('data', d => o += d);
    c.stderr.on('data', d => e += d);
    c.on('error', (err) => resolve({ error: err.message, stdout: o, stderr: e }));
    c.on('close', (code) => {
      let parsed = null;
      try { const lines = o.trim().split(/\r?\n/).filter(Boolean); if (lines.length) parsed = JSON.parse(lines[lines.length-1]); } catch (_) {}
      resolve({ ok: code === 0, code, stdout: o, stderr: e, parsed });
    });
  });
}

async function runOCR(imageUrl, altUrl) {
  if (!imageUrl) return null;
  _log('ocr', 'Running OCR on ' + imageUrl);
  try {
    const r = await runOnce(imageUrl);
    if (r.parsed) return r.parsed;
    if (altUrl) {
      _log('ocr', 'Trying alt URL ' + altUrl);
      const r2 = await runOnce(altUrl);
      if (r2.parsed) return r2.parsed;
    }
  } catch (e) { _log('ocr', 'Error: ' + e.message); }
  return null;
}

module.exports = { init, formatForBot, runOnce, runOCR };
