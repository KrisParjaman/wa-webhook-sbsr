#!/usr/bin/env node
/**
 * LLM Address Matcher — fallback untuk server.js
 * Dipanggil saat deterministic address matching gagal menentukan region/district
 */
const cp = require('child_process');
const OPENCLAW_CONTAINER = process.env.OPENCLAW_EXEC_CONTAINER || 'sbsr-openclaw-1';

async function llmExtractRegion(text) {
  if (!text || text.length < 5) return null;
  const prompt = `Dari teks alamat berikut, tentukan region/kota mana ini berada. Jawab HANYA dengan salah satu kata: jakarta, bekasi, depok, tangerang, bogor, jawa_barat, banten, atau null jika tidak yakin.\n\nAlamat: ${text.substring(0, 200)}`;
  try {
    const out = cp.execSync(`docker exec -i ${OPENCLAW_CONTAINER} node -e "
const r=require('readline').createInterface({input:process.stdin});
let d='';r.on('line',l=>d+=l);r.on('close',()=>{
const o=JSON.parse(d);console.log(o.result||'null')
})"`, { input: JSON.stringify({ action: 'prompt', prompt }), timeout: 15000, encoding: 'utf8' });
    const result = (out || '').trim().toLowerCase();
    if (['jakarta','bekasi','depok','tangerang','bogor','jawa_barat','banten'].includes(result)) return result;
  } catch(e) {}
  return null;
}

async function llmCompareAddresses(addr1, addr2) {
  if (!addr1 || !addr2) return null;
  const prompt = `Bandingkan 2 alamat berikut: apakah merujuk ke KOTA/WILAYAH yang SAMA atau BERBEDA? Jawab HANYA: SAMA atau BERBEDA.\n\nAlamat 1: ${addr1.substring(0, 150)}\nAlamat 2: ${addr2.substring(0, 150)}`;
  try {
    const out = cp.execSync(`docker exec -i ${OPENCLAW_CONTAINER} node -e "
const r=require('readline').createInterface({input:process.stdin});
let d='';r.on('line',l=>d+=l);r.on('close',()=>{
const o=JSON.parse(d);console.log(o.result||'null')
})"`, { input: JSON.stringify({ action: 'prompt', prompt }), timeout: 15000, encoding: 'utf8' });
    const result = (out || '').trim().toUpperCase();
    if (result === 'SAMA') return false;
    if (result === 'BERBEDA') return true;
  } catch(e) {}
  return null;
}

async function llmExtractDistrict(text) {
  if (!text || text.length < 5) return '';
  const prompt = `Dari teks alamat berikut, ekstrak nama KECAMATAN-nya. Jawab HANYA dengan nama kecamatan dalam 1-2 kata, atau KOSONGKAN jika tidak ada kecamatan yang disebut.\n\nAlamat: ${text.substring(0, 200)}`;
  try {
    const out = cp.execSync(`docker exec -i ${OPENCLAW_CONTAINER} node -e "
const r=require('readline').createInterface({input:process.stdin});
let d='';r.on('line',l=>d+=l);r.on('close',()=>{
const o=JSON.parse(d);console.log(o.result||'')
})"`, { input: JSON.stringify({ action: 'prompt', prompt }), timeout: 15000, encoding: 'utf8' });
    return (out || '').trim().toLowerCase() || '';
  } catch(e) {}
  return '';
}

// CLI mode
if (require.main === module) {
  const mode = process.argv[2];
  const input = process.argv[3];
  const input2 = process.argv[4];
  if (mode === 'region') {
    llmExtractRegion(input).then(r => { console.log(r || 'null'); process.exit(0); });
  } else if (mode === 'compare') {
    llmCompareAddresses(input, input2).then(r => { console.log(r === true ? 'BERBEDA' : r === false ? 'SAMA' : 'null'); process.exit(0); });
  } else if (mode === 'district') {
    llmExtractDistrict(input).then(r => { console.log(r || ''); process.exit(0); });
  } else {
    console.log('Usage: node llm-addr.cjs <region|compare|district> <text> [text2]');
  }
}

module.exports = { llmExtractRegion, llmCompareAddresses, llmExtractDistrict };
