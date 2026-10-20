'use strict';

/**
 * tests/push-delivery.test.cjs — a job offer reaches the artisan: by push when
 * push works, and on the dashboard when it does not.
 *
 * Run: node tests/push-delivery.test.cjs
 *
 * WHAT THIS PROTECTS (AR-04, 2026-10-19 artisan audit)
 * ────────────────────────────────────────────────────
 * Both apps registered /firebase-messaging-sw.js at scope '/', and both sites
 * answered that path with login.html (the `**` rewrite) — the only worker file
 * lived at /customer-app/firebase-messaging-sw.js, and the artisan app had none.
 * Registration failed, the error was swallowed, no device ever stored a token
 * (production: 0 artisans, 0 customers), and job offers expired unseen. Behind
 * that, three more faults waited: notification links pointed at /jobs.html
 * (outside every app folder), web messages carried a `notification` block the
 * browser SDK would draw a second time, and the push send was fire-and-forget on
 * a platform that throttles CPU once the request returns.
 *
 * Covered here:
 *   1. hosting — the staged site has a real JavaScript worker at its root,
 *      with no-cache, and the page registers exactly that URL
 *   2. the worker — draws data-only pushes, marks an offer that expired in
 *      transit, never draws twice, keeps every link inside its app, opens or
 *      focuses the app on click
 *   3. the server — data-only for web tokens, a notification block for native
 *      ones, a TTL equal to the offer's time left, no push for a lapsed offer,
 *      dead tokens cleared (but never a fresher one), failures never thrown,
 *      and the send awaited
 *   4. the fallback — honest push status, offer deadlines that never go NaN,
 *      new offers announced on the dashboard, expired offers not acceptable
 *
 * Real message delivery to a device cannot be proven in a unit test; see
 * docs/PUSH_NOTIFICATIONS.md for the authorised manual check
 * (scripts/send-test-push.cjs).
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const vm     = require('vm');
const { execFileSync } = require('child_process');

const fake = require('./support/fake-firebase.cjs').install();
const ROOT = path.join(__dirname, '..');
const notifications = require(path.join(ROOT, 'functions', 'notifications.js'));

let passed = 0, failed = 0;
const failures = [];
async function t(name, fn) {
    try { await fn(); passed++; console.log(`  PASS  ${name}`); }
    catch (e) { failed++; failures.push([name, e]); console.log(`  FAIL  ${name}\n        ${e.message}`); }
}

function loadEsm(rel, names) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8')
        .replace(/^\s*import\s[^\n]*\n/gm, '')
        .replace(/^\s*export\s+async\s+function\s+/gm, 'async function ')
        .replace(/^\s*export\s+function\s+/gm, 'function ')
        .replace(/^\s*export\s+const\s+/gm, 'const ');
    // eslint-disable-next-line no-new-func
    return new Function(`${src}\nreturn { ${names.join(', ')} };`)();
}
const PUSH   = loadEsm('shared/js/services/pushState.js', ['PUSH_STATE', 'describePushState', 'tokenNeedsSave', 'workerUrl']);
const OFFERS = loadEsm('shared/js/domain/jobOffers.js', ['offerDeadlineMs', 'offerState', 'formatTimeLeft', 'createOfferWatcher']);

const SW_SRC  = fs.readFileSync(path.join(ROOT, 'shared', 'push', 'firebase-messaging-sw.js'), 'utf8');
const CONFIG  = { apiKey: 'test-key', projectId: 'test-project', messagingSenderId: '123', appId: '1:123:web:abc' };

/** Run the worker source in a sandbox that stands in for a ServiceWorkerGlobalScope. */
function loadWorker({ app = 'artisan', config = CONFIG, origin = 'https://lamax-artisan.web.app', windows = [] } = {}) {
    const listeners = {};
    const shown = [];
    const imported = [];
    let background = null;
    const opened = [];
    const query = config ? PUSH.workerUrl(app, config) : `/firebase-messaging-sw.js?app=${app}`;
    const sandbox = {
        URL, console: { log() {}, warn() {}, error() {} },
        importScripts: (...urls) => imported.push(...urls),
        firebase: {
            initializeApp: (c) => { sandbox._initConfig = c; },
            messaging: () => ({ onBackgroundMessage: (fn) => { background = fn; } }),
        },
    };
    sandbox.self = sandbox;
    sandbox.location = { href: origin + query, origin };
    sandbox.addEventListener = (type, fn) => { listeners[type] = fn; };
    sandbox.registration = { showNotification: async (title, options) => { shown.push({ title, options }); } };
    sandbox.clients = {
        matchAll: async () => windows,
        openWindow: async (url) => { opened.push(url); },
    };
    vm.runInNewContext(SW_SRC, sandbox, { filename: 'firebase-messaging-sw.js' });
    return {
        sandbox, shown, imported, opened, listeners,
        push: (payload) => background && background(payload),
        hasBackgroundHandler: () => typeof background === 'function',
        click: async (data) => {
            let waited;
            const event = { notification: { data, close() {} }, waitUntil: (p) => { waited = p; } };
            listeners.notificationclick(event);
            await waited;
        },
        resolveTarget: sandbox.resolveTarget,
    };
}

