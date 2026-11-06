'use strict';
/**
 * tests/artisan-dashboard-page.test.cjs — artisan dashboard findings from the
 * 28 Oct audit, checked against the page itself.
 *
 *   FUNC-001  The "This Week" selector under Your Performance did nothing.
 *   COPY-003  (link only) The schedule's "View all" opened a tab that does not exist.
 *   RESP-001  (dashboard) Quick Access was cut off on narrow phones.
 *   UI-003    The same status showed in different colours on different screens.
 *
 * Phase 2 (2026-11-06) rebuilt the dashboard as Today (artisan-app/dashboard.html
 * drawn by artisan-app/js/today.js). Each finding is held against the new
 * screen: the Performance and Quick Access sections became one "Your work" list,
 * the schedule's "View all" became rows that open each job, and the status chip
 * takes resolveJourney's tone. The rendered checks are in tests/e2e/artisan_today.py.
 */
require('./support/no-production.cjs');   // must stay the first statement (npm run lint:tests)

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');
const page = read('artisan-app/dashboard.html');
const view = read('artisan-app/js/today.js');

let passed = 0, failed = 0;
const failures = [];
async function t(name, fn) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { failed++; failures.push([name, e]); console.log(`  ✗ ${name}`); }
}

/** The "Your work" list on Today: [href, label] per row. */
function workRows() {
    const at = page.indexOf('<h2 class="fx-sect__title" id="more-h">Your work</h2>');
    assert.ok(at > -1, 'the "Your work" section is missing');
    const list = page.slice(at, page.indexOf('</ul>', at));
    return [...list.matchAll(/<a class="fx-row" href="([^"]+)">[\s\S]*?<span class="fx-row__title">([^<]+)<\/span>/g)].map((m) => [m[1], m[2]]);
}

(async () => {
console.log('\n── FUNC-001 · no dead controls; Performance is one tap away ──\n');

await t('the dead "This Week" selector is gone; a row goes to Performance', () => {
    assert.ok(!/id="perf-period-btn"/.test(page));
    assert.ok(!/>\s*This Week\s*</.test(page));
    assert.deepStrictEqual(workRows()[0], ['performance.html', 'Performance']);
    assert.ok(fs.existsSync(path.join(ROOT, 'artisan-app', 'performance.html')));
});

console.log('\n── COPY-003 · every link into Jobs opens something that exists ──\n');

await t('a job on Today opens that job; the only other ways into Jobs are the tab and ?quote=', () => {
    assert.match(view, /const jobHref = \(id\) => `job\.html\?id=\$\{encodeURIComponent\(id\)\}`;/);
    assert.match(view, /<a class="fx-row" href="\$\{jobHref\(b\.id\)\}">/, 'waiting / upcoming rows open the job');
    const links = [...(page + view).matchAll(/jobs\.html(\?[^"`'\s]*)?/g)].map((m) => m[1] || '');
    assert.ok(links.length >= 1);
    for (const q of links) assert.ok(q === '' || /^\?quote=/.test(q), `unexpected Jobs link: jobs.html${q}`);
});
await t('every jobs.html?tab= link left on Today names a tab Jobs actually has', () => {
    const jobs = read('artisan-app/jobs.html');
    const tabs = JSON.parse(jobs.match(/const JOB_TABS\s*=\s*(\[[^\]]*\])/)[1].replace(/'/g, '"'));
    const links = [...(page + view).matchAll(/jobs\.html\?tab=([a-z]+)/g)].map((m) => m[1]);
    for (const tab of links) assert.ok(tabs.includes(tab), `jobs.html?tab=${tab} — Jobs has ${tabs.join(', ')}`);
});

console.log('\n── RESP-001 · nothing on Today scrolls sideways ──\n');

await t('Quick Access is a full-width list ("Your work"), not a sideways strip', () => {
    assert.ok(!/quick-access-row|quick-item/.test(page), 'the sideways strip is back');
    assert.deepStrictEqual(workRows().map((r) => r[0]), ['performance.html', 'reviews.html', 'profile.html?edit=area', 'support.html']);
    // 360 / 390 / 768 px and 200% text, rendered: tests/e2e/artisan_today.py.
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
await t('Jobs loads it and keeps no pill palette of its own', () => {
    const jobs = read('artisan-app/jobs.html');
    assert.match(jobs, /<link rel="stylesheet" href="\.\.\/shared\/css\/components\/booking-pill\.css" \/>/);
    assert.ok(!/^\s*\.pill-[a-z_]+\s*\{/m.test(jobs), 'jobs.html still defines .pill-* rules');
});
await t('css/dashboard.css keeps no pill or status-chip palette of its own (UI-003 cleanup)', () => {
    const css = read('artisan-app/css/dashboard.css');
    assert.ok(!/^\s*\.pill-[a-z_]+\s*\{/m.test(css), 'a .pill-* rule is back in dashboard.css');
    assert.ok(!/\.status-(upcoming|progress|pending)\s*\{/.test(css), 'a hand-coloured status chip rule is back');
});
await t("Today's stage chip is coloured by resolveJourney's tone, not a hand-written status check", () => {
    assert.match(view, /const CHIP_TONE = \{ action: 'fx-chip--accent', live: 'fx-chip--info', waiting: 'fx-chip--warn', ended: '' \};/);
    assert.match(view, /<span class="fx-chip \$\{CHIP_TONE\[j\.tone\] \|\| ''\}">\$\{esc\(j\.here\)\}<\/span>/);
    assert.ok(!/status === '|\.status ===/.test(view), 'today.js branches on a status of its own');
    // Today is on the artisan design system: none of the legacy pill classes.
    assert.ok(!/pill-|booking-pill\.css|css\/dashboard\.css/.test(page), 'Today mixes in the legacy palette');
});

console.log(`\nartisan-dashboard-page: ${passed} passed, ${failed} failed`);
for (const [name, e] of failures) console.log(`\n  ✗ ${name}\n    ${e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n    ') : e}`);
process.exit(failed ? 1 : 0);
})();
