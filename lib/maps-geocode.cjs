// maps-geocode.cjs — Google Maps / Nominatim geocode utilities.
// Pure functions + HTTP-dependent async functions.
// DI: log() injected via init(). Address functions via require(./address-matcher).

'use strict';

const https = require('https');
const am = require('./address-matcher.cjs');

// ── Logger ─────────────────────────────────────────────────────────
let _log = function() {};
function init(opts) { if (opts && opts.log) _log = opts.log; }

// ── Constants ──────────────────────────────────────────────────────
const SBSR_GMAPS_COORD_PATTERNS = [
  { re: /\/@(-?\d+\.\d+),(-?\d+\.\d+),(\d+)[zm]/i, lat: 1, lng: 2 },
  { re: /[?&]center=(-?\d+\.\d+),(-?\d+\.\d+)/i, lat: 1, lng: 2 },
  { re: /\/@(-?\d+\.\d+),(-?\d+\.\d+)/i, lat: 1, lng: 2 },
];
const SBSR_GMAPS_DIRECT_PATTERNS = [
  { re: /^\/?\s*(-?\d+\.\d+),(-?\d+\.\d+)\s*\/?\s*$/ },
  { re: /^(-?\d+\.\d{3,})\s*,\s*(-?\d+\.\d{3,})\s*$/ },
];
const SBSR_GMAPS_HOST_RE = /^https?:\/\/(?:[a-z0-9.-]*\.)?(?:maps\.app\.goo\.gl|goo\.gl\/maps|maps\.google\.com|google\.com\/maps)\/?/i;
const SBSR_GMAPS_RESOLVE_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36';

// ── Pure helpers ───────────────────────────────────────────────────
function isSbsrCoordInRegion(lat, lng) { return am.inferRegionFromCoords(lat, lng) !== null; }

function finalizeSbsrCoords(lat, lng) {
  const la = Number(lat), lo = Number(lng);
  if (!Number.isFinite(la) || !Number.isFinite(lo)) return null;
  const region = am.inferRegionFromCoords(la, lo);
  if (region === 'jawa_barat' && (lo >= 106.55 && lo <= 107.15 && la >= -6.45 && la <= -6.00)) return { lat: la, lng: lo };
  if (!region) {
    const absLat = Math.abs(la), absLng = Math.abs(lo);
    if ((absLat >= 0 && absLat <= 11) && (absLng >= 95 && absLng <= 141)) return { lat: la, lng: lo };
    return null;
  }
  return { lat: la, lng: lo };
}

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371, toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function decodeMapsPlaceFromUrlBridge(inputUrl) {
  if (!inputUrl) return null;
  const u = String(inputUrl);
  try { const urlObj = new URL(u); const q = urlObj.searchParams.get('q') || ''; if (q) return decodeURIComponent(q); } catch (_) {}
  const m = u.match(/\/place\/([^/?]+)/); if (m) return decodeURIComponent(m[1].replace(/\+/g, ' '));
  const d = u.match(/\/dir\/([^/?]+)/); if (d) return decodeURIComponent(d[1].replace(/\+/g, ' '));
  return null;
}

function buildPlaceGeocodeCandidates(place) {
  const base = am.normalizeSpaces(place); if (!base) return [];
  _log('gmaps-normalize', 'source=decoded_place_only');
  const candidates = [];
  const noJakarta = base.replace(/\b(jakarta|jaktim|jakarta timur|jakarta pusat|jakarta barat|jakarta selatan|jakarta utara|dki jakarta|dki)\b/gi, '').trim();
  if (noJakarta.length >= 3 && !/^[\s,.-]+$/.test(noJakarta)) candidates.push(noJakarta);
  const noDistrict = base.replace(/\b(?:kec(?:amatan)?[.\s]*)?[a-z\s-]{3,40}\b/gi, '').trim();
  if (noDistrict.length >= 3 && !candidates.includes(noDistrict)) candidates.push(noDistrict);
  candidates.push(base);
  const segs = base.split(',').map(s => am.normalizeSpaces(s)).filter(Boolean);
  if (segs.length > 1 && !candidates.includes(segs[0])) candidates.push(segs[0]);
  return [...new Set(candidates)].filter(c => c.length >= 2);
}

