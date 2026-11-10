'use strict';
/**
 * tests/artisan-medium-ui.test.cjs — two Medium findings from the 28 Oct
 * artisan audit (MED-UI).
 *
 * 1. notifications.html and performance.html printed `${[1,2,3,4].map(…)}` as
 *    text: a JavaScript template expression written into static HTML, where
 *    nothing evaluates it. The skeleton showed the expression and ONE row. The
 *    rows are now written out. Guarded across all three apps: no page's static
 *    markup may contain `${`.
 * 2. messages.html loaded design-system.css but neither themeManager.js (which
 *    sets data-theme before first paint — the dark tokens key off it) nor DM
 *    Sans (which --ds-font names): it ignored dark mode and fell back to the
 *    system font. It now has the head every other artisan page has. Guarded:
 *    a page on the design system loads both, except the listed pages, a list
 *    that can only shrink.
 */
require('./support/no-production.cjs');   // must stay the first statement (npm run lint:tests)

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

let passed = 0, failed = 0;
const failures = [];
function t(name, fn) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { failed++; failures.push([name, e]); console.log(`  ✗ ${name}`); }
}

/** The page with scripts, styles and comments blanked (line numbers kept): what the browser shows as markup. */
const staticMarkup = (src) => src
    .replace(/<script\b[\s\S]*?<\/script>/gi, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/<style\b[\s\S]*?<\/style>/gi,   (m) => m.replace(/[^\n]/g, ' '))
    .replace(/<!--[\s\S]*?-->/g,              (m) => m.replace(/[^\n]/g, ' '));

const pages = (dir) => fs.readdirSync(path.join(ROOT, dir)).filter((f) => f.endsWith('.html')).map((f) => `${dir}/${f}`);
const APP_PAGES = ['artisan-app', 'customer-app', 'admin-dashboard'].flatMap(pages);

/** The children of the element with this id (balanced <div>s), as markup. */
function blockOf(src, id) {
    const start = src.indexOf(`id="${id}"`);
    assert.ok(start > 0, `#${id} not found`);
    const open = src.lastIndexOf('<div', start);
    let depth = 0, i = open;
    const re = /<\/?div\b/g;
    re.lastIndex = open;
    let m;
    while ((m = re.exec(src))) {
        depth += m[0] === '<div' ? 1 : -1;
        if (depth === 0) { i = m.index; break; }
    }
    return src.slice(open, i);
}

console.log('\n── 1. Static markup never holds a template expression ──\n');

t('no page in any app has `${` in its static markup (it would be printed, not run)', () => {
    assert.ok(APP_PAGES.length > 40, `only ${APP_PAGES.length} pages scanned`);
    const hits = [];
    for (const p of APP_PAGES) {
        staticMarkup(read(p)).split('\n').forEach((line, i) => {
            if (line.includes('${')) hits.push(`${p}:${i + 1}: ${line.trim().slice(0, 80)}`);
        });
    }
    assert.deepStrictEqual(hits, []);
});

t('notifications: the loading skeleton is four real rows', () => {
    const block = blockOf(read('artisan-app/notifications.html'), 'notif-loading');
    // Phase 5: Notifications is on the design system — four fx skeleton rows.
    assert.strictEqual((block.match(/class="fx-skel fx-skel--row"/g) || []).length, 4);
    assert.doesNotMatch(block, /\.map\(|\.join\(/);
});

// Phase 4: performance.html forwards to reputation.html, which holds its figures now.
t('reputation (was performance): the loading skeleton is real rows written out', () => {
    const block = blockOf(read('artisan-app/reputation.html'), 'rep-body');
    assert.strictEqual((block.match(/class="fx-skel fx-skel--(?:title|row)"/g) || []).length, 5);
    assert.doesNotMatch(block, /\.map\(|\.join\(/);
});

console.log('\n── 2. Every design-system page has the artisan head ──\n');

// Phase 6: the artisan pages decide their theme with their own bootstrap
// (artisan-app/js/theme.js), which sets data-theme for css/tokens.css.
const THEME = 'js/theme.js';
const FONT  = 'https://fonts.googleapis.com/css2?family=DM+Sans:';
const head  = (src) => src.slice(0, src.indexOf('</head>'));

t('messages: theme applied before first paint, DM Sans, the design system — in dashboard.html\'s order', () => {
    // Since Phase 6 messages.html is on the fx system like dashboard.html: the
    // tokens replace design-system.css, and the page carries no styles of its own.
    const h = head(read('artisan-app/messages.html'));
    const theme = h.indexOf(`<script src="${THEME}"></script>`);
    const font  = h.indexOf(FONT);
    const ds    = h.indexOf('href="css/tokens.css"');
    assert.ok(theme > 0, 'js/theme.js');
    assert.ok(font > theme, 'DM Sans');
    assert.ok(ds > theme, 'the tokens after the theme script');
    assert.ok(!h.includes('css/design-system.css') && !h.includes('<style>'), 'no legacy stylesheet and no page styles');
    const dash = head(read('artisan-app/dashboard.html'));
    assert.ok(dash.includes(`<script src="${THEME}"></script>`) && dash.includes(FONT), 'the pattern being copied');
});

// Pages on the design system that do not yet follow it. This list may only
// shrink: job.html is fixed on fix/offer-refusal; login/signup are signed-out
// pages (whether they should follow the saved theme is an open product call).
const NOT_YET = ['job.html', 'login.html', 'signup.html'];

t('every artisan page on the design system loads the theme and DM Sans (known gaps excepted)', () => {
    const missing = [];
    for (const p of pages('artisan-app')) {
        const h = head(read(p));
        if (!h.includes('css/design-system.css')) continue;
        if (!h.includes(THEME) || !h.includes(FONT)) missing.push(path.basename(p));
    }
    const unexpected = missing.filter((p) => !NOT_YET.includes(p));
    assert.deepStrictEqual(unexpected, [], 'a page on the design system without the theme/font');
    assert.ok(!missing.includes('messages.html'));
});

console.log(`\nartisan-medium-ui: ${passed} passed, ${failed} failed`);
for (const [name, e] of failures) console.log(`\n  ✗ ${name}\n    ${e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n    ') : e}`);
process.exit(failed ? 1 : 0);
