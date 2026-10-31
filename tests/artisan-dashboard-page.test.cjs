'use strict';
/**
 * tests/artisan-dashboard-page.test.cjs — artisan dashboard findings from the
 * 28 Oct audit, checked against the page itself.
 *
 *   FUNC-001  The "This Week" selector under Your Performance did nothing.
 *   COPY-003  (link only) The schedule's "View all" opened a tab that does not exist.
 *   RESP-001  (dashboard) Quick Access was cut off on narrow phones.
 *   UI-003    The same status showed in different colours on different screens.
 */
require('./support/no-production.cjs');   // must stay the first statement (npm run lint:tests)

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');
const page = read('artisan-app/dashboard.html');

let passed = 0, failed = 0;
const failures = [];
async function t(name, fn) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { failed++; failures.push([name, e]); console.log(`  ✗ ${name}`); }
}

/** The header link of a dashboard section, by its title. */
function sectionLink(title) {
    const at = page.indexOf(`<span class="section-title">${title}</span>`);
    assert.ok(at > -1, `section "${title}" not found`);
    const end = page.indexOf('</div>', at);
    const m = page.slice(at, end).match(/<a href="([^"]+)" class="view-all-link">\s*([^<]+?)\s*</);
    return m ? { href: m[1], text: m[2] } : null;
}

(async () => {
console.log('\n── FUNC-001 · no dead controls under Your Performance ──\n');

await t('the dead "This Week" selector is gone; a link goes to Performance', () => {
    assert.ok(!/id="perf-period-btn"/.test(page));
    assert.ok(!/>\s*This Week\s*</.test(page));
    assert.deepStrictEqual(sectionLink('Your Performance'), { href: 'performance.html', text: 'See Performance' });
    assert.ok(fs.existsSync(path.join(ROOT, 'artisan-app', 'performance.html')));
});

console.log('\n── COPY-003 · every "View all" opens a tab that exists ──\n');

await t("the schedule's \"View all\" opens Jobs on the Active tab", () => {
    assert.strictEqual(sectionLink("Today's Schedule").href, 'jobs.html?tab=active');
});
await t('every dashboard link into Jobs names a tab Jobs actually has', () => {
    const jobs = read('artisan-app/jobs.html');
    const tabs = JSON.parse(jobs.match(/const JOB_TABS\s*=\s*(\[[^\]]*\])/)[1].replace(/'/g, '"'));
    const links = [...page.matchAll(/href="jobs\.html\?tab=([a-z]+)"/g)].map((m) => m[1]);
    assert.ok(links.length >= 2);
    for (const tab of links) assert.ok(tabs.includes(tab), `jobs.html?tab=${tab} — Jobs has ${tabs.join(', ')}`);
});

console.log('\n── RESP-001 · Quick Access fits a narrow phone ──\n');

await t('on screens up to 400px Quick Access is a 3 + 2 grid, not a hidden sideways scroll', () => {
    const rule = page.match(/@media \(max-width: 400px\) \{[\s\S]*?\.quick-access-row \{([^}]*)\}[\s\S]*?\.quick-item \{([^}]*)\}/);
    assert.ok(rule, 'narrow-screen rule missing');
    assert.match(rule[1], /display: grid; grid-template-columns: repeat\(3, minmax\(0, 1fr\)\); overflow-x: visible;/);
    assert.match(rule[2], /min-width: 0;/);
});

console.log('\n── UI-003 · one colour per status, on every screen ──\n');

const pillCss = read('shared/css/components/booking-pill.css');
const metaSrc = read('shared/js/domain/bookingStatusMeta.js');

await t('every tone describe() can return has a rule in booking-pill.css', () => {
    const tones = new Set([...metaSrc.matchAll(/tone:\s*'([a-z_]+)'/g)].map((m) => m[1]));
    assert.ok(tones.size >= 9, `only ${tones.size} tones found — the scan is broken`);
    for (const tone of tones) assert.match(pillCss, new RegExp(`\\.pill-${tone}\\s*\\{`), `no rule for tone "${tone}"`);
});
await t('booking-pill.css uses design tokens only — no raw colours', () => {
    const decls = pillCss.replace(/\/\*[\s\S]*?\*\//g, '');
    assert.ok(!/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/.test(decls), 'a raw colour crept in');
    for (const m of decls.matchAll(/(?:background|color):\s*([^;]+);/g)) assert.match(m[1], /^var\(--ds-[a-z0-9-]+\)$/, m[1]);
});
await t('the dashboard and Jobs both load it; Jobs keeps no pill palette of its own', () => {
    assert.match(page, /<link rel="stylesheet" href="\.\.\/shared\/css\/components\/booking-pill\.css" \/>/);
    const jobs = read('artisan-app/jobs.html');
    assert.match(jobs, /<link rel="stylesheet" href="\.\.\/shared\/css\/components\/booking-pill\.css" \/>/);
    assert.ok(!/^\s*\.pill-[a-z_]+\s*\{/m.test(jobs), 'jobs.html still defines .pill-* rules');
    const dashCss = page.indexOf('href="css/dashboard.css"'), pills = page.indexOf('booking-pill.css');
    assert.ok(dashCss > -1 && pills > dashCss, 'loaded after dashboard.css, so it wins');
});
await t('css/dashboard.css keeps no pill or status-chip palette of its own (UI-003 cleanup)', () => {
    const css = read('artisan-app/css/dashboard.css');
    assert.ok(!/^\s*\.pill-[a-z_]+\s*\{/m.test(css), 'a .pill-* rule is back in dashboard.css');
    assert.ok(!/\.status-(upcoming|progress|pending)\s*\{/.test(css), 'a hand-coloured status chip rule is back');
});
await t("the schedule chip is coloured by the status's tone, not a hand-written check", () => {
    assert.match(page, /const statusClass = sm\.pillCls;/);
    assert.ok(!/d\.status === 'accepted' \? 'status-upcoming'/.test(page));
    assert.match(page, /pillCls: `pill-\$\{d\.tone\}`/);
});

console.log(`\nartisan-dashboard-page: ${passed} passed, ${failed} failed`);
for (const [name, e] of failures) console.log(`\n  ✗ ${name}\n    ${e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n    ') : e}`);
process.exit(failed ? 1 : 0);
})();
