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
    // notifications is v2: a v1 payload could hold chat text, so it is never painted.
    { file: 'artisan-app/notifications.html', key: 'artisan-notifications',    mode: 'subscribe', version: 2 },
    // Phase 4: performance and reviews are one screen, Reputation (the old pages forward).
    { file: 'artisan-app/reputation.html',    key: 'artisan-reputation',       mode: 'fetch',     version: 1 },
    { file: 'artisan-app/support.html',       key: 'artisan-support-requests', mode: 'subscribe', version: 1 },
    { file: 'artisan-app/messages.html',      key: 'artisan-messages-inbox',   mode: 'subscribe', version: 1 },
];

console.log('\n── Every screen: the one cache path, keyed and versioned ──\n');

for (const s of SCREENS) {
    t(`${path.basename(s.file)}: mountInstantView '${s.key}' v${s.version}, ${s.mode}, failed refresh keeps content, pagehide teardown`, () => {
        const code = moduleOf(s.file);
        assert.match(code, /import \{ mountInstantView \}\s+from '\.\.\/shared\/js\/services\/instantView\.js';/);
        const v = viewOf(code, s.key);
        assert.match(v, new RegExp(`version: ${s.version},`));
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

t('the screens\' keys are unique across the artisan app', () => {
    const keys = fs.readdirSync(path.join(ROOT, 'artisan-app')).filter((f) => f.endsWith('.html'))
        .flatMap((f) => [...read(`artisan-app/${f}`).matchAll(/mountInstantView\(\{\s*key:\s*'([^']+)'/g)].map((m) => m[1]));
    for (const s of SCREENS) assert.ok(keys.includes(s.key), s.key);
    assert.strictEqual(new Set(keys).size, keys.length, `duplicate keys: ${keys.join(', ')}`);
});

console.log('\n── What each screen caches ──\n');

/** cacheable() and its live-text map, evaluated from the page. */
function loadCacheable() {
    const code = moduleOf('artisan-app/notifications.html');
    const src = code.slice(code.indexOf('const LIVE_CHAT_TEXT = new Map();'), code.indexOf('const view = mountInstantView'));
    assert.ok(src.includes('const cacheable = (n) =>'), 'cacheable()');
    // cacheable() reads an offer alert's deadline through jobOffers' offerState.
    const offers = read('shared/js/domain/jobOffers.js')
        .replace(/^\s*export\s+function\s+/gm, 'function ').replace(/^\s*export\s+const\s+/gm, 'const ');
    // eslint-disable-next-line no-new-func
    return new Function(`${offers}\n${src}\nreturn { cacheable, LIVE_CHAT_TEXT };`)();
}
const NOTE = (over) => ({ id: 'n1', type: 'Bookings', title: 'Job accepted', message: 'Kofi accepted your plumbing job.',
    isRead: false, readAt: null, actionUrl: 'booking.html', metadata: { bookingId: 'HHB-1' }, senderId: 'S', receiverId: 'A1',
    createdAt: new Date('2026-10-28T09:00:00Z'), ...over });

t('notifications: a row\'s fields only — no metadata, sender, receiver or readAt', () => {
    const { cacheable } = loadCacheable();
    assert.deepStrictEqual(cacheable(NOTE()), {
        id: 'n1', type: 'Bookings', title: 'Job accepted', isRead: false, message: 'Kofi accepted your plumbing job.',
        actionUrl: 'booking.html', expiresAtMs: null, createdAt: '2026-10-28T09:00:00.000Z',
    });
    // An offer alert keeps its deadline (a number) — and still nothing else of metadata (NOTIF-005).
    const offer = cacheable(NOTE({ metadata: { bookingId: 'HHB-2', expiresAtMs: 1761642180000, round: 1 } }));
    assert.strictEqual(offer.expiresAtMs, 1761642180000);
    assert.ok(!('metadata' in offer) && !JSON.stringify(offer).includes('HHB-2'));
    const code = moduleOf('artisan-app/notifications.html');
    assert.match(viewOf(code, 'artisan-notifications'), /onData\(notifications\.map\(cacheable\)\)/);
});

t('notifications: no chat text in the cache — a Messages row keeps its title; its text lives in memory, live only', () => {
    const { cacheable, LIVE_CHAT_TEXT } = loadCacheable();
    const chat = NOTE({ id: 'n2', type: 'Messages', title: 'New message from Ama', message: 'Call me on 0555000111', actionUrl: 'messages.html?chatId=A1_C1' });
    const row = cacheable(chat);
    assert.ok(!('message' in row), 'a chat preview would be cached');
    assert.ok(!JSON.stringify(row).includes('0555000111'));
    assert.deepStrictEqual([row.title, row.type, row.actionUrl, row.createdAt],
        ['New message from Ama', 'Messages', 'messages.html?chatId=A1_C1', '2026-10-28T09:00:00.000Z']);
    assert.strictEqual(LIVE_CHAT_TEXT.get('n2'), 'Call me on 0555000111', 'the live list still shows it');
    // The renderer puts the live text back, and a cached paint (empty map) shows the title alone.
    const code = moduleOf('artisan-app/notifications.html');
    assert.match(viewOf(code, 'artisan-notifications'),
        /message: n\.type === 'Messages' \? \(LIVE_CHAT_TEXT\.get\(n\.id\) \|\| ''\) : n\.message,/);
    assert.match(code, /\$\{n\.message \? `<p class="notif-item-msg">\$\{escHtml\(n\.message\)\}<\/p>` : ''\}/);
});

t('reputation: always revalidated; the profile and bookings reduced to what the figures need — no money, prices, address, contact or full name', () => {
    const code = moduleOf('artisan-app/reputation.html');
    const v = viewOf(code, 'artisan-reputation');
    assert.match(v, /staleMs: 0,/);
    assert.match(v, /fetch: \(\) => loadReputation\(user\.uid\),/);
    const shape = code.slice(code.indexOf('const artisanOf'), code.indexOf('async function loadReputation'));
    const artisan = /const artisanOf = \(a\) => \(\{([\s\S]*?)\}\);/.exec(shape);
    const booking = /const bookingOf = \(b\) => \(\{([\s\S]*?)\}\);/.exec(shape);
    assert.ok(artisan && booking, 'the two projections');
    // Money never enters this cache (the old Performance page had to strip totalEarned).
    for (const f of ['totalEarned', 'availableBalance', 'withdrawnTotal', 'phone', 'email', 'payoutAccount', 'name', 'lat', 'lng']) {
        assert.doesNotMatch(artisan[1], new RegExp(`\\b${f}\\b`), `artisan.${f} would be cached`);
    }
    for (const f of ['price', 'jobQuote', 'calloutFee', 'address', 'customerPhone', 'customerName', 'customerId', 'phone', 'email', 'lat', 'lng']) {
        assert.doesNotMatch(booking[1], new RegExp(`\\b${f}\\b`), `booking.${f} would be cached`);
    }
    // The load returns exactly the projections, and "complete" only on a short read.
    const load = code.slice(code.indexOf('async function loadReputation'), code.indexOf('// ── Paint'));
    assert.match(load, /return \{ artisan: artisanOf\(\(snap && snap\.data\) \|\| \{\}\), bookings: list, complete: list\.length < REPUTATION_READ_LIMIT \};/);
});

t('performance.html and reviews.html forward to Reputation; they read and cache nothing any more', () => {
    for (const [f, to] of [['artisan-app/performance.html', 'reputation.html'], ['artisan-app/reviews.html', 'reputation.html#reviews']]) {
        const src = read(f);
        assert.ok(src.includes(`location.replace('${to}')`), `${f} forwards to ${to}`);
        assert.ok(!/mountInstantView|databaseService|queryWithOptions/.test(src), `${f} still loads data`);
    }
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

console.log('\n── NOTIF-002: every notification type lands in a tab ──\n');

/** Every literal `type` the Cloud Functions write to customer_notifications. */
function serverNotificationTypes() {
    const files = [];
    (function walk(d) {
        for (const e of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) {
            const p = `${d}/${e.name}`;
            if (e.isDirectory()) { if (!['node_modules', 'shared'].includes(e.name)) walk(p); }
            else if (p.endsWith('.js')) files.push(p);
        }
    })('functions');
    const argsAt = (src, open) => {
        let depth = 0;
        for (let j = open; j < src.length; j++) {
            if (src[j] === '(') depth++;
            else if (src[j] === ')' && --depth === 0) return src.slice(open, j + 1);
        }
        return '';
    };
    const types = new Set();
    for (const f of files) {
        const src = read(f);
        // Calls to the two writers (and the notify(...) wrappers forwarding to
        // them) that pass an object literal; definitions and pass-throughs of a
        // variable carry no literal and are skipped.
        for (const m of src.matchAll(/\b(sendNotification|sendArtisanNotification|notify)\s*\(/g)) {
            const call = argsAt(src, m.index + m[0].length - 1);
            if (!call.includes('{')) continue;
            const t = /\btype\s*:\s*'([^']+)'/.exec(call);
            types.add(t ? t[1] : 'General');   // the writers default a missing type to 'General'
        }
        for (const m of src.matchAll(/collection\('customer_notifications'\)\.add\(/g)) {
            const t = /\btype\s*:\s*'([^']+)'/.exec(argsAt(src, m.index + m[0].length - 1));
            if (t) types.add(t[1]);
        }
    }
    // The booking lifecycle's table (sent with type: rule.type).
    const b = read('functions/bookings.js');
    const table = b.slice(b.indexOf('const TRANSITIONS = ['), b.indexOf('];', b.indexOf('const TRANSITIONS = [')));
    for (const m of table.matchAll(/type:\s*'([^']+)'/g)) types.add(m[1]);
    return [...types].sort();
}

/** tabOf + NOTIF_TAB, evaluated from the page itself. */
function loadTabOf() {
    const code = moduleOf('artisan-app/notifications.html');
    const map = /const NOTIF_TAB = \{[\s\S]*?\};/.exec(code);
    const fn  = /function tabOf\(type\) \{[\s\S]*?\n\}/.exec(code);
    assert.ok(map && fn, 'NOTIF_TAB / tabOf not found');
    // eslint-disable-next-line no-new-func
    return new Function(`${map[0]}\n${fn[0]}\nreturn tabOf;`)();
}

const TABS = (() => {
    const html = read('artisan-app/notifications.html');
    return [...html.matchAll(/data-filter="([^"]+)"/g)].map((m) => m[1]).filter((f) => f !== 'all');
})();

t('the scan finds the server\'s notification types (guards the scan itself)', () => {
    const types = serverNotificationTypes();
    for (const k of ['Bookings', 'Payments', 'System', 'Updates', 'booking_accepted', 'booking_rejected', 'booking_en_route',
                     'booking_started', 'booking_awaiting', 'booking_completed', 'booking_cancelled', 'booking_disputed']) {
        assert.ok(types.includes(k), `${k} not found: ${types.join(', ')}`);
    }
});

t('every type the server writes lands in a filter tab — none falls through to hidden', () => {
    const tabOf = loadTabOf();
    assert.deepStrictEqual(TABS, ['Bookings', 'Payments', 'Messages', 'System']);
    const homeless = serverNotificationTypes().filter((type) => !TABS.includes(tabOf(type)));
    assert.deepStrictEqual(homeless, []);
});

t('booking lifecycle types (completed, cancelled…) are Jobs; the rules\' and clients\' types have their tabs', () => {
    const tabOf = loadTabOf();
    for (const type of serverNotificationTypes().filter((x) => /^booking_/.test(x))) assert.strictEqual(tabOf(type), 'Bookings', type);
    // Every type firestore.rules lets a client write (chat, support, booking confirmations).
    const rules = read('firestore.rules');
    const block = rules.slice(rules.indexOf('match /customer_notifications/{notificationId}'));
    const allowed = /incoming\(\)\.type in \[([^\]]+)\]/.exec(block)[1].match(/'([^']+)'/g).map((s) => s.slice(1, -1));
    for (const type of allowed) assert.ok(TABS.includes(tabOf(type)), `${type} → ${tabOf(type)}`);
    assert.strictEqual(tabOf('Messages'), 'Messages');
    assert.strictEqual(tabOf('Payments'), 'Payments');
    assert.strictEqual(tabOf('something_new'), 'System', 'an unlisted type is still shown');
    assert.strictEqual(tabOf(undefined), 'System');
});

t('the filter and the icons use tabOf, not an exact type match', () => {
    const code = moduleOf('artisan-app/notifications.html');
    assert.match(code, /notifications\.filter\(n => tabOf\(n\.type\) === _filter\)/);
    assert.doesNotMatch(code, /n\.type === _filter/);
    assert.match(code, /return ICONS\[type\] \|\| ICONS\[tabOf\(type\)\] \|\| ICONS\.General;/);
});

console.log(`\nartisan-cache-first: ${passed} passed, ${failed} failed`);
for (const [name, e] of failures) console.log(`\n  ✗ ${name}\n    ${e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n    ') : e}`);
process.exit(failed ? 1 : 0);
