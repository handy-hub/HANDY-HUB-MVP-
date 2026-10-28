#!/usr/bin/env node
'use strict';

/**
 * check-test-safety.cjs — no test may be able to reach production.
 *
 * This machine has gcloud application-default credentials. On 2026-10-22 a test
 * that loaded functions/index.js used them and wrote to the live database.
 * tests/support/no-production.cjs replaces those credentials for the whole
 * process, but only if it runs before anything else does — so every test entry
 * file must load it as its first statement (after 'use strict').
 *
 * Checked: tests/*.{cjs,mjs,js} and tests/e2e/*.{cjs,mjs,js}. Not tests/support/
 * (helpers, loaded after the guard) and not Python (no Google SDK).
 *
 * Exit 0 = clean, 1 = violations.
 */

const fs   = require('fs');
const path = require('path');

const ROOT  = path.join(__dirname, '..');
const DIRS  = ['tests', path.join('tests', 'e2e')];
const GUARD = 'support/no-production.cjs';

/** The first line of a file that is code, skipping comments and 'use strict'. */
function firstStatement(src) {
  let inBlock = false;
  const lines = src.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();
    if (inBlock) {
      if (!line.includes('*/')) continue;
      line = line.slice(line.indexOf('*/') + 2).trim();
      inBlock = false;
    }
    if (line.startsWith('/*')) {
      if (!line.includes('*/')) { inBlock = true; continue; }
      line = line.slice(line.indexOf('*/') + 2).trim();
    }
    if (!line || line.startsWith('//') || line.startsWith('#!')) continue;
    if (/^['"]use strict['"];?$/.test(line)) continue;
    return { line: i + 1, text: line };
  }
  return null;
}

const violations = [];
for (const dir of DIRS) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) continue;
  for (const name of fs.readdirSync(abs)) {
    if (!/\.(cjs|mjs|js)$/.test(name)) continue;
    const rel  = path.join(dir, name).replace(/\\/g, '/');
    const first = firstStatement(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
    if (!first || !first.text.includes(GUARD)) {
      violations.push({ file: rel, line: first ? first.line : 0, text: first ? first.text : '(empty)' });
    }
  }
}

if (violations.length) {
  console.error(`\n✗ ${violations.length} test file(s) can reach production — see tests/support/no-production.cjs\n`);
  for (const v of violations) {
    console.error(`  ${v.file}${v.line ? ':' + v.line : ''}`);
    console.error(`    first statement is: ${v.text.slice(0, 100)}`);
  }
  console.error(`\n  fix: make the first statement require('./${GUARD}')`);
  console.error(`       (or import './${GUARD}'; in an .mjs file, ../ from tests/e2e).\n`);
  process.exit(1);
}

console.log('✓ Every test loads tests/support/no-production.cjs first — no test can reach production.');
