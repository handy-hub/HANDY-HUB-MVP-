#!/usr/bin/env node
'use strict';

/**
 * design-token-lint.cjs — Design System enforcement gate for the customer app.
 *
 * Scans customer-app CSS and inline HTML <style>/style="" for values that
 * bypass the canonical token system in shared/css/ui-polish.css:
 *   • border-radius   → must be a token value (10/14/18/999/50%) or 0
 *   • box-shadow      → elevation shadows must reference --ui-elev-* tokens
 *   • font-size (px)  → must be an integer on the approved scale (no half-pixels)
 *   • neutral colors  → hardcoded greys/white that should be surface tokens
 *
 * Exit code 1 when violations exceed the ratchet baseline, so CI fails on NEW
 * drift while allowing the known legacy debt to be paid down over time.
 *
 * Usage:
 *   node scripts/design-token-lint.cjs            # report + enforce baseline
 *   node scripts/design-token-lint.cjs --update   # rewrite the baseline
 *   node scripts/design-token-lint.cjs --strict   # fail on ANY violation (target state)
 */

const fs   = require('fs');
const path = require('path');

const ROOT      = path.resolve(__dirname, '..');
const SCAN_DIRS = ['customer-app'];
const BASELINE  = path.join(__dirname, '.design-token-baseline.json');

// ── Approved vocabulary ──────────────────────────────────────────────────────
const OK_RADII   = new Set(['0', '0px', '10px', '14px', '18px', '999px', '50%']);
// Small functional radii that are legitimately not "card" radii:
const OK_RADII_SMALL = new Set(['1px', '2px', '3px', '4px']); // hairlines, scrollbars, tiny bars
const OK_FONT_PX = new Set([9,10,11,12,13,14,15,16,17,18,20,22,24,26,28,32,40].map(String));

// ── Violation matchers ───────────────────────────────────────────────────────
const RX = {
  radius:  /border-radius:\s*([0-9.]+px|[0-9.]+%)(?!\s*[0-9])/gi,   // single-value only
  shadowRaw: /box-shadow:\s*([0-9-][^;>"}]*?(?:rgba?\([^)]*\)|#[0-9a-f]{3,6})[^;>"}]*)/gi,
  fontPx:  /font-size:\s*([0-9.]+)px/gi,
  greys:   /(?:background(?:-color)?|color):\s*(#f4f4f4|#f5f5f5|#f7f7f7|#ebebeb|#efefef|#e4e4e4|#eeeeee|#f2f2f7|#444|#555|#888|#333)\b/gi,
};

// Files/blocks that are allowed their own values (design north-star + shared tokens)
const SKIP_FILES = [/ui-polish\.css$/, /variables\.css$/, /components[\\/]/];

function walk(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!/node_modules|\.git|build-/.test(p)) walk(p, acc);
    } else if (/\.(css|html)$/.test(entry.name)) {
      acc.push(p);
    }
  }
  return acc;
}

function isFunctionalShadow(s) {
  // focus rings, brand glows, status rings communicate STATE not depth → allowed
  return /0 0 0/.test(s) || /var\(--ui-primary-rgb\)/.test(s) || /rgba\(115, ?2, ?1/.test(s)
      || /rgba\(34, ?197, ?94/.test(s);
}

// Dark-mode blocks legitimately carry their own literal neutrals (the light
// tokens don't belong there). Detect whether a match index sits inside a rule
// whose nearest-preceding selector references a dark scope, and exempt it.
function inDarkBlock(src, idx) {
  const openBrace = src.lastIndexOf('{', idx);
  if (openBrace === -1) return false;
  // selector text is between the previous '}' (or start) and this '{'
  const prevClose = src.lastIndexOf('}', openBrace);
  const selector = src.slice(prevClose + 1, openBrace);
  return /html\.dark|\[data-theme=["']?dark|\.dark\b|@media[^{]*prefers-color-scheme:\s*dark/i.test(selector);
}

function scanFile(file) {
  if (SKIP_FILES.some(rx => rx.test(file))) return [];
  const src = fs.readFileSync(file, 'utf8');
  const rel = path.relative(ROOT, file);
  const out = [];
  const lineAt = idx => src.slice(0, idx).split('\n').length;

  let m;
  RX.radius.lastIndex = 0;
  while ((m = RX.radius.exec(src))) {
    const v = m[1];
    if (OK_RADII.has(v) || OK_RADII_SMALL.has(v)) continue;
    out.push({ rule: 'radius', value: v, line: lineAt(m.index), file: rel });
  }
  RX.shadowRaw.lastIndex = 0;
  while ((m = RX.shadowRaw.exec(src))) {
    if (isFunctionalShadow(m[1])) continue;
    out.push({ rule: 'shadow', value: m[1].trim().slice(0, 40), line: lineAt(m.index), file: rel });
  }
  RX.fontPx.lastIndex = 0;
  while ((m = RX.fontPx.exec(src))) {
    const v = m[1];
    if (OK_FONT_PX.has(v)) continue;
    out.push({ rule: 'font-size', value: v + 'px', line: lineAt(m.index), file: rel });
  }
  RX.greys.lastIndex = 0;
  while ((m = RX.greys.exec(src))) {
    if (inDarkBlock(src, m.index)) continue;   // dark-mode literals are legitimate
    out.push({ rule: 'neutral-color', value: m[1], line: lineAt(m.index), file: rel });
  }
  return out;
}

// ── Run ──────────────────────────────────────────────────────────────────────
const files = SCAN_DIRS.flatMap(d => walk(path.join(ROOT, d)));
const violations = files.flatMap(scanFile);

const byRule = violations.reduce((a, v) => ((a[v.rule] = (a[v.rule] || 0) + 1), a), {});
const total = violations.length;

const strict = process.argv.includes('--strict');
const update = process.argv.includes('--update');

if (update) {
  fs.writeFileSync(BASELINE, JSON.stringify({ total, byRule, updatedAt: new Date().toISOString() }, null, 2));
  console.log(`✓ Baseline updated: ${total} known violations (${JSON.stringify(byRule)})`);
  process.exit(0);
}

const baseline = fs.existsSync(BASELINE)
  ? JSON.parse(fs.readFileSync(BASELINE, 'utf8'))
  : { total: Infinity };

console.log(`Design-token scan: ${total} violations across ${files.length} files`);
console.log(`  by rule: ${JSON.stringify(byRule)}`);

// Show a sample so devs can act
for (const v of violations.slice(0, 25)) {
  console.log(`  ${v.rule.padEnd(14)} ${String(v.value).padEnd(24)} ${v.file}:${v.line}`);
}
if (total > 25) console.log(`  … and ${total - 25} more`);

if (strict && total > 0) {
  console.error(`\n✗ STRICT: ${total} design-token violations. Map every value to a token in ui-polish.css.`);
  process.exit(1);
}
if (total > baseline.total) {
  console.error(`\n✗ REGRESSION: ${total} violations > baseline ${baseline.total}. New drift introduced — fix it or run --update if intentional.`);
  process.exit(1);
}
console.log(`\n✓ No new drift (baseline ${baseline.total === Infinity ? 'unset' : baseline.total}).`);
process.exit(0);
