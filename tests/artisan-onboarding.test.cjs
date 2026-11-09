'use strict';
/**
 * tests/artisan-onboarding.test.cjs — the professional's application (Phase 5).
 *
 * Runs artisan-app/js/onboarding.js, which decides what each step requires,
 * where a returning artisan resumes, what is saved and what is sent, and checks
 * that artisan-app/onboarding.html carries those decisions out. What the rules
 * make of the writes is tests/onboarding-rules.test.mjs (emulator); the
 * rendered page is tests/e2e/artisan_onboarding.py.
 *
 * Findings from the Phase 5 inspection this pins:
 *   · no resume, no prefill: a rejected artisan got an empty form and never
 *     saw the reason;
 *   · a second tap could submit twice (the button was disabled only after the
 *     first await);
 *   · five sequential writes: a failure part-way left a profile "under review"
 *     with no request for a reviewer;
 *   · a resubmission after a rejection was refused by the rules (the request
 *     kept verificationStatus 'rejected');
 *   · upload boxes were divs with onclick (no keyboard, no screen reader);
 *   · promises the product does not keep ("1–2 business days", "within 24
 *     hours", "within 48 hrs", the TIN tax threshold), a "VDF" label, 50 and
 *     100 km radii dispatch never searches, and years of experience stored as
 *     buckets ("10+ years" became 15 on the customer's screen).
 */
require('./support/no-production.cjs');   // must stay the first statement (npm run lint:tests)

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');
const page = read('artisan-app/onboarding.html');
const script = /<script type="module">([\s\S]*?)<\/script>/.exec(page)[1];
const markup = page.replace(/<script[\s\S]*?<\/script>/g, '');

let passed = 0, failed = 0;
const failures = [];
async function t(name, fn) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { failed++; failures.push([name, e]); console.log(`  ✗ ${name}`); }
}

const NOW = Date.parse('2026-11-09T12:00:00Z');
const NOW_ISO = new Date(NOW).toISOString();
const UID = 'art_1';