(async () => {
console.log('\n── 1. Hosting serves a real worker at the site root ──\n');

await t('staging puts the worker at the root of the artisan and customer builds, byte for byte', () => {
    for (const app of ['artisan-app', 'customer-app']) {
        execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'stage-hosting.cjs'), app], { cwd: ROOT, stdio: 'pipe' });
        const built = path.join(ROOT, `build-${app}`, 'firebase-messaging-sw.js');
        assert.ok(fs.existsSync(built), `${app}: no root worker in build-${app}/`);
        assert.strictEqual(fs.readFileSync(built, 'utf8'), SW_SRC, `${app}: root worker differs from shared/push source`);
    }
});

await t('the admin dashboard does not get a push worker', () => {
    const src = fs.readFileSync(path.join(ROOT, 'scripts', 'stage-hosting.cjs'), 'utf8');
    assert.match(src, /PUSH_APPS = new Set\(\['customer-app', 'artisan-app'\]\)/);
});

await t('firebase.json: nothing shadows the worker, and it is never served stale', () => {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'firebase.json'), 'utf8'));
    for (const target of ['customer', 'artisan']) {
        const h = cfg.hosting.find((x) => x.target === target);
        const hdr = h.headers.find((x) => x.source === '/firebase-messaging-sw.js');
        assert.ok(hdr, `${target}: no header rule for the worker`);
        assert.match(hdr.headers.find((x) => x.key === 'Cache-Control').value, /no-cache/);
        // Static files are served before rewrites; a redirect would still win.
        assert.ok(!(h.redirects || []).some((r) => /firebase-messaging-sw/.test(r.source)), `${target}: a redirect shadows the worker`);
    }
});

await t('the page registers exactly that worker, at scope "/", with its own config', () => {
    const svc = fs.readFileSync(path.join(ROOT, 'shared', 'js', 'services', 'pushNotificationService.js'), 'utf8');
    assert.match(svc, /navigator\.serviceWorker\.register\(workerUrl\(userType, options\), \{\s*scope: '\/',/);
    const url = new URL(PUSH.workerUrl('artisan', CONFIG), 'https://x.invalid');
    assert.strictEqual(url.pathname, '/firebase-messaging-sw.js');
    assert.strictEqual(url.searchParams.get('app'), 'artisan');
    for (const k of Object.keys(CONFIG)) {
        assert.strictEqual(url.searchParams.get(k), CONFIG[k], `workerUrl must pass ${k}`);
        assert.ok(SW_SRC.includes(`PARAMS.get('${k}')`), `the worker must read ${k}`);
    }
    assert.strictEqual(new URL(PUSH.workerUrl('customer', CONFIG), 'https://x.invalid').searchParams.get('app'), 'customer');
});

await t('the old customer-only worker is gone — one source, one place', () => {
    assert.ok(!fs.existsSync(path.join(ROOT, 'customer-app', 'firebase-messaging-sw.js')));
});

console.log('\n── 2. The worker ──\n');

await t('loads the pinned compat SDK and initialises with the page\'s config', () => {
    const w = loadWorker();
    assert.deepStrictEqual(w.imported, [
        'https://www.gstatic.com/firebasejs/10.8.0/firebase-app-compat.js',
        'https://www.gstatic.com/firebasejs/10.8.0/firebase-messaging-compat.js',
    ]);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(w.sandbox._initConfig)), CONFIG);
    assert.ok(w.hasBackgroundHandler());
});

await t('a data-only job offer is drawn: title, body, one-per-booking tag, stays on screen, opens the app', async () => {
    const w = loadWorker();
    await w.push({ data: { type: 'Bookings', title: 'New Booking Request', body: 'Plumbing request · 2 km away.',
                           actionUrl: 'dashboard.html', bookingId: 'b1', expiresAtMs: String(Date.now() + 120000) } });
    assert.strictEqual(w.shown.length, 1);
    const { title, options } = w.shown[0];
    assert.strictEqual(title, 'New Booking Request');
    assert.strictEqual(options.body, 'Plumbing request · 2 km away.');
    assert.strictEqual(options.tag, 'booking-b1');
    assert.strictEqual(options.requireInteraction, true);
    assert.strictEqual(options.data.url, '/artisan-app/dashboard.html');
    assert.strictEqual(options.icon, '/shared/assets/images/handyhub-logo.png');
});

