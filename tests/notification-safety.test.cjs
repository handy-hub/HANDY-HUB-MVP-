/**
 * notification-safety.test.cjs — SEC-001: a notification may only open a page
 * in the same app.
 *
 * customer_notifications is writable by any signed-in user. The artisan inbox
 * built each row's onclick from the notification's actionUrl and assigned it to
 * location.href, so a forged notification could run `javascript:` in the app;
 * the customer inbox followed the same field through bookingRouter's fallback.
 *
 * Pinned here:
 *   1. safeAppUrl() accepts every link the product itself writes (every literal
 *      actionUrl in functions/ and the clients, and every bookingHref shape)
 *      and refuses schemes, other hosts, paths and quote injection;
 *   2. the pattern in firestore.rules gives the same answer on the same inputs;
 *   3. neither inbox builds handlers from notification data, and both navigate
 *      only through safeAppUrl().
 * The rules themselves run against the emulator in notification-rules.test.mjs.
 */
'use strict';

require('./support/no-production.cjs');   // must stay the first statement (npm run lint:tests)
const assert = require('assert');
const path   = require('path');
const fs     = require('fs');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function loadModule(rel, names) {
    const body = read(rel)
        .replace(/^\s*export\s+async\s+function\s+/gm, 'async function ')
        .replace(/^\s*export\s+function\s+/gm, 'function ')
        .replace(/^\s*export\s+const\s+/gm, 'const ');
    // eslint-disable-next-line no-new-func
    return new Function(`${body}\nreturn { ${names.join(', ')} };`)();
}

const { safeAppUrl, SAFE_APP_URL_PATTERN, SAFE_APP_URL_MAX } =
    loadModule('shared/js/utils/safeAppUrl.js', ['safeAppUrl', 'SAFE_APP_URL_PATTERN', 'SAFE_APP_URL_MAX']);
const { bookingHref } = loadModule('shared/js/domain/bookingRouter.js', ['bookingHref']);

const failures = [];
let passed = 0;
function test(name, fn) {
    try { fn(); passed++; } catch (e) { failures.push([name, e]); }
}

// ── The corpus ───────────────────────────────────────────────────────────────

/** Every actionUrl the codebase writes as a literal, with ${…} filled in. */
function productLinks() {
    const files = [];
    const walk = (dir) => {
        for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
            const rel = path.join(dir, e.name);
            if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'vendor') walk(rel); }
            else if (/\.(c?js|mjs|html)$/.test(e.name)) files.push(rel);
        }
    };
    ['functions', 'shared/js', 'customer-app', 'artisan-app', 'admin-dashboard'].forEach(walk);

    const links = new Set();
    for (const f of files) {
        const src = read(f);
        const re = /actionUrl\s*:\s*(?:'([^']*)'|`([^`]*)`)/g;
        let m;
        while ((m = re.exec(src))) {
            const raw = m[1] !== undefined ? m[1] : m[2].replace(/\$\{[^}]*\}/g, 'HHB-260820-0332-58F1');
            if (raw) links.add(raw);
        }
    }
    return [...links];
}

const PRODUCT = productLinks();

const ID = 'HHB-260820-0332-58F1';
const ROUTED = [
    { id: ID, track: 'inspection', status: 'pending' },
    { id: ID, track: 'inspection', status: 'accepted', calloutPaid: false },
    { id: ID, track: 'inspection', status: 'inspection_done', calloutPaid: true },
    { id: ID, status: 'quoted' },
    { id: ID, status: 'in_progress' },
    { id: ID, status: 'completed' },
    {},
].map(bookingHref);

const LEGIT = [
    'booking.html', 'support.html', 'wallet.html', 'transaction-history.html',
    'messages.html?chatId=customer_1_artisan_a',
    `job.html?id=${ID}`, `book-request.html?resume=${ID}`,
    `live-tracking.html?bookingId=${encodeURIComponent(ID)}`,
];

const HOSTILE = [
    'javascript:alert(1)', 'JavaScript:alert(1)', ' javascript:alert(1)', 'javascript:alert(1)//.html',
    'data:text/html,<script>alert(1)</script>', 'data:text/html;base64,PHNjcmlwdD4=',
    'https://evil.example', 'https://evil.example/booking.html', 'http://evil.example/x.html',
    '//evil.example', '//evil.example/booking.html', '/\\evil.example', '\\\\evil.example\\x.html',
    '/booking.html', '../customer-app/booking.html', 'artisan-app/jobs.html',
    "booking.html');alert(1);//", "x.html?a=');alert(1)//", 'x.html?a=" onmouseover="alert(1)',
    'booking.html#frag', 'booking.html?a=<b>', 'booking.html?a=b c', 'booking.html\n',
    'booking.htm', '.html', 'booking.html?q=javascript:alert(1)',
    'a'.repeat(SAFE_APP_URL_MAX) + '.html',
    '', null, undefined, 42, {}, ['booking.html'],
];

