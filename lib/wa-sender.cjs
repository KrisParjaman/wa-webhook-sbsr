// wa-sender.cjs — WhatsApp Cloud API sender module.
// Centralized output channel for all WhatsApp messages.
// Dependency injection: init() with config + callbacks.
//
// Architecture:
//   sendText(to, text)         → core text message
//   sendCatalog(to, body, ft)  → catalog message
//   sendImage(to, mediaId, cp) → image/video/document
//   sendReaction(to, msgId, e) → reaction emoji
//
// All functions return Promise<object|null>. Null = window closed or error.

'use strict';

const https = require('https');

// ── Injected config + callbacks ─────────────────────────────────────
let _cfg = {};
let _log, _sanitize, _isWindowOpen, _onSent;

function init(opts = {}) {
  _cfg = {
    apiVersion: opts.apiVersion || 'v22.0',
    phoneNumberId: opts.phoneNumberId || '',
    accessToken: opts.accessToken || '',
  };
  _log = opts.log || (() => {});
  _sanitize = opts.sanitizeReply || ((t) => t);
  _isWindowOpen = opts.isWindowOpen || (() => true);
  _onSent = opts.onSent || (() => {});
}

// ── Core: Text message ──────────────────────────────────────────────

async function sendText(to, text, replyToMessageId = null) {
  text = _sanitize(String(text || ''));
  if (!_isWindowOpen(to)) {
    _log('wa-window', 'SKIPPED — 24h window closed for ' + to);
    return null;
  }

  const url = `https://graph.facebook.com/${_cfg.apiVersion}/${_cfg.phoneNumberId}/messages`;
  const payload = {
    messaging_product: 'whatsapp', recipient_type: 'individual', to,
    type: 'text', text: { preview_url: false, body: text },
  };
  if (replyToMessageId) payload.context = { message_id: replyToMessageId };

  return _post(url, payload, 'wa-send', to, text);
}

// ── Interactive messages ─────────────────────────────────────────────

async function sendButtons(to, bodyText, buttons) {
  const truncated = String(bodyText || '').slice(0, 1020);
  const url = `https://graph.facebook.com/${_cfg.apiVersion}/${_cfg.phoneNumberId}/messages`;
  const payload = {
    messaging_product: 'whatsapp', recipient_type: 'individual', to,
    type: 'interactive', interactive: {
      type: 'button', body: { text: truncated },
      action: { buttons: buttons },
    },
  };
  return _post(url, payload, 'wa-interactive', to);
}

async function sendFinanceButtons(to, bodyText, suffix) {
  const truncated = String(bodyText || '').slice(0, 1020);
  const url = `https://graph.facebook.com/${_cfg.apiVersion}/${_cfg.phoneNumberId}/messages`;
  const payload = {
    messaging_product: 'whatsapp', recipient_type: 'individual', to,
    type: 'interactive', interactive: {
      type: 'button', body: { text: truncated },
      footer: { text: 'Tap tombol atau balas APPROVE/REJECT manual' },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'sbsr_approve_' + suffix, title: '✅ Approve' } },
          { type: 'reply', reply: { id: 'sbsr_reject_' + suffix, title: '❌ Reject' } },
        ],
      },
    },
  };
  return _post(url, payload, 'wa-finance-btn', to);
}

async function sendLocationRequest(to, bodyText) {
  const truncated = String(bodyText || '').slice(0, 1020);
  const url = `https://graph.facebook.com/${_cfg.apiVersion}/${_cfg.phoneNumberId}/messages`;
  const payload = {
    messaging_product: 'whatsapp', recipient_type: 'individual', to,
    type: 'interactive', interactive: {
      type: 'location_request_message',
      body: { text: truncated },
      action: { name: 'send_location' },
    },
  };
  return _post(url, payload, 'wa-location-req', to);
}

// ── Catalog ──────────────────────────────────────────────────────────

async function sendCatalog(to, bodyText, footerText) {
  const truncated = String(bodyText || '').slice(0, 1020);
  const footer = String(footerText || '').slice(0, 60);
  const url = `https://graph.facebook.com/${_cfg.apiVersion}/${_cfg.phoneNumberId}/messages`;
  const payload = {
    messaging_product: 'whatsapp', recipient_type: 'individual', to,
    type: 'interactive', interactive: {
      type: 'catalog_message',
      body: { text: truncated },
      ...(footer ? { footer: { text: footer } } : {}),
      action: { name: 'catalog_message' },
    },
  };
  return _post(url, payload, 'wa-catalog', to);
}

// ── Media (image, video, document) ───────────────────────────────────