await t('an offer that expired in transit is still shown (a push must show something) — as expired', async () => {
    const w = loadWorker();
    await w.push({ data: { type: 'Bookings', title: 'New Booking Request', body: 'x', bookingId: 'b2',
                           expiresAtMs: String(Date.now() - 1000) } });
    assert.strictEqual(w.shown.length, 1);
    assert.strictEqual(w.shown[0].title, 'Job request expired');
    assert.strictEqual(w.shown[0].options.requireInteraction, false);
});

await t('a message the SDK already drew (notification block) is not drawn twice', async () => {
    const w = loadWorker();
    await w.push({ notification: { title: 'A', body: 'B' }, data: { type: 'Bookings' } });
    assert.strictEqual(w.shown.length, 0);
});

await t('every link stays inside its own app', () => {
    const a = loadWorker();
    assert.strictEqual(a.resolveTarget('jobs.html?tab=pending#x'), '/artisan-app/jobs.html?tab=pending#x');
    assert.strictEqual(a.resolveTarget('/jobs.html'), '/artisan-app/jobs.html');
    for (const hostile of ['https://evil.example/x', '//evil.example/x', 'javascript:alert(1)',
                           '../customer-app/booking.html', '', null]) {
        assert.strictEqual(a.resolveTarget(hostile), '/artisan-app/dashboard.html', String(hostile));
    }
    const c = loadWorker({ app: 'customer', origin: 'https://lamax-4fd82.web.app' });
    assert.strictEqual(c.resolveTarget('booking.html'), '/customer-app/booking.html');
});

await t('a click focuses an open app window and navigates it; otherwise opens one', async () => {
    let navigated = null, focused = false;
    const open = { url: 'https://lamax-artisan.web.app/artisan-app/wallet.html',
                   focus: async () => { focused = true; }, navigate: async (u) => { navigated = u; } };
    const w1 = loadWorker({ windows: [open] });
    await w1.click({ url: '/artisan-app/jobs.html' });
    assert.ok(focused);
    assert.strictEqual(navigated, '/artisan-app/jobs.html');
    const w2 = loadWorker({ windows: [] });
    await w2.click({ url: '/artisan-app/jobs.html' });
    assert.deepStrictEqual(w2.opened, ['/artisan-app/jobs.html']);
});

await t('a click on an SDK-drawn notification is left to the SDK', async () => {
    const w = loadWorker();
    let waited = false;
    w.listeners.notificationclick({ notification: { data: { FCM_MSG: {} }, close() {} }, waitUntil: () => { waited = true; } });
    assert.strictEqual(waited, false);
});

await t('registered without config, it stays harmless (no SDK, no crash)', () => {
    const w = loadWorker({ config: null });
    assert.deepStrictEqual(w.imported, []);
    assert.strictEqual(w.hasBackgroundHandler(), false);
});

console.log('\n── 3. The server sends the right thing, and only while it matters ──\n');

const ART = 'art_push_1';
function seedArtisan(over = {}) {
    fake.db._reset(); fake.messaging._reset();
    fake.db._set(`artisans/${ART}`, { fcmToken: 'tok-web-1', fcmPlatform: 'web', ...over });
}
const offer = (expiresAtMs) => ({
    type: 'Bookings', title: 'New Booking Request', message: 'Plumbing request. You have 3 minutes to respond.',
    actionUrl: 'dashboard.html', metadata: { bookingId: 'b9', expiresAtMs },
});
const inbox = (uid) => fake.db._keys('customer_notifications/').map((k) => fake.db._get(k)).filter((n) => n.receiverId === uid);

await t('web token → data-only message (no notification block), urgent, app-tagged', async () => {
    seedArtisan();
    await notifications.sendArtisanNotification(ART, offer(Date.now() + 180000));
    assert.strictEqual(fake.messaging.sent.length, 1, 'the send completed before the call resolved');
    const m = fake.messaging.sent[0];
    assert.strictEqual(m.token, 'tok-web-1');
    assert.strictEqual(m.notification, undefined);
    assert.strictEqual(m.data.title, 'New Booking Request');
    assert.strictEqual(m.data.app, 'artisan');
    assert.strictEqual(m.data.bookingId, 'b9');
    assert.strictEqual(m.webpush.headers.Urgency, 'high');
});

