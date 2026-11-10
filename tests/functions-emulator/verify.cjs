// tests/functions-emulator/verify.cjs — the real Cloud Functions in an isolated
// emulator (scripts/verify-functions-local.cjs builds it: a copy of the code
// with a dummy-only .env; every outside call answered by netguard.cjs). Called over HTTP exactly as
// the apps call them, with ID tokens from the Auth emulator; data seeded and
// read with the Admin SDK against the Firestore emulator; client writes made
// through the Firestore emulator's REST API so the real rules decide.
//
// Run it with:  npm run test:functions-emulator   (never directly against a
// real project: it clears the emulator database it talks to).
'use strict';
require('../support/no-production.cjs');   // must stay the first statement
const path = require('path');
// Emulators only. A demo- project id makes the SDKs refuse to reach Google.
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';
process.env.GCLOUD_PROJECT = 'demo-fidusx';
const fs = require('fs');
const crypto = require('crypto');
const ROOT = path.resolve(__dirname, '..', '..');
const fnRequire = require('module').createRequire(path.join(ROOT, 'functions', 'package.json'));
const admin = fnRequire('firebase-admin');
const { getFirestore, FieldValue } = fnRequire('firebase-admin/firestore');

const STATE = process.argv[2] || process.env.FX_NETGUARD_STATE;
const NETLOG = process.argv[3] || process.env.FX_NETGUARD_LOG;
if (!STATE || !NETLOG) { console.error("run through npm run test:functions-emulator"); process.exit(2); }
const PROJECT = 'demo-fidusx';
const DB_ID = 'ai-studio-5589039d-72c4-40d8-ae39-f35c6c321eb6';
const FN_BASE = `http://127.0.0.1:5001/${PROJECT}/europe-west1`;
const FS_REST = `http://127.0.0.1:8080/v1/projects/${PROJECT}/databases/${DB_ID}/documents`;
const DUMMY_SECRET = 'sk_test_LOCAL_DUMMY_NOT_A_KEY';
const LIMITS = '_rate_limits';
const ADMIN_EMAIL = 'silas7korda@gmail.com';   // an emulator-only account; nothing is sent to it

admin.initializeApp({ projectId: PROJECT });
const db = getFirestore(DB_ID);
const auth = admin.auth();

const results = [];
function check(area, name, ok, detail) { results.push({ area, name, ok: !!ok, detail }); console.log(`  ${ok ? 'PASS' : 'FAIL'}  [${area}] ${name}${ok ? '' : `   ${String(JSON.stringify(detail)).slice(0, 400)}`}`); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const setState = (s) => fs.writeFileSync(STATE, JSON.stringify(s));
const netLines = () => fs.readFileSync(NETLOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
async function waitFor(fn, ms = 15000) { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v || Date.now() > end) return v; await sleep(250); } }

async function user(uid, email, { verified = true } = {}) {
    await auth.deleteUser(uid).catch(() => {});
    await auth.createUser({ uid, email, password: 'Passw0rd!23', emailVerified: verified });
    const r = await fetch('http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'Passw0rd!23', returnSecureToken: true }) });
    const j = await r.json();
    if (!j.idToken) throw new Error(`sign-in failed for ${email}: ${JSON.stringify(j)}`);
    return j.idToken;
}
async function call(name, data, token) {
    const r = await fetch(`${FN_BASE}/${name}`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ data }) });
    const j = await r.json().catch(() => ({}));
    return { http: r.status, result: j.result, error: j.error };
}
const enc = (v) => typeof v === 'string' ? { stringValue: v } : typeof v === 'boolean' ? { booleanValue: v }
    : Number.isInteger(v) ? { integerValue: String(v) } : typeof v === 'number' ? { doubleValue: v } : v === null ? { nullValue: null } : { stringValue: String(v) };
