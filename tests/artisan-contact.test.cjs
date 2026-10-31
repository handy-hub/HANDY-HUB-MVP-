'use strict';
/**
 * tests/artisan-contact.test.cjs — CONTACT-001 (user decision): an artisan's
 * phone and email are never public; a customer gets the phone only inside a
 * booking's window. The REAL functions/*.js run against fake-firebase.
 *
 *   • new profiles (ensureArtisanProfile, the OTP signup) put phone and email in
 *     artisans/{uid}/private/contact, never on the public artisans/{uid};
 *   • on acceptance, onBookingStatusChanged writes the phone to
 *     bookings/{id}/private/artisanContact (read through contactDisclosed in
 *     firestore.rules — proven in tests/privacy-access-rules.test.mjs), and
 *     never onto the booking document itself.
 */
require('./support/no-production.cjs');   // must stay the first statement (npm run lint:tests)

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const fake = require('./support/fake-firebase.cjs').install();
const ROOT = path.join(__dirname, '..');
const FN   = path.join(ROOT, 'functions');
const artisanAccount = require(path.join(FN, 'artisanAccount.js'));
const bookings       = require(path.join(FN, 'bookings.js'));

let passed = 0, failed = 0;
const failures = [];
async function t(name, fn) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { failed++; failures.push([name, e]); console.log(`  ✗ ${name}`); }
}

const CONTACT = ['phone', 'email', 'phoneNumber', 'contactEmail', 'whatsapp'];

