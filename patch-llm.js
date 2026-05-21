const fs = require('fs');
const path = '/docker/wa-webhook-sbsr/server.js';
let code = fs.readFileSync(path, 'utf8');

// Replace the LLM wrapper functions with simpler inline versions that use the existing sendToOpenClaw
const oldLlmWrapper = `// LLM fallback for address matching - called when deterministic fails
function callLlmRegion(text) {
  return new Promise((resolve) => {
    if (!text || text.length < 5) return resolve(null);
    const cp = require('child_process');
    cp.execFile('node', [__dirname + '/scripts/llm-addr.cjs', 'region', text.substring(0, 200)], {
      timeout: 15000, cwd: __dirname
    }, (err, stdout) => {
      if (err) return resolve(null);
      const r = (stdout || '').trim().toLowerCase();
      if (['jakarta','bekasi','depok','tangerang','bogor','jawa_barat','banten'].includes(r)) return resolve(r);
      resolve(null);
    });
  });
}
function callLlmDistrict(text) {
  return new Promise((resolve) => {
    if (!text || text.length < 5) return resolve('');
    const cp = require('child_process');
    cp.execFile('node', [__dirname + '/scripts/llm-addr.cjs', 'district', text.substring(0, 200)], {
      timeout: 15000, cwd: __dirname
    }, (err, stdout) => {
      if (err) return resolve('');
      resolve((stdout || '').trim().toLowerCase() || '');
    });
  });
}
function callLlmCompare(addr1, addr2) {
  return new Promise((resolve) => {
    if (!addr1 || !addr2) return resolve(null);
    const cp = require('child_process');
    cp.execFile('node', [__dirname + '/scripts/llm-addr.cjs', 'compare', addr1.substring(0, 150), addr2.substring(0, 150)], {
      timeout: 15000, cwd: __dirname
    }, (err, stdout) => {
      if (err) return resolve(null);
      const r = (stdout || '').trim().toUpperCase();
      if (r === 'SAMA') return resolve(false);
      if (r === 'BERBEDA') return resolve(true);
      resolve(null);
    });
  });
}`;

const newLlmWrapper = `// LLM fallback for address matching - called when deterministic fails
// Uses existing OpenClaw WebSocket to send utility prompts
async function callLlmAddr(prompt, mode) {
  if (!prompt || prompt.length < 5) return mode === 'region' ? null : '';
  try {
    const reply = await sendToOpenClaw('llm-addr-' + Date.now(), prompt);
    const cleaned = (reply || '').trim().toLowerCase();
    if (mode === 'region') {
      if (['jakarta','bekasi','depok','tangerang','bogor','jawa_barat','banten'].includes(cleaned)) return cleaned;
      // Try to extract region name from longer response
      for (const r of ['jakarta','bekasi','depok','tangerang','bogor','jawa_barat','banten']) {
        if (cleaned.includes(r)) return r;
      }
      return null;
    }
    if (mode === 'district') return cleaned || '';
    if (mode === 'compare') {
      if (cleaned.includes('sama')) return false;
      if (cleaned.includes('beda') || cleaned.includes('berbeda')) return true;
      return null;
    }
    return null;
  } catch(e) {
    return mode === 'region' ? null : '';
  }
}
async function callLlmRegion(text) { return callLlmAddr(text, 'region'); }
async function callLlmDistrict(text) { return callLlmAddr(text, 'district'); }
async function callLlmCompare(a, b) { return callLlmAddr('Bandingkan: apakah alamat 1 dan 2 di KOTA yang SAMA atau BERBEDA? Jawab SAMA/BERBEDA saja.\\n1: ' + a.substring(0, 150) + '\\n2: ' + b.substring(0, 150), 'compare'); }`;

if (code.includes(oldLlmWrapper)) {
  code = code.replace(oldLlmWrapper, newLlmWrapper);
  console.log('LLM wrapper updated to use sendToOpenClaw');
} else {
  console.log('WARNING: old LLM wrapper not found, checking for other patterns');
  if (code.includes('callLlmRegion')) {
    console.log('callLlmRegion exists but wrapper format differs');
  }
}

const backupPath = path + '.backup3.' + new Date().toISOString().replace(/[:.]/g, '-');
fs.writeFileSync(backupPath, fs.readFileSync(path));
console.log('Backup: ' + backupPath);
fs.writeFileSync(path, code, 'utf8');

try {
  require('child_process').execSync('node --check ' + path, { timeout: 10000, stdio: 'pipe' });
  console.log('Syntax check: PASSED');
} catch(e) {
  const err = (e.stderr||'').toString();
  console.log('Syntax check: FAILED');
  console.log(err.substring(0, 500));
  fs.writeFileSync(path, fs.readFileSync(backupPath));
  console.log('Restored backup');
  process.exit(1);
}
