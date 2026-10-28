'use strict';

/**
 * tests/wallet-settings-platform.test.cjs — wallet figures, verification
 * decisions, notification preference, account closure and the artisan web
 * app's installability. (2026-10-19 artisan audit, AR-13 … AR-16)
 *
 * Run: node tests/wallet-settings-platform.test.cjs
 * (Rules for verification fields and the push preference:
 *  tests/marketplace-rules.test.mjs.)
 *
 *   AR-13  every wallet figure is derived from its authoritative record and
 *          reconciles against the ledger through holds, releases, refunds,
 *          dispute settlements and withdrawals that succeed or fail.
 *   AR-14  reviewer decisions are recorded by the server, with who and when.
 *   AR-15  the push preference is enforced where pushes are sent; artisan
 *          closure refuses while anything is outstanding and keeps records.
 *   AR-16  the manifest is valid, installability is judged honestly, and the
 *          app-shell worker never caches what it must not.
 *
 * The REAL functions/*.js modules run against tests/support/fake-firebase.cjs.
 */

require('./support/no-production.cjs');   // must stay the first statement (npm run lint:tests)
process.env.PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || 'sk_test_wallet_suite_only';
process.env.PIN_PEPPER = process.env.PIN_PEPPER || 'test-pepper-0123456789abcdef0123456789abcdef';

const assert = require('assert');
const { fundCustomer, fundArtisan } = require('./support/walletEvidence.cjs');
const fs     = require('fs');
const path   = require('path');
const vm     = require('vm');

const fake = require('./support/fake-firebase.cjs').install();
const ROOT = path.join(__dirname, '..');
const FN   = path.join(ROOT, 'functions');

const escrow        = require(path.join(FN, 'financial', 'escrow.js'));
const transfers     = require(path.join(FN, 'financial', 'transfers.js'));
const disputes      = require(path.join(FN, 'disputes.js'));
const verification  = require(path.join(FN, 'artisanVerification.js'));
const notifications = require(path.join(FN, 'notifications.js'));
const lifecycle     = require(path.join(FN, 'accountLifecycle.js'));
const ledger        = require(path.join(FN, 'shared', 'walletLedger.js'));
const { evaluateApp, APPS } = require(path.join(ROOT, 'scripts', 'check-pwa.cjs'));
const { COMMISSION_RATE, ADMIN_EMAILS } = require(path.join(FN, 'config.js'));

let passed = 0, failed = 0;
const failures = [];
async function t(name, fn) {
    try { await fn(); passed++; console.log(`  PASS  ${name}`); }
    catch (e) { failed++; failures.push([name, e]); console.log(`  FAIL  ${name}\n        ${e.message}`); }
}
async function rejects(fn, re) {
    try { await fn(); } catch (e) { if (re && !re.test(e.message)) throw new Error(`wrong refusal: "${e.message}"`); return e; }
    throw new Error('expected a refusal, got success');
}
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const ADMIN_AUTH = { uid: 'adm_w1', token: { email: ADMIN_EMAILS[0], email_verified: true } };

const CUST = 'cust_w1', ART = 'art_w1';
const share = (amount) => Math.round(amount * (1 - COMMISSION_RATE) * 100) / 100;

function seedParties({ wallet = 1000 } = {}) {
    fake.db._reset(); fake.messaging._reset(); fake.auth.reset();
    fake.db._set(`customers/${CUST}`, { walletBalance: wallet, escrowBalance: 0, spent: 0 });
    fundCustomer(fake.db, CUST, wallet);
    fake.db._set(`artisans/${ART}`, { userType: 'artisan', status: 'active', verificationStatus: 'approved',
        name: 'Kofi', availableBalance: 0, totalEarned: 0, withdrawnTotal: 0, pendingBalance: 0 });
}
const art = () => fake.db._get(`artisans/${ART}`);
const rows = (prefix) => fake.db._keys(prefix).filter((k) => k.split('/').length === prefix.split('/').length)
    .map((k) => ({ id: k.split('/').pop(), ...fake.db._get(k) }));
const escrowsFor = (uid) => rows('escrow/').filter((e) => e.artisanId === uid && ['held', 'disputed'].includes(e.status));
const payoutsFor = (uid) => rows('payouts/').filter((p) => p.userId === uid);
const txnsFor    = (uid) => rows(`artisans/${uid}/transactions/`);
const view = () => ledger.deriveArtisanWallet({ artisan: art(), escrows: escrowsFor(ART), payouts: payoutsFor(ART) });
function assertReconciles(label) {
    const r = ledger.reconcileArtisanWallet({ artisan: art(), transactions: txnsFor(ART), payouts: payoutsFor(ART) });
    assert.ok(r.ok, `${label}: ${JSON.stringify(r.checks.filter((c) => !c.ok))}`);
    return r;
}
async function book(id, amount) {
    fake.db._set(`bookings/${id}`, { customerId: CUST, artisanId: ART, status: 'accepted', price: amount });
    const { escrowId } = await escrow.holdFundsForBooking({ bookingId: id, customerId: CUST, artisanId: ART, amount, callerAuth: null });
    return escrowId;
}
/** A withdrawal reservation, exactly as transfers.executeWithdrawal's transaction writes it. */
function reserveWithdrawal(id, amount) {
    const a = art();
    fake.db._set(`artisans/${ART}`, { ...a, availableBalance: +(a.availableBalance - amount).toFixed(2),
        withdrawnTotal: +((a.withdrawnTotal || 0) + amount).toFixed(2) });
    fake.db._set(`payouts/${id}`, { userId: ART, userType: 'artisan', requestId: id, ref: `AW-${id}`, amount,
        amountPesewas: Math.round(amount * 100), provider: 'mtn', phone: '0240000000', status: 'reserved', refundedAt: null });
    fake.db._set(`artisans/${ART}/transactions/payout_${id}`, { type: 'withdrawal', amount, status: 'processing',
        ref: `AW-${id}`, payoutId: id, createdAt: new Date().toISOString() });
}