(async () => {
console.log('\n── CONTACT-001 · new profiles keep contact details private ──\n');

await t('ensureArtisanProfile: the public profile has no phone/email; private/contact has them', async () => {
    fake.db._reset();
    const res = await artisanAccount.ensureArtisanProfile({
        uid: 'a_new', token: { email: 'kofi@example.com', name: 'Kofi Boateng', phone_number: '+233201234567', email_verified: true },
    });
    assert.strictEqual(res.result, 'created');
    const pub = fake.db._get('artisans/a_new');
    for (const f of CONTACT) assert.ok(!(f in pub), `public profile carries ${f}`);
    const priv = fake.db._get('artisans/a_new/private/contact');
    assert.deepStrictEqual({ artisanId: priv.artisanId, email: priv.email, phone: priv.phone },
        { artisanId: 'a_new', email: 'kofi@example.com', phone: '+233201234567' });
});
await t('baseArtisanProfile itself carries no contact field (every caller is covered)', () => {
    const p = artisanAccount.baseArtisanProfile({ uid: 'u', email: 'e@x.co', name: 'K', phone: '024' }, 't');
    for (const f of CONTACT) assert.ok(!(f in p), f);
});
await t('the OTP signup writes the artisan doc without phone/email and private/contact with them', () => {
    const src = fs.readFileSync(path.join(FN, 'emailOtp.js'), 'utf8');
    const doc = src.slice(src.indexOf('const artisanDoc = {'), src.indexOf('if (specialtyDesc) artisanDoc.requestedService'));
    assert.ok(doc.length > 100, 'artisanDoc not found');
    assert.ok(!/\b(email|phone)\s*:/.test(doc), 'artisanDoc still carries email/phone');
    assert.match(src, /batch\.set\(db\(\)\.collection\('artisans'\)\.doc\(uid\)\.collection\('private'\)\.doc\('contact'\), \{\s*artisanId: uid,\s*email:/);
});

console.log('\n── CONTACT-001 · the phone reaches the customer only through the booking ──\n');

async function accept({ privatePhone, publicPhone } = {}) {
    fake.db._reset();
    fake.db._set('artisans/art_1', { userType: 'artisan', fullName: 'Kofi Boateng', verificationStatus: 'approved',
        ...(publicPhone ? { phone: publicPhone } : {}) });
    if (privatePhone) fake.db._set('artisans/art_1/private/contact', { artisanId: 'art_1', phone: privatePhone, email: 'k@x.co' });
    const before = { customerId: 'cust_1', status: 'pending', serviceType: 'plumbing', track: 'standard' };
    const after  = { ...before, status: 'accepted', artisanId: 'art_1' };
    fake.db._set('bookings/BK1', after);
    await bookings.onBookingStatusChanged({
        params: { bookingId: 'BK1' },
        data: { before: { data: () => before }, after: { data: () => after } },
    });
    return { booking: fake.db._get('bookings/BK1'), contact: fake.db._get('bookings/BK1/private/artisanContact') };
}

await t('on acceptance the artisan\'s phone goes to bookings/{id}/private/artisanContact', async () => {
    const { contact } = await accept({ privatePhone: '+233209999999' });
    assert.deepStrictEqual({ bookingId: contact.bookingId, artisanId: contact.artisanId, artisanPhone: contact.artisanPhone },
        { bookingId: 'BK1', artisanId: 'art_1', artisanPhone: '+233209999999' });
});
await t('…and never onto the booking document itself', async () => {
    const { booking } = await accept({ privatePhone: '+233209999999' });
    for (const k of ['proPhone', 'artisanPhone', 'phone']) assert.ok(!(k in booking), k);
    assert.strictEqual(booking.artisanName, 'Kofi Boateng', 'the identity stamp still runs');
});
await t('a legacy profile not yet migrated: the public phone is used, still only in the private record', async () => {
    const { contact, booking } = await accept({ publicPhone: '0241112222' });
    assert.strictEqual(contact.artisanPhone, '0241112222');
    assert.ok(!('artisanPhone' in booking));
});
await t('the private record wins over a stale public copy', async () => {
    const { contact } = await accept({ privatePhone: '+233209999999', publicPhone: '0240000000' });
    assert.strictEqual(contact.artisanPhone, '+233209999999');
});
await t('no phone anywhere → no artisanContact record (nothing invented)', async () => {
    const { contact } = await accept({});
    assert.strictEqual(contact, undefined);
});

console.log('\n── CONTACT-001 · the clients ──\n');

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const between = (s, a, b) => { const i = s.indexOf(a); assert.ok(i >= 0, `missing: ${a}`); const j = s.indexOf(b, i + a.length); return s.slice(i, j < 0 ? undefined : j); };
const READS_CONTACT = /getDocument\(`bookings\/\$\{[^}]+\}\/private`,\s*'artisanContact'\)/;

await t('artisan onboarding: phone and email go to private/contact, not the public profile', () => {
    const s = read('artisan-app/onboarding.html');
    assert.match(s, /setDocument\(`artisans\/\$\{uid\}\/private`, 'contact', \{\s*artisanId: uid,/);
    const pub = between(s, "await databaseService.setDocument('artisans', uid, {", '}, { merge: true });');
    assert.ok(!/^\s*(email|phone)\s*[,:]/m.test(pub), 'the public profile still carries email/phone');
});
await t('artisan Settings: the phone is read from and saved to private/contact only', () => {
    const s = read('artisan-app/settings.html');
    assert.match(s, /getDocument\(`artisans\/\$\{user\.uid\}\/private`, 'contact'\)/);
    assert.match(s, /setDocument\(`artisans\/\$\{user\.uid\}\/private`, 'contact', patch, \{ merge: true \}\)/);
    assert.ok(!/updateDocument\('artisans', user\.uid, \{[^}]*phone/.test(s));
});
await t('customer artisan profile: no Call button, and the booking hand-off carries no phone', () => {
    const s = read('customer-app/artisan-profile.html');
    assert.ok(!/hero-call-btn|tel:/.test(s));
    assert.ok(!/phone:\s*a\.phone/.test(s));
    assert.match(s, /id="hero-msg-btn"/, 'Message stays');
});
await t('customer pages never read an artisan phone from a profile, a booking or the cache', () => {
    for (const [f, re] of [
        ['customer-app/book-emergency.html', /d\.phone|phone:\s*d\./],
        ['customer-app/live-tracking.html',  /pro\.phone/],
        ['customer-app/booking.html',        /proPhone/],
        ['customer-app/messages.html',       /d\.phone|info\.phone/],
        ['customer-app/professionals.html',  /phone:\s*d\.phone/],
        ['shared/js/services/bookingService.js',      /proPhone/],
        ['shared/js/utils/bookingConfirmNotify.js',   /proPhone/],
        ['customer-app/js/authInit.js',               /proPhone/],
    ]) assert.ok(!re.test(read(f)), `${f} still reads ${re}`);
});
await t('artisanRepository.upsert() never writes a phone or email onto the public profile', () => {
    const s = read('shared/js/data/repositories/artisanRepository.js');
    const payload = between(s, 'async upsert(', '\n        },');
    assert.ok(payload.length > 200, 'upsert() not found');
    assert.ok(!/\b(phone|email|phoneNumber|contactEmail|whatsapp)\s*:/.test(payload), 'upsert() writes a contact field');
});
await t('the Call buttons read the booking\'s private/artisanContact', () => {
    assert.match(read('customer-app/book-emergency.html'), READS_CONTACT);
    assert.match(between(read('customer-app/live-tracking.html'), 'async function callArtisan()', '\n}\n'), READS_CONTACT);
    const ms = between(read('customer-app/messages.html'), 'window.callConversation = async function()', '\n};');
    assert.match(ms, READS_CONTACT);
    assert.match(ms, /_bookingCtx\.artisanId === currentOtherUid/, 'only for the artisan on this thread\'s booking');
});

console.log(`\nartisan-contact: ${passed} passed, ${failed} failed`);
for (const [name, e] of failures) console.log(`\n  ✗ ${name}\n    ${e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n    ') : e}`);
process.exit(failed ? 1 : 0);
})();
