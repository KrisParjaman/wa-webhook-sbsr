// media-utils.cjs — WhatsApp media download + ImgBB upload.
// Extracted from server.js. Uses built-in https + DI for log + config.

'use strict';
const https = require('https');
const fs = require('fs');

let _log, _waApiVersion, _waAccessToken, _imgbbKey;

function init(opts) {
  _log = opts.log || (() => {});
  _waApiVersion = opts.waApiVersion || 'v22.0';
  _waAccessToken = opts.waAccessToken || '';
  _imgbbKey = opts.imgbbKey || '';
}

async function downloadMedia(mediaId) {
  const url = `https://graph.facebook.com/${_waApiVersion}/${mediaId}`;
  const info = await new Promise((resolve, reject) => {
    const req = https.request(url, { method:'GET', headers:{ Authorization:'Bearer '+_waAccessToken } }, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { if (res.statusCode >= 200 && res.statusCode < 300) resolve(JSON.parse(d)); else reject(new Error('Media info error '+res.statusCode)); });
    });
    req.on('error', reject); req.end();
  });
  const dlUrl = new URL(info.url);
  const data = await new Promise((resolve, reject) => {
    const req = https.request(dlUrl, { method:'GET', headers:{ Authorization:'Bearer '+_waAccessToken } }, (res) => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => { if (res.statusCode >= 200 && res.statusCode < 300) resolve(Buffer.concat(chunks)); else reject(new Error('Media download error '+res.statusCode)); });
    });
    req.on('error', reject); req.end();
  });
  return { data, mimeType: info.mime_type || 'image/jpeg' };
}

async function uploadToImgbb(imageBuffer) {
  if (!imageBuffer || !_imgbbKey) return null;
  const base64 = imageBuffer.toString('base64');
  const body = new URLSearchParams({ key: _imgbbKey, image: base64 });

  return new Promise((resolve) => {
    const req = https.request({ hostname:'api.imgbb.com', path:'/1/upload', method:'POST', headers:{ 'Content-Type':'application/x-www-form-urlencoded' } }, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { const j = JSON.parse(d); resolve(j?.data?.url || null); } catch (_) { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.write(body.toString()); req.end();
  });
}

async function handleImage(msg) {
  let image = msg.image || (msg.type === 'image' ? msg : null);
  if (!image) return { url: null, text: null };

  try {
    const media = await downloadMedia(image.id);
    const imgbbUrl = await uploadToImgbb(media.data);
    return {
      url: imgbbUrl || ('data:' + media.mimeType + ';base64,' + media.data.toString('base64').slice(0, 100)),
      text: image.caption || null,
      imgbbUrl,
    };
  } catch (e) {
    _log('media', 'handle err: ' + e.message);
    return { url: null, error: e.message, text: null };
  }
}

module.exports = { init, downloadMedia, uploadToImgbb, handleImage };