async function sendImage(to, mediaId, caption) {
  const url = `https://graph.facebook.com/${_cfg.apiVersion}/${_cfg.phoneNumberId}/messages`;
  const payload = {
    messaging_product: 'whatsapp', recipient_type: 'individual', to,
    type: 'image', image: { id: mediaId, ...(caption ? { caption: String(caption).slice(0, 1024) } : {}) },
  };
  return _post(url, payload, 'wa-image', to);
}

async function sendVideo(to, mediaId, caption) {
  const url = `https://graph.facebook.com/${_cfg.apiVersion}/${_cfg.phoneNumberId}/messages`;
  const payload = {
    messaging_product: 'whatsapp', recipient_type: 'individual', to,
    type: 'video', video: { id: mediaId, ...(caption ? { caption: String(caption).slice(0, 1024) } : {}) },
  };
  return _post(url, payload, 'wa-video', to);
}

async function sendDocument(to, mediaId, filename, caption) {
  const url = `https://graph.facebook.com/${_cfg.apiVersion}/${_cfg.phoneNumberId}/messages`;
  const payload = {
    messaging_product: 'whatsapp', recipient_type: 'individual', to,
    type: 'document', document: { id: mediaId, filename: filename || 'document.pdf', ...(caption ? { caption: String(caption).slice(0, 1024) } : {}) },
  };
  return _post(url, payload, 'wa-doc', to);
}

// ── Reactions + non-message ──────────────────────────────────────────

async function sendReaction(to, messageId, emoji) {
  const url = `https://graph.facebook.com/${_cfg.apiVersion}/${_cfg.phoneNumberId}/messages`;
  const payload = {
    messaging_product: 'whatsapp', recipient_type: 'individual', to,
    type: 'reaction', reaction: { message_id: messageId, emoji: emoji || '' },
  };
  return _post(url, payload, 'wa-reaction', to);
}

async function markRead(messageId) {
  const url = `https://graph.facebook.com/${_cfg.apiVersion}/${_cfg.phoneNumberId}/messages`;
  const payload = {
    messaging_product: 'whatsapp', recipient_type: 'individual',
    to: '0', // will be overridden, WA requires this field
    type: 'read',
  };
  // Mark read doesn't need a specific 'to' — WA uses the message context
  // This is handled differently in production, simplified here
  return null;
}

// ── Upload media to WhatsApp ─────────────────────────────────────────

async function uploadMedia(filePath, mimeType) {
  const fs = require('fs');
  if (!fs.existsSync(filePath)) return null;
  const fileData = fs.readFileSync(filePath);
  const url = `https://graph.facebook.com/${_cfg.apiVersion}/${_cfg.phoneNumberId}/media`;
  const boundary = 'wa-upload-' + Date.now();
  const mpField = '--' + boundary + '\r\nContent-Disposition: form-data; name="messaging_product"\r\n\r\nwhatsapp\r\n';
  const header = '--' + boundary + '\r\nContent-Disposition: form-data; name="file"; filename="' + require('path').basename(filePath) + '"\r\nContent-Type: ' + mimeType + '\r\n\r\n';
  const footer = '\r\n--' + boundary + '--\r\n';
  const body = Buffer.concat([Buffer.from(mpField), Buffer.from(header), fileData, Buffer.from(footer)]);

  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + _cfg.accessToken,
        'Content-Type': 'multipart/form-data; boundary=' + boundary,
        'Content-Length': body.length,
      },
    }, (res) => {
      let data = ''; res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (_) { resolve(null); }
      });
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

// ── Utility ──────────────────────────────────────────────────────────

function splitMessage(text, maxLen = 4096) {
  const parts = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    let cut = maxLen;
    const lastNewline = remaining.lastIndexOf('\n', maxLen);
    if (lastNewline > maxLen * 0.6) cut = lastNewline;
    parts.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
  if (remaining) parts.push(remaining);
  return parts;
}

// ── Internal ─────────────────────────────────────────────────────────

function _post(url, payload, tag, to, text) {
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + _cfg.accessToken,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = ''; res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          _onSent(to, text || tag);
          try { resolve(JSON.parse(data)); } catch (_) { resolve({ ok: true }); }
        } else {
          _log(tag, 'Error ' + res.statusCode + ': ' + data.slice(0, 200));
          reject(new Error('WA API error ' + res.statusCode));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

module.exports = {
  init,
  sendText,
  sendButtons,
  sendFinanceButtons,
  sendLocationRequest,
  sendCatalog,
  sendImage,
  sendVideo,
  sendDocument,
  sendReaction,
  markRead,
  uploadMedia,
  splitMessage,
};