function parseDirectGmapsCoordsBridge(input) {
  const text = String(input || '').trim(); if (!text) return null;
  for (const p of SBSR_GMAPS_DIRECT_PATTERNS) { const m = text.match(p.re); if (m) { const lat = parseFloat(m[1]), lng = parseFloat(m[2]); if (Number.isFinite(lat) && Number.isFinite(lng)) return finalizeSbsrCoords(lat, lng); } }
  return null;
}

function extractCoordsFromMapsUrlBridge(input) {
  const text = String(input || '').trim(); if (!text) return null;
  for (const p of SBSR_GMAPS_DIRECT_PATTERNS) { const m = text.match(p.re); if (m) { const lat = parseFloat(m[1]), lng = parseFloat(m[2]); if (Number.isFinite(lat) && Number.isFinite(lng)) { const c = finalizeSbsrCoords(lat, lng); if (c) return c; } } }
  for (const p of SBSR_GMAPS_COORD_PATTERNS) { const m = text.match(p.re); if (m) { const lat = parseFloat(m[p.lat]), lng = parseFloat(m[p.lng]); if (Number.isFinite(lat) && Number.isFinite(lng)) { const c = finalizeSbsrCoords(lat, lng); if (c) return c; } } }
  return null;
}

function parseScriptJSON(stdout) {
  if (!stdout) return null;
  const text = String(stdout);
  // Try full parse first
  try { return JSON.parse(text.trim()); } catch (_) {}
  // Fallback: find JSON object spanning multiple lines
  const lines = text.split(/\r?\n/);
  for (let endIdx = lines.length - 1; endIdx >= 0; endIdx--) {
    if (lines[endIdx].trim() !== '}') continue;
    let depth = 0;
    for (let startIdx = endIdx; startIdx >= 0; startIdx--) {
      const l = lines[startIdx];
      for (const ch of l) {
        if (ch === '}') depth++;
        else if (ch === '{') depth--;
      }
      if (depth === 0) {
        try { return JSON.parse(lines.slice(startIdx, endIdx + 1).join('\n')); } catch (_) {}
        break;
      }
    }
  }
  return null;
}

// ── HTTP geocode ───────────────────────────────────────────────────
async function fetchMapsRedirectUrlBridge(current) {
  return new Promise((resolve) => {
    const urlObj = new URL(current);
    const req = https.request({ method:'HEAD', hostname:urlObj.hostname, path:urlObj.pathname+(urlObj.search||''), headers:{'User-Agent':SBSR_GMAPS_RESOLVE_UA}, timeout:8000 }, (res) => {
      const loc = res.headers.location || ''; resolve(loc || null);
    });
    req.on('timeout', () => { try { req.destroy(); } catch (_) {} resolve(null); });
    req.on('error', () => resolve(null)); req.end();
  });
}

async function resolveGmapsUrlBridge(url) {
  if (!url || typeof url !== 'string') return null;
  let current = url.trim();
  if (current.startsWith('http://')) current = current.replace('http://', 'https://');
  if (!current.startsWith('https://')) current = 'https://' + current;
  const visited = new Set();
  for (let hop = 0; hop < 6; hop++) {
    if (visited.has(current) || visited.size > 10) break; visited.add(current);
    _log('gmaps-resolve', 'hop=' + hop + ' url=' + current.slice(0, 100));
    let coords = parseDirectGmapsCoordsBridge(current);
    if (!coords) coords = extractCoordsFromMapsUrlBridge(current);
    if (coords) { const place = decodeMapsPlaceFromUrlBridge(current); _log('gmaps-resolve', 'coords_extracted lat='+coords.lat+' lng='+coords.lng); return {...coords, place, source:'direct_coords', confidence:'high'}; }
    if (SBSR_GMAPS_HOST_RE.test(current)) { const next = await fetchMapsRedirectUrlBridge(current); if (!next) break; current = next.startsWith('/') ? new URL(next, new URL(current).origin).toString() : next; if (!current.startsWith('https://')) { try { current = new URL(current, new URL(url.trim()).origin).toString(); } catch (_) {} } }
    else break;
  }
  return null;
}

