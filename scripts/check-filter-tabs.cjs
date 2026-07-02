#!/usr/bin/env node
/**
 * check-filter-tabs.cjs
 *
 * Enforcement mechanism for the filter-tab convergence performed across
 * notification.html / booking.html / saved.html: shared/css/components/tabs.css
 * (.ui-tabs / .ui-tab) is the ONE canonical filter-tab / segmented-control /
 * category-selector implementation for the whole platform. This script fails
 * the build if any page introduces a new, competing implementation instead of
 * using it — the same class of drift that originally produced .bk-tab,
 * .jobs-tab, .notif-tab, .tab-btn, .chip, .sv-tab, etc. across the app.
 *
 * Run: node scripts/check-filter-tabs.cjs   (wired into `npm test`)
 *
 * What it checks, across every .html file under customer-app/ and artisan-app/:
 *
 *   1. Inline <style> blocks or linked page CSS files defining a NEW class
 *      that looks like a tab/filter/segmented-control implementation
 *      (heuristic: a class rule containing `role="tab"`-adjacent naming
 *      patterns, or a class ending in -tab/-tabs/-filter/-chip/-segment
 *      that also sets border-bottom + color together, the classic
 *      "underline tab" fingerprint — the same shape .bk-tab/.jobs-tab/
 *      .notif-tab all had before convergence).
 *   2. Any page with `role="tablist"` in its HTML that does NOT also load
 *      shared/css/components/tabs.css.
 *
 * This is a heuristic linter, not a parser — it is intentionally permissive
 * (false negatives are fine; the goal is to catch the obvious, repeated
 * pattern of "someone hand-rolled another tab component") and reports
 * findings with file:line so a human decides, rather than silently blocking
 * unrelated CSS work.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const APP_DIRS = ['customer-app', 'artisan-app'];
const CANONICAL = 'shared/css/components/tabs.css';

/** Recursively collect files matching `exts` under `dir`, skipping heavy/irrelevant dirs. */
function walk(dir, exts, out = []) {
  const SKIP = new Set(['node_modules', '.git', 'build-artisan-app', 'dataconnect']);
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, exts, out);
    else if (exts.some(e => entry.name.endsWith(e))) out.push(full);
  }
  return out;
}

function relative(p) {
  return path.relative(ROOT, p).replace(/\\/g, '/');
}

/**
 * Heuristic fingerprint of a hand-rolled underline/segmented tab rule:
 * a class selector whose declaration block sets both `border-bottom` (or
 * `background` for a pill/segment fill) AND a `color`/`background` change
 * inside a sibling `.active`/[aria-selected="true"] rule for the SAME base
 * class name. Rather than parse CSS properly, we look for the textual
 * pattern that every prior violation shared: `<selector>.active` or
 * `<selector>[aria-selected="true"]` co-occurring with `border-bottom` or a
 * solid `background:` fill within ~400 chars of a class name matching
 * /-tab(s)?\b|-chip\b|-filter\b/ that ISN'T `.ui-tab`/`.ui-tabs`.
 */
const TAB_LIKE_CLASS = /\.([a-zA-Z][\w-]*-(?:tab|tabs|chip|filter|segment)s?)\b/g;
const ACTIVE_STATE_HINT = /\.active\b|\[aria-selected=["']true["']\]/;
const VISUAL_STATE_HINT = /border-bottom|background\s*:/;

function findHandRolledTabs(content, filePath, findings) {
  const lines = content.split('\n');
  const seen = new Set();
  let match;
  TAB_LIKE_CLASS.lastIndex = 0;
  while ((match = TAB_LIKE_CLASS.exec(content))) {
    const cls = match[1];
    if (cls === 'ui-tab' || cls === 'ui-tabs') continue; // the canonical component itself
    if (seen.has(cls)) continue;

    // Look at a window around this class's declarations for the active-state
    // + visual-state co-occurrence that marks "this is a styled tab, not just
    // a data attribute or JS hook".
    const windowStart = Math.max(0, match.index - 200);
    const windowEnd = Math.min(content.length, match.index + 600);
    const windowText = content.slice(windowStart, windowEnd);
    if (ACTIVE_STATE_HINT.test(windowText) && VISUAL_STATE_HINT.test(windowText)) {
      seen.add(cls);
      const lineNo = content.slice(0, match.index).split('\n').length;
      findings.push({
        file: relative(filePath),
        line: lineNo,
        message: `Class ".${cls}" looks like a hand-rolled tab/filter component ` +
          `(active-state + visual-state rule found nearby). Use the canonical ` +
          `${CANONICAL} (.ui-tabs / .ui-tab) instead of a new implementation.`,
      });
    }
  }
}

function checkTablistWithoutCanonicalCss(content, filePath, findings) {
  if (!/role=["']tablist["']/.test(content)) return;
  const linksCanonical = new RegExp(CANONICAL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(content);
  if (!linksCanonical) {
    findings.push({
      file: relative(filePath),
      line: 1,
      message: `Page has role="tablist" markup but does not link ${CANONICAL}. ` +
        `Every filter-tab / segmented-control surface must load the canonical component.`,
    });
  }
}

function main() {
  const findings = [];

  for (const appDir of APP_DIRS) {
    const dirPath = path.join(ROOT, appDir);
    if (!fs.existsSync(dirPath)) continue;

    for (const file of walk(dirPath, ['.html'])) {
      const content = fs.readFileSync(file, 'utf8');
      findHandRolledTabs(content, file, findings);
      checkTablistWithoutCanonicalCss(content, file, findings);
    }
    for (const file of walk(dirPath, ['.css'])) {
      const content = fs.readFileSync(file, 'utf8');
      findHandRolledTabs(content, file, findings);
    }
  }

  if (findings.length === 0) {
    console.log('[check-filter-tabs] OK — no competing tab/filter implementations found.');
    process.exit(0);
  }

  console.error(`[check-filter-tabs] FAILED — ${findings.length} finding(s):\n`);
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}\n    ${f.message}\n`);
  }
  console.error(
    'Fix: use shared/css/components/tabs.css\'s .ui-tabs / .ui-tab (+ .ui-tabs--artisan\n' +
    'brand modifier if this is an artisan-app page) instead of introducing a new class.\n' +
    'See notification.html, booking.html, or saved.html for the canonical usage pattern.'
  );
  process.exit(1);
}

main();