await t('a job offer\'s push lives exactly as long as the offer (TTL = time left)', async () => {
    seedArtisan();
    await notifications.sendArtisanNotification(ART, offer(Date.now() + 180000));
    const ttl = Number(fake.messaging.sent[0].webpush.headers.TTL);
    assert.ok(ttl >= 178 && ttl <= 180, `TTL ${ttl}`);
    assert.ok(Number(fake.messaging.sent[0].data.expiresAtMs) > Date.now());
});

await t('a lapsed offer is not pushed — but the in-app record is still written', async () => {
    seedArtisan();
    await notifications.sendArtisanNotification(ART, offer(Date.now() - 5000));
    assert.strictEqual(fake.messaging.sent.length, 0);
    assert.strictEqual(inbox(ART).length, 1);
});

await t('native token (Capacitor) → notification block, high priority, TTL in ms', async () => {
    seedArtisan({ fcmToken: 'tok-android-1', fcmPlatform: 'android' });
    await notifications.sendArtisanNotification(ART, offer(Date.now() + 60000));
    const m = fake.messaging.sent[0];
    assert.strictEqual(m.notification.title, 'New Booking Request');
    assert.strictEqual(m.android.priority, 'high');
    assert.ok(m.android.ttl > 58000 && m.android.ttl <= 60000);
    assert.strictEqual(m.webpush, undefined);
});

await t('a dead token is cleared, with its platform', async () => {
    seedArtisan();
    fake.messaging.failNextWith('messaging/registration-token-not-registered');
    await notifications.sendArtisanNotification(ART, offer(Date.now() + 60000));
    const a = fake.db._get(`artisans/${ART}`);
    assert.strictEqual(a.fcmToken, null);
    assert.strictEqual(a.fcmPlatform, null);
    assert.strictEqual(inbox(ART).length, 1, 'the offer is still in the in-app inbox');
});

await t('…but a token the device replaced while the send was in flight survives', async () => {
    seedArtisan();
    const orig = fake.messaging.send;
    fake.messaging.send = async () => {
        fake.messaging.send = orig;
        fake.db._set(`artisans/${ART}`, { ...fake.db._get(`artisans/${ART}`), fcmToken: 'tok-web-2' });
        throw Object.assign(new Error('gone'), { code: 'messaging/registration-token-not-registered' });
    };
    await notifications.sendArtisanNotification(ART, offer(Date.now() + 60000));
    assert.strictEqual(fake.db._get(`artisans/${ART}`).fcmToken, 'tok-web-2');
});

await t('a transient FCM error keeps the token and never throws to the caller', async () => {
    seedArtisan();
    fake.messaging.failNextWith('messaging/internal-error');
    const id = await notifications.sendArtisanNotification(ART, offer(Date.now() + 60000));
    assert.ok(id, 'resolves with the in-app notification id');
    assert.strictEqual(fake.db._get(`artisans/${ART}`).fcmToken, 'tok-web-1');
});

await t('customers get the same treatment (data-only on web, app-tagged)', async () => {
    fake.db._reset(); fake.messaging._reset();
    fake.db._set('customers/c1', { fcmToken: 'tok-c', fcmPlatform: 'web' });
    await notifications.sendNotification('c1', { type: 'Payments', title: 'Payment Secured', message: 'GHS 240.00 held.', actionUrl: 'booking.html' });
    const m = fake.messaging.sent[0];
    assert.strictEqual(m.data.app, 'customer');
    assert.strictEqual(m.data.actionUrl, 'booking.html');
    assert.strictEqual(m.webpush.headers.Urgency, 'normal');
    assert.strictEqual(m.webpush.headers.TTL, undefined, 'only offers expire');
});

await t('dispatch hands the offer\'s deadline to the push', () => {
    const src = fs.readFileSync(path.join(ROOT, 'functions', 'dispatch.js'), 'utf8');
    assert.match(src, /offerExpiresAtMs = Date\.now\(\) \+ timeout \* 1000;/);
    assert.match(src, /const deadline = Timestamp\.fromMillis\(offerExpiresAtMs\);/);
    assert.match(src, /expiresAtMs: offerExpiresAtMs,/);
});

console.log('\n── 4. When push is not there, the dashboard is ──\n');

await t('push status is stated honestly: only a saved token is ON', () => {
    const S = PUSH.PUSH_STATE;
    assert.strictEqual(PUSH.describePushState(S.ON).alert, false);
    assert.strictEqual(PUSH.describePushState(S.PENDING).alert, false);
    for (const s of [S.OFF, S.FAILED]) {
        const d = PUSH.describePushState(s);
        assert.ok(d.alert && d.canEnable, s);
        assert.match(d.message, /offers|open/i);
    }
    for (const s of [S.BLOCKED, S.UNSUPPORTED]) {
        const d = PUSH.describePushState(s);
        assert.ok(d.alert && !d.canEnable, `${s}: a denied permission cannot be re-prompted from a button`);
        assert.match(d.message, /keep this screen open/i);
    }
});