async function geocodeMapsPlaceBridge(place, finalUrl, sourceType) {
  if (!place) return null; _log('gmaps-resolve', 'decoded_place=' + place);
  const gKey = process.env.GOOGLE_GEOCODING_API_KEY || process.env.GOOGLE_API_KEY || '';
  if (gKey && place.length >= 3) {
    try {
      const u = 'https://maps.googleapis.com/maps/api/geocode/json?address='+encodeURIComponent(place)+'&components=country%3AID&key='+gKey+'&language=id&region=id';
      const r = await fetch(u, { signal: AbortSignal.timeout(5000) });
      const d = await r.json().catch(() => null);
      if (d && d.status === 'OK' && d.results?.[0]) {
        const loc = d.results[0].geometry.location; const c = finalizeSbsrCoords(Number(loc.lat), Number(loc.lng));
        if (c) { _log('gmaps-geocode', 'google_api lat='+c.lat+' lng='+c.lng); return {...c, address_text:place, confidence:'high', decoded_place:place, geocode_display:d.results[0].formatted_address||''}; }
      }
    } catch (_) {}
  }
  const candidates = buildPlaceGeocodeCandidates(place);
  const preferJakarta = am.isJakartaLikeHint(place) || am.isJakartaLikeHint(finalUrl);
  const sourceIsMapsApp = /maps_app|gmaps_link/.test(String(sourceType || ''));
  for (const cand of candidates) {
    _log('gmaps-geocode', 'trying=' + cand);
    const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 5000);
    try {
      const url = new URL('https://nominatim.openstreetmap.org/search');
      url.searchParams.set('q', cand); url.searchParams.set('format', 'jsonv2'); url.searchParams.set('limit', '5');
      const res = await fetch(url.toString(), { signal: ctrl.signal, headers: { 'User-Agent': SBSR_GMAPS_RESOLVE_UA } });
      if (!res.ok) continue; const rows = await res.json();
      if (!Array.isArray(rows) || rows.length === 0) continue;
      for (const row of rows) {
        const lat = parseFloat(row?.lat), lng = parseFloat(row?.lon);
        const coords = finalizeSbsrCoords(lat, lng);
        if (!coords) { _log('gmaps-geocode', 'rejected_non_id'); continue; }
        const display = String(row?.display_name || '');
        if (am.hasWestJavaHint(place) && am.hasJakartaHint(display)) { _log('gmaps-resolve', 'semantic_city_mismatch'); continue; }
        if (preferJakarta && !am.isJakartaLikeHint(display)) continue;
        const candClean = am.normalizeSpaces(cand);
        const placeRegion = await am.extractSemanticRegion(place);
        const displayRegion = await am.extractSemanticRegion(display);
        let confidence = 'medium';
        const hasStreetSignal = /\bjl\.?\b|\bno\.?\s*\d+/i.test(candClean);
        if (hasStreetSignal && candClean.length >= 12) confidence = 'high';
        if (placeRegion && displayRegion && placeRegion !== displayRegion) confidence = 'low';
        if (!hasStreetSignal && candClean.length < 8 && sourceIsMapsApp) confidence = 'medium';
        _log('gmaps-geocode', 'accepted lat='+coords.lat+' lng='+coords.lng);
        _log('gmaps-resolve', 'resolved via decoded_place_geocode');
        return {...coords, address_text:cand, confidence, decoded_place:place, geocode_display:display};
      }
    } catch (_) {} finally { clearTimeout(timer); }
  }
  return null;
}

async function geocodeAddressTextBridge(addressText) {
  if (!addressText || String(addressText).trim().length < 5) return null;
  const text = String(addressText).trim(); _log('maps-typed-geocode', 'geocoding text len='+text.length);
  try {
    const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 6000);
    const url = new URL('https://nominatim.openstreetmap.org/search');
    url.searchParams.set('q', text); url.searchParams.set('format', 'jsonv2'); url.searchParams.set('limit', '3');
    const res = await fetch(url.toString(), { signal: ctrl.signal, headers: { 'User-Agent': SBSR_GMAPS_RESOLVE_UA } });
    clearTimeout(timer);
    if (!res.ok) return null; const rows = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) return null;
    for (const row of rows) {
      const lat = parseFloat(row?.lat), lng = parseFloat(row?.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      const c = finalizeSbsrCoords(lat, lng);
      if (c) { _log('maps-typed-geocode', 'resolved lat='+c.lat+' lng='+c.lng); return {...c, display_name: row.display_name || ''}; }
    }
  } catch (_) {}
  return null;
}

