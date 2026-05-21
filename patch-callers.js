const fs = require('fs');
const path = '/docker/wa-webhook-sbsr/server.js';
let code = fs.readFileSync(path, 'utf8');

// Fix 1: geocodeMapsPlaceBridge - extractSemanticRegion calls (line ~2243-2244)
code = code.replace(
  /const placeRegion = extractSemanticRegion\(place\);\s*\n\s*const displayRegion = extractSemanticRegion\(display\);/,
  'const placeRegion = await extractSemanticRegion(place);\n        const displayRegion = await extractSemanticRegion(display);'
);

// Fix 2: hasSemanticRegionConflict in if condition + hasTextOnlyDistrictMismatch (line ~2485)
// Break it into variables
code = code.replace(
  /if \(decodedPlace && addressTextCandidate && \(hasSemanticRegionConflict\(addressTextCandidate, decodedPlace\) \|\| hasTextOnlyDistrictMismatch\(addressTextCandidate, decodedPlace\)\)\) \{/,
  `const hasConflict = await hasSemanticRegionConflict(addressTextCandidate, decodedPlace);
    const hasMismatch = await hasTextOnlyDistrictMismatch(addressTextCandidate, decodedPlace);
    if (decodedPlace && addressTextCandidate && (hasConflict || hasMismatch)) {`
);

// Fix 3: hasSemanticRegionConflict in the semantic match check (line ~2522)
code = code.replace(
  /!hasSemanticRegionConflict\(addressTextCandidate, decodedPlace\)/,
  '!(await hasSemanticRegionConflict(addressTextCandidate, decodedPlace))'
);

// Fix 4: extractSemanticRegion calls in semantic match comparison (line ~2525)
code = code.replace(
  /\(extractSemanticRegion\(decodedPlace\) && extractSemanticRegion\(decodedPlace\) === extractSemanticRegion\(addressTextCandidate\)\)/,
  '((await extractSemanticRegion(decodedPlace)) && (await extractSemanticRegion(decodedPlace)) === (await extractSemanticRegion(addressTextCandidate)))'
);

// Fix 5: extractSemanticRegion in pin confirm region check (line ~2665-2666)
code = code.replace(
  /const typedRegion = extractSemanticRegion\(addressText\) \|\| "";\s*\n\s*const pinRegion = extractSemanticRegion\(pinRev\?\.display \|\| pinRev\?\.city \|\| pinRev\?\.state \|\| ""\) \|\| "";/,
  'const typedRegion = (await extractSemanticRegion(addressText)) || "";\n    const pinRegion = (await extractSemanticRegion(pinRev?.display || pinRev?.city || pinRev?.state || "")) || "";'
);

// Write backup and save
const backupPath = path + '.backup2.' + new Date().toISOString().replace(/[:.]/g, '-');
fs.writeFileSync(backupPath, fs.readFileSync(path));
console.log('Backup: ' + backupPath);
fs.writeFileSync(path, code, 'utf8');
console.log('server.js updated');

// Syntax check
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
