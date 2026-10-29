'use strict';
/**
 * tests/artisan-cache-first.test.cjs — PERF-002: five artisan screens paint
 * from cache first (CLAUDE.md §1, "render first, fetch second").
 *
 * notifications, performance, reviews, support ("Your requests") and messages
 * (the inbox) each waited on the network on every visit. Each now mounts its
 * list through mountInstantView — the one sanctioned cache path — with a key
 * and a version, keeps content on a failed refresh, tears down on pagehide,
 * and caches only what its rows show: never money (performance strips
 * totalEarned), never contact data, never another person's words (the inbox
 * caches no message previews), never notification metadata or ticket owner
 * fields.
 *
 * Source-level here; tests/e2e/artisan_cache_first.py runs the CLAUDE.md §1
 * "return visit" test on the real pages in Chromium.
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

/** The page's module script, comments removed (they describe what is NOT done). */
function moduleOf(file) {
    const src = read(file);
    const m = /<script type="module">([\s\S]*?)<\/script>/.exec(src);
    assert.ok(m, `${file}: no module script`);
    return m[1].replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

/** The object literal passed to mountInstantView({ key: '<key>', ... }). */
function viewOf(code, key) {
    const at = code.indexOf(`key: '${key}'`);
    assert.ok(at > 0, `view ${key} not found`);
    const open = code.lastIndexOf('mountInstantView({', at);
    let depth = 0;
    for (let i = code.indexOf('{', open); i < code.length; i++) {
        if (code[i] === '{') depth++;
        else if (code[i] === '}' && --depth === 0) return code.slice(open, i + 1);
    }
    throw new Error(`view ${key}: unbalanced`);
}

const SCREENS = [
    { file: 'artisan-app/notifications.html', key: 'artisan-notifications',    mode: 'subscribe' },
    { file: 'artisan-app/performance.html',   key: 'artisan-performance',      mode: 'fetch' },
    { file: 'artisan-app/reviews.html',       key: 'artisan-reviews',          mode: 'fetch' },
    { file: 'artisan-app/support.html',       key: 'artisan-support-requests', mode: 'subscribe' },
    { file: 'artisan-app/messages.html',      key: 'artisan-messages-inbox',   mode: 'subscribe' },
];

console.log('\n── Every screen: the one cache path, keyed and versioned ──\n');

for (const s of SCREENS) {
    t(`${path.basename(s.file)}: mountInstantView '${s.key}' v1, ${s.mode}, failed refresh keeps content, pagehide teardown`, () => {
        const code = moduleOf(s.file);
        assert.match(code, /import \{ mountInstantView \}\s+from '\.\.\/shared\/js\/services\/instantView\.js';/);
        const v = viewOf(code, s.key);
        assert.match(v, /version: 1,/);
        assert.match(v, new RegExp(`\\b${s.mode}: `));
        // A failed refresh keeps content: the handler bails out when content is showing.
        assert.match(v, /onError: \((?:_err|err), \{ hasContent \}\) => \{[\s\S]*?if \(hasContent\) return;/);
        // onEmpty, where present, only reveals the skeleton the markup already has.
        const onEmpty = /onEmpty: ([^\n]*)/.exec(v);
        if (onEmpty) assert.doesNotMatch(onEmpty[1], /innerHTML|fetch|subscribe/);
        // Torn down on pagehide.
        assert.match(code, /addEventListener\('pagehide'[\s\S]{0,200}(?:\.destroy\(\)|_unsub\?\.\(\)|unsubChats\?\.\(\))/);
        // No hand-rolled caching beside it.
        assert.doesNotMatch(code, /localStorage|sessionStorage|readCache|writeCache|persistentCache/);
    });
}

t('the five keys are unique across the artisan app', () => {
    const keys = fs.readdirSync(path.join(ROOT, 'artisan-app')).filter((f) => f.endsWith('.html'))
        .flatMap((f) => [...read(`artisan-app/${f}`).matchAll(/mountInstantView\(\{\s*key:\s*'([^']+)'/g)].map((m) => m[1]));
    for (const s of SCREENS) assert.ok(keys.includes(s.key), s.key);
    assert.strictEqual(new Set(keys).size, keys.length, `duplicate keys: ${keys.join(', ')}`);
});

console.log('\n── What each screen caches ──\n');

t('notifications: a row\'s fields only — no metadata, sender, receiver or readAt', () => {
    const code = moduleOf('artisan-app/notifications.html');
    const shape = /const cacheable = \(n\) => \(\{([\s\S]*?)\}\);/.exec(code);
    assert.ok(shape, 'cacheable()');
    for (const f of ['id', 'type', 'title', 'message', 'isRead', 'actionUrl', 'createdAt']) assert.match(shape[1], new RegExp(`\\b${f}:`));
    for (const f of ['metadata', 'senderId', 'receiverId', 'readAt']) assert.doesNotMatch(shape[1], new RegExp(`\\b${f}\\b`));
    assert.match(viewOf(code, 'artisan-notifications'), /onData\(notifications\.map\(cacheable\)\)/);
});

t('performance: money stripped (totalEarned), always revalidated, bookings reduced to what the figures need', () => {
    const code = moduleOf('artisan-app/performance.html');
    const v = viewOf(code, 'artisan-performance');
    assert.match(v, /stripFields: \['totalEarned'\]/);
    assert.match(v, /staleMs: 0,/);
    const load = code.slice(code.indexOf('async function loadPerformance'), code.indexOf('const perfView'));
    const row = /bookings: \(bookings \|\| \[\]\)\.map\(b => \(\{([\s\S]*?)\}\)\),/.exec(load);
    assert.ok(row, 'the booking projection');
    for (const f of ['price', 'jobQuote', 'calloutFee', 'address', 'customerPhone', 'customerName', 'lat', 'lng']) {
        assert.doesNotMatch(row[1], new RegExp(`\\b${f}\\b`), `${f} would be cached`);
    }
    // A cached paint (no totalEarned) shows "—", never "GHS 0".
    assert.match(code, /_artisan\.totalEarned == null \? '—'/);
});

t('reviews: the review shape only — never the booking\'s prices, address or contact fields', () => {
    const code = moduleOf('artisan-app/reviews.html');
    const load = code.slice(code.indexOf('async function loadReviews'), code.indexOf('const reviewsView'));
    for (const f of ['price', 'jobQuote', 'calloutFee', 'address', 'customerPhone', 'phone', 'email', 'lat', 'lng']) {
        assert.doesNotMatch(load, new RegExp(`\\b${f}\\b`), `${f} would be cached`);
    }
    assert.match(viewOf(code, 'artisan-reviews'), /staleMs: 0,/);
});

t('support: topic, own message, status and dates — never userEmail, userName or userId', () => {
    const code = moduleOf('artisan-app/support.html');
    const shape = code.slice(code.indexOf('const cacheableTicket'), code.indexOf('const _ticketsView'));
    assert.match(shape, /return \{ id: r\.id, subject: d\.subject, message: d\.message, status: d\.status,/);
    for (const f of ['userEmail', 'userName', 'userId']) assert.doesNotMatch(shape, new RegExp(f));
    assert.match(viewOf(code, 'artisan-support-requests'), /onData\(\(records \|\| \[\]\)\.map\(cacheableTicket\)\)/);
});

t('messages: rows carry no preview; previews live in memory only; the inbox no longer waits on the booking read', () => {
    const code = moduleOf('artisan-app/messages.html');
    const rows = code.slice(code.indexOf('async function toRows'), code.indexOf('function paintList'));
    const ret = /return \{([\s\S]*?)\};/.exec(rows);
    assert.ok(ret, 'the cached row');
    assert.doesNotMatch(ret[1], /lastMessage\b|text|preview/i, 'a message preview would be cached');
    assert.match(rows, /PREVIEWS\.set\(c\.id, c\.data\.lastMessage \|\| ''\);/);
    assert.match(code, /const preview = fromCache \? '' : \(PREVIEWS\.get\(r\.id\) \|\| 'No messages yet'\);/);
    // Only the newest snapshot paints (names resolve asynchronously).
    assert.match(code, /const seq = \+\+_rowsSeq;[\s\S]{0,80}if \(seq === _rowsSeq\) onData\(rows\);/);
    // Mounted before the booking context read.
    assert.ok(code.indexOf("key: 'artisan-messages-inbox'") < code.indexOf('bookingCtx = await loadBookingContext();'),
        'the inbox waits on loadBookingContext');
    // A row tapped before the live list arrives opens with the painted name.
    assert.match(code, /const painted = ROW_INFO\.get\(chatId\);/);
});

console.log(`\nartisan-cache-first: ${passed} passed, ${failed} failed`);
for (const [name, e] of failures) console.log(`\n  ✗ ${name}\n    ${e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n    ') : e}`);
process.exit(failed ? 1 : 0);