function buildTypedAddressCandidates(addressText) {
  const base = am.normalizeSpaces(addressText); if (!base) return [];
  const candidates = [base];
  const noDistrict = base.replace(/\b(?:kec(?:amatan)?[.\s]*)?[a-z\s-]{3,40}\b/gi, '').trim();
  if (noDistrict.length >= 4 && !candidates.includes(noDistrict)) candidates.push(noDistrict);
  return candidates;
}

async function geocodeTypedAddressWithFallback(addressText) {
  for (const cand of buildTypedAddressCandidates(addressText)) { const r = await geocodeAddressTextBridge(cand); if (r) return r; }
  return null;
}

async function reverseGeocodeCoordsBridge(lat, lng) {
  const la = Number(lat), lo = Number(lng);
  if (!Number.isFinite(la) || !Number.isFinite(lo)) return null;
  try {
    const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 6000);
    const url = new URL('https://nominatim.openstreetmap.org/reverse');
    url.searchParams.set('lat', String(la)); url.searchParams.set('lon', String(lo)); url.searchParams.set('format', 'jsonv2');
    const res = await fetch(url.toString(), { signal: ctrl.signal, headers: { 'User-Agent': SBSR_GMAPS_RESOLVE_UA } });
    clearTimeout(timer);
    if (!res.ok) return null; const data = await res.json();
    if (!data || data.error) return null;
    return { display_name: data.display_name || '', city: data.address?.city || data.address?.county || '', state: data.address?.state || '', county: data.address?.county || '' };
  } catch (_) {}
  return null;
}

async function resolveLocationDisplayBridge({ decodedPlace = '', lat = null, lng = null, gmapsLink = '' } = {}) {
  const fromDecoded = String(decodedPlace || '').trim();
  if (fromDecoded) { _log('location-display', 'resolved_address='+fromDecoded); _log('location-display', 'source=decoded_place'); return { place_address: fromDecoded, place_label: fromDecoded, source: 'decoded_place' }; }
  if (Number.isFinite(Number(lat)) && Number.isFinite(Number(lng))) {
    const rev = await reverseGeocodeCoordsBridge(Number(lat), Number(lng));
    const revText = String(rev?.display || '').trim();
    if (revText) { _log('location-display', 'resolved_address='+revText); _log('location-display', 'source=reverse_geocode'); return { place_address: revText, place_label: revText, source: 'reverse_geocode' }; }
  }
  const link = String(gmapsLink || '').trim();
  if (link) { _log('location-display', 'resolved_address='+link); _log('location-display', 'source=gmaps_link'); return { place_address: link, place_label: link, source: 'gmaps_link' }; }
  const fallback = (Number.isFinite(Number(lat)) && Number.isFinite(Number(lng))) ? Number(lat)+','+Number(lng) : '';
  _log('location-display', 'resolved_address='+fallback); _log('location-display', 'source=latlng_fallback');
  return { place_address: fallback, place_label: fallback, source: 'latlng_fallback' };
}

module.exports = {
  init, SBSR_GMAPS_COORD_PATTERNS, SBSR_GMAPS_DIRECT_PATTERNS, SBSR_GMAPS_HOST_RE, SBSR_GMAPS_RESOLVE_UA,
  isSbsrCoordInRegion, finalizeSbsrCoords, haversineKm,
  decodeMapsPlaceFromUrlBridge, buildPlaceGeocodeCandidates,
  parseDirectGmapsCoordsBridge, extractCoordsFromMapsUrlBridge, parseScriptJSON,
  fetchMapsRedirectUrlBridge, resolveGmapsUrlBridge, geocodeMapsPlaceBridge,
  geocodeAddressTextBridge, buildTypedAddressCandidates,
  geocodeTypedAddressWithFallback, reverseGeocodeCoordsBridge, resolveLocationDisplayBridge,
};