(async () => {
console.log('\n── AR-13 · each wallet figure comes from its authoritative record ──\n');

await t('the derived view: pending release, dispute, in transit, paid out — in pesewas', () => {
    const v = ledger.deriveArtisanWallet({
        artisan: { availableBalance: 0.1, totalEarned: 0.3, withdrawnTotal: 0.2 },
        escrows: [{ status: 'held', artisanShare: 0.1 }, { status: 'held', artisanShare: 0.2 }, { status: 'disputed', artisanShare: 5 }],
        payouts: [{ status: 'processing', amount: 0.15 }, { status: 'success', amount: 9 }, { status: 'failed', amount: 9 }],
    });
    assert.deepStrictEqual([v.available, v.pendingRelease, v.heldJobs, v.inDispute, v.totalEarned, v.inTransit, v.paidOut],
                           [0.1, 0.3, 2, 5, 0.3, 0.15, 0.05]);
    const bad = ledger.deriveArtisanWallet({ artisan: { withdrawnTotal: 1 }, payouts: [{ status: 'reserved', amount: 5 }] });
    assert.deepStrictEqual([bad.paidOut, bad.issues], [null, ['withdrawn_total_below_in_transit']], 'inconsistent → unknown, never a made-up number');
});

await t('a held job shows as PENDING RELEASE, not available — and becomes available on release', async () => {
    seedParties();
    const esc = await book('bk_a', 200);
    let v = view();
    assert.deepStrictEqual([v.pendingRelease, v.available, v.heldJobs], [share(200), 0, 1]);
    assert.strictEqual(art().pendingBalance, 0, 'the materialised field is untouched — never incremented');
    await escrow.releaseEscrow(esc, { releasedBy: 'test', callerAuth: null });
    v = view();
    assert.deepStrictEqual([v.pendingRelease, v.available, v.totalEarned], [0, share(200), share(200)]);
    assertReconciles('after release');
});

await t('a cancellation refunds the customer and leaves the artisan\'s figures unchanged', async () => {
    seedParties();
    const esc = await book('bk_c', 100);
    assert.strictEqual(view().pendingRelease, share(100));
    await escrow.refundEscrow(esc, { reason: 'cancelled', refundedBy: 'test', callerAuth: null });
    const v = view();
    assert.deepStrictEqual([v.pendingRelease, v.available, v.totalEarned], [0, 0, 0]);
    assert.strictEqual(fake.db._get(`customers/${CUST}`).walletBalance, 1000);
    assertReconciles('after refund');
});

await t('a disputed hold is shown as "in dispute", and a partial settlement reconciles', async () => {
    seedParties();
    await book('bk_d', 100);
    fake.db._set('bookings/bk_d', { ...fake.db._get('bookings/bk_d'), status: 'disputed' });
    const id = rows('escrow/')[0].id;
    fake.db._set(`escrow/${id}`, { ...fake.db._get(`escrow/${id}`), status: 'disputed' });
    assert.deepStrictEqual([view().pendingRelease, view().inDispute], [0, share(100)]);
    await disputes.resolveDispute(ADMIN_AUTH, { bookingId: 'bk_d', resolution: 'partial_refund', notes: 'half done', customerAmount: 40 });
    assert.strictEqual(view().inDispute, 0);
    assert.ok(art().availableBalance > 0);
    assertReconciles('after partial settlement');
});

await t('a withdrawal in flight is "on its way", then "paid out" once Paystack confirms', async () => {
    seedParties();
    await escrow.releaseEscrow(await book('bk_w', 200), { releasedBy: 'test', callerAuth: null });
    reserveWithdrawal('p1', 50);
    let v = view();
    assert.deepStrictEqual([v.inTransit, v.paidOut, v.available], [50, 0, share(200) - 50]);
    assertReconciles('reserved');
    await transfers.finalizePayout('p1', transfers.STATUS.SUCCESS, { source: 'test' });
    v = view();
    assert.deepStrictEqual([v.inTransit, v.paidOut], [0, 50]);
    assert.strictEqual(fake.db._get(`artisans/${ART}/transactions/payout_p1`).status, 'successful');
    assertReconciles('succeeded');
});

await t('a FAILED withdrawal is refunded once and never counted as paid out', async () => {
    seedParties();
    await escrow.releaseEscrow(await book('bk_f', 200), { releasedBy: 'test', callerAuth: null });
    reserveWithdrawal('p2', 60);
    await transfers.finalizePayout('p2', transfers.STATUS.FAILED, { source: 'test', reason: 'bad number' });
    await transfers.finalizePayout('p2', transfers.STATUS.FAILED, { source: 'test', reason: 'webhook again' });
    const v = view();
    assert.deepStrictEqual([v.inTransit, v.paidOut, v.available], [0, 0, share(200)], 'refunded exactly once');
    assertReconciles('failed + redelivered');
});

await t('a legacy row still saying "processing" for a failed payout shows as failed and is flagged', () => {
    const r = ledger.reconcileArtisanWallet({
        artisan: { totalEarned: 100, withdrawnTotal: 0, availableBalance: 100 },
        transactions: [{ id: 'e1', type: 'earning', amount: 100 }, { id: 'w1', type: 'withdrawal', amount: 30, status: 'processing', payoutId: 'px' }],
        payouts: [{ id: 'px', status: 'failed' }],
    });
    assert.strictEqual(r.ok, true, 'the balances reconcile: the failed payout was refunded');
    assert.deepStrictEqual(r.staleRows, [{ id: 'w1', stored: 'processing', actual: 'failed' }]);
    assert.strictEqual(ledger.withdrawalStatus({ status: 'processing' }, { status: 'failed' }), 'failed');
    assert.strictEqual(ledger.withdrawalStatus({ status: 'processing' }, null), 'processing');
});

await t('a real mismatch is reported, not hidden', () => {
    const r = ledger.reconcileArtisanWallet({ artisan: { totalEarned: 100, withdrawnTotal: 0, availableBalance: 120 },
        transactions: [{ type: 'earning', amount: 100 }] });
    assert.deepStrictEqual(r.checks.filter((c) => !c.ok).map((c) => c.name), ['available']);
});

await t('one definition of an open payout, shared with transfers.js', () => {
    assert.deepStrictEqual([...ledger.PAYOUT_OPEN_STATUSES].sort(), [...transfers.OPEN_STATUSES].sort());
});

await t('the wallet, dashboard and profile no longer read pendingBalance; no payout-time promise', () => {
    for (const rel of ['artisan-app/wallet.html', 'artisan-app/dashboard.html', 'artisan-app/profile.html', 'shared/js/data/repositories/walletRepository.js']) {
        const code = read(rel).replace(/\/\/.*$/gm, '').replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
        assert.ok(!/\.pendingBalance/.test(code), `${rel} still reads pendingBalance`);
    }
    assert.ok(!read('artisan-app/wallet.html').includes('~1 min'));
    assert.match(read('artisan-app/wallet.html'), /withdrawalStatus\(/);
    assert.ok(!/pendingBalance:/.test(read('functions/financial/escrow.js')), 'release no longer writes the dead field');
});

console.log('\n── AR-14 · a review decision is the reviewer\'s, recorded by the server ──\n');

await t('approve and reject record who decided and when, and log it', async () => {
    fake.db._reset(); fake.auth.reset();
    for (const id of ['a_ok', 'a_no']) {
        fake.db._set(`artisans/${id}`, { userType: 'artisan', name: 'Ama', category: 'Plumbing', verificationStatus: 'pending_review', status: 'pending' });
        fake.db._set(`verification_requests/${id}`, { artisanId: id, status: 'pending_review', trustScore: 99, reviewedBy: 'self' });
        fake.auth.setUser(id, { emailVerified: true });
    }
    await verification.approveArtisan(ADMIN_AUTH, { artisanId: 'a_ok' });
    await verification.rejectArtisan(ADMIN_AUTH, { artisanId: 'a_no', reason: 'Ghana Card photo unreadable' });
    const ok = fake.db._get('verification_requests/a_ok'), no = fake.db._get('verification_requests/a_no');
    assert.deepStrictEqual([ok.status, ok.approvedBy], ['approved', ADMIN_EMAILS[0]]);
    assert.ok(ok.approvedAt, 'timestamped');
    assert.deepStrictEqual([no.status, no.rejectedBy, no.rejectionReason], ['rejected', ADMIN_EMAILS[0], 'Ghana Card photo unreadable']);
    const logs = rows('verification_logs/');
    assert.ok(logs.some((l) => l.artisanId === 'a_ok' && l.adminEmail === ADMIN_EMAILS[0]));
    assert.ok(logs.some((l) => l.artisanId === 'a_no'));
    await rejects(() => verification.approveArtisan({ uid: 'a_ok', token: {} }, { artisanId: 'a_no' }), /Unauthorized|Admin/);
});

await t('nothing in the app writes a reviewer field; the rules allow only evidence', () => {
    const ob = read('artisan-app/onboarding.html').replace(/\/\/.*$/gm, '');
    for (const k of ['trustScore:', 'reviewedBy:', 'adminNotes:', 'rejectionReason:']) assert.ok(!ob.includes(k), `onboarding writes ${k}`);
    const rules = read('firestore.rules');
    assert.match(rules, /incoming\(\)\.keys\(\)\.hasOnly\(verificationEvidenceFields\(\)\)/);
    assert.match(rules, /match \/verification_logs\/\{logId\} \{[\s\S]*?allow create, update, delete: if false;/);
    assert.match(rules, /!incoming\(\)\.keys\(\)\.hasAny\(artisanDecisionFields\(\)\)/);
});

console.log('\n── AR-15 · the push preference is enforced where pushes are sent ──\n');

await t('artisanPushAllowed: off stops pushes except payments; absent means on', () => {
    const off = { notificationPreferences: { push: false } };
    assert.strictEqual(notifications.artisanPushAllowed(off, 'Bookings'), false);
    assert.strictEqual(notifications.artisanPushAllowed(off, 'System'), false);
    assert.strictEqual(notifications.artisanPushAllowed(off, 'Payments'), true, 'financial notices are mandatory');
    assert.strictEqual(notifications.artisanPushAllowed({}, 'Bookings'), true);
    assert.strictEqual(notifications.artisanPushAllowed({ notificationPreferences: { push: true } }, 'Bookings'), true);
});

await t('push off: the job alert is still in the inbox, but no push is sent', async () => {
    fake.db._reset(); fake.messaging._reset();
    fake.db._set(`artisans/${ART}`, { userType: 'artisan', fcmToken: 'tok-1', fcmPlatform: 'web', notificationPreferences: { push: false } });
    await notifications.sendArtisanNotification(ART, { type: 'Bookings', title: 'New job request', message: 'Plumbing, 2 km', bookingId: 'b1' });
    assert.strictEqual(fake.messaging.sent.length, 0);
    assert.strictEqual(rows('customer_notifications/').filter((n) => n.receiverId === ART).length, 1);
    await notifications.sendArtisanNotification(ART, { type: 'Payments', title: 'Withdrawal sent', message: 'GHS 50', bookingId: null });
    assert.strictEqual(fake.messaging.sent.length, 1, 'a payment notice is pushed regardless');
});

await t('push on (or never set): pushes as before', async () => {
    fake.db._reset(); fake.messaging._reset();
    fake.db._set(`artisans/${ART}`, { userType: 'artisan', fcmToken: 'tok-2', fcmPlatform: 'web' });
    await notifications.sendArtisanNotification(ART, { type: 'Bookings', title: 'New job request', message: 'x', bookingId: 'b2' });
    assert.strictEqual(fake.messaging.sent.length, 1);
});

await t('Settings saves the preference to the profile, and separates it from device permission', () => {
    const s = read('artisan-app/settings.html');
    assert.match(s, /notificationPreferences: \{ push: want, updatedAt: n \}/);
    assert.ok(!/localStorage\.setItem\('artisan_pref_notifications'/.test(s), 'the old browser-only save is gone');
    assert.match(s, /enablePushNotifications\(user\.uid, 'artisan'\)/);
    assert.match(s, /blocked:\s+'Blocked by this browser/);
});

console.log('\n── AR-15 · closing an artisan account ──\n');

const FRESH = () => ({ uid: ART, token: { email: 'k@example.com', auth_time: Math.floor(Date.now() / 1000) - 30 } });
const STALE = () => ({ uid: ART, token: { email: 'k@example.com', auth_time: Math.floor(Date.now() / 1000) - 3600 } });
function seedClosable(over = {}) {
    fake.db._reset(); fake.auth.reset(); fake.messaging._reset();
    fake.db._set(`artisans/${ART}`, { userType: 'artisan', status: 'active', verificationStatus: 'approved', name: 'Kofi Boateng',
        email: 'k@example.com', phone: '0240000000', bio: 'Plumber', profileImageId: 'img1', fcmToken: 'tok', lat: 5.6, lng: -0.19,
        geohash: 's0rk3', skills: ['leaks'], searchKeywords: ['kofi'], availableBalance: 0, totalEarned: 300, withdrawnTotal: 300, ...over });
    fake.db._set(`artisans/${ART}/private/kyc`, { artisanId: ART, ghanaCardNumber: 'GHA-1', payoutAccount: { provider: 'mtn', phone: '024' } });
    fake.db._set(`artisans/${ART}/private/location`, { lat: 5.6037, lng: -0.187 });
    fake.db._set(`artisans/${ART}/transactions/e1`, { type: 'earning', amount: 300 });
    fake.db._set(`artisan_index/${ART}`, { artisanId: ART, status: 'active' });
    fake.db._set('bookings/old1', { artisanId: ART, customerId: CUST, status: 'completed', artisanName: 'Kofi Boateng' });
    fake.auth.setUser(ART, { email: 'k@example.com' });
}

await t('every outstanding obligation blocks closure, with a reason', async () => {
    const cases = [
        [{ over: { availableBalance: 12.5 } }, 'available_balance'],
        [{ payout: true }, 'withdrawal_in_flight'],
        [{ escrow: true }, 'escrow_held'],
        [{ booking: 'en_route' }, 'active_bookings'],
        [{ offer: true }, 'open_offers'],
    ];
    for (const [c, code] of cases) {
        seedClosable(c.over);
        if (c.payout)  fake.db._set('payouts/px', { userId: ART, status: 'processing', amount: 10 });
        if (c.escrow)  fake.db._set('escrow/ex', { artisanId: ART, status: 'held', artisanShare: 10 });
        if (c.booking) fake.db._set('bookings/live', { artisanId: ART, status: c.booking });
        if (c.offer)   fake.db._set('job_offers/o1', { artisanId: ART, offerStatus: 'open' });
        const r = await lifecycle.checkAccountDeletable(FRESH());
        assert.strictEqual(r.deletable, false, code);
        assert.ok(r.blockers.some((b) => b.code === code), `${code} expected, got ${r.blockers.map((b) => b.code)}`);
        await rejects(() => lifecycle.requestAccountDeletion(FRESH()));
        assert.strictEqual(fake.auth.deleted.length, 0, `${code}: the login must survive a refusal`);
        assert.strictEqual(art().name, 'Kofi Boateng');
    }
});

await t('closure needs a sign-in from the last few minutes, checked on the server', async () => {
    seedClosable();
    const e = await rejects(() => lifecycle.requestAccountDeletion(STALE()), /sign in again/);
    assert.strictEqual(e.reason, 'reauth_required');
    await rejects(() => lifecycle.requestAccountDeletion({ uid: ART, token: {} }), /sign in again/);
    assert.strictEqual(fake.auth.deleted.length, 0);
});

await t('a clear account closes: PII erased, out of dispatch, records kept, login deleted last', async () => {
    seedClosable();
    const r = await lifecycle.requestAccountDeletion(FRESH());
    assert.deepStrictEqual(r, { success: true, role: 'artisan' });
    const a = art();
    assert.deepStrictEqual([a.deleted, a.status, a.isAvailable, a.name], [true, 'closed', false, 'Former professional']);
    for (const k of ['email', 'phone', 'bio', 'profileImageId', 'fcmToken', 'lat', 'lng', 'geohash', 'skills', 'searchKeywords']) {
        assert.strictEqual(a[k], undefined, `${k} must be erased`);
    }
    assert.strictEqual(a.totalEarned, 300, 'financial figures are kept');
    assert.strictEqual(fake.db._has(`artisans/${ART}/private/location`), false);
    assert.strictEqual(fake.db._has(`artisan_index/${ART}`), false);
    const kyc = fake.db._get(`artisans/${ART}/private/kyc`);
    assert.ok(kyc.ghanaCardNumber && kyc.accountClosedAt, 'identity evidence retained and stamped');
    assert.ok(fake.db._has(`artisans/${ART}/transactions/e1`), 'ledger retained');
    assert.strictEqual(fake.db._get('bookings/old1').status, 'completed', 'the customer\'s booking is untouched');
    assert.ok(rows('financialAudit/').some((x) => x.action === 'account_closed' && x.userType === 'artisan'));
    assert.deepStrictEqual(fake.auth.deleted, [ART]);
});

const CUST_AT = (secondsAgo) => ({ uid: CUST, token: { auth_time: Math.floor(Date.now() / 1000) - secondsAgo } });

await t('the customer path still refuses money outstanding', async () => {
    fake.db._reset(); fake.auth.reset();
    fake.db._set(`customers/${CUST}`, { walletBalance: 5, escrowBalance: 0, name: 'Ama' });
    fundCustomer(fake.db, CUST, 5);
    const r = await lifecycle.checkAccountDeletable({ uid: CUST, token: {} });
    assert.deepStrictEqual([r.deletable, r.blockers[0].code], [false, 'wallet_balance']);
    fake.db._set(`customers/${CUST}`, { walletBalance: 0, escrowBalance: 0, name: 'Ama', email: 'a@x.com' });
    fundCustomer(fake.db, CUST, 0);
    await lifecycle.requestAccountDeletion(CUST_AT(30));
    assert.deepStrictEqual(fake.auth.deleted, [CUST]);
});

await t('deleting a customer needs a recent sign-in too — a bare session token cannot erase the account', async () => {
    fake.db._reset(); fake.auth.reset();
    fake.db._set(`customers/${CUST}`, { walletBalance: 0, escrowBalance: 0, name: 'Ama', email: 'a@x.com' });
    fundCustomer(fake.db, CUST, 0);
    for (const auth of [{ uid: CUST, token: {} }, CUST_AT(3600)]) {
        const e = await rejects(() => lifecycle.requestAccountDeletion(auth), /sign in again/);
        assert.strictEqual(e.reason, 'reauth_required');
    }
    assert.strictEqual(fake.auth.deleted.length, 0);
    assert.strictEqual(fake.db._get(`customers/${CUST}`).name, 'Ama', 'nothing erased on a refusal');
    const page = read('customer-app/js/pages/settingsPage.js');
    assert.ok(page.indexOf('authService.reauthenticate(password)') > 0, 'customer settings refreshes the token (auth_time) before calling');
    assert.ok(page.indexOf('authService.reauthenticate(password)') < page.indexOf('await deleteAccountOnServer();'));
});

await t('Settings asks the server first and re-authenticates before closing', () => {
    const s = read('artisan-app/settings.html');
    assert.ok(s.indexOf("callable('checkAccountDeletable')") > 0);
    assert.ok(s.indexOf('authService.reauthenticate(') < s.indexOf("callable('requestAccountDeletion')"), 'reauth happens first');
    assert.match(s, /Type CLOSE to confirm/);
    assert.match(read('shared/js/backend/providers/firebase/firebaseAuthService.js'), /await user\.getIdToken\(true\)/);
});

console.log('\n── Settings · what an artisan sees, and what each control really does ──\n');

await t('job radius reads and writes the field dispatch uses, within what dispatch honours', () => {
    const s = read('artisan-app/settings.html');
    assert.ok(!/jobRadius/.test(s), 'jobRadius was never written by anything; the row always showed 10 km');
    assert.match(s, /updateDocument\('artisans', user\.uid, patch\)/);
    assert.match(s, /const patch = \{ workRadius: v, updatedAt: n \}/);
    assert.match(s, /RADIUS_CHOICES = \[5, 10, 15, 20, 25\]/);
    assert.match(read('functions/dispatch.js'), /25_000/, 'Settings caps at the dispatch search radius');
    assert.match(read('functions/dispatch.js'), /a\.workRadius \|\| 20/);
    assert.match(read('firestore.rules'), /isValidArtisanWorkRadius\(\)\s*\n\s*\);/);
});

await t('verification is a status for an approved artisan, not a link into onboarding', () => {
    const s = read('artisan-app/settings.html');
    assert.match(s, /approved:\s+\{ value: 'Verified',\s+tone: 'ok',.*link: false \}/);
    assert.match(read('artisan-app/onboarding.html'), /verificationStatus === 'approved'\) \{\s*window\.location\.href = 'dashboard\.html'/,
        'onboarding bounces approved accounts, which is why the row must not link there');
});

await t('the payout account is shown masked and never edited from Settings', () => {
    const s = read('artisan-app/settings.html');
    assert.match(s, /digits\.slice\(-4\)/);
    assert.ok(!/(update|set)Document\(`artisans\/\$\{user\.uid\}\/private`/.test(s));
});

await t('changing the password proves the current one first, and only for password accounts', () => {
    const s = read('artisan-app/settings.html');
    const i = s.indexOf('await authService.reauthenticate(cur)');
    assert.ok(i > 0 && i < s.indexOf('await authService.changePassword(next)'));
    assert.match(s, /\$\('password-row'\)\.hidden = !usesPassword/);
    assert.ok(s.indexOf("showToast('Password updated.'") > s.indexOf('await authService.changePassword(next)'), 'success only after Firebase accepts');
});

await t('Settings pages no longer send the device location to third parties', () => {
    const tm = read('shared/js/utils/themeManager.js');
    assert.ok(!/navigator\.geolocation|fetch\(/.test(tm), 'themeManager asked for GPS and posted it to a reverse-geocoder');
});

await t('the shared legal pages go back where the reader came from (artisans were sent into the customer app)', () => {
    // They now live in shared/legal/, served by both sites; with no history the
    // fallback is the site's own home, never the customer settings page.
    for (const f of ['shared/legal/terms.html', 'shared/legal/privacy.html']) {
        assert.match(read(f), /document\.referrer\.indexOf\(location\.origin \+ '\/'\) === 0\) history\.back\(\); else location\.href = '\/';/, f);
    }
});

await t('Profile is the professional profile; account controls have one home, in Settings', () => {
    const pf = read('artisan-app/profile.html');
    // HTML comments only: a /*…*/ strip is fooled by accept="image/*" and
    // swallows most of the page (it hid a real match while this test passed).
    const code = pf.replace(/<!--[\s\S]*?-->/g, '');
    for (const [what, re] of [
        ['sign out', /signOut|sessionService\.logout|Sign [Oo]ut/],
        // ("Withdraw request" cancels a pending profile-change request — not money.)
        ['wallet / earnings', /wallet\.html|availableBalance|totalEarned|Available to withdraw/],
        ['email or phone editing', /type="email"|type="tel"|field-email|field-phone|phone:\s/],
        ['settings menu rows', /pf2-row|menuRow\(/],
    ]) assert.ok(!re.test(code), `Profile still has ${what}`);
    assert.match(pf, /href="settings\.html" aria-label="Settings"/, 'one way to Settings');
    assert.match(pf, /if \(!locked\) \{\s*updates\.name/, 'verified claims written only while editable');
    const st = read('artisan-app/settings.html');
    assert.match(st, /id="phone-row"/);
    assert.match(st, /const patch = \{ phone: raw, updatedAt: new Date\(\)\.toISOString\(\) \}/);
    assert.match(read('artisan-app/dashboard.html'), /profile\.html\?edit=area/, 'Edit Area opens the service area');
});

console.log('\n── AR-16 · installability, judged honestly; a worker that caches only what it may ──\n');

await t('the artisan manifest is valid and in scope, and says honestly it is not installable yet', () => {
    const r = evaluateApp(APPS.find((a) => a.app === 'artisan-app'));
    assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
    assert.strictEqual(r.installable, false);
    assert.deepStrictEqual(r.blockers.map((b) => b.split(' — ')[0]), ['no icons declared']);
    const m = JSON.parse(read('artisan-app/manifest.webmanifest'));
    assert.deepStrictEqual([m.name, m.scope, m.start_url, m.display], ['Fidus X Artisan', '/artisan-app/', '/artisan-app/dashboard.html', 'standalone']);
});

await t('the checker reads real icon sizes (the customer icon is 384×242, not the 512×512 it claims)', () => {
    const r = evaluateApp(APPS.find((a) => a.app === 'customer-app'));
    assert.strictEqual(r.installable, false);
    assert.ok(r.blockers.some((b) => /384x242, not square/.test(b)));
});

function loadWorker() {
    const listeners = {};
    const self = { location: { origin: 'https://lamax-artisan.web.app' }, addEventListener: (n, f) => { listeners[n] = f; }, clients: {} };
    vm.runInNewContext(read('artisan-app/sw.js'), { self, caches: {}, fetch: () => {}, URL, Response, console });
    return { policy: self.__fxArtisanSwPolicy, listeners };
}
await t('the worker never caches data, auth, payments, pages or the push worker', () => {
    const { policy } = loadWorker();
    const O = 'https://lamax-artisan.web.app';
    const p = (url, extra = {}) => policy({ url, origin: O, ...extra });
    assert.strictEqual(p('https://firestore.googleapis.com/v1/projects/x/databases/y/documents/bookings/b1'), 'network');
    assert.strictEqual(p('https://europe-west1-lamax-4fd82.cloudfunctions.net/processArtisanWithdrawal', { method: 'POST' }), 'network');
    assert.strictEqual(p('https://api.paystack.co/transfer'), 'network');
    assert.strictEqual(p(`${O}/__/auth/handler?apiKey=x`), 'network', 'the Auth popup handler');
    assert.strictEqual(p(`${O}/firebase-messaging-sw.js`), 'network');
    assert.strictEqual(p(`${O}/release-manifest.json`), 'network');
    assert.strictEqual(p(`${O}/artisan-app/js/x.js`, { hasAuthorization: true }), 'network');
    assert.strictEqual(p(`${O}/artisan-app/wallet.html`, { mode: 'navigate' }), 'navigate', 'pages: network, offline page fallback only');
    assert.strictEqual(p(`${O}/customer-app/index.html`, { mode: 'navigate' }), 'network', 'out of scope');
    assert.strictEqual(p(`${O}/artisan-app/js/pwa.js`), 'network-first');
    assert.strictEqual(p(`${O}/shared/js/domain/walletLedger.js`), 'network-first');
    assert.strictEqual(p(`${O}/shared/assets/images/handyhub-logo.png`), 'swr');
    assert.strictEqual(p(`${O}/shared/js/x.js?token=abc`), 'network');
});

await t('the worker leaves push to the messaging worker and cleans only its own caches', () => {
    const { listeners } = loadWorker();
    assert.deepStrictEqual(Object.keys(listeners).sort(), ['activate', 'fetch', 'install']);
    const src = read('artisan-app/sw.js');
    assert.match(src, /k\.startsWith\('fx-artisan-'\)/);
    assert.ok(!/cache\.put\(OFFLINE_URL|navigate[\s\S]{0,200}cache\.put/.test(src), 'navigations are never written to the cache');
});

await t('every artisan page links the manifest and registers the worker; hosting revalidates both', () => {
    for (const f of fs.readdirSync(path.join(ROOT, 'artisan-app')).filter((n) => n.endsWith('.html') && n !== 'offline.html')) {
        const s = read(`artisan-app/${f}`);
        assert.match(s, /<link rel="manifest" href="manifest\.webmanifest" \/>/, f);
        assert.match(s, /<script src="js\/pwa\.js" defer><\/script>/, f);
    }
    assert.match(read('artisan-app/js/pwa.js'), /register\('\/artisan-app\/sw\.js', \{ scope: '\/artisan-app\/' \}\)/);
    const hosting = JSON.parse(read('firebase.json')).hosting.find((h) => h.target === 'artisan');
    const hdr = (src) => (hosting.headers.find((h) => h.source === src) || { headers: [] }).headers;
    assert.ok(hdr('/artisan-app/sw.js').some((h) => /no-cache/.test(h.value)));
    assert.ok(hdr('/artisan-app/manifest.webmanifest').some((h) => h.value === 'application/manifest+json'));
});

await t('the Android project is still the customer app only — untouched', () => {
    const cap = JSON.parse(read('capacitor.config.json'));
    assert.deepStrictEqual([cap.appId, cap.webDir], ['com.handyhub.customer', 'build-customer-app']);
    // The launcher name is the brand; the package id is the Play identity and stays.
    assert.strictEqual(cap.appName, 'Fidus X');
    const strings = read('android/app/src/main/res/values/strings.xml');
    assert.match(strings, /<string name="app_name">Fidus X<\/string>/);
    assert.match(strings, /<string name="title_activity_main">Fidus X<\/string>/);
    assert.match(strings, /<string name="package_name">com\.handyhub\.customer<\/string>/);
    assert.match(read('docs/ARTISAN_PLATFORMS.md'), /Native Android artisan app — not built, and why/);
});

await t('the customer APK cannot be built without Firebase native config (it closed on every login)', () => {
    const os = require('os');
    const { firebaseConfigProblem } = require(path.join(ROOT, 'scripts', 'build-capacitor.cjs'));
    const fake = (files) => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-cap-'));
        fs.mkdirSync(path.join(dir, 'android', 'app'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'capacitor.config.json'), JSON.stringify({ appId: 'com.handyhub.customer' }));
        for (const [rel, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, rel), body);
        return dir;
    };
    const cfg = (...pkgs) => JSON.stringify({ project_info: { project_id: 'lamax-4fd82' },
        client: pkgs.map((p) => ({ client_info: { android_client_info: { package_name: p } } })) });
    assert.match(firebaseConfigProblem(fake({})), /missing/);
    assert.match(firebaseConfigProblem(fake({ 'android/app/google-services (2).json': cfg('com.handyhub.customer') })),
        /must be named exactly google-services\.json/, 'a browser download name is not read by Gradle');
    assert.match(firebaseConfigProblem(fake({ 'android/app/google-services.json': cfg('com.handyhub.artisan') })), /no client for com\.handyhub\.customer/);
    assert.strictEqual(firebaseConfigProblem(fake({ 'android/app/google-services.json': cfg('com.handyhub.artisan', 'com.handyhub.customer') })), null);

    // Gradle refuses too (Android Studio builds never run build-capacitor.cjs),
    // instead of the template's info-level "Push Notifications won't work".
    const gradle = read('android/app/build.gradle');
    assert.match(gradle, /throw new GradleException\(/);
    assert.match(gradle, /servicesPackages\.contains\(android\.defaultConfig\.applicationId\)/);
    assert.ok(!/logger\.info\("google-services\.json not found/.test(gradle), 'the silent skip is gone');
    assert.match(gradle, /^apply plugin: 'com\.google\.gms\.google-services'$/m, 'applied unconditionally');

    // Why it crashed rather than failing softly: the plugin reaches Firebase
    // natively, and Capacitor re-throws plugin exceptions on its own thread.
    assert.match(read('node_modules/@capacitor/push-notifications/android/src/main/java/com/capacitorjs/plugins/pushnotifications/PushNotificationsPlugin.java'),
        /public void register\(PluginCall call\) \{\s*FirebaseMessaging\.getInstance\(\)/);
    assert.match(read('node_modules/@capacitor/android/capacitor/src/main/java/com/getcapacitor/Bridge.java'),
        /Serious error executing plugin", ex\);\s*throw new RuntimeException\(ex\);/);
    assert.match(read('customer-app/js/authInit.js'), /initializePushNotifications\(user\.uid, 'customer'\)/, 'runs right after sign-in');
});

await t('the installed app opens on the startup router, which waits for Firebase — never a timer', () => {
    // The native shim used to open index.html ("Get started" → Sign up), which
    // never asks whether anyone is signed in: every relaunch looked like a new visitor.
    const cap = read('scripts/build-capacitor.cjs');
    assert.match(cap, /const ENTRY = 'customer-app\/splash-screen\.html';/);
    const splash = read('customer-app/splash-screen.html');
    const code = splash.slice(splash.indexOf('<script type="module">'));
    assert.match(code, /await authService\.waitForUser\(\)/);
    assert.match(code, /window\.location\.replace\(user \? 'dashboard\.html' : 'index\.html'\)/, 'same destinations as before');
    // No timer may route: the old 2.8 s fallback sent slow restores to Sign up
    // (reproduced in a browser with the auth IndexedDB read delayed 4.5 s).
    const timers = [...code.matchAll(/setTimeout\(([\s\S]*?)\}?, \d+\)/g)].map((m) => m[1]);
    assert.ok(timers.length && timers.every((t) => !/location/.test(t)), 'a timer only changes the message');
    assert.ok(!/catch[\s\S]{0,200}location\.replace\('index\.html'\)/.test(code), 'a failure offers a retry, not Sign up');
    assert.match(splash, /id="splash-retry"/);
});

await t('requireAuth reaches login when Firebase fails (it threw on an undefined timer)', () => {
    const g = read('shared/js/utils/authGuard.js');
    const tail = g.slice(g.indexOf('container.services.authService.waitForUser()'), g.indexOf('export function consumeReturnUrl'));
    assert.ok(!/clearTimeout\(timeout\)/.test(tail));
    assert.match(tail, /\.catch\(\(\) => \{[\s\S]*clearTimers\(\);[\s\S]*redirectToLogin\(\);/);
});

await t('the launcher icon is the supplied customer-app-icon.png, at every density, adaptive and legacy', () => {
    const res = 'android/app/src/main/res';
    const size = (rel) => { const b = fs.readFileSync(path.join(ROOT, rel)); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };
    assert.ok(fs.existsSync(path.join(ROOT, 'shared/assets/images/customer-app-icon.png')), 'the source image');
    const dens = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
    for (const [d, m] of Object.entries(dens)) {
        for (const f of ['ic_launcher', 'ic_launcher_round']) assert.deepStrictEqual(size(`${res}/mipmap-${d}/${f}.png`), [48 * m, 48 * m], `${d}/${f}`);
        for (const f of ['ic_launcher_foreground', 'ic_launcher_monochrome']) assert.deepStrictEqual(size(`${res}/mipmap-${d}/${f}.png`), [108 * m, 108 * m], `${d}/${f}`);
    }
    for (const f of ['ic_launcher', 'ic_launcher_round']) {
        const x = read(`${res}/mipmap-anydpi-v26/${f}.xml`);
        assert.match(x, /@mipmap\/ic_launcher_foreground/); assert.match(x, /<monochrome android:drawable="@mipmap\/ic_launcher_monochrome"\/>/);
    }
    assert.match(read(`${res}/values/ic_launcher_background.xml`), /#640115/, 'the artwork\'s own maroon, not white');
    const manifest = read('android/app/src/main/AndroidManifest.xml');
    assert.match(manifest, /android:icon="@mipmap\/ic_launcher"/); assert.match(manifest, /android:roundIcon="@mipmap\/ic_launcher_round"/);
});

await t('Android status bar: one source of top inset (native padding), readable on every version', () => {
    // The mechanism this relies on (Capacitor 8 SystemBars): a page declaring
    // viewport-fit=cover gets the full screen on Android 15+ and must pad itself;
    // any other page is padded below the status bar natively.
    const sb = read('node_modules/@capacitor/android/capacitor/src/main/java/com/getcapacitor/plugin/SystemBars.java');
    assert.match(sb, /shouldPassthroughInsets = getWebViewMajorVersion\(\) >= WEBVIEW_VERSION_WITH_SAFE_AREA_FIX && hasViewportCover/);
    assert.match(sb, /VANILLA_ICE_CREAM\) \{[\s\S]{0,160}v\.setPadding\(\s*systemBarsInsets\.left,\s*systemBarsInsets\.top/);
    // So no Customer page may opt out (seven did; five drew under the clock).
    const covers = fs.readdirSync(path.join(ROOT, 'customer-app')).filter((f) => f.endsWith('.html'))
        .filter((f) => /name="viewport"[^>]*viewport-fit=cover/.test(read(`customer-app/${f}`)));
    assert.deepStrictEqual(covers, [], 'viewport-fit=cover draws the page under the Android status bar');
    assert.match(read('scripts/build-capacitor.cjs'), /viewport-fit=cover would draw these pages under the Android status bar/);

    // Colours: the app's #FEFEFE behind the bar, dark icons — not the phone's
    // dark mode, not Capacitor's template indigo (#303F9F) on Android 14 and below.
    assert.match(read('android/app/src/main/res/values/colors.xml'), /<color name="fx_system_bar">#FEFEFE<\/color>/);
    const styles = read('android/app/src/main/res/values/styles.xml');
    const theme = styles.slice(styles.indexOf('name="AppTheme.NoActionBar"'), styles.indexOf('name="AppTheme.NoActionBarLaunch"'));
    assert.match(theme, /parent="Theme\.AppCompat\.Light\.NoActionBar"/);
    for (const item of ['android:windowBackground', 'android:statusBarColor', 'android:navigationBarColor']) {
        assert.match(theme, new RegExp(`name="${item}">@color/fx_system_bar<`), item);
    }
    assert.match(theme, /name="android:windowLightStatusBar">true</);
    assert.match(read('android/app/src/main/AndroidManifest.xml'), /android:theme="@style\/AppTheme\.NoActionBarLaunch"|android:theme="@style\/AppTheme\.NoActionBar"/);
    assert.strictEqual(JSON.parse(read('capacitor.config.json')).plugins.SystemBars.style, 'LIGHT', 'dark icons on the light bar, whatever the phone theme');
});

await t('status bar: the app pads the WebView by the real insets on EVERY Android version — not Capacitor\'s 15+ only path', () => {
    // Root cause: Capacitor 8 pads only on Android 15+ and re-decides per page
    // from an asynchronous viewport check; a window drawn behind the status bar
    // below 15, or a page judged "cover" (the launch shim was), got no padding.
    const sb = read('node_modules/@capacitor/android/capacitor/src/main/java/com/getcapacitor/plugin/SystemBars.java');
    assert.match(sb, /if \(Build\.VERSION\.SDK_INT >= Build\.VERSION_CODES\.VANILLA_ICE_CREAM\) \{\s*\/\/ We need to correct for a possible shown IME\s*v\.setPadding/);
    const main = read('android/app/src/main/java/com/handyhub/customer/MainActivity.java');
    assert.match(main, /ViewCompat\.setOnApplyWindowInsetsListener\(container,/);
    assert.match(main, /WindowInsetsCompat\.Type\.systemBars\(\) \| WindowInsetsCompat\.Type\.displayCutout\(\)/);
    assert.match(main, /v\.setPadding\(bars\.left, bars\.top, bars\.right, Math\.max\(bars\.bottom, ime\.bottom\)\)/);
    assert.ok(!/SDK_INT|VERSION_CODES/.test(main.replace(/\/\*[\s\S]*?\*\//g, '')), 'no Android-version gate in our handling');
    assert.match(main, /View container = \(View\) getBridge\(\)\.getWebView\(\)\.getParent\(\);/);
    // Exactly one layer: Capacitor's own handling is off, so nothing else pads.
    assert.strictEqual(JSON.parse(read('capacitor.config.json')).plugins.SystemBars.insetsHandling, 'disable');
    // And the first page the app ever loads no longer opts out either.
    const cap = read('scripts/build-capacitor.cjs');
    const shim = cap.slice(cap.indexOf('const SHIM ='), cap.indexOf('function main()'));
    assert.ok(!/viewport-fit=cover/.test(shim), 'the launch shim declared viewport-fit=cover');
    assert.match(cap, /\}\)\(WEB_DIR\);\s*if \(covers\.length\)/, 'the guard scans the whole bundle, shim included');
});

await t('permissions: only what a feature uses, asked when it is used', () => {
    const m = read('android/app/src/main/AndroidManifest.xml').replace(/<!--[\s\S]*?-->/g, '');
    const perms = [...m.matchAll(/<uses-permission android:name="android\.permission\.([A-Z_]+)"/g)].map((x) => x[1]).sort();
    assert.deepStrictEqual(perms, ['ACCESS_COARSE_LOCATION', 'ACCESS_FINE_LOCATION', 'INTERNET', 'POST_NOTIFICATIONS'],
        'location was missing (Android refused every request without a prompt); nothing broader is needed');
    // Capacitor's WebView asks Android for exactly these two when a page calls geolocation.
    assert.match(read('node_modules/@capacitor/android/capacitor/src/main/java/com/getcapacitor/BridgeWebChromeClient.java'),
        /geoPermissions = \{ Manifest\.permission\.ACCESS_COARSE_LOCATION, Manifest\.permission\.ACCESS_FINE_LOCATION \}/);
    // No location dialog on page load: the dashboard and live tracking refresh
    // only when already allowed; the explicit button is where it is asked.
    const dash = read('customer-app/dashboard.html');
    const auto = dash.slice(dash.indexOf('(function autoDetect(){'), dash.indexOf('Lazy-load Leaflet'));
    assert.match(auto, /navigator\.permissions\.query\(\{ name: 'geolocation' \}\)[\s\S]*st\.state === 'granted'\) refresh\(\)/);
    const live = read('customer-app/live-tracking.html');
    assert.match(live, /navigator\.permissions\.query\(\{ name: 'geolocation' \}\)\.then\(\(st\) => \{\s*if \(!st \|\| st\.state !== 'granted'\) return;/);
    // A refusal is explained, with the manual alternative.
    assert.match(dash, /err && err\.code === 1\)\s*\? 'Location is off for Fidus X\. Tap the map to set your location/);
    // Photos: the system picker (no media permission) — and no camera capture
    // attribute that would need CAMERA.
    for (const f of ['profile', 'book-request', 'messages']) {
        const h = read(`customer-app/${f}.html`);
        assert.ok(/<input[^>]*type="file"[^>]*accept="image/.test(h), f);
        assert.ok(!/<input[^>]*type="file"[^>]*capture/.test(h), `${f}: capture would need CAMERA`);
    }
    // Notifications: Android's state shown in Settings, with the one fix possible.
    const sn = read('customer-app/js/pages/settingsNotifications.js');
    assert.match(sn, /initializePushNotifications\(user\.uid, 'customer', \{ prompt: false \}\)/);
    assert.match(sn, /btn\.hidden = !\(state === 'off' \|\| state === 'failed'\)/);
});

console.log(`\nwallet-settings-platform: ${passed} passed, ${failed} failed`);
if (failed) { for (const [name, e] of failures) console.log(`\n✗ ${name}\n${e.stack}`); process.exit(1); }
})();
