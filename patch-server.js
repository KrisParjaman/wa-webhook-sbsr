const fs = require('fs');
const path = '/docker/wa-webhook-sbsr/server.js';
let code = fs.readFileSync(path, 'utf8');

// 1. Add LLM wrapper function AFTER line 2116 (after closing brace of extractRegionKeywords)
const llmWrapper = `
// LLM fallback for address matching - called when deterministic fails
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
}
`;

// Insert after extractRegionKeywords closing brace (line ~2117)
// ExtractRegionKeywords ends at line ~2116 (the last closing brace before extractDistrictFromText)
// Let's find the exact insertion point: after the last } of extractRegionKeywords
const insertPoint = code.indexOf('function extractDistrictFromText');
if (insertPoint === -1) { console.log('ERROR: could not find insertion point'); process.exit(1); }

// Check if LLM wrapper already exists
if (code.includes('callLlmRegion')) {
  console.log('LLM wrapper already exists, skipping insert');
} else {
  // Insert before extractDistrictFromText
  code = code.slice(0, insertPoint) + llmWrapper + '\n' + code.slice(insertPoint);
  console.log('LLM wrapper inserted');
}

// 2. Modify extractSemanticRegion to add LLM fallback
// Current: returns "jakarta", "bekasi", etc. or null
// New: if null, try LLM
const oldExtract = `function extractSemanticRegion(text) {
  const t = String(text || "").toLowerCase();
  if (!t) return null;
  if (/(jakarta|jaktim|jakarta timur|jakarta barat|jakarta selatan|jakarta utara|jakarta pusat|dki|ibu kota)/i.test(t)) {
    return "jakarta";
  }
  if (/(sumedang|cimanggung|bandung|jawa barat|jabar|kabupaten bandung|kota bandung|ciwidey|soreang)/i.test(t)) {
    return "jawa_barat";
  }
  if (/(bekasi|kota bekasi|kabupaten bekasi|cikarang|mustika jaya|bantar gebang)/i.test(t)) {
    return "bekasi";
  }
  if (/(depok|kota depok|pancoran mas|sukmajaya|beji|cimanggis|sawangan|limo)/i.test(t)) {
    return "depok";
  }
  if (/(tangerang|kota tangerang|kabupaten tangerang|tangerang selatan|tangsel|pamulang|ciputat|serpong|bintaro|bsd)/i.test(t)) {
    return "tangerang";
  }
  if (/(bogor|kota bogor|kabupaten bogor|cibinong|gunung putri|citeureup|cileungsi|sukaraja)/i.test(t)) {
    return "bogor";
  }
  if (/(banten)/i.test(t)) {
    return "banten";
  }
  return null;
}`;

const newExtract = `async function extractSemanticRegion(text, useLlmFallback) {
  const t = String(text || "").toLowerCase();
  if (!t) return null;
  // Deterministic matching first
  if (/(jakarta|jaktim|jakarta timur|jakarta barat|jakarta selatan|jakarta utara|jakarta pusat|dki|ibu kota)/i.test(t)) {
    return "jakarta";
  }
  if (/(sumedang|cimanggung|bandung|jawa barat|jabar|kabupaten bandung|kota bandung|ciwidey|soreang)/i.test(t)) {
    return "jawa_barat";
  }
  if (/(bekasi|kota bekasi|kabupaten bekasi|cikarang|mustika jaya|bantar gebang)/i.test(t)) {
    return "bekasi";
  }
  if (/(depok|kota depok|pancoran mas|sukmajaya|beji|cimanggis|sawangan|limo)/i.test(t)) {
    return "depok";
  }
  if (/(tangerang|kota tangerang|kabupaten tangerang|tangerang selatan|tangsel|pamulang|ciputat|serpong|bintaro|bsd)/i.test(t)) {
    return "tangerang";
  }
  if (/(bogor|kota bogor|kabupaten bogor|cibinong|gunung putri|citeureup|cileungsi|sukaraja)/i.test(t)) {
    return "bogor";
  }
  if (/(banten)/i.test(t)) {
    return "banten";
  }
  // LLM fallback: jika deterministic tidak dapat menentukan
  if (useLlmFallback !== false) {
    try {
      const llmRegion = await callLlmRegion(text);
      if (llmRegion) return llmRegion;
    } catch(e) {}
  }
  return null;
}`;

