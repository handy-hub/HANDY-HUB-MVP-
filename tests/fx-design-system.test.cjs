'use strict';
/**
 * tests/fx-design-system.test.cjs — the artisan design system holds (Phase 1).
 *
 *   • the approved tokens: the seven named colours, DM Sans, six sizes, three
 *     weights, four radii — a change to any of them is a decision, not an edit
 *   • every contrast promise, recomputed from tokens.css (WCAG 2.x)
 *   • the lint passes on app.css and catches every rule it claims to
 *   • the customer app stays maroon: nothing there references --fx-*
 *   • the pure behaviour: countdown urgency, the four tabs, icons
 *
 * The rendered checks (touch targets, overflow, focus, keyboard, reduced motion,
 * 200% text, forced colours) are tests/e2e/fx_design_system.py.
 */
require('./support/no-production.cjs');   // must stay the first statement (npm run lint:tests)
const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const { pathToFileURL } = require('url');

const ROOT   = path.join(__dirname, '..');
const read   = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const tokensCss = read('artisan-app/css/tokens.css');
const appCss    = read('artisan-app/css/app.css');
const lint = require(path.join(ROOT, 'scripts', 'check-fx-design-system.cjs'));

let passed = 0, failed = 0;
const failures = [];
async function t(name, fn) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { failed++; failures.push([name, e]); console.log(`  ✗ ${name}`); }
}

