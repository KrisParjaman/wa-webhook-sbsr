// gsheet-sync.cjs — Google Sheets customer DB sync.
// Syncs customer metrics (LTV, AOV, order count) to Google Sheets
// via a Docker-based script runner. Pure functions for computing metrics.

'use strict';

// ── Injected ────────────────────────────────────────────────────────
let _toNum, _fmtYmd, _nowJakartaDate, _normalizePhone08, _pickNonEmpty;
let _openclawContainer;

function init(opts = {}) {
  _toNum = opts.toNum || ((v) => Number(v) || 0);
  _fmtYmd = opts.fmtYmd || ((d) => d.toISOString().slice(0, 10));
  _nowJakartaDate = opts.nowJakartaDate || (() => new Date());
  _normalizePhone08 = opts.normalizePhone08 || ((v) => String(v).replace(/[^0-9]/g, ''));
  _pickNonEmpty = opts.pickNonEmpty || ((...vals) => { for (const v of vals) { const s = String(v||'').trim(); if (s) return s; } return ''; });
  _openclawContainer = opts.openclawContainer || 'sbsr-openclaw-1';
}

// ── Utilities ──────────────────────────────────────────────────────

function deriveSegment(useCase) {
  const u = String(useCase || '').toLowerCase().trim();
  if (!u) return '';
  if (u.includes('makan') || u.includes('eat_now')) return 'Eat Now';
  if (u.includes('stock') || u.includes('frozen-rumah')) return 'Stock Frozen';
  if (u.includes('meeting') || u.includes('acara')) return 'Meeting/Event';
  if (u.includes('gift') || u.includes('hampers')) return 'Gift/Hampers';
  return '';
}

function derivePreferredProduct(draft) {
  const items = Array.isArray(draft?.items) ? draft.items : [];
  let frozen = 0, goreng = 0;
  for (const it of items) {
    const form = String(it?.form || '').toLowerCase();
    if (form === 'frozen') frozen += Number(it?.qty || 1);
    else if (form === 'goreng') goreng += Number(it?.qty || 1);
  }
  if (frozen > 0 && goreng === 0) return 'Frozen';
  if (goreng > 0 && frozen === 0) return 'Goreng';
  if (frozen > goreng) return 'Frozen';
  if (goreng > frozen) return 'Goreng';
  if (frozen > 0 || goreng > 0) return 'Mix';
  return '';
}

function calcOrderQty(items) {
  return (Array.isArray(items) ? items : []).reduce((s, it) => s + (Number(it?.qty || 0) * Number(it?.pack_size || 1)), 0);
}

function monthKey(ymd) {
  const m = String(ymd || '').match(/^(\d{4})-(\d{2})-/);
  return m ? `${m[1]}-${m[2]}` : '';
}

function appendNote(existing, newNote, max = 900) {
  const base = String(existing || '').trim(), next = String(newNote || '').trim();
  if (!next) return base;
  if (!base) return next.slice(0, max);
  if (base.includes(next)) return base.slice(0, max);
  return `${base} | ${next}`.slice(0, max);
}

// ── Metrics ────────────────────────────────────────────────────────

function computeMetrics({ eventType, draft, existingCustomer }) {
  const ex = existingCustomer || {};
  const exQty = _toNum(ex['Total quantity _Order_Closing']);
  const exOmzet = _toNum(ex['Total_Omzet']);
  const exAov = _toNum(ex['Average_Order (AOV)']);
  const exOmzetMonth = _toNum(ex['Omzet_Bulan_Ini']);
  const nowYmd = _fmtYmd(_nowJakartaDate());
  const nowMonth = monthKey(nowYmd);
  const orderQty = calcOrderQty(draft?.items || []);
  const orderOmzet = _toNum(draft?.grand_total || (_toNum(draft?.subtotal) + _toNum(draft?.ongkir)));
  const exLastOrder = String(ex['Last_Order'] || '');

  let totalQty = exQty, totalOmzet = exOmzet, omzetBulanIni = exOmzetMonth, lastOrder = exLastOrder;

  if (eventType === 'payment_approved') {
    totalQty = exQty + orderQty;
    totalOmzet = exOmzet + orderOmzet;
    lastOrder = nowYmd;
    omzetBulanIni = (monthKey(exLastOrder) === nowMonth) ? exOmzetMonth + orderOmzet : orderOmzet;
  }

  let closedCount = (exAov > 0 && exOmzet > 0) ? Math.max(1, Math.round(exOmzet / exAov)) : 0;
  if (eventType === 'payment_approved') closedCount += 1;
  const aov = closedCount > 0 ? Math.round(totalOmzet / closedCount) : exAov;

  let hari = ex['Hari_Sejak_Last_Order'] || '';
  if (lastOrder) {
    const t0 = new Date(`${lastOrder}T00:00:00+07:00`).getTime();
    const t1 = new Date(`${nowYmd}T00:00:00+07:00`).getTime();
    if (Number.isFinite(t0) && Number.isFinite(t1) && t1 >= t0) hari = Math.floor((t1 - t0) / 86400000);
  }

  return { totalQtyClosing: totalQty, totalOmzet, aov, omzetBulanIni, lastOrder, firstOrderCandidate: nowYmd, hariSejakLastOrder: hari };
}

