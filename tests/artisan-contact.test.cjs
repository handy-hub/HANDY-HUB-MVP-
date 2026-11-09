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

await t('artisan onboarding: phone and email go to private/contact, not the public profile', async () => {
    // Phase 5: onboarding sends what artisan-app/js/onboarding.js builds — the
    // submission batch and each step's saved draft. Run it rather than read it.
    const { pathToFileURL } = require('url');
    const ob = await import(pathToFileURL(path.join(ROOT, 'artisan-app/js/onboarding.js')).href);
    const v = { ...ob.emptyValues(), firstName: 'Kofi', lastName: 'Boateng', phone: '024 123 4567', dob: '1990-04-12',
        address: 'Accra', pin: { lat: 5.6037, lng: -0.1869 }, ghanaCard: 'GHA-123456789-0', trade: 'Plumbing',
        bio: 'x'.repeat(60), experience: '5', radius: 10, payProvider: 'mtn', payNumber: '0241111111', payName: 'Kofi' };
    const n = '2026-11-09T00:00:00.000Z';
    const sent = ob.submissionWrites({ uid: 'art_1', email: 'k@example.com', v, docUrls: {}, nowIso: n });
    const drafts = ['you', 'work'].flatMap((s) => ob.draftWrites(s, { uid: 'art_1', email: 'k@example.com', v, emailVerified: true, nowIso: n }).writes);
    for (const writes of [sent, drafts]) {
        const contact = writes.find((w) => w.path === 'artisans/art_1/private' && w.id === 'contact');
        assert.deepStrictEqual(contact.data, { artisanId: 'art_1', phone: '0241234567', email: 'k@example.com', updatedAt: n });
        for (const w of writes.filter((x) => x.path === 'artisans')) {
            for (const k of ['email', 'phone', 'phoneNumber', 'contactEmail', 'whatsapp']) assert.ok(!(k in w.data), `the public profile carries ${k}`);
        }
    }
    assert.match(read('artisan-app/onboarding.html'), /databaseService\.commitBatch\(submissionWrites\(/, 'the page sends those writes');
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

console.log('\n── CONTACT-001 · the admin dashboard ──\n');

await t('admin artisans: list, search, drawer and CSV read private/contact (legacy profile values as fallback)', () => {
    const s = read('admin-dashboard/artisans.html');
    assert.match(s, /getDoc\(doc\(db, 'artisans', id, 'private', 'contact'\)\)/);
    assert.match(s, /return \{ phone: c\.phone \|\| a\.phone \|\| '', email: c\.email \|\| a\.email \|\| '' \};/);
    const rest = s.replace(/const contactOf = [\s\S]*?\n\};/, '');
    assert.ok(!/\ba\.(phone|email)\b/.test(rest), 'a direct read of the public phone/email remains');
    assert.match(between(s, 'window.exportCSV', '\n};'), /contactOf\(a\)\.email,contactOf\(a\)\.phone/);
    assert.match(s, /loadContacts\(allArtisans\.map\(a => a\.id\)\)\.then\(added => \{ if \(added\) applyAndRender\(\); \}\)/);
});

console.log('\n── CONTACT-001 · the migration (dry-run → copy → strip) ──\n');

const privacy = require(path.join(FN, 'artisanPrivacy.js'));
const contactMig = require(path.join(FN, 'contactPrivacy.js'));
const migrate = (mode, extra) => privacy.migrateArtisanPrivateData({ mode, ...extra });
const PHONE = '+233201234567', EMAIL = 'kofi@example.com';
const VALUES = [PHONE, EMAIL, '0559998888', 'not an email', 'ama@example.com'];
const noValues = (r) => { const j = JSON.stringify(r); for (const v of VALUES) assert.ok(!j.includes(v), `report leaks a value`); };
const legacyArtisan = (id, extra = {}) => fake.db._set(`artisans/${id}`,
    { id, userType: 'artisan', name: 'Kofi Boateng', category: 'plumbing', phone: PHONE, email: EMAIL, ...extra });

await t('the migration and firestore.rules name exactly the same contact fields', () => {
    const m = read('firestore.rules').match(/function artisanContactFields\(\)\s*\{\s*return\s*\[([^\]]*)\]/);
    assert.ok(m, 'artisanContactFields() not found');
    assert.deepStrictEqual(m[1].match(/'([^']+)'/g).map((x) => x.slice(1, -1)).sort(), [...privacy.CONTACT_FIELDS].sort());
});
await t('dry run: writes nothing, names the contact fields, reports no values', async () => {
    fake.db._reset(); legacyArtisan('a1');
    const before = JSON.stringify(fake.db._get('artisans/a1'));
    const r = await migrate('dry-run');
    assert.strictEqual(JSON.stringify(fake.db._get('artisans/a1')), before);
    assert.ok(!fake.db._has('artisans/a1/private/contact'));
    assert.deepStrictEqual(r.artisans[0].wouldCopy.sort(), ['email', 'phone']);
    noValues(r);
});
await t('copy: private/contact gets phone and email; the public profile still has them', async () => {
    fake.db._reset(); legacyArtisan('a1');
    await migrate('copy');
    const c = fake.db._get('artisans/a1/private/contact');
    assert.deepStrictEqual({ phone: c.phone, email: c.email, artisanId: c.artisanId }, { phone: PHONE, email: EMAIL, artisanId: 'a1' });
    assert.strictEqual(fake.db._get('artisans/a1').phone, PHONE, 'copy never strips');
    assert.ok(!fake.db._has('artisans/a1/private/kyc'), 'contact details do not go to kyc');
});
await t('strip: the profile loses them only once private/contact holds them; everything else stays', async () => {
    fake.db._reset(); legacyArtisan('a1');
    const r = await migrate('strip');
    const p = fake.db._get('artisans/a1');
    for (const f of privacy.CONTACT_FIELDS) assert.ok(!(f in p), f);
    assert.strictEqual(p.name, 'Kofi Boateng'); assert.strictEqual(p.category, 'plumbing');
    assert.strictEqual(fake.db._get('artisans/a1/private/contact').phone, PHONE);
    noValues(r);
});
await t('an existing private/contact is never overwritten (the newer value wins, conflict reported)', async () => {
    fake.db._reset(); legacyArtisan('a1');
    fake.db._set('artisans/a1/private/contact', { artisanId: 'a1', phone: '0559998888' });
    const r = await migrate('strip');
    const c = fake.db._get('artisans/a1/private/contact');
    assert.strictEqual(c.phone, '0559998888');
    assert.strictEqual(c.email, EMAIL, 'the empty email slot is filled');
    assert.deepStrictEqual(r.artisans[0].conflicts, ['phone']);
    assert.strictEqual(fake.db._get('artisans/a1/private/contactLegacy').phone, PHONE, 'the older number is kept, privately');
    assert.ok(!('phone' in fake.db._get('artisans/a1')));
});
await t('aliases fill an empty slot only when valid; the rest go to private/contactLegacy, and contact stays rule-valid', async () => {
    fake.db._reset();
    fake.db._set('artisans/a2', { id: 'a2', userType: 'artisan', name: 'Ama',
        phoneNumber: PHONE, whatsapp: '0559998888', contactEmail: 'not an email', email: '' });
    await migrate('strip');
    const c = fake.db._get('artisans/a2/private/contact');
    assert.deepStrictEqual(Object.keys(c).filter((k) => !['artisanId', 'createdAt', 'updatedAt'].includes(k)), ['phone']);
    assert.strictEqual(c.phone, PHONE);
    const kept = fake.db._get('artisans/a2/private/contactLegacy');
    assert.deepStrictEqual({ whatsapp: kept.whatsapp, contactEmail: kept.contactEmail }, { whatsapp: '0559998888', contactEmail: 'not an email' });
    assert.ok(!('email' in kept), 'an empty placeholder is not kept');
    for (const f of privacy.CONTACT_FIELDS) assert.ok(!(f in fake.db._get('artisans/a2')), f);
});
await t('idempotent: a second strip finds nothing; an already-migrated artisan is skipped', async () => {
    fake.db._reset(); legacyArtisan('a1');
    await migrate('strip');
    const snap = JSON.stringify([fake.db._get('artisans/a1'), fake.db._get('artisans/a1/private/contact')]);
    const r = await migrate('strip');
    assert.strictEqual(r.affected, 0);
    assert.strictEqual(JSON.stringify([fake.db._get('artisans/a1'), fake.db._get('artisans/a1/private/contact')]), snap);
});
await t('a profile whose KYC was already copied (the production state) gets its contact moved too', async () => {
    fake.db._reset(); legacyArtisan('a1', { ghanaCardNumber: 'GHA-1' });
    fake.db._set('artisans/a1/private/kyc', { artisanId: 'a1', ghanaCardNumber: 'GHA-1' });
    const r = await migrate('copy');
    assert.deepStrictEqual(r.artisans[0].copied.sort(), ['email', 'phone'], 'KYC is not re-copied');
    assert.strictEqual(fake.db._get('artisans/a1/private/kyc').ghanaCardNumber, 'GHA-1');
});

console.log('\n── CONTACT-001 · the migration of booking copies ──\n');

const seedBooking = (id, extra) => fake.db._set(`bookings/${id}`, { customerId: 'c1', artisanId: 'art_1', status: 'completed', ...extra });
await t('dry run: names the bookings carrying an artisan phone; writes nothing; no values', async () => {
    fake.db._reset();
    seedBooking('B1', { proPhone: PHONE });
    seedBooking('B2', { artisan: { id: 'art_1', name: 'Kofi', phone: PHONE } });
    seedBooking('B3', {});
    const r = await contactMig.migrateContactPrivacy({ mode: 'dry-run' });
    assert.deepStrictEqual(r.artisanPhones.ids.sort(), ['B1', 'B2']);
    assert.ok(!fake.db._has('bookings/B1/private/artisanContact'));
    noValues(r);
});
await t('strip: every copy leaves the booking, nested maps keep their other fields, the phone lands in artisanContact', async () => {
    fake.db._reset();
    seedBooking('B1', { proPhone: PHONE, artisan: { id: 'art_1', name: 'Kofi', phone: PHONE },
        professional: { id: 'art_1', name: 'Kofi', phone: `tel:${PHONE}` } });
    await contactMig.migrateContactPrivacy({ mode: 'strip' });
    const b = fake.db._get('bookings/B1');
    assert.ok(!('proPhone' in b));
    assert.deepStrictEqual(b.artisan, { id: 'art_1', name: 'Kofi' });
    assert.deepStrictEqual(b.professional, { id: 'art_1', name: 'Kofi' });
    const c = fake.db._get('bookings/B1/private/artisanContact');
    assert.deepStrictEqual({ artisanId: c.artisanId, artisanPhone: c.artisanPhone }, { artisanId: 'art_1', artisanPhone: PHONE }, 'tel: prefix removed');
});
await t('the accept trigger\'s artisanContact is never overwritten; a re-run does nothing', async () => {
    fake.db._reset();
    seedBooking('B1', { proPhone: '0559998888' });
    fake.db._set('bookings/B1/private/artisanContact', { bookingId: 'B1', artisanId: 'art_1', artisanPhone: PHONE });
    await contactMig.migrateContactPrivacy({ mode: 'strip' });
    assert.strictEqual(fake.db._get('bookings/B1/private/artisanContact').artisanPhone, PHONE);
    assert.ok(!('proPhone' in fake.db._get('bookings/B1')));
    const r = await contactMig.migrateContactPrivacy({ mode: 'strip' });
    assert.strictEqual(r.artisanPhones.exposed, 0);
});

console.log(`\nartisan-contact: ${passed} passed, ${failed} failed`);
for (const [name, e] of failures) console.log(`\n  ✗ ${name}\n    ${e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n    ') : e}`);
process.exit(failed ? 1 : 0);
})();