async function clientPatch(docPath, fields, token) {
    const mask = Object.keys(fields).map((f) => `updateMask.fieldPaths=${encodeURIComponent(f)}`).join('&');
    const r = await fetch(`${FS_REST}/${docPath}?${mask}`, { method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, enc(v)])) }) });
    return r.status;
}
async function clientGet(docPath, token) {
    const r = await fetch(`${FS_REST}/${docPath}`, { headers: { Authorization: `Bearer ${token}` } });
    return { status: r.status, body: await r.json().catch(() => ({})) };
}
const get = async (p) => { const s = await db.doc(p).get(); return s.exists ? s.data() : null; };
async function webhook(event) {
    const raw = JSON.stringify(event);
    const sig = crypto.createHmac('sha512', DUMMY_SECRET).update(raw).digest('hex');
    const r = await fetch(`${FN_BASE}/paystackWebhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-paystack-signature': sig }, body: raw });
    return r.status;
}
const NOW = new Date().toISOString();
// The withdrawal limit is 3 per artisan per hour (middleware/rateLimiter.js). Cases
// that need a fresh allowance clear the counter, in the emulator only.
async function resetLimits(uid) { const s = await db.collection(LIMITS).get(); await Promise.all(s.docs.filter((d) => d.id.startsWith(uid)).map((d) => d.ref.delete())); }
const daysAgo = (d) => new Date(Date.now() - d * 864e5).toISOString();

(async () => {
    // A clean emulator database for every run (the emulator only; it has no other data).
    const wipe = await fetch(`http://127.0.0.1:8080/emulator/v1/projects/${PROJECT}/databases/${DB_ID}/documents`, { method: 'DELETE' });
    if (wipe.status !== 200) throw new Error('could not clear the emulator database: ' + wipe.status);
    // ═══ A. Withdrawals while Paystack refuses payouts (the on-hold account) ═══
    console.log('\nA. Artisan withdrawals: Paystack on hold, retries, concurrency, webhooks\n');
    const W = 'v_art_w';
    const wTok = await user(W, 'artisan.w@fidusx.invalid');
    await db.doc(`artisans/${W}`).set({ userType: 'artisan', name: 'Kofi Boateng', status: 'active', verificationStatus: 'approved', availableBalance: 50, withdrawnTotal: 0, createdAt: NOW });
    await db.doc(`artisans/${W}/private/kyc`).set({ artisanId: W, payoutAccount: { provider: 'mtn', phone: '0241111111', accountName: 'Kofi Boateng' } });
    await db.doc('escrow/v_esc_w').set({ bookingId: 'v_bk_w', customerId: 'v_cus_w', artisanId: W, kind: 'job', amount: 58.82, artisanShare: 50, status: 'released', fundingVerified: true, createdAt: NOW });
    await db.doc(`artisans/${W}/transactions/earn1`).set({ type: 'earning', amount: 50, escrowId: 'v_esc_w', bookingId: 'v_bk_w', status: 'completed', createdAt: NOW });
    const pin = await call('setSecurityPin', { pin: '4826' }, wTok);
    check('withdraw', 'the artisan sets a Security PIN through the real callable', pin.result && !pin.error, pin);

    setState({ transfer: 'starter' });
    const before = netLines().length;
    const r1 = await call('processArtisanWithdrawal', { amount: 20, pin: '4826', requestId: 'req-hold-1' }, wTok);
    const p1 = await get(`payouts/${W}_req-hold-1`);
    const bal1 = (await get(`artisans/${W}`)).availableBalance;
    const tCalls1 = netLines().slice(before).filter((l) => l.host === 'api.paystack.co' && l.path === '/transfer');
    check('withdraw', 'on hold: Paystack refuses, the artisan is told plainly and the balance is restored',
        r1.error && r1.error.status === 'FAILED_PRECONDITION' && /could not be started.*restored/i.test(r1.error.message) && bal1 === 50, { r1, bal1 });
    check('withdraw', 'on hold: the payout is recorded as failed and refunded exactly once',
        p1 && p1.status === 'failed' && !!p1.refundedAt && tCalls1.length === 1 && tCalls1[0].status === 400 && tCalls1[0].amount === 2000, { p1: p1 && { s: p1.status, r: !!p1.refundedAt }, tCalls1 });
    const audits1 = (await db.collection('financialAudit').where('payoutId', '==', `${W}_req-hold-1`).get()).docs.map((d) => d.data().action).sort();
    check('withdraw', 'on hold: the audit trail shows the reservation and its refund, nothing else', JSON.stringify(audits1) === JSON.stringify(['withdrawal_initiated', 'withdrawal_refunded']), audits1);
    const before2 = netLines().length;
    const r1b = await call('processArtisanWithdrawal', { amount: 20, pin: '4826', requestId: 'req-hold-1' }, wTok);
    check('withdraw', 'retrying the same request returns that failed payout and calls Paystack no more',
        r1b.result && r1b.result.duplicate === true && r1b.result.status === 'failed' && netLines().slice(before2).filter((l) => l.path === '/transfer').length === 0 && (await get(`artisans/${W}`)).availableBalance === 50, r1b);
    const rWrong = await call('processArtisanWithdrawal', { amount: 20, pin: '1111', requestId: 'req-wrong-pin' }, wTok);
    check('withdraw', 'a wrong PIN is refused before anything is reserved', rWrong.error && !(await get(`payouts/${W}_req-wrong-pin`)) && (await get(`artisans/${W}`)).availableBalance === 50, rWrong);
    await resetLimits(W);
    const rOver = await call('processArtisanWithdrawal', { amount: 80, pin: '4826', requestId: 'req-over' }, wTok);
    check('withdraw', 'more than the balance is refused, nothing reserved', rOver.error && /Insufficient/i.test(rOver.error.message) && !(await get(`payouts/${W}_req-over`)), rOver);

    setState({ transfer: 'accept' });
    await resetLimits(W);
    const r2 = await call('processArtisanWithdrawal', { amount: 20, pin: '4826', requestId: 'req-ok-2' }, wTok);
    check('withdraw', 'once Paystack accepts: processing, never "paid", and the money is held', r2.result && r2.result.status === 'processing' && (await get(`artisans/${W}`)).availableBalance === 30, r2);
    await resetLimits(W);
    const before3 = netLines().length;
    const [c1, c2] = await Promise.all([
        call('processArtisanWithdrawal', { amount: 10, pin: '4826', requestId: 'req-twin' }, wTok),
        call('processArtisanWithdrawal', { amount: 10, pin: '4826', requestId: 'req-twin' }, wTok),
    ]);
    const twinTransfers = netLines().slice(before3).filter((l) => l.path === '/transfer');
    check('withdraw', 'a double tap sent at the same moment makes one payout and one Paystack transfer',
        c1.result && c2.result && c1.result.payoutId === c2.result.payoutId && twinTransfers.length === 1 && (await get(`artisans/${W}`)).availableBalance === 20, { c1, c2, twinTransfers: twinTransfers.length });
    const ref2 = (await get(`payouts/${W}_req-ok-2`)).ref;
    const ev = { event: 'transfer.failed', data: { reference: ref2, amount: 2000, status: 'failed', reason: 'local test' } };
    const h1 = await webhook(ev); const h2 = await webhook(ev);
    await waitFor(async () => (await get(`payouts/${W}_req-ok-2`)).status === 'failed');
    check('withdraw', 'a transfer.failed webhook delivered twice refunds once', h1 === 200 && h2 === 200 && (await get(`artisans/${W}`)).availableBalance === 40, { h1, h2, bal: (await get(`artisans/${W}`)).availableBalance });
    const bad = await fetch(`${FN_BASE}/paystackWebhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-paystack-signature': 'forged' }, body: JSON.stringify({ event: 'transfer.failed', data: { reference: (await get(`payouts/${W}_req-twin`)).ref, amount: 1000 } }) });
    check('withdraw', 'a forged webhook is rejected and moves nothing', bad.status === 400 && (await get(`payouts/${W}_req-twin`)).status === 'processing' && (await get(`artisans/${W}`)).availableBalance === 40, bad.status);
    const success = await webhook({ event: 'transfer.success', data: { reference: (await get(`payouts/${W}_req-twin`)).ref, amount: 1000, status: 'success' } });
    await waitFor(async () => (await get(`payouts/${W}_req-twin`)).status === 'success');
    check('withdraw', 'transfer.success completes the other payout and keeps it debited', success === 200 && (await get(`artisans/${W}`)).availableBalance === 40, success);
    const late = await webhook(ev);
    check('withdraw', 'a late duplicate of the failure still changes nothing', late === 200 && (await get(`artisans/${W}`)).availableBalance === 40);

    // ═══ B. Cancelling approved work (decision Q5) through the real rules and trigger ═══
    console.log('\nB. Approved work: no direct cancel by either party; support cancels and the trigger refunds once\n');
    const CB = 'v_cus_b', AB = 'v_art_b', ADM = 'v_admin';
    const cTok = await user(CB, 'customer.b@fidusx.invalid');
    const aTok = await user(AB, 'artisan.b@fidusx.invalid');
    const admTok = await user(ADM, ADMIN_EMAIL);
    await db.doc(`customers/${CB}`).set({ userType: 'customer', name: 'Ama', status: 'active', walletBalance: 0, escrowBalance: 100, spent: 0 });
    await db.doc(`artisans/${AB}`).set({ userType: 'artisan', name: 'Yaw', status: 'active', verificationStatus: 'approved' });
    await db.doc('bookings/v_bk_b').set({ customerId: CB, artisanId: AB, status: 'accepted', track: 'standard', quoteApproved: true, escrowHeldAmount: 100, serviceType: 'Plumbing', address: '3 Test Lane, Osu', lat: 5.55, lng: -0.18, createdAt: daysAgo(1), updatedAt: daysAgo(1) });
    await db.doc('escrow/v_esc_b').set({ bookingId: 'v_bk_b', customerId: CB, artisanId: AB, kind: 'job', amount: 100, artisanShare: 85, status: 'held', createdAt: NOW });
    await db.doc('bookings/v_bk_b2').set({ customerId: CB, artisanId: AB, status: 'accepted', track: 'standard', serviceType: 'Plumbing', createdAt: daysAgo(1), updatedAt: daysAgo(1) });
    const sA = await clientPatch('bookings/v_bk_b', { status: 'cancelled', cancelledBy: 'artisan', cancellationReason: 'x', updatedAt: new Date().toISOString() }, aTok);
    const sC = await clientPatch('bookings/v_bk_b', { status: 'cancelled', cancelledBy: 'customer', cancellationReason: 'x', updatedAt: new Date().toISOString() }, cTok);
    await sleep(1500);
    check('cancel', 'the artisan\'s direct cancel of approved work is refused by the rules', sA === 403, sA);
    check('cancel', 'the customer\'s direct cancel of approved work is refused by the rules', sC === 403, sC);
    check('cancel', 'the held money did not move', (await get('escrow/v_esc_b')).status === 'held' && (await get(`customers/${CB}`)).walletBalance === 0);
    const sA2 = await clientPatch('bookings/v_bk_b2', { status: 'cancelled', cancelledBy: 'artisan', cancellationReason: 'x', updatedAt: new Date().toISOString() }, aTok);
    check('cancel', 'before approval the artisan still cancels an accepted job directly', sA2 === 200, sA2);
    const nonAdm = await call('cancelBookingAsAdmin', { bookingId: 'v_bk_b', reason: 'Support decision' }, cTok);
    check('cancel', 'a customer cannot use the support cancellation', nonAdm.error && (await get('bookings/v_bk_b')).status === 'accepted', nonAdm);
    const adm = await call('cancelBookingAsAdmin', { bookingId: 'v_bk_b', reason: 'Support decision after a complaint' }, admTok);
    const refunded = await waitFor(async () => (await get('escrow/v_esc_b')).status === 'refunded');
    const cust = await get(`customers/${CB}`);
    check('cancel', 'support cancels it; the status trigger refunds the held money to the customer once',
        !adm.error && refunded && cust.walletBalance === 100 && cust.escrowBalance === 0 && (await get('bookings/v_bk_b')).cancelledBy === `admin:${ADMIN_EMAIL}`, { adm, cust });
    const again = await call('cancelBookingAsAdmin', { bookingId: 'v_bk_b', reason: 'again' }, admTok);
    await sleep(1500);
    check('cancel', 'a second support cancel is refused and refunds nothing more', again.error && (await get(`customers/${CB}`)).walletBalance === 100, again);
    const stamped = await waitFor(async () => (await get('bookings/v_bk_b')).locationRetainUntilMs);
    check('cancel', 'closing the booking starts the 14-day location clock (decision Q6)', stamped && Math.abs(stamped - (Date.now() + 14 * 864e5)) < 5 * 60e3, stamped);

    // ═══ C. Verification decisions: no admin email on the public profile ═══
    console.log('\nC. Approve, ban, unban: the admin\'s email stays off the public profile\n');
    const DC = 'v_art_c';
    await user(DC, 'artisan.c@fidusx.invalid');
    await db.doc(`artisans/${DC}`).set({ userType: 'artisan', name: 'Esi', category: 'Plumbing', verificationStatus: 'pending_review', status: 'pending', approvedBy: 'old-admin@x.test', createdAt: NOW });
    await db.doc(`verification_requests/${DC}`).set({ artisanId: DC, status: 'pending_review', verificationStatus: 'pending_review' });
    const notAdmin = await call('approveArtisan', { artisanId: DC }, cTok);
    check('decisions', 'a customer cannot approve an artisan', notAdmin.error && (await get(`artisans/${DC}`)).verificationStatus === 'pending_review', notAdmin);
    const ap = await call('approveArtisan', { artisanId: DC }, admTok);
    const seen = await clientGet(`artisans/${DC}`, cTok);
    const pubFields = Object.keys((seen.body && seen.body.fields) || {});
    check('decisions', 'approved; a customer reading the profile sees no admin email, old or new',
        !ap.error && seen.status === 200 && pubFields.includes('verificationStatus') && !pubFields.some((f) => /By$/.test(f)) && !JSON.stringify(seen.body).includes('@x.test') && !JSON.stringify(seen.body).includes(ADMIN_EMAIL), { ap, pubFields });
    check('decisions', 'the request still records who approved', (await get(`verification_requests/${DC}`)).approvedBy === ADMIN_EMAIL);
    await call('banArtisan', { artisanId: DC, reason: 'Fraudulent job reports' }, admTok);
    await call('unbanArtisan', { artisanId: DC }, admTok);
    const after = await get(`artisans/${DC}`);
    check('decisions', 'after a ban and an unban the profile holds no reason and no admin email',
        !Object.keys(after).some((f) => /By$/.test(f) || f === 'banReason' && after[f]) && after.verificationStatus === 'approved', Object.keys(after));

    // ═══ D. The three prepared migrations: dry run, copy, strip, repeat ═══
    console.log('\nD. Migrations on seeded legacy data\n');
    const L1 = 'v_leg_1', L2 = 'v_leg_2';
    await db.doc(`artisans/${L1}`).set({ userType: 'artisan', name: 'Kwame', category: 'Electrical', status: 'active', verificationStatus: 'approved',
        phone: '0207777777', email: 'kwame.legacy@fidusx.invalid', ghanaCardNumber: 'GHA-000000001-1', payoutAccount: { provider: 'mtn', phone: '0207777777', accountName: 'Kwame' },
        currentLat: 5.603717, currentLng: -0.186964, rejectionReason: 'Earlier: card photo unreadable', approvedBy: 'old-admin@x.test', bannedBy: null, adminNotes: 'internal note', trustScore: 71 });
    await db.doc(`verification_requests/${L1}`).set({ artisanId: L1, status: 'approved' });
    await db.doc(`artisans/${L2}`).set({ userType: 'artisan', name: 'Abena', category: 'Painting', status: 'active', verificationStatus: 'banned', banReason: 'Fraud (legacy)', bannedBy: 'old-admin@x.test' });
    await db.doc('bookings/v_leg_bk1').set({ customerId: CB, artisanId: L1, status: 'completed', completedAt: daysAgo(30), updatedAt: daysAgo(30), createdAt: daysAgo(31),
        serviceType: 'Electrical', address: '14 Legacy Road, Osu', lat: 5.55, lng: -0.18, customerPhone: '0551234567', proPhone: '0207777777' });
    await db.doc('bookings/v_leg_bk2').set({ customerId: CB, artisanId: L1, status: 'completed', completedAt: daysAgo(3), updatedAt: daysAgo(3), createdAt: daysAgo(4),
        serviceType: 'Electrical', address: '2 Recent Street, Labone', lat: 5.56, lng: -0.17 });
    const SECRETS = ['0207777777', 'kwame.legacy@fidusx.invalid', 'GHA-000000001-1', 'card photo unreadable', 'old-admin@x.test', 'internal note', 'Fraud (legacy)', '14 Legacy Road', '0551234567', '5.603717'];
    const leaks = (o) => SECRETS.filter((s) => JSON.stringify(o).includes(s));

    const deniedA = await call('adminMigrateArtisanPrivateData', { mode: 'strip' }, cTok);
    const deniedC = await call('adminMigrateContactPrivacy', { mode: 'strip' }, aTok);
    const deniedU = await call('adminMigrateContactPrivacy', {}, null);
    check('migrations', 'nobody but a verified super-admin can run either migration',
        deniedA.error && deniedC.error && deniedU.error && (await get(`artisans/${L1}`)).phone === '0207777777', { a: deniedA.error, c: deniedC.error, u: deniedU.error });
    const unverified = await user('v_admin_unv', 'paakumisam@gmail.com', { verified: false });
    const deniedV = await call('adminMigrateArtisanPrivateData', { mode: 'strip' }, unverified);
    check('migrations', 'an allow-listed email that is not verified cannot run it', deniedV.error && (await get(`artisans/${L1}`)).phone === '0207777777', deniedV.error);

    const dryA = (await call('adminMigrateArtisanPrivateData', {}, admTok)).result;
    const dryC = (await call('adminMigrateContactPrivacy', {}, admTok)).result;
    const legA = dryA && dryA.artisans.find((a) => a.artisanId === L1);
    check('migrations', 'dry run (the default): reports field names and counts, writes nothing',
        dryA && dryA.mode === 'dry-run' && legA && ['phone', 'email', 'ghanaCardNumber', 'rejectionReason', 'approvedBy'].every((f) => legA.fields.includes(f))
        && (await get(`artisans/${L1}`)).phone === '0207777777' && !(await get(`artisans/${L1}/private/contact`)) && !(await get('bookings/v_leg_bk1')).locationRetainUntilMs, { legA });
    check('migrations', 'dry run of the contact migration finds the legacy position, booking phones and old closed bookings',
        dryC && dryC.artisans.exposed >= 1 && dryC.bookings.exposed >= 1 && dryC.artisanPhones.exposed >= 1, dryC && { a: dryC.artisans, b: dryC.bookings, p: dryC.artisanPhones, r: Object.keys(dryC).filter((k) => !['artisans', 'bookings', 'artisanPhones', 'mode'].includes(k)).map((k) => [k, dryC[k]]) });
    check('migrations', 'no report contains a value it is protecting', leaks(dryA).length === 0 && leaks(dryC).length === 0, [leaks(dryA), leaks(dryC)]);
    fs.writeFileSync(path.join(path.dirname(NETLOG), 'dryrun-reports.json'), JSON.stringify({ artisanPrivateData: dryA, contactPrivacy: dryC }, null, 2));

    const copyA = (await call('adminMigrateArtisanPrivateData', { mode: 'copy' }, admTok)).result;
    const copyC = (await call('adminMigrateContactPrivacy', { mode: 'copy' }, admTok)).result;
    const priv = await get(`artisans/${L1}/private/contact`), kyc = await get(`artisans/${L1}/private/kyc`);
    check('migrations', 'copy fills the private records and leaves the public copies in place (the admin screens can be checked)',
        copyA && copyC && priv && priv.phone === '0207777777' && kyc && kyc.ghanaCardNumber === 'GHA-000000001-1' && (await get(`artisans/${L1}`)).phone === '0207777777', { priv: !!priv, kyc: !!kyc });
    const stripA = (await call('adminMigrateArtisanPrivateData', { mode: 'strip' }, admTok)).result;
    const stripC = (await call('adminMigrateContactPrivacy', { mode: 'strip' }, admTok)).result;
    const lp1 = await get(`artisans/${L1}`), lp2 = await get(`artisans/${L2}`);
    check('migrations', 'strip: nothing private is left on either public profile (the position stays only as a ~1 km copy, by design)',
        stripA && stripC && leaks(lp1).length === 0 && leaks(lp2).length === 0 && lp1.currentLat == null && lp1.currentLng == null && lp1.locationAccuracy == null, { p1: leaks(lp1), p2: leaks(lp2), coarse: [lp1.currentLat, lp1.currentLng] });
    check('migrations', 'nothing was lost: every value is in its private home',
        (await get(`verification_requests/${L1}`)).rejectionReason === 'Earlier: card photo unreadable' && (await get(`verification_requests/${L1}`)).approvedBy === 'old-admin@x.test'
        && (await get(`artisans/${L2}/private/decisionLegacy`)).banReason === 'Fraud (legacy)' && !(await get(`verification_requests/${L2}`))
        && (await get(`artisans/${L1}/private/kyc`)).payoutAccount.phone === '0207777777' && (await get('bookings/v_leg_bk1/private/contact')).customerPhone === '0551234567');
    const bk1 = await get('bookings/v_leg_bk1'), bk2 = await get('bookings/v_leg_bk2');
    check('migrations', 'old closed bookings get the 14-day clock from their close date; the hourly sweep moves the address',
        bk1.locationRetainUntilMs && Math.abs(bk1.locationRetainUntilMs - (Date.parse(bk1.completedAt) + 14 * 864e5)) < 864e5 && bk2.locationRetainUntilMs > Date.now(), { bk1: bk1.locationRetainUntilMs, bk2: bk2.locationRetainUntilMs });
    check('migrations', 'the booking phone numbers left the booking documents', !('customerPhone' in bk1) && !('proPhone' in bk1), Object.keys(bk1));
    const again1 = (await call('adminMigrateArtisanPrivateData', { mode: 'strip' }, admTok)).result;
    const again2 = (await call('adminMigrateContactPrivacy', { mode: 'strip' }, admTok)).result;
    check('migrations', 'running strip again finds nothing left to do',
        again1 && !again1.artisans.some((a) => [L1, L2].includes(a.artisanId)) && again2 && again2.artisans.exposed === 0 && again2.bookings.exposed === 0 && again2.artisanPhones.exposed === 0, { a: again1 && again1.artisans.map((a) => a.artisanId), c: again2 && [again2.artisans.exposed, again2.bookings.exposed, again2.artisanPhones.exposed] });
    fs.writeFileSync(path.join(path.dirname(NETLOG), 'migration-reports.json'), JSON.stringify({ copyA, copyC, stripA, stripC, again1, again2 }, null, 2));

    // ═══ E. What the functions tried to reach ═══
    console.log('\nE. Network\n');
    const lines = netLines().filter((l) => l.event !== 'preload');
    const byHost = {};
    for (const l of lines) { const k = `${l.host} ${l.answered}`; byHost[k] = (byHost[k] || 0) + 1; }
    // firebase-tools itself (the CLI process, not a function) pings its analytics and npm's update check.
    const CLI_HOSTS = new Set(['www.google-analytics.com', 'registry.npmjs.org']);
    const blockedFromFunctions = lines.filter((l) => l.answered === 'BLOCKED' && !CLI_HOSTS.has(l.host));
    const cliBlocked = lines.filter((l) => l.answered === 'BLOCKED' && CLI_HOSTS.has(l.host));
    check('network', 'the only blocked calls were the emulator CLI’s own (analytics, npm update check), from processes that ran no function', cliBlocked.every((l) => !lines.some((m) => m.pid === l.pid && m.host === 'api.paystack.co')), [...new Set(cliBlocked.map((l) => l.pid))]);
    check('network', 'nothing a function did left this machine (every outside call was answered locally)', blockedFromFunctions.length === 0, blockedFromFunctions.slice(0, 5));
    check('network', 'every Paystack call carried the dummy key', lines.filter((l) => l.host === 'api.paystack.co').every((l) => l.keyKind === 'sk_test_'), [...new Set(lines.filter((l) => l.host === 'api.paystack.co').map((l) => l.keyKind))]);
    console.log('  outside calls by host:', JSON.stringify(byHost));

    const failed = results.filter((r) => !r.ok);
    console.log(`\nfunctions-emulator verification: ${results.length - failed.length} passed, ${failed.length} failed`);
    fs.writeFileSync(path.join(path.dirname(NETLOG), 'verify-results.json'), JSON.stringify({ results, byHost }, null, 2));
    process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('VERIFY CRASHED', e); process.exit(2); });