function buildRow(draft, event, existingCustomer) {
  const ex = existingCustomer || {}, ev = event || {};
  const metrics = computeMetrics({ eventType: ev.type, draft, existingCustomer: ex });
  const nowStr = new Date().toISOString();
  const note = `${nowStr} ${ev.type || 'event'}${draft?.grand_total ? ` total=${draft.grand_total}` : ''}`;

  return {
    'No_WA': _normalizePhone08(draft?.phone || ev.phone || ex['No_WA'] || ''),
    'Nama': _pickNonEmpty(draft?.customer_name, ex['Nama'], ''),
    'Alamat': _pickNonEmpty(draft?.address_text, draft?.destination?.address_text, ex['Alamat'], ''),
    'Segment_CRM_Auto': _pickNonEmpty(deriveSegment(draft?.use_case), ex['Segment_CRM_Auto'], ''),
    'First_Order': ex['First_Order'] || metrics.firstOrderCandidate || '',
    'Last_Order': metrics.lastOrder || ex['Last_Order'] || '',
    'Total quantity _Order_Closing': metrics.totalQtyClosing,
    'Total_Omzet': metrics.totalOmzet,
    'Average_Order (AOV)': metrics.aov,
    'Omzet_Bulan_Ini': metrics.omzetBulanIni,
    'Hari_Sejak_Last_Order': metrics.hariSejakLastOrder,
    'Opt_In_WA': ex['Opt_In_WA'] || 'TRUE',
    'Saved_Contact': ex['Saved_Contact'] || (draft?.customer_name ? 'Yes' : ''),
    'Preferred_Channel': 'WhatsApp',
    'Preferred_Product': _pickNonEmpty(derivePreferredProduct(draft), ex['Preferred_Product'], ''),
    'Priority_Level': ex['Priority_Level'] || 'WARM',
    'Notes': appendNote(ex['Notes'] || '', note),
  };
}

// ── Docker script runner ──────────────────────────────────────────

async function runGsheet(args = [], stdinObj = null, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const cp = require('child_process');
    const child = cp.spawn('docker', [
      'exec', '-i', _openclawContainer,
      'node', '/data/sentuhrasa-pdf/scripts/sentuh-gsheet.mjs',
      ...args,
    ], { timeout: timeoutMs });
    let stdout = '', stderr = '';
    child.stdout.on('data', c => { stdout += c; });
    child.stderr.on('data', c => { stderr += c; });
    child.on('error', (err) => resolve({ ok: false, error: err.message, stdout, stderr }));
    child.on('close', (code) => {
      let parsed = null;
      const lines = String(stdout).trim().split(/\r?\n/).filter(Boolean);
      if (lines.length) { try { parsed = JSON.parse(lines[lines.length - 1]); } catch (_) {} }
      resolve({ ok: code === 0, code, stdout, stderr, parsed });
    });
    child.stdin.end(stdinObj ? JSON.stringify(stdinObj) : undefined);
  });
}

function extractRow(resp) {
  if (!resp || !resp.ok) return null;
  const p = resp.parsed || {};
  return (p && typeof p.row === 'object' && p.row) ? p.row
    : (p && typeof p.data === 'object' && p.data) ? p.data
    : (p && typeof p.customer === 'object' && p.customer) ? p.customer : null;
}

module.exports = { init, deriveSegment, derivePreferredProduct, calcOrderQty, monthKey, appendNote, computeMetrics, buildRow, runGsheet, extractRow };