// ── 1. The helper ────────────────────────────────────────────────────────────

test('the scan found the product\'s links (guards the scan itself)', () => {
    assert.ok(PRODUCT.length >= 10, `only ${PRODUCT.length} distinct literal actionUrls found`);
    for (const l of ['booking.html', 'dashboard.html', 'wallet.html', 'transaction-history.html'])
        assert.ok(PRODUCT.includes(l), `missing ${l}`);
    assert.ok(PRODUCT.some((l) => l.startsWith('messages.html?chatId=')), 'chat link not found');
});

test('every actionUrl the product writes is accepted', () => {
    for (const l of PRODUCT) assert.strictEqual(safeAppUrl(l), l, `refused product link ${JSON.stringify(l)}`);
});

test('every bookingHref destination is accepted', () => {
    for (const l of ROUTED) assert.strictEqual(safeAppUrl(l), l, `refused routed link ${l}`);
});

test('ordinary same-app links are accepted unchanged', () => {
    for (const l of LEGIT) assert.strictEqual(safeAppUrl(l), l, `refused ${l}`);
});

test('schemes, other hosts, paths, injection and non-strings are refused', () => {
    for (const l of HOSTILE) assert.strictEqual(safeAppUrl(l), null, `accepted ${JSON.stringify(l)}`);
});

// ── 2. The rules apply the same pattern ──────────────────────────────────────

const RULES = read('firestore.rules');
const block = RULES.slice(RULES.indexOf('match /customer_notifications/{notificationId}'));
const createRule = block.slice(block.indexOf('allow create'), block.indexOf('allow update'));

test('the create rule closes the shape and checks actionUrl', () => {
    assert.match(createRule, /incoming\(\)\.keys\(\)\.hasOnly\(/);
    assert.match(createRule, /actionUrl\.size\(\) <= 300/);
    assert.match(createRule, /actionUrl\.matches\('/);
});

test('the rules pattern agrees with safeAppUrl on every input', () => {
    const m = /actionUrl\.matches\('([^']+)'\)/.exec(createRule);
    assert.ok(m, 'no matches() in the create rule');
    const rules = new RegExp(m[1]);   // rules regexes are RE2 full-match; anchored here too
    const rulesSays = (v) => typeof v === 'string' && v.length <= 300 && rules.test(v);
    for (const v of [...PRODUCT, ...ROUTED, ...LEGIT, ...HOSTILE]) {
        assert.strictEqual(rulesSays(v), safeAppUrl(v) !== null, `rules and helper disagree on ${JSON.stringify(v)}`);
    }
    assert.strictEqual(SAFE_APP_URL_MAX, 300);
});

// ── 3. Both inboxes navigate only through safeAppUrl ─────────────────────────

test('artisan inbox: no handler is built from notification data', () => {
    const html = read('artisan-app/notifications.html');
    assert.doesNotMatch(html, /onclick="openNotif/, 'row onclick is back');
    assert.doesNotMatch(html, /onclick="[^"]*\$\{n\./, 'an onclick interpolates notification data');
    assert.doesNotMatch(html, /\$\{n\.actionUrl/, 'actionUrl is rendered into the page');
    assert.match(html, /import \{ safeAppUrl \}\s+from '\.\.\/shared\/js\/utils\/safeAppUrl\.js'/);
    assert.match(html, /safeAppUrl\(notif\?\.actionUrl\)/);
    assert.doesNotMatch(html, /location\.href\s*=\s*actionUrl/);
});

test('customer inbox: the routed or fallback href passes safeAppUrl before navigation', () => {
    const js = read('customer-app/js/pages/notificationPage.js');
    assert.match(js, /import \{ safeAppUrl \} from "\.\.\/\.\.\/\.\.\/shared\/js\/utils\/safeAppUrl\.js"/);
    assert.match(js, /const safe = safeAppUrl\(href\);\s*if \(safe\) window\.location\.href = safe;/);
    assert.doesNotMatch(js, /location\.href\s*=\s*href\b/);
});

test('native push tap: the payload link passes safeAppUrl before navigation', () => {
    const js = read('shared/js/services/pushNotificationService.js');
    assert.match(js, /import \{ safeAppUrl \}\s+from '\.\.\/utils\/safeAppUrl\.js'/);
    const tap = js.slice(js.indexOf("'pushNotificationActionPerformed'"));
    const handler = tap.slice(0, tap.indexOf('});'));
    assert.match(handler, /const href = safeAppUrl\(/);
    assert.match(handler, /window\.location\.href = href;/);
    assert.doesNotMatch(handler, /location\.href = String\(/, 'raw payload link is navigated');
});

// ── Report ───────────────────────────────────────────────────────────────────

for (const [name, e] of failures) console.error(`  FAIL  ${name}\n        ${e.message.split('\n')[0]}`);
console.log(`notification-safety: ${passed} passed, ${failures.length} failed (${PRODUCT.length} product links scanned)`);
process.exit(failures.length ? 1 : 0);
