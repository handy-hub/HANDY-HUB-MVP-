'use strict';
/**
 * tests/confirm-sheet.test.cjs — "Are you sure?" is the app's own sheet
 * (28 Oct audit UI-011), run against shared/js/ui/confirmSheet.js itself with
 * the canonical sheet (openSheet) stubbed and a minimal DOM.
 */
require('./support/no-production.cjs');   // must stay the first statement (npm run lint:tests)

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');

let passed = 0, failed = 0;
const failures = [];
async function t(name, fn) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { failed++; failures.push([name, e]); console.log(`  ✗ ${name}`); }
}

/** A tiny element: enough for confirmSheet to build its content. */
function el(tag) {
    const listeners = {};
    const node = {
        tag, id: '', className: '', type: '', style: {}, dataset: {}, children: [],
        set textContent(v) { node._text = v; }, get textContent() { return node._text; },
        set innerHTML(v) { throw new Error('innerHTML must not be used'); },
        appendChild(c) { node.children.push(c); return c; },
        append(...cs) { node.children.push(...cs); },
        addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
        click() { (listeners.click || []).forEach((fn) => fn()); },
    };
    return node;
}
const find = (root, pred) => {
    if (pred(root)) return root;
    for (const c of root.children || []) { const hit = find(c, pred); if (hit) return hit; }
    return null;
};

/** Load confirmSheet with a stubbed openSheet. */
function load({ openFails = false, nativeAnswer = true } = {}) {
    const src = read('shared/js/ui/confirmSheet.js')
        .replace(/^import[^\n]*\n/gm, '')
        .replace(/^export\s+async\s+function\s+/gm, 'async function ');
    const opened = { content: null, onClose: null, closedWith: null, nativeAsked: null };
    const openSheet = async (opts) => {
        if (openFails) throw new Error('sheet css failed');
        opened.content = opts.content; opened.onClose = opts.onClose; opened.opts = opts;
        return { close: (reason) => { opened.closedWith = reason; } };
    };
    const document = { createElement: el };
    const window = { confirm: (m) => { opened.nativeAsked = m; return nativeAnswer; } };
    // eslint-disable-next-line no-new-func
    const confirmSheet = new Function('openSheet', 'document', 'window', `${src}; return confirmSheet;`)(openSheet, document, window);
    return { confirmSheet, opened };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

(async () => {
console.log('\n── UI-011 · confirmSheet answers like confirm(), in the app\'s own sheet ──\n');

await t('pressing the confirm button resolves true and closes the sheet', async () => {
    const { confirmSheet, opened } = load();
    const p = confirmSheet({ title: 'Decline this job request?', confirmLabel: 'Decline', danger: true });
    await tick();
    find(opened.content, (n) => 'confirm' in n.dataset).click();
    assert.strictEqual(await p, true);
    assert.strictEqual(opened.closedWith, 'confirm');
});
await t('Cancel resolves false', async () => {
    const { confirmSheet, opened } = load();
    const p = confirmSheet({ title: 'Cancel this job?' });
    await tick();
    find(opened.content, (n) => 'cancel' in n.dataset).click();
    assert.strictEqual(await p, false);
});
await t('any dismissal (Escape, backdrop, swipe) resolves false', async () => {
    const { confirmSheet, opened } = load();
    const p = confirmSheet({ title: 'Cancel this job?' });
    await tick();
    opened.onClose('escape');
    assert.strictEqual(await p, false);
});
await t('the safe choice has focus, and labels are wired for screen readers', async () => {
    const { confirmSheet, opened } = load();
    confirmSheet({ title: 'T', message: 'M' });
    await tick();
    assert.strictEqual(opened.opts.initialFocus, '[data-cancel]');
    assert.ok(opened.opts.labelledBy && opened.opts.describedBy);
});
await t('caller text is text, never markup', async () => {
    const { confirmSheet, opened } = load();
    const evil = '<img src=x onerror=alert(1)>';
    confirmSheet({ title: evil, message: evil, confirmLabel: evil });
    await tick();
    const texts = [];
    (function walk(n) { if (n._text !== undefined) texts.push(n._text); (n.children || []).forEach(walk); })(opened.content);
    assert.ok(texts.filter((x) => x === evil).length >= 3, 'set as textContent');
});
await t('the danger style follows the option', async () => {
    const a = load(); a.confirmSheet({ title: 'x', danger: true }); await tick();
    const b = load(); b.confirmSheet({ title: 'x' }); await tick();
    assert.match(find(a.opened.content, (n) => 'confirm' in n.dataset).className, /ds-btn--danger/);
    assert.match(find(b.opened.content, (n) => 'confirm' in n.dataset).className, /ds-btn--primary/);
});
await t('if the sheet cannot open, it still asks (native fallback) rather than block the action', async () => {
    const { confirmSheet, opened } = load({ openFails: true, nativeAnswer: false });
    assert.strictEqual(await confirmSheet({ title: 'Decline?', message: 'Really' }), false);
    assert.strictEqual(opened.nativeAsked, 'Decline?\n\nReally');
});

console.log('\n── UI-011 · no native dialogs left on the job screens ──\n');

await t('Today, Jobs and the job screen call no native confirm() or alert()', () => {
    for (const f of ['artisan-app/dashboard.html', 'artisan-app/jobs.html', 'artisan-app/job.html']) {
        const code = read(f).split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
        assert.ok(!/(^|[^.\w])(confirm|alert)\(/m.test(code), `${f} still calls a native dialog`);
    }
    assert.match(read('artisan-app/jobs.html'), /import \{ confirmSheet \} from '\.\.\/shared\/js\/ui\/confirmSheet\.js';/, 'jobs.html');
    // The job screen (Phase 2) is on the design system: its own modal sheet.
    const job = read('artisan-app/job.html');
    assert.match(job, /import \{ openSheet \}\s+from '\.\/js\/fx\/sheet\.js';/);
    assert.match(job, /<div class="fx-overlay" id="confirm-sheet" hidden>[\s\S]*?role="dialog" aria-modal="true"/);
    assert.match(job, /if \(spec\.confirm && !\(await confirmIn\(spec\.confirm\)\)\) return;/);
    assert.match(job, /'decline':\s+\{ action: ACTION\.DECLINE,\s+confirm: \{/, 'decline asks first');
    assert.match(job, /'cancel':\s+\{ action: ACTION\.CANCEL,[\s\S]{0,120}confirm: \{/, 'cancel asks first');
    // Today is on the artisan design system: its confirmations are its own
    // modal sheets (artisan-app/js/fx/sheet.js — focus trap, Escape, inert background).
    const today = read('artisan-app/dashboard.html');
    assert.match(today, /import \{ openSheet \}\s+from '\.\/js\/fx\/sheet\.js';/);
    assert.match(today, /<div class="fx-overlay" id="decline-sheet" hidden>[\s\S]*?role="dialog" aria-modal="true"/);
    assert.match(today, /if \(!\(await confirmIn\('decline-sheet'\)\)\) return;/, 'decline asks first');
    assert.match(today, /case 'stop-offers': if \(await confirmIn\('offline-sheet'\)\) changeAvailability\(false\); return;/);
});

console.log(`\nconfirm-sheet: ${passed} passed, ${failed} failed`);
for (const [name, e] of failures) console.log(`\n  ✗ ${name}\n    ${e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n    ') : e}`);
process.exit(failed ? 1 : 0);
})();