const oldExtractPos = code.indexOf(oldExtract);
if (oldExtractPos !== -1 && !code.includes('async function extractSemanticRegion')) {
  code = code.replace(oldExtract, newExtract);
  console.log('extractSemanticRegion patched -> async + LLM fallback');
} else if (code.includes('async function extractSemanticRegion')) {
  console.log('extractSemanticRegion already patched');
} else {
  console.log('WARNING: could not find old extractSemanticRegion function');
}

// 3. Modify hasSemanticRegionConflict to be async + LLM fallback
const oldConflict = `function hasSemanticRegionConflict(addressText, decodedPlace) {
  const a = extractSemanticRegion(addressText);
  const b = extractSemanticRegion(decodedPlace);
  if (!a || !b) return false;
  return a !== b;
}`;

const newConflict = `async function hasSemanticRegionConflict(addressText, decodedPlace) {
  const a = await extractSemanticRegion(addressText);
  const b = await extractSemanticRegion(decodedPlace);
  if (!a || !b) {
    // LLM fallback: jika salah satu tidak terdeteksi deterministic
    if (a !== null || b !== null) {
      try {
        const llmResult = await callLlmCompare(addressText, decodedPlace);
        if (llmResult !== null) return llmResult;
      } catch(e) {}
    }
    return false;
  }
  if (a !== b) return true;
  return false;
}`;

if (code.includes(oldConflict) && !code.includes('async function hasSemanticRegionConflict')) {
  code = code.replace(oldConflict, newConflict);
  console.log('hasSemanticRegionConflict patched -> async + LLM fallback');
} else if (code.includes('async function hasSemanticRegionConflict')) {
  console.log('hasSemanticRegionConflict already patched');
} else {
  console.log('WARNING: could not find old hasSemanticRegionConflict');
}

// 4. Modify hasTextOnlyDistrictMismatch to be async + LLM fallback
const oldTextOnly = `function hasTextOnlyDistrictMismatch(addressText, decodedPlace) {
  const aDist = extractDistrictFromText(addressText);
  const bDist = extractDistrictFromText(decodedPlace);
  const aReg = extractSemanticRegion(addressText);
  const bReg = extractSemanticRegion(decodedPlace);
  if (aReg && bReg && aReg !== bReg) return true;
  if (aDist && bDist && aDist !== bDist) return true;
  return false;
}`;

const newTextOnly = `async function hasTextOnlyDistrictMismatch(addressText, decodedPlace) {
  const aDist = extractDistrictFromText(addressText);
  const bDist = extractDistrictFromText(decodedPlace);
  const aReg = await extractSemanticRegion(addressText);
  const bReg = await extractSemanticRegion(decodedPlace);
  if (aReg && bReg && aReg !== bReg) return true;
  if (aDist && bDist && aDist !== bDist) return true;
  // LLM fallback: jika deterministic tidak mendeteksi perbedaan
  if (!aReg && !bReg && !aDist && !bDist) {
    try {
      const llmResult = await callLlmCompare(addressText, decodedPlace);
      if (llmResult === true) return true;
    } catch(e) {}
  }
  return false;
}`;

if (code.includes(oldTextOnly) && !code.includes('async function hasTextOnlyDistrictMismatch')) {
  code = code.replace(oldTextOnly, newTextOnly);
  console.log('hasTextOnlyDistrictMismatch patched -> async + LLM fallback');
} else if (code.includes('async function hasTextOnlyDistrictMismatch')) {
  console.log('hasTextOnlyDistrictMismatch already patched');
} else {
  console.log('WARNING: could not find old hasTextOnlyDistrictMismatch');
}

// Write result
const backupPath = path + '.backup.' + new Date().toISOString().replace(/[:.]/g, '-');
if (!code.includes('callLlmRegion')) {
  console.log('ERROR: LLM wrapper not found in output, something went wrong');
  process.exit(1);
}
fs.writeFileSync(backupPath, fs.readFileSync(path));
console.log('Backup saved: ' + backupPath);
fs.writeFileSync(path, code, 'utf8');
console.log('server.js updated successfully');

// Syntax check
try {
  require('child_process').execSync('node --check ' + path, { timeout: 10000, stdio: 'pipe' });
  console.log('Syntax check: PASSED');
} catch(e) {
  console.log('Syntax check: FAILED - ' + (e.stderr||'').toString().substring(0, 200));
  // Restore backup
  fs.writeFileSync(path, fs.readFileSync(backupPath));
  console.log('Restored backup');
  process.exit(1);
}
