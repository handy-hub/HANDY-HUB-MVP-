'use strict';
/**
 * artisan-keyboard-a11y.test.cjs — keyboard defects found by the Phase 0
 * signed-in Tab walk of the artisan screens (360 px, local emulators).
 *
 *   1. The closed quote sheet (jobs.html) only slides off-screen, so Tab walked
 *      into its six hidden controls; Escape did not close it.
 *   2. A focused settings switch looked exactly like an unfocused one: the
 *      input is invisible and nothing marked the track (WCAG 2.4.7).
 *   3. The job composer's note field had outline:none and no focus style.
 *
 * None of these changes how the screens look to a pointer user.
 */
require('./support/no-production.cjs');   // must stay the first statement (npm run lint:tests)
const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');

let passed = 0, failed = 0;
const failures = [];
function t(name, fn) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { failed++; failures.push([name, e]); console.log(`  ✗ ${name}`); }
}

const jobs = read('artisan-app/jobs.html');

console.log('\n── 1 · Jobs keeps no modal of its own; every control is a native one ──\n');

// Phase 3: the quote sheet and the photo lightbox left Jobs. The quote composer
// is inline on the job screen (shared/js/ui/quoteComposer.js — nothing to trap),
// and the job screen's confirmations are the design system's modal sheet, whose
// focus trap, Escape and focus return tests/fx-design-system.test.cjs and
// tests/e2e/fx_design_system.py prove.
t('Jobs has no quote sheet, lightbox or inert dialog left to trap focus', () => {
    assert.ok(!/qs-sheet|job-lightbox|openQuoteSheet|openPhoto/.test(jobs));
    assert.match(jobs, /if \(one\) \{ window\.__jobsLeaving = true; location\.replace\('job\.html\?id=' \+ encodeURIComponent\(one\)\); \}/,
        '?quote= opens the job screen, where the composer is');
});

t('every Jobs control is a native button or link (Tab reaches it, Enter / Space work)', () => {
    const view = read('artisan-app/js/jobsScreen.js');
    assert.ok(!/onclick=|tabindex="[0-9]/.test(jobs + view), 'an inline handler or a custom tab order');
    assert.match(jobs, /<button class="fx-seg__btn" type="button" data-view="current" aria-pressed="true">Current<\/button>/);
    assert.match(view, /<a class="fx-row fx-jobs__row" href="\$\{jobHref\(r\.id\)\}"/);
    assert.match(view, /<button class="fx-btn fx-btn--secondary fx-btn--block" type="button" data-act="more"/);
});

t('the job screen confirms through the modal sheet', () => {
    const job = read('artisan-app/job.html');
    assert.match(job, /import \{ openSheet \}\s+from '\.\/js\/fx\/sheet\.js';/);
    assert.match(read('artisan-app/js/fx/sheet.js'), /Escape/);
});

t('Back from a job returns to the same view and scroll position', () => {
    assert.match(jobs, /rememberScroll\(\{ name: 'jobs\.html' \}\);/);
    assert.match(jobs, /history\.replaceState\(history\.state, '', url\);/);
});

console.log('\n── 2 · a focused switch shows it ──\n');

t('design-system.css marks the track of a keyboard-focused switch', () => {
    const css = read('artisan-app/css/design-system.css');
    assert.match(css, /\.ds-switch input:focus-visible ~ \.ds-switch-track \{ outline: 2px solid var\(--ds-brand-text\); outline-offset: 2px; \}/);
});

console.log('\n── 3 · the composer note field shows focus ──\n');

t('.qc-note gets the same focus style as .qc-input', () => {
    const c = read('shared/js/ui/quoteComposer.js');
    assert.match(c, /\.qc-input:focus, \.qc-note:focus \{ background: var\(--ds-surface, #fff\); border-color: var\(--ds-brand-500, #F97316\); \}/);
});

console.log(`\nartisan-keyboard-a11y: ${passed} passed, ${failed} failed`);
if (failed) { for (const [n, e] of failures) console.error(`\n✗ ${n}\n${e.stack}`); process.exit(1); }
process.exit(0);