await t('a token is written only when it changed', () => {
    assert.strictEqual(PUSH.tokenNeedsSave(null, 'a'), true);
    assert.strictEqual(PUSH.tokenNeedsSave('a', 'b'), true);
    assert.strictEqual(PUSH.tokenNeedsSave('a', 'a'), false);
    assert.strictEqual(PUSH.tokenNeedsSave('a', ''), false);
    assert.strictEqual(PUSH.tokenNeedsSave('a', null), false);
});

await t('offer deadlines never come out NaN, whatever shape they arrive in', () => {
    const ms = Date.parse('2026-10-20T10:00:00Z');
    assert.strictEqual(OFFERS.offerDeadlineMs({ toMillis: () => ms }), ms);
    assert.strictEqual(OFFERS.offerDeadlineMs({ seconds: ms / 1000, nanoseconds: 500e6 }), ms + 500);
    assert.strictEqual(OFFERS.offerDeadlineMs({ _seconds: ms / 1000 }), ms);
    assert.strictEqual(OFFERS.offerDeadlineMs('2026-10-20T10:00:00Z'), ms);
    assert.strictEqual(OFFERS.offerDeadlineMs(ms), ms);
    assert.strictEqual(OFFERS.offerDeadlineMs(ms / 1000), ms);
    for (const junk of [null, undefined, '', 'soon', {}, NaN, -1, { toMillis: () => NaN }]) {
        assert.strictEqual(OFFERS.offerDeadlineMs(junk), null, String(junk));
    }
});

await t('offerState: time left, and expiry at the deadline', () => {
    const now = 1_000_000_000_000;
    assert.deepStrictEqual(OFFERS.offerState({ responseDeadline: now + 125000 }, now),
        { expiresAtMs: now + 125000, secondsLeft: 125, expired: false });
    assert.strictEqual(OFFERS.offerState({ responseDeadline: now }, now).expired, true);
    assert.strictEqual(OFFERS.offerState({}, now).expired, false);
    assert.strictEqual(OFFERS.formatTimeLeft(125), '2:05');
    assert.strictEqual(OFFERS.formatTimeLeft(45), '45s');
});

await t('new offers are told apart from the ones already on screen', () => {
    const w = OFFERS.createOfferWatcher();
    assert.deepStrictEqual(w.next(['a', 'b']), [], 'the first snapshot only primes');
    assert.deepStrictEqual(w.next(['a', 'b', 'c']), ['c']);
    assert.deepStrictEqual(w.next(['a', 'b', 'c']), []);
    assert.deepStrictEqual(w.next(['a']), []);
    assert.deepStrictEqual(w.next(['a', 'c']), ['c'], 're-offered later: announced again');
});

await t('the dashboard announces new offers, states push status, and withdraws Accept on expiry', () => {
    const dash = fs.readFileSync(path.join(ROOT, 'artisan-app', 'dashboard.html'), 'utf8');
    assert.match(dash, /_offerWatcher\.next\(records\.map\(r => r\.id\)\)/);
    assert.match(dash, /\.forEach\(fid => alertNewOffer\(/);
    assert.match(dash, /renderPushBanner\(getPushState\(\)\)/);
    assert.match(dash, /window\.addEventListener\('fx:push-state'/);
    assert.match(dash, /lapsed\s*\n?\s*\/\/[^\n]*\n[^\n]*\n\s*\? `<button class="btn-accept" disabled/);
    assert.match(dash, /acceptBtn\.disabled = true;/);
    assert.match(dash, /const offer\s+= offerState\(d\);/);
});

await t('push failures are reported, not swallowed', () => {
    const svc = fs.readFileSync(path.join(ROOT, 'shared', 'js', 'services', 'pushNotificationService.js'), 'utf8');
    assert.match(svc, /catch \(err\) \{[\s\S]{0,200}setState\(PUSH_STATE\.FAILED\)/);
    assert.match(svc, /fcmPlatform:\s+platform/);
    assert.match(svc, /tokenNeedsSave\(saved, token\)/);
});

console.log(`\npush-delivery: ${passed} passed, ${failed} failed`);
if (failed) { for (const [name, e] of failures) console.log(`\n✗ ${name}\n${e.stack}`); process.exit(1); }
})();
