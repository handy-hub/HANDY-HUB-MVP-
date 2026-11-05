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

console.log('\n── 1 · the quote sheet leaves the Tab order when closed ──\n');

t('the sheet starts inert', () => {
    assert.match(jobs, /<div id="qs-sheet" class="qs-sheet" role="dialog" aria-modal="true" aria-label="Submit Job Quote" inert>/);
});

/** jobs.html's own open/close functions over a stub DOM. */
function quoteSheet() {
    const els = {};
    const el = (id) => (els[id] = els[id] || {
        id, value: '', innerHTML: '', inert: id === 'qs-sheet', style: {}, isConnected: true,
        _cls: new Set(), focused: 0,
        classList: { add(c) { els[id]._cls.add(c); }, remove(c) { els[id]._cls.delete(c); },
                     contains(c) { return els[id]._cls.has(c); }, toggle(c, on) { on ? els[id]._cls.add(c) : els[id]._cls.delete(c); } },
        focus() { els[id].focused++; doc.activeElement = els[id]; },
    });
    const doc = { activeElement: null, getElementById: el };
    const src = jobs.slice(jobs.indexOf('window.openQuoteSheet = function'), jobs.indexOf('window.setMaterials = function'));
    const win = {};
    // eslint-disable-next-line no-new-func
    new Function('window', 'document', 'recalcQuote', `let _quoteBookingId, _needsMaterials, _quoteOpener = null; ${src}`)(win, doc, () => {});
    return { win, el, doc };
}

t('opening it makes it reachable and moves focus in; closing makes it inert and returns focus', () => {
    const { win, el, doc } = quoteSheet();
    const opener = el('card-btn'); opener.focus();
    win.openQuoteSheet('HHB-1');
    assert.strictEqual(el('qs-sheet').inert, false);
    assert.strictEqual(doc.activeElement, el('qs-labour'));
    win.closeQuoteSheet();
    assert.strictEqual(el('qs-sheet').inert, true);
    assert.strictEqual(el('qs-sheet').classList.contains('open'), false);
    assert.strictEqual(doc.activeElement, opener, 'focus goes back to the control that opened it');
});

t('closing never throws when the opener has left the page (a re-rendered card)', () => {
    const { win, el, doc } = quoteSheet();
    const opener = el('old-btn'); opener.focus();
    win.openQuoteSheet('HHB-1');
    opener.isConnected = false;
    win.closeQuoteSheet();
    assert.strictEqual(el('qs-sheet').inert, true);
    assert.notStrictEqual(doc.activeElement, opener);
});

t('Escape closes an open quote sheet as well as the photo', () => {
    const block = jobs.slice(jobs.indexOf("document.addEventListener('keydown', e => {"), jobs.indexOf('let _quoteBookingId'));
    assert.match(block, /if \(e\.key !== 'Escape'\) return;\s*window\.closePhoto\(\);\s*if \(document\.getElementById\('qs-sheet'\)\.classList\.contains\('open'\)\) window\.closeQuoteSheet\(\);/);
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