(async () => {
    const ob = await import(pathToFileURL(path.join(ROOT, 'artisan-app/js/onboarding.js')).href);
    const trades = await import(pathToFileURL(path.join(ROOT, 'shared/js/domain/artisanTrades.js')).href);
    const catalog = await import(pathToFileURL(path.join(ROOT, 'shared/js/data/serviceCatalog.js')).href);

    const STORED = { state: 'stored', url: 'https://storage.example/x' };
    const DOCS_OK = { selfie: { state: 'stored' }, idFront: STORED, idBack: STORED, bizReg: { state: 'none' }, cert: { state: 'none' } };
    const complete = (over = {}) => ({
        ...ob.emptyValues(),
        firstName: 'Kofi', lastName: 'Boateng', phone: '024 123 4567', gender: 'male', dob: '1990-04-12',
        address: '12 Example Street, Accra', gpsAddress: 'ga-123-4567', emergencyName: 'Ama', emergencyPhone: '0201112222',
        pin: { lat: 5.603716, lng: -0.186964, accuracy: 18, setAt: '2026-11-09T11:00:00.000Z' },
        ghanaCard: 'gha 123456789 0', tin: '',
        trade: 'Plumbing', skills: ['Fix Leaking Pipe'], bio: 'Plumber in Accra for twelve years: leaks, toilets, water heaters.',
        experience: '12', radius: 10, baseRate: '', days: ['Mon', 'Sat'],
        payProvider: 'mtn', payNumber: '0241111111', payName: 'Kofi Boateng', terms: true,
        ...over,
    });
    const problems = (step, v, d = DOCS_OK) => ob.stepProblems(step, v, d, { now: NOW });

    console.log('\n── The steps and their checks ──\n');

    await t('five steps in order; the last is the review', () => {
        assert.deepStrictEqual(ob.STEP_IDS, ['you', 'identity', 'work', 'payout', 'review']);
        for (const id of ob.STEP_IDS) assert.match(page, new RegExp(`id="ob-step-${id}" data-step="${id}"`), `${id} has its section`);
    });

    await t('a complete application has no problems on any step', () => {
        assert.deepStrictEqual(ob.applicationProblems(complete(), DOCS_OK, { now: NOW }), []);
    });

    await t('about you: names, a Ghana mobile number, 18 or older, an address, the work pin and a photo are required', () => {
        const p = problems('you', ob.emptyValues(), {});
        assert.deepStrictEqual(Object.keys(p).sort(), ['address', 'dob', 'firstName', 'lastName', 'phone', 'pin', 'selfie']);
        assert.strictEqual(problems('you', complete({ phone: '12345' })).phone, 'Enter a Ghana mobile number, like 024 123 4567.');
        assert.strictEqual(problems('you', complete({ phone: '+233 24 123 4567' })).phone, undefined);
        assert.strictEqual(problems('you', complete({ dob: '2008-11-10' })).dob, 'You must be 18 or older to work on Fidus X.', 'one day short of 18');
        assert.strictEqual(problems('you', complete({ dob: '2008-11-09' })).dob, undefined, '18 today');
        assert.strictEqual(problems('you', complete({ dob: '2001-02-30' })).dob, 'Enter a real date.');
        assert.strictEqual(problems('you', complete({ emergencyPhone: '999' })).emergencyPhone, 'Enter a Ghana mobile number, or leave this empty.');
        assert.strictEqual(problems('you', complete({ emergencyName: '', emergencyPhone: '' })).emergencyPhone, undefined, 'the emergency contact is optional');
        assert.strictEqual(problems('you', complete(), { ...DOCS_OK, selfie: { state: 'picked' } }).selfie, undefined, 'a picked photo counts');
    });

    await t('identity: the Ghana Card number in any common typing, and both sides of the card', () => {
        assert.strictEqual(ob.normaliseGhanaCard('gha-123456789-0'), 'GHA-123456789-0');
        assert.strictEqual(ob.normaliseGhanaCard('GHA 1234567890'), 'GHA-123456789-0');
        assert.strictEqual(ob.normaliseGhanaCard('GHA-12345678-0'), '');
        assert.strictEqual(problems('identity', complete({ ghanaCard: 'GH-1' })).ghanaCard, 'Enter it as on the card: GHA-123456789-0.');
        const p = problems('identity', complete(), { idFront: { state: 'none' }, idBack: { state: 'none' } });
        assert.ok(p.idFront && p.idBack);
        assert.strictEqual(problems('identity', complete({ tin: '' })).tin, undefined, 'TIN is optional');
    });

    await t('work: a listed trade, or Other with a description and the closest listed trade (the server\'s rule and words)', () => {
        assert.strictEqual(problems('work', complete({ trade: '' })).trade, 'Choose your trade.');
        assert.strictEqual(problems('work', complete({ trade: 'Tiling' })).trade, 'Choose your trade.', 'a retired trade is not accepted');
        const other = problems('work', complete({ trade: 'Other', otherDesc: '', otherBucket: '' }));
        assert.strictEqual(other.otherDesc, 'Describe your trade.');
        assert.strictEqual(other.otherBucket, 'Choose the listed trade closest to yours.');
        const emailOtp = read('functions/emailOtp.js');
        assert.ok(emailOtp.includes("'Describe your trade.'") && emailOtp.includes("'Choose the listed trade closest to yours.'"), 'same words as the server');
    });

    await t('work: a 50-character bio, whole years 0–60, a radius dispatch honours, an optional rate', () => {
        assert.strictEqual(problems('work', complete({ bio: 'Short' })).bio, 'Write at least 50 characters (5 so far).');
        assert.strictEqual(problems('work', complete({ experience: '' })).experience, 'Enter your years of experience.');
        assert.strictEqual(problems('work', complete({ experience: '61' })).experience, 'Enter a whole number of years, 0 to 60.');
        assert.strictEqual(problems('work', complete({ experience: '0' })).experience, undefined, 'less than a year is 0');
        assert.strictEqual(problems('work', complete({ radius: 50 })).radius, 'Choose how far you will travel.');
        assert.strictEqual(problems('work', complete({ baseRate: 'abc' })).baseRate, 'Enter an amount in cedis, or leave this empty.');
        assert.strictEqual(problems('work', complete({ baseRate: '80' })).baseRate, undefined);
    });

    await t('the radius choices are Settings\' choices, and none is beyond dispatch\'s 25 km net', () => {
        const settings = read('artisan-app/settings.html');
        assert.match(settings, /const RADIUS_CHOICES = \[5, 10, 15, 20, 25\];/);
        assert.deepStrictEqual([...ob.RADIUS_CHOICES], [5, 10, 15, 20, 25]);
        assert.match(read('functions/dispatch.js'), /25 km cast net/);
        assert.strictEqual(ob.radiusChoice(100), 25, 'a stored 100 km becomes the widest real choice');
        assert.strictEqual(ob.radiusChoice(undefined), 10);
    });

    await t('payout: a provider from the shared MoMo list, a Ghana number and the account name', () => {
        assert.deepStrictEqual(ob.PAYOUT_PROVIDERS.map((p) => p.id), ['mtn', 'telecel', 'airteltigo']);
        assert.deepStrictEqual(ob.PAYOUT_PROVIDERS.map((p) => p.name), ['MTN Mobile Money', 'Telecel Cash', 'AirtelTigo Money']);
        const p = problems('payout', complete({ payProvider: 'vdf', payNumber: '12', payName: '' }));
        assert.deepStrictEqual(Object.keys(p).sort(), ['payName', 'payNumber', 'payProvider']);
    });

    await t('review: the agreement is required and starts unticked', () => {
        assert.strictEqual(problems('review', complete({ terms: false })).terms, 'Agree to the Terms of Service and Privacy Policy to send your application.');
        assert.strictEqual(ob.prefill({ profile: { name: 'A B' } }).terms, false);
        assert.ok(!/id="ob-terms"[^>]*\bchecked\b/.test(markup));
    });

    await t('a file is refused here for what storage.rules refuse: type and 5 MB', () => {
        assert.strictEqual(ob.fileProblem({ type: 'image/jpeg', size: 1000 }, { image: true }), null);
        assert.strictEqual(ob.fileProblem({ type: 'application/pdf', size: 1000 }), null);
        assert.strictEqual(ob.fileProblem({ type: 'application/pdf', size: 1000 }, { image: true }), 'Choose a photo (JPG or PNG).');
        assert.strictEqual(ob.fileProblem({ type: 'image/png', size: 6 * 1024 * 1024 }), 'Choose a file under 5 MB.');
        const storage = read('storage.rules');
        assert.match(storage, /request\.resource\.size <= 5 \* 1024 \* 1024/);
    });

    console.log('\n── Skills come from what customers book ──\n');

    await t('each trade offers the catalogue\'s own services; chosen ones are never dropped', () => {
        for (const trade of trades.ARTISAN_TRADES) {
            const names = catalog.getCategoryByLabel(trade).services.map((s) => s.name);
            assert.deepStrictEqual(ob.skillChoices(trade), names, trade);
        }
        assert.ok(ob.skillChoices('Plumbing', ['Pipe Repair']).includes('Pipe Repair'), 'a legacy choice stays visible');
        assert.deepStrictEqual(ob.skillChoices('', []), []);
    });

    console.log('\n── Where the application stands: the server\'s word ──\n');

    await t('phase: draft → fill; rejected / re-verification → fix; submitted or anything unknown → review; approved', () => {
        const ph = (vs) => ob.applicationPhase({ verificationStatus: vs });
        assert.deepStrictEqual(['', 'draft', 'rejected', 're_verification_required', 'pending_review', 'submitted', 'pending', 'approved'].map(ph),
            ['fill', 'fill', 'fix', 'fix', 'review', 'review', 'review', 'approved']);
    });

    await t('a rejection shows the reviewer\'s reason; a request for information shows the notes; none says so', () => {
        const r = ob.fixNotice({ verificationStatus: 'rejected' }, { rejectionReason: '  The card photo is blurred. ' });
        assert.deepStrictEqual(r, { title: 'Your application needs changes', reason: 'The card photo is blurred.', recorded: true });
        const m = ob.fixNotice({ verificationStatus: 're_verification_required' }, { infoRequestNotes: 'Add the back of the card.' });
        assert.strictEqual(m.title, 'Fidus X needs more information');
        assert.strictEqual(m.reason, 'Add the back of the card.');
        const none = ob.fixNotice({ verificationStatus: 'rejected' }, {});
        assert.strictEqual(none.recorded, false);
        assert.match(none.reason, /No reason was recorded/);
    });

    await t('the page never decides approval: approved goes to Today, review shows the waiting screen', () => {
        assert.match(script, /if \(profile\.verificationStatus === 'approved'\) \{ window\.location\.href = 'dashboard\.html'; return; \}/);
        assert.match(script, /if \(phase === 'review'\) \{ showDone\('review'\); return; \}/);
        assert.ok(!/verificationStatus:\s*'approved'|isVerified|status:\s*'active'/.test(script + read('artisan-app/js/onboarding.js')),
            'nothing on this screen names an approved, verified or active state');
    });

    await t('a failed or empty read is not "nothing sent": no form, a retry (FLOW-004)', () => {
        assert.match(script, /if \(!profile\) \{\s*\$\('ob-loading'\)\.hidden = true;\s*notice\(\$\('ob-alert'\), 'warn', \{ title: "Can't reach the server"/);
        const loadAt = script.indexOf('async function load()');
        const formShown = script.indexOf("$('ob-form').hidden = false", loadAt);
        assert.ok(script.indexOf('if (!profile) {', loadAt) < formShown, 'the form is shown only after a profile was read');
    });

    console.log('\n── Resuming ──\n');

    await t('prefill reads every step back from the account\'s records', () => {
        const v = ob.prefill({
            profile: { name: 'Kofi  Mensah Boateng', gender: 'male', category: 'AC Repair', skills: ['AC Installation'], bio: 'B'.repeat(60),
                yearsExperience: 7, workRadius: 20, baseRate: 80, availability: ['Sat', 'Mon', 'Funday'] },
            kyc: { dob: '1990-04-12', address: 'Accra', gpsAddress: 'GA-1-2', ghanaCardNumber: 'GHA-123456789-0', tin: 'C1',
                emergencyContact: { name: 'Ama', phone: '0201112222' }, payoutAccount: { provider: 'telecel', phone: '0201234567', accountName: 'Kofi' } },
            contact: { phone: '0241234567' },
            location: { lat: 5.6, lng: -0.18, accuracy: 12, updatedAt: '2026-11-01T00:00:00Z' },
        });
        assert.deepStrictEqual([v.firstName, v.lastName], ['Kofi', 'Mensah Boateng']);
        assert.deepStrictEqual([v.phone, v.dob, v.address, v.ghanaCard, v.trade, v.experience, v.radius, v.baseRate],
            ['0241234567', '1990-04-12', 'Accra', 'GHA-123456789-0', 'AC Repair', '7', 20, '80']);
        assert.deepStrictEqual(v.days, ['Mon', 'Sat'], 'known days, in week order');
        assert.deepStrictEqual(v.pin, { lat: 5.6, lng: -0.18, accuracy: 12, setAt: '2026-11-01T00:00:00Z' });
        assert.deepStrictEqual([v.payProvider, v.payNumber, v.payName], ['telecel', '0201234567', 'Kofi']);
    });

    await t('an "Other" trade comes back as Other, its description and its closest listed trade', () => {
        const v = ob.prefill({ profile: { name: 'A B', category: 'Electrical', requestedService: 'Solar inverters' } });
        assert.deepStrictEqual([v.trade, v.otherDesc, v.otherBucket], ['Other', 'Solar inverters', 'Electrical']);
        assert.strictEqual(ob.prefill({ profile: { name: 'A B', category: 'electrical' } }).trade, 'Electrical', 'legacy lower-case');
        assert.strictEqual(ob.prefill({ profile: { name: 'A B', category: 'Tiling' } }).trade, '', 'a retired trade must be chosen again');
    });

    await t('documents on file: the profile photo and the request\'s documents; none are asked for again', () => {
        const d = ob.docsOnFile({ profile: { profileImageId: 'p/1' }, request: { documents: { idFront: 'u1', idBack: 'u2', certs: 'u3' } } });
        assert.deepStrictEqual(d.selfie, { state: 'stored' });
        assert.deepStrictEqual([d.idFront.url, d.idBack.url, d.cert.url, d.bizReg.state], ['u1', 'u2', 'u3', 'none']);
        assert.strictEqual(ob.docPath('U', 'idFront'), 'artisans/U/documents/idFront', 'one name per kind, so a return visit finds it');
        assert.strictEqual(ob.docPath('U', 'cert'), 'artisans/U/documents/certs', 'admin reads documents.certs');
    });

    await t('a returning artisan resumes at the first step that is not complete', () => {
        assert.strictEqual(ob.resumeStep(ob.emptyValues(), {}, { now: NOW }), 'you');
        assert.strictEqual(ob.resumeStep(complete({ ghanaCard: '' }), DOCS_OK, { now: NOW }), 'identity');
        assert.strictEqual(ob.resumeStep(complete({ payName: '' }), DOCS_OK, { now: NOW }), 'payout');
        assert.strictEqual(ob.resumeStep(complete({ terms: false }), DOCS_OK, { now: NOW }), 'review');
    });

    await t('each completed step is saved; identity and payout only with a verified email (the rules\' condition)', () => {
        const v = complete();
        const ids = (r) => r.writes.map((w) => `${w.path}/${w.id}`);
        const you = ob.draftWrites('you', { uid: UID, email: 'k@example.com', v, emailVerified: false, nowIso: NOW_ISO });
        assert.deepStrictEqual(ids(you), [`artisans/${UID}/private/contact`, `artisans/${UID}/private/location`, `artisans/${UID}`]);
        assert.strictEqual(you.held, true);
        const youV = ob.draftWrites('you', { uid: UID, email: 'k@example.com', v, emailVerified: true, nowIso: NOW_ISO });
        assert.ok(ids(youV).includes(`artisans/${UID}/private/kyc`) && youV.held === false);
        assert.deepStrictEqual(ids(ob.draftWrites('identity', { uid: UID, v, emailVerified: false, nowIso: NOW_ISO })), []);
        assert.deepStrictEqual(ids(ob.draftWrites('work', { uid: UID, v, emailVerified: false, nowIso: NOW_ISO })), [`artisans/${UID}`]);
        assert.deepStrictEqual(ids(ob.draftWrites('payout', { uid: UID, v, emailVerified: true, nowIso: NOW_ISO })), [`artisans/${UID}/private/kyc`]);
        for (const step of ob.STEP_IDS) for (const w of ob.draftWrites(step, { uid: UID, v, emailVerified: true, nowIso: NOW_ISO }).writes) {
            if (w.path === 'artisans') assert.ok(!('verificationStatus' in w.data) && !('status' in w.data), `a ${step} draft changes no state`);
        }
    });

    console.log('\n── What is sent ──\n');

    const writes = ob.submissionWrites({ uid: UID, email: 'k@example.com', v: complete(),
        docUrls: { idFront: 'https://s/f', idBack: 'https://s/b', bizReg: 'https://s/r', stray: 'x' }, nowIso: NOW_ISO });
    const W = (p, id) => writes.find((w) => w.path === p && w.id === id);

    await t('one batch of five merges: identity, work pin, contact, profile, request', () => {
        assert.deepStrictEqual(writes.map((w) => `${w.path}/${w.id}`), [
            `artisans/${UID}/private/kyc`, `artisans/${UID}/private/location`, `artisans/${UID}/private/contact`, `artisans/${UID}`, `verification_requests/${UID}`]);
        assert.ok(writes.every((w) => w.merge === true));
        assert.match(script, /await withTimeout\(databaseService\.commitBatch\(submissionWrites\(\{ uid, email: user\.email, v, docUrls, nowIso \}\)\), SEND_TIMEOUT_MS\);/);
        const db = read('shared/js/backend/providers/firebase/firebaseDatabaseService.js');
        assert.match(db, /const batch = writeBatch\(dbInstance\);[\s\S]*?await batch\.commit\(\);/);
        assert.match(read('shared/js/services/cachedDatabaseService.js'), /async function commitBatch\(writes\)/);
    });

    await t('identity and payout go to private/kyc only, normalised', () => {
        const k = W(`artisans/${UID}/private`, 'kyc').data;
        assert.deepStrictEqual(k, { artisanId: UID, ghanaCardNumber: 'GHA-123456789-0', tin: null, dob: '1990-04-12',
            address: '12 Example Street, Accra', gpsAddress: 'GA-123-4567',
            emergencyContact: { name: 'Ama', phone: '0201112222' },
            payoutAccount: { provider: 'mtn', phone: '0241111111', accountName: 'Kofi Boateng' }, updatedAt: NOW_ISO });
    });

    await t('the work pin: precise and private; the public profile carries it to ~1 km (AR-03)', () => {
        const loc = W(`artisans/${UID}/private`, 'location').data;
        assert.deepStrictEqual([loc.lat, loc.lng, loc.accuracy, loc.source], [5.603716, -0.186964, 18, 'work_pin']);
        const pub = W('artisans', UID).data;
        assert.deepStrictEqual([pub.lat, pub.lng], [5.6, -0.19]);
    });

    await t('phone and email go to private/contact; the public profile carries neither (CONTACT-001)', () => {
        assert.deepStrictEqual(W(`artisans/${UID}/private`, 'contact').data, { artisanId: UID, phone: '0241234567', email: 'k@example.com', updatedAt: NOW_ISO });
        const pub = W('artisans', UID).data;
        for (const k of ['phone', 'email', 'phoneNumber', 'contactEmail', 'whatsapp']) assert.ok(!(k in pub), `the profile carries ${k}`);
        for (const k of ['ghanaCardNumber', 'tin', 'dob', 'address', 'gpsAddress', 'emergencyContact', 'payoutAccount']) assert.ok(!(k in pub), `the profile carries ${k}`);
    });

    await t('the profile: under review and offline; never its status, creation date, photo or a reviewer\'s field', () => {
        const pub = W('artisans', UID).data;
        assert.strictEqual(pub.verificationStatus, 'pending_review');
        assert.strictEqual(pub.isAvailable, false);
        for (const k of ['status', 'createdAt', 'profileImageId', 'profileImageVersion', 'isVerified', 'approvedAt', 'rejectionReason', 'trustScore', 'reviewedBy', 'adminNotes'])
            assert.ok(!(k in pub), `the profile write names ${k}`);
        assert.deepStrictEqual([pub.name, pub.category, pub.specialty, pub.requestedService, pub.yearsExperience, pub.workRadius, pub.baseRate],
            ['Kofi Boateng', 'Plumbing', 'Plumbing', null, 12, 10, null]);
        assert.deepStrictEqual(pub.availability, ['Mon', 'Sat']);
    });

    await t('the request: evidence only, both status fields, the documents admin reads', () => {
        const r = W('verification_requests', UID).data;
        assert.strictEqual(r.status, 'pending_review');
        assert.strictEqual(r.verificationStatus, 'pending_review', 'a rejected request keeps verificationStatus "rejected" unless this is written');
        assert.deepStrictEqual(r.documents, { idFront: 'https://s/f', idBack: 'https://s/b', bizReg: 'https://s/r' });
        const rules = read('firestore.rules');
        const evidence = /function verificationEvidenceFields\(\) \{\s*return \[([\s\S]*?)\];/.exec(rules)[1].match(/'([^']+)'/g).map((s) => s.slice(1, -1));
        for (const k of Object.keys(r)) assert.ok(evidence.includes(k), `${k} is not an evidence field`);
    });

    await t('"Other": the dispatch trade is the closest listed one; the description rides on the profile and a service request', () => {
        const v = complete({ trade: 'Other', otherDesc: 'Solar inverter installation', otherBucket: 'Electrical' });
        const ws = ob.submissionWrites({ uid: UID, email: 'k@example.com', v, docUrls: {}, nowIso: NOW_ISO });
        const pub = ws.find((w) => w.path === 'artisans').data;
        assert.deepStrictEqual([pub.category, pub.specialty, pub.requestedService], ['Electrical', 'Electrical', 'Solar inverter installation']);
        assert.deepStrictEqual(ob.serviceRequestWrite({ uid: UID, v, nowIso: NOW_ISO }).data, { artisanId: UID, artisanName: 'Kofi Boateng',
            requestedService: 'Solar inverter installation', operationalCategory: 'Electrical', status: 'pending', createdAt: NOW_ISO });
        assert.strictEqual(ob.serviceRequestWrite({ uid: UID, v: complete(), nowIso: NOW_ISO }), null);
        // Outside the batch: the rules let an artisan create it once and never update it.
        assert.match(script, /if \(sr\) databaseService\.setDocument\(sr\.path, sr\.id, sr\.data\)\.catch\(/);
    });

    await t('the review masks the identity and payout numbers', () => {
        const rows = Object.fromEntries(ob.reviewSummary(complete(), DOCS_OK).flatMap((s) => s.rows));
        assert.strictEqual(rows['Ghana Card'], 'GHA-•••••6789-0');
        assert.strictEqual(rows.Number, '•••• 1111');
        assert.strictEqual(rows['Card, front'], 'On file');
    });

    console.log('\n── The page carries it out ──\n');

    await t('one submission: the guard is set before anything waits, and only a sent application keeps it', () => {
        const at = script.indexOf('async function submitApplication()');
        const body = script.slice(at, script.indexOf('\nfunction showDone', at));
        const guard = body.indexOf('if (busy) return;\n  busy = true;');
        assert.ok(guard > 0 && guard < body.indexOf('await '), 'busy is set before the first await');
        assert.match(body, /finally \{\s*if \(!sent\) \{ busy = false; setBusy\(false\); \}/);
        assert.match(script, /\$\('ob-form'\)\.addEventListener\('submit', async \(e\) => \{\s*e\.preventDefault\(\);\s*if \(busy\) return;/);
    });

    await t('sending needs a verified email (AR-09), checked first', () => {
        assert.match(script, /if \(!\(await ensureVerifiedEmail\(\)\)\) return;/);
        const body = script.slice(script.indexOf('async function submitApplication()'));
        assert.ok(body.indexOf('ensureVerifiedEmail()') < body.indexOf('commitBatch'));
    });

    await t('errors keep the answers: a failed step or send leaves the form as it was, in words', () => {
        assert.strictEqual(ob.saveError({ code: 'unavailable' }), "Can't reach the server. Your answers are still here — check your connection and try again.");
        assert.match(ob.saveError({ code: 'permission-denied' }, { submitting: true }), /Reload the page to see where it stands/);
        assert.match(ob.saveError(new Error('Firebase: weird')), /Your answers are still here/);
        assert.ok(!/err\.message|e\.message\)/.test(script.replace(/console\.(warn|error)\([^;]*;/g, '')), 'no raw error text is shown');
        assert.ok(!/\.reset\(\)|location\.reload\(\)[^;]*;\s*\}\s*catch/.test(script), 'nothing clears the form on failure');
    });

    await t('a required upload that fails stops the step; the files are stored before the step\'s answers are saved', () => {
        assert.match(script, /if \(d\.required\) throw failure\(/);
        assert.match(script, /const skipped = await storeFiles\(step\);\s*await saveDraft\(step, v\);/);
        assert.match(script, /storageService\.uploadFile\(path, file, \{ contentType: file\.type \}\), UPLOAD_TIMEOUT_MS\)/);
        assert.match(script, /withTimeout\(replaceProfilePhoto\(file, 'artisan'\)/, 'the photo goes through the shared lifecycle');
    });

    await t('every file control is a real button over a hidden input (keyboard and screen reader)', () => {
        for (const which of Object.keys(ob.DOCS)) {
            assert.match(markup, new RegExp(`<button class="fx-btn fx-btn--secondary fx-btn--s" type="button" id="ob-${which}-btn"`), which);
            assert.match(markup, new RegExp(`<input type="file" id="ob-${which}-input" accept="[^"]+" hidden />`), which);
        }
        assert.ok(!/onclick=/.test(page), 'no inline click handlers');
        assert.ok(!/capture="user"/.test(page), 'the photo can come from the gallery, not only the camera');
    });

    await t('every input has a label; every hint and error is announced with its field', () => {
        const ids = [...markup.matchAll(/<(?:input|select|textarea)\b[^>]*\bid="([^"]+)"/g)].map((m) => m[1]).filter((id) => !/-input$|^ob-terms$/.test(id));
        for (const id of ids) assert.match(markup, new RegExp(`<label class="fx-field__label" for="${id}">`), `${id} has a label`);
        for (const m of markup.matchAll(/aria-describedby="([^"]+)"/g)) for (const ref of m[1].split(' ')) assert.match(markup, new RegExp(`id="${ref}"`), `${ref} exists`);
    });

    await t('the trade list is the domain\'s (8 bookable + Other); the providers are the shared list', () => {
        assert.match(script, /for \(const t of \[\.\.\.ARTISAN_TRADES, OTHER_TRADE\]\) \$\('ob-trade'\)\.add\(new Option\(t, t\)\);/);
        assert.ok(!/Tiling|Roofing|Landscaping|Security Systems|Moving/.test(page), 'no retired trade');
        assert.ok(!/\bVDF\b/.test(page));
    });

    await t('no promise the product does not keep (decision 3) and no HandyHub', () => {
        for (const re of [/business days/i, /within 24 hours/i, /48 ?hrs?/i, /20,000/, /SMS/, /HandyHub/i, /\bimmediately visible\b/i])
            assert.ok(!re.test(page), `the page says ${re}`);
    });

    await t('the commission is stated from PLATFORM_CONFIG (config-consistency)', () => {
        assert.ok((page.match(/data-fx-commission/g) || []).length >= 2);
        assert.match(script, /PLATFORM_CONFIG\.commissionRate/);
    });

    await t('the page is on the design system: tokens, no inline styles, no legacy shell', () => {
        assert.match(page, /<body class="fx-app">/);
        assert.match(page, /href="css\/fx\/onboarding\.css"/);
        assert.ok(!/style="/.test(page) && !/\.style\./.test(script));
        assert.ok(!/fastLoader|font-awesome|icons8/.test(page));
    });

    console.log(`\nonboarding: ${passed} passed, ${failed} failed`);
    for (const [n, e] of failures) console.log(`\n✗ ${n}\n  ${String(e && e.stack || e).split('\n').slice(0, 3).join('\n  ')}`);
    process.exit(failed ? 1 : 0);
})();
