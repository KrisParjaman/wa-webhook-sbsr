// payment-engine.cjs — Payment processing engine for Sentuh Rasa.
// Handles: invoice confirmation → QRIS generation → payment proof OCR → admin escalation.
//
// Architecture: pure orchestrator — delegates to injected services.
//   processInvoice(ctx)    — "OK" at invoice confirm → sends QRIS + payment instructions
//   processProof(ctx)      — image received → OCR → notify admin
//   getPaymentStatus(ctx)  — query payment status

'use strict';

// ── Injected services ────────────────────────────────────────────────
let _log, _sendMessage, _sendImage, _notifyAdmin, _uploadToImgbb;
let _execFile, _loadDraft, _saveDraft;
let _openclawContainer, _receiptBaseUrl;

function init(opts = {}) {
  _log = opts.log || (() => {});
  _sendMessage = opts.sendMessage || (async () => {});
  _sendImage = opts.sendImage || (async () => {});
  _notifyAdmin = opts.notifyAdmin || (async () => {});
  _uploadToImgbb = opts.uploadToImgbb || (async () => null);
  _execFile = opts.execFile || ((cmd, args, opts, cb) => cb(null, '', ''));
  _loadDraft = opts.loadDraft || (() => ({}));
  _saveDraft = opts.saveDraft || (() => {});
  _openclawContainer = opts.openclawContainer || 'sbsr-openclaw-1';
  _receiptBaseUrl = opts.receiptBaseUrl || 'https://production.biks.ai/receipts/';
}

// ── Invoice confirmation ─────────────────────────────────────────────

async function processInvoice(ctx) {
  const draft = ctx.draft;
  if (!draft.grand_total) {
    _log('payment', 'no grand_total — cannot send invoice');
    return { ok: false, error: 'no_grand_total' };
  }

  const orderKey = buildOrderKey(draft);
  _log('payment', 'processing invoice order_key=' + orderKey);

  await _saveDraft(ctx.from, {
    ...draft,
    state: 'awaiting_proof',
    payment_sent_at: new Date().toISOString(),
    payment_order_key: orderKey,
  });

  // Delegate to sentuh-payment.mjs (runs in Docker container)
  const payload = JSON.stringify({
    phone: '+' + String(ctx.from).replace(/[^0-9]/g, ''),
    customer_name: draft.customer_name || '',
    grand_total: draft.grand_total,
    order_key: orderKey,
  });

  return new Promise((resolve) => {
    const cp = require('child_process');
    cp.execFile('docker', [
      'exec', _openclawContainer,
      'node', '/data/sentuhrasa-pdf/scripts/sentuh-payment.mjs', payload,
    ], { timeout: 30000 }, async (err, stdout, stderr) => {
      const out = String(stdout || '').trim();
      const errOut = String(stderr || '').trim();
      _log('payment', 'script exit=' + (err?.code || 0) + ' out=' + out.slice(0, 100));

      try {
        const result = JSON.parse(out);
        if (result.userMessage) {
          await _sendMessage(ctx.from, result.userMessage);
        }
        if (result.qrisPath) {
          // QRIS image handling handled by caller
        }
        resolve({ ok: true, result });
      } catch (_) {
        _log('payment', 'parse error: ' + out.slice(0, 200));
        resolve({ ok: false, error: 'parse_error', raw: out });
      }
    });
  });
}

// ── Payment proof processing ─────────────────────────────────────────

async function processProof(ctx, imageUrl, ocrResult) {
  const draft = ctx.draft;
  _log('payment', 'processing proof from ' + ctx.from);

  if (ocrResult) {
    const merchant = ocrResult.merchant || '?';
    const total = ocrResult.total || '?';
    const date = ocrResult.date || '?';

    const summary = [
      '💰 *Bukti Pembayaran Diterima*',
      'Customer: ' + (draft.customer_name || '?') + ' (+' + ctx.from + ')',
      'Order Key: ' + (draft.payment_order_key || '?'),
      'Grand Total: Rp' + Number(draft.grand_total || 0).toLocaleString('id-ID'),
      '',
      'OCR Result:',
      '• Merchant: ' + merchant,
      '• Total: ' + total,
      '• Date: ' + date,
      '• Image: ' + imageUrl,
    ].join('\n');

    await _notifyAdmin(summary, 'sbsr-payment-proof');
    await _sendMessage(ctx.from, 'Bukti pembayaran diterima ya Kak 🤍 Admin akan verifikasi dalam beberapa menit.');

    await _saveDraft(ctx.from, {
      ...draft,
      bukti_url: imageUrl,
      bukti_ocr_merchant: merchant,
      bukti_ocr_total: total,
      state: 'awaiting_manual_payment_review',
      payment_proof_received_at: new Date().toISOString(),
    });

    return { ok: true, merchant, total, date };
  }

  // OCR failed — notify admin for manual review
  const summary = [
    '⚠️ *Bukti Pembayaran — OCR GAGAL*',
    'Customer: ' + (draft.customer_name || '?') + ' (+' + ctx.from + ')',
    'Image: ' + imageUrl,
    'Grand Total: Rp' + Number(draft.grand_total || 0).toLocaleString('id-ID'),
    '',
    'Mohon cek manual dan approve/reject.',
  ].join('\n');

  await _notifyAdmin(summary, 'sbsr-ocr-failed');
  await _sendMessage(ctx.from, 'Bukti pembayaran diterima ya Kak 🤍 Admin akan cek manual, mohon tunggu sebentar.');

  await _saveDraft(ctx.from, {
    ...draft,
    bukti_url: imageUrl,
    state: 'awaiting_manual_payment_review',
    payment_proof_received_at: new Date().toISOString(),
  });

  return { ok: true, ocrFailed: true };
}

// ── Payment status ───────────────────────────────────────────────────

function getPaymentStatus(draft) {
  const state = String(draft?.state || '').trim().toLowerCase();
  if (state === 'awaiting_proof') return 'waiting_for_proof';
  if (state === 'awaiting_manual_payment_review') return 'under_review';
  if (state === 'approved' || state === 'BOOKED' || state === 'booked') return 'approved';
  if (state === 'pending_finance') return 'pending_finance';
  if (state === 'delivered') return 'delivered';
  if (state === 'cancelled') return 'cancelled';
  return 'unknown';
}

// ── Helpers ──────────────────────────────────────────────────────────

function buildOrderKey(draft) {
  const items = (draft.items || []).map(it =>
    (it.sku || '?') + 'x' + (it.qty || 1)
  ).join('_');
  return [
    String(draft.phone || '').replace(/[^0-9]/g, ''),
    items || 'no_items',
    draft.grand_total || 0,
  ].join('_').slice(0, 120);
}

module.exports = {
  init,
  processInvoice,
  processProof,
  getPaymentStatus,
  buildOrderKey,
};