// Token values from the light :root block (before any media query).
const rootBlock = tokensCss.slice(tokensCss.indexOf(':root {'), tokensCss.indexOf('\n}', tokensCss.indexOf(':root {')));
const TOK = Object.fromEntries([...rootBlock.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(--fx-[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
const hexOf = (name) => { const v = TOK[name]; const ref = /^var\((--fx-[\w-]+)\)$/.exec(v || ''); return ref ? hexOf(ref[1]) : v; };

function lum(hex) {
    const h = hex.replace('#', '');
    const c = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
const contrast = (a, b) => { const [x, y] = [lum(hexOf(a)), lum(hexOf(b))].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

(async () => {
console.log('\n── The approved tokens ──\n');

await t('the seven approved colours, exactly', () => {
    assert.deepStrictEqual({
        ink: TOK['--fx-ink'], secondary: TOK['--fx-ink-2'], muted: TOK['--fx-ink-3'], paper: TOK['--fx-paper'],
        well: TOK['--fx-well'], line: TOK['--fx-line'], accent: TOK['--fx-accent'],
    }, { ink: '#111316', secondary: '#3B4048', muted: '#62676F', paper: '#FFFFFF', well: '#F3F3F2', line: '#E6E7E9', accent: '#F97316' });
});
await t('primary orange buttons carry near-black text; deep orange #C2410C is for text and links', () => {
    assert.strictEqual(TOK['--fx-on-accent'], '#111316');
    assert.strictEqual(TOK['--fx-accent-text'], '#C2410C');
    assert.match(appCss, /\.fx-btn--primary\s+\{ background: var\(--fx-accent\); color: var\(--fx-on-accent\); \}/);
    assert.match(appCss, /\.fx-link \{\s*color: var\(--fx-accent-text\);/);
});
await t('DM Sans, six sizes, three weights (400 / 550 / 650)', () => {
    assert.match(TOK['--fx-font'], /^'DM Sans',/);
    const sizes = Object.keys(TOK).filter((k) => k.startsWith('--fx-size-'));
    assert.deepStrictEqual(sizes, ['--fx-size-display', '--fx-size-title', '--fx-size-heading', '--fx-size-body', '--fx-size-label', '--fx-size-caption']);
    assert.deepStrictEqual(sizes.map((k) => TOK[k]), ['2.125rem', '1.5rem', '1.125rem', '1rem', '0.875rem', '0.75rem']);   // 34 24 18 16 14 12
    const weights = Object.keys(TOK).filter((k) => k.startsWith('--fx-w-'));
    assert.deepStrictEqual(weights.map((k) => TOK[k]), ['400', '550', '650']);
});
await t('four radius values, by role', () => {
    const radii = Object.keys(TOK).filter((k) => k.startsWith('--fx-r-'));
    assert.deepStrictEqual(Object.fromEntries(radii.map((k) => [k, TOK[k]])),
        { '--fx-r-chip': '6px', '--fx-r-control': '8px', '--fx-r-sheet': '16px', '--fx-r-round': '999px' });
});
await t('touch and control dimensions: 44 hit, 56 / 48 / 36 buttons, 56 app bar, 64 tab bar', () => {
    assert.deepStrictEqual(['--fx-hit', '--fx-h-l', '--fx-h-m', '--fx-h-s', '--fx-bar', '--fx-tab'].map((k) => TOK[k]),
        ['44px', '56px', '48px', '36px', '56px', '64px']);
});
await t('tabular figures on money and time', () => {
    for (const sel of ['.fx-ledger__v', '.fx-row__value', '.fx-countdown__value', '.fx-num']) {
        const block = appCss.slice(appCss.indexOf(sel + ' '), appCss.indexOf('}', appCss.indexOf(sel + ' ')));
        assert.match(block, /font-variant-numeric: tabular-nums/, sel);
    }
});

console.log('\n── Contrast, recomputed ──\n');

const TEXT = 4.5, UI = 3;
const PAIRS = [
    ['--fx-ink', '--fx-paper', TEXT], ['--fx-ink', '--fx-well', TEXT], ['--fx-ink', '--fx-well-2', TEXT],
    ['--fx-ink-2', '--fx-paper', TEXT], ['--fx-ink-2', '--fx-well', TEXT],
    ['--fx-ink-3', '--fx-paper', TEXT], ['--fx-ink-3', '--fx-well', TEXT],
    ['--fx-on-accent', '--fx-accent', TEXT], ['--fx-on-accent', '--fx-accent-press', TEXT],
    ['--fx-accent-text', '--fx-paper', TEXT], ['--fx-accent-text', '--fx-well', TEXT],
    ['--fx-ok', '--fx-ok-wash', TEXT], ['--fx-info', '--fx-info-wash', TEXT], ['--fx-warn', '--fx-warn-wash', TEXT], ['--fx-bad', '--fx-bad-wash', TEXT],
    ['--fx-ok', '--fx-paper', TEXT], ['--fx-info', '--fx-paper', TEXT], ['--fx-warn', '--fx-paper', TEXT], ['--fx-bad', '--fx-paper', TEXT],
    ['--fx-on-bad', '--fx-bad', TEXT], ['--fx-on-ink', '--fx-ink', TEXT], ['--fx-on-ink-2', '--fx-ink', TEXT],
    ['--fx-edge', '--fx-paper', UI], ['--fx-edge', '--fx-well', UI],          // input boundaries, the selected segment (WCAG 1.4.11)
    ['--fx-indicator', '--fx-paper', UI],                                      // badges and unread dots
    ['--fx-focus-color', '--fx-paper', UI], ['--fx-focus-color', '--fx-well', UI],
    ['--fx-ink', '--fx-ink-3', UI],                                            // the selected tab's label against the others
];
for (const [fg, bg, min] of PAIRS) {
    await t(`${fg} on ${bg} ≥ ${min}:1`, () => {
        const r = contrast(fg, bg);
        assert.ok(r >= min, `${r.toFixed(2)}:1`);
    });
}
console.log('\n── Dark theme: the same names, re-pointed ──\n');

// The dark theme is ONE block of token overrides. Nothing else in the artisan
// app may know that a dark theme exists.
const darkStart = tokensCss.indexOf(':root[data-theme="dark"] {');
const darkBlock = darkStart < 0 ? '' : tokensCss.slice(darkStart, tokensCss.indexOf('\n}', darkStart));
const DARK_SET = Object.fromEntries([...darkBlock.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(--fx-[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
const DARK = { ...TOK, ...DARK_SET };
const darkHex = (name) => { const v = DARK[name]; const ref = /^var\((--fx-[\w-]+)\)$/.exec(v || ''); return ref ? darkHex(ref[1]) : v; };
const darkContrast = (fg, bg) => { const [a, b] = [lum(darkHex(fg)), lum(darkHex(bg))].sort((x, y) => y - x); return (a + 0.05) / (b + 0.05); };

await t('there is exactly one dark block, and it lives in tokens.css', () => {
    assert.ok(darkStart > 0, 'tokens.css has a :root[data-theme="dark"] block');
    assert.strictEqual(tokensCss.replace(/\/\*[\s\S]*?\*\//g, '').split(':root[data-theme="dark"]').length - 1, 1);
    const cssDir = path.join(ROOT, 'artisan-app', 'css');
    const others = [];
    (function scan(dir) {
        for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, f.name);
            if (f.isDirectory()) scan(full);
            else if (f.name.endsWith('.css') && f.name !== 'tokens.css' && /data-theme|prefers-color-scheme|\.dark\b/.test(fs.readFileSync(full, 'utf8'))) others.push(path.relative(ROOT, full));
        }
    })(path.join(cssDir, 'fx'));
    if (/data-theme|prefers-color-scheme/.test(appCss)) others.push('artisan-app/css/app.css');
    assert.deepStrictEqual(others, [], 'component stylesheets carry no theme rules of their own');
});
await t('the dark block only re-points colour and elevation tokens that already exist', () => {
    const names = Object.keys(DARK_SET);
    assert.ok(names.length >= 20, String(names.length));
    for (const n of names) {
        assert.ok(n in TOK, n + ' is not a light token: the dark theme may not invent names');
        if (n === '--fx-scheme') { assert.strictEqual(DARK_SET[n], 'dark'); continue; }
        assert.match(DARK_SET[n], /^#[0-9A-Fa-f]{6}$|^rgba\([^)]*\)$|^0 .*rgba\(/, n + ' must be a colour or a shadow: ' + DARK_SET[n]);
        assert.ok(!/^--fx-(size|lh|t|w|space|r|h|d|z|font|track|hit|bar|tab|gutter|ease)(-|$)/.test(n), n + ' is not a colour token');
    }
    assert.strictEqual(TOK['--fx-scheme'], 'light');
    assert.match(appCss, /color-scheme:\s*var\(--fx-scheme\)/, 'the page tells the browser which scheme it is in (form controls, scrollbars)');
});
await t('the brand orange is the same in both themes', () => {
    for (const n of ['--fx-accent', '--fx-accent-press', '--fx-on-accent']) assert.ok(!(n in DARK_SET), n);
});
const DARK_PAIRS = [...PAIRS,
    ['--fx-ink-3', '--fx-well-2', UI],                                         // muted text on a pressed row stays legible as large/UI text
    ['--fx-edge', '--fx-well-2', UI],
    ['--fx-ink', '--fx-ok-wash', TEXT], ['--fx-ink', '--fx-info-wash', TEXT], ['--fx-ink', '--fx-warn-wash', TEXT], ['--fx-ink', '--fx-bad-wash', TEXT],   // a notice's body text
];
for (const [fg, bg, min] of DARK_PAIRS) {
    await t(`dark: ${fg} on ${bg} ≥ ${min}:1`, () => {
        const r = darkContrast(fg, bg);
        assert.ok(r >= min, `${r.toFixed(2)}:1`);
    });
}
await t('dark surfaces are dark and dark ink is light (the block is not a copy of the light one)', () => {
    assert.ok(lum(darkHex('--fx-paper')) < 0.02 && lum(darkHex('--fx-ink')) > 0.8);
    assert.ok(lum(darkHex('--fx-well')) > lum(darkHex('--fx-paper')), 'raised surfaces get lighter in the dark');
});
await t('every artisan page that uses the tokens decides its theme before its stylesheets load', () => {
    const dir = path.join(ROOT, 'artisan-app');
    const missing = [];
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.html'))) {
        const html = fs.readFileSync(path.join(dir, f), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
        if (!/css\/tokens\.css/.test(html)) continue;
        const at = html.indexOf('<script src="js/theme.js"></script>');
        const firstSheet = html.search(/<link[^>]+rel="stylesheet"/);
        if (at < 0 || (firstSheet >= 0 && at > firstSheet)) missing.push(f);
    }
    assert.deepStrictEqual(missing, []);
    // The offline page cannot load anything, so it writes both themes out: they must be the tokens' values.
    const off = read('artisan-app/offline.html');
    assert.match(off, /getItem\('pref_theme'\)/);
    const lightLine = /:root \{ --paper: (#\w+); --ink: (#\w+); --ink-2: (#\w+);/.exec(off);
    const darkLine = /:root\[data-theme="dark"\] \{ --paper: (#\w+); --ink: (#\w+); --ink-2: (#\w+);/.exec(off);
    assert.deepStrictEqual(lightLine.slice(1), [hexOf('--fx-paper'), hexOf('--fx-ink'), hexOf('--fx-ink-2')]);
    assert.deepStrictEqual(darkLine.slice(1), [darkHex('--fx-paper'), darkHex('--fx-ink'), darkHex('--fx-ink-2')]);
    const theme = read('artisan-app/js/theme.js');
    assert.ok(!/#[0-9a-fA-F]{3,6}\b|rgb\(/.test(theme.replace(/\/\*[\s\S]*?\*\//g, '')), 'theme.js knows no colour');
});
await t('white on the accent fails AA (2.8:1) — which is why orange buttons use near-black', () => {
    const r = (lum('#FFFFFF') + 0.05) / (lum(hexOf('--fx-accent')) + 0.05);
    assert.ok(r < 4.5, r.toFixed(2));
});
await t('orange itself is never a small indicator on white (2.8:1): badges use --fx-indicator', () => {
    assert.ok(contrast('--fx-accent', '--fx-paper') < 3);
    for (const sel of ['.fx-iconbtn__badge', '.fx-tab__badge']) {
        const block = appCss.slice(appCss.indexOf(sel + ' {'), appCss.indexOf('}', appCss.indexOf(sel + ' {')));
        assert.match(block, /background: var\(--fx-indicator\)/, sel);
    }
});

console.log('\n── Enforcement ──\n');

await t('app.css passes the lint with no exceptions', () => {
    const r = lint.lintCss(appCss, 'artisan-app/css/app.css');
    assert.deepStrictEqual(r.violations.map((v) => `${v.line} ${v.rule} ${v.msg}`), []);
    assert.strictEqual(r.exceptions.length, 0);
});
await t('the lint catches each rule it enforces', () => {
    const fixture = [
        '.fx-a { color: #fff; }', '.fx-a { background: rgba(0,0,0,.5); }', '.fx-a { color: red; }',
        '.fx-a { border-radius: 12px; }', '.fx-a { box-shadow: 0 2px 4px var(--fx-ink); }',
        '.fx-a { font-size: 15px; }', '.fx-a { font-weight: 700; }', '.fx-a { z-index: 99; }',
        '.fx-a { transition: opacity 200ms; }', '.fx-a { margin: 13px; }', '.fx-a { color: var(--fx-ink) !important; }',
        '#x .fx-a { color: var(--fx-ink); }', '.fx-a.fx-b.fx-c.fx-d { color: var(--fx-ink); }', 'button { color: var(--fx-ink); }',
        '.fx-a { color: var(--ds-ink); }', '.fx-a { color: var(--fx-nope); }', '.fx-a { --fx-x: 4px; }', '.fx-a { color: Highlight; }',
    ].join('\n');
    const rules = new Set(lint.lintCss(fixture, 'fixture.css').violations.map((v) => v.rule));
    for (const r of ['raw-colour', 'raw-radius', 'raw-shadow', 'raw-type', 'raw-z', 'raw-duration', 'raw-space', 'important',
                     'id-selector', 'specificity', 'scope', 'mixed-system', 'unknown-token', 'raw-custom']) {
        assert.ok(rules.has(r), `not caught: ${r}`);
    }
});
await t('a documented exception passes and is reported, never silent', () => {
    const r = lint.lintCss('.fx-a { gap: 6px; /* fx-allow: map tiles need an odd gap */ }', 'x.css');
    assert.strictEqual(r.violations.length, 0);
    assert.deepStrictEqual(r.exceptions.map((e) => [e.rule, e.reason]), [['raw-space', 'map tiles need an odd gap']]);
});
await t('forced-colours system colours are allowed only in their media block', () => {
    assert.strictEqual(lint.lintCss('@media (forced-colors: active) { .fx-a { border-color: ButtonText; } }', 'x.css').violations.length, 0);
});
await t('an opted-in page may not carry inline styles', () => {
    const r = lint.lintPage('<body class="fx-app"><p style="color:#000">x</p></body>', 'p.html');
    assert.deepStrictEqual(r.violations.map((v) => v.rule), ['inline-style']);
    assert.strictEqual(lint.lintPage('<body class="other"><p style="color:#000">x</p></body>', 'p.html').optedIn, false);
});
await t('lint:fx is part of npm run lint', () => {
    const pkg = JSON.parse(read('package.json'));
    assert.match(pkg.scripts.lint, /npm run lint:fx/);
    assert.strictEqual(pkg.scripts['lint:fx'], 'node scripts/check-fx-design-system.cjs');
});

console.log('\n── Customer maroon, artisan orange ──\n');

await t('nothing in the customer app references the artisan system', () => {
    const hits = [];
    const walk = (dir) => { for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = `${dir}/${e.name}`;
        if (e.isDirectory()) { if (!/node_modules/.test(rel)) walk(rel); }
        else if (/\.(css|html|js)$/.test(e.name) && /--fx-|css\/tokens\.css|css\/app\.css|js\/fx\//.test(fs.readFileSync(path.join(ROOT, rel), 'utf8'))) hits.push(rel);
    } };
    walk('customer-app');
    assert.deepStrictEqual(hits, []);
});
await t('the artisan tokens hold no customer maroon (--ui-primary #730201)', () => {
    const maroon = /--ui-primary:\s*(#[0-9a-f]{6})/i.exec(read('shared/css/ui-polish.css'))[1].toUpperCase();
    assert.strictEqual(maroon, '#730201');
    assert.ok(!Object.values(TOK).some((v) => v.toUpperCase().includes(maroon)));
    assert.ok(!/var\(--ui-/.test(tokensCss + appCss), 'no customer tokens in the artisan system');
});

console.log('\n── Behaviour (pure) ──\n');

const controls = await import(pathToFileURL(path.join(ROOT, 'artisan-app', 'js', 'fx', 'controls.js')).href);
const icons    = await import(pathToFileURL(path.join(ROOT, 'artisan-app', 'js', 'fx', 'icons.js')).href);

await t('countdown urgency: normal › soon (≤30s) › now (≤10s) › done', () => {
    const u = controls.countdownUrgency;
    assert.deepStrictEqual([180_000, 30_001, 30_000, 10_001, 10_000, 1, 0, -5].map((ms) => u(ms)),
        ['normal', 'normal', 'soon', 'soon', 'now', 'now', 'done', 'done']);
});
await t('the four tabs: Today · Jobs · Earnings · Account', () => {
    assert.deepStrictEqual(controls.ARTISAN_TABS.map((x) => x.label), ['Today', 'Jobs', 'Earnings', 'Account']);
});
await t('renderTabbar marks the current tab and gives a badge words', () => {
    const nav = { innerHTML: '' };
    controls.renderTabbar(nav, { current: 'jobs', badges: { jobs: '2 new offers' } });
    assert.strictEqual((nav.innerHTML.match(/class="fx-tab"/g) || []).length, 4);
    assert.strictEqual((nav.innerHTML.match(/aria-current="page"/g) || []).length, 1);
    assert.match(nav.innerHTML, /href="jobs\.html" aria-current="page"/);
    assert.match(nav.innerHTML, /<span class="fx-sr">, 2 new offers<\/span>/);
    controls.renderTabbar(nav, { current: 'today', badges: { jobs: '<img src=x onerror=alert(1)>' } });
    assert.ok(!nav.innerHTML.includes('<img'), 'badge text is escaped');
});
await t('icons are decorative and take the component\'s colour', () => {
    const svg = icons.icon('bell');
    assert.match(svg, /aria-hidden="true"/);
    assert.match(svg, /stroke="currentColor"/);
    assert.strictEqual(icons.icon('nope'), '');
    for (const tab of controls.ARTISAN_TABS) assert.ok(icons.ICON_NAMES.includes(tab.icon), tab.icon);
});

console.log(`\nfx-design-system: ${passed} passed, ${failed} failed`);
if (failed) { for (const [n, e] of failures) console.error(`\n✗ ${n}\n${e.stack}`); process.exit(1); }
process.exit(0);
})();
