/**
 * artisan-app/js/onboarding.js — the application a professional sends for
 * review (Phase 5). Pure: no DOM, no Firebase. onboarding.html carries these
 * decisions out; tests/artisan-onboarding.test.cjs and the rules suite run them.
 *
 *  · Five steps, each checked before the next opens. Every message says what
 *    to do, not what went wrong in the abstract.
 *  · Resumable: each completed step is saved to the account (draftWrites) and
 *    read back on return (prefill, resumeStep). What the rules let a client
 *    save depends on the email being verified: the identity and payout record
 *    (private/kyc) needs it, the profile, phone and work pin do not.
 *  · One submission, one atomic batch (submissionWrites): the identity record,
 *    the work pin, the private contact, the profile and the request for review
 *    land together or not at all. Written one at a time, a failure part-way
 *    could leave a profile "under review" with no request for a reviewer to see.
 *  · Nothing here can make an account approved, verified or dispatch-ready.
 *    The profile is set to pending_review and taken offline; approval is
 *    functions/artisanVerification.js alone (firestore.rules refuse the rest).
 */
import { ARTISAN_TRADES, OTHER_TRADE, canonicalTrade, isOtherTrade } from '../../shared/js/domain/artisanTrades.js';
import { getCategoryByLabel } from '../../shared/js/data/serviceCatalog.js';
import { coarseCoord } from '../../shared/js/domain/locationPrivacy.js';
import { MOMO_PROVIDERS } from '../../shared/js/config/appConfig.js';
import { normalisePhone, isEmail } from './entry.js';

export { ARTISAN_TRADES, OTHER_TRADE };

// ── The steps ────────────────────────────────────────────────────────────────

export const STEPS = Object.freeze([
    Object.freeze({ id: 'you',      title: 'About you' }),
    Object.freeze({ id: 'identity', title: 'Your identity' }),
    Object.freeze({ id: 'work',     title: 'Your work' }),
    Object.freeze({ id: 'payout',   title: 'Getting paid' }),
    Object.freeze({ id: 'review',   title: 'Check and send' }),
]);
export const STEP_IDS = Object.freeze(STEPS.map((s) => s.id));

/** Settings → Job radius offers the same: dispatch casts a 25 km net (functions/dispatch.js). */
export const RADIUS_CHOICES = Object.freeze([5, 10, 15, 20, 25]);
export const DEFAULT_RADIUS = 10;
export const MAX_YEARS = 60;                 // profile.html's edit sheet allows 0–60
export const MIN_BIO = 50;
export const MIN_AGE = 18;
export const MAX_FILE_BYTES = 5 * 1024 * 1024;   // storage.rules isValidFileSize
export const DAYS = Object.freeze(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
export const GENDERS = Object.freeze(['male', 'female', 'other']);
export const PAYOUT_PROVIDERS = Object.freeze(Object.values(MOMO_PROVIDERS).map((p) => Object.freeze({ id: p.key, name: p.name })));
const PROVIDER_IDS = PAYOUT_PROVIDERS.map((p) => p.id);

/** The files an application carries. `key` is the verification_requests.documents key admin reads. */
export const DOCS = Object.freeze({
    selfie:  Object.freeze({ required: true,  step: 'you' }),
    idFront: Object.freeze({ required: true,  step: 'identity', key: 'idFront' }),
    idBack:  Object.freeze({ required: true,  step: 'identity', key: 'idBack' }),
    bizReg:  Object.freeze({ required: false, step: 'identity', key: 'bizReg' }),
    cert:    Object.freeze({ required: false, step: 'identity', key: 'certs' }),
});
/** Where a document is stored (storage.rules: owner write, owner + admin read). One name per kind, so a return visit can find it. */
export const docPath = (uid, which) => `artisans/${uid}/documents/${DOCS[which].key}`;

const clean = (v) => String(v == null ? '' : v).trim().replace(/\s+/g, ' ');
const hasDoc = (d) => !!d && (d.state === 'picked' || d.state === 'stored');

// ── Small normalisers ────────────────────────────────────────────────────────

/** GHA-123456789-0, from what people type (lower case, spaces, no dashes); '' if it is not one. */
export function normaliseGhanaCard(raw) {
    const s = String(raw || '').toUpperCase().replace(/\s+/g, '');
    const m = s.replace(/-/g, '').match(/^GHA(\d{9})(\d)$/);
    return m ? `GHA-${m[1]}-${m[2]}` : '';
}

/** Whole years between an ISO date (YYYY-MM-DD) and `now`; null for a date that does not exist. */
export function ageYears(iso, now) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
    if (!m) return null;
    const y = +m[1], mo = +m[2], d = +m[3];
    const birth = new Date(Date.UTC(y, mo - 1, d));
    if (birth.getUTCFullYear() !== y || birth.getUTCMonth() !== mo - 1 || birth.getUTCDate() !== d) return null;
    const t = new Date(now);
    let age = t.getUTCFullYear() - y;
    const tm = t.getUTCMonth() + 1;
    if (tm < mo || (tm === mo && t.getUTCDate() < d)) age -= 1;
    return age;
}

/** A radius dispatch honours: the nearest choice, never beyond its 25 km net. */
export function radiusChoice(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_RADIUS;
    return RADIUS_CHOICES.reduce((best, c) => (Math.abs(c - n) < Math.abs(best - n) ? c : best), RADIUS_CHOICES[0]);
}

/** The trade dispatch matches: the listed trade, or for "Other" the closest listed one. */
export function effectiveTrade(v) {
    return isOtherTrade(v.trade) ? canonicalTrade(v.otherBucket) : canonicalTrade(v.trade);
}

/** The jobs a trade covers, as customers book them (the catalogue), plus any already chosen. */
export function skillChoices(trade, chosen = []) {
    const cat = getCategoryByLabel(canonicalTrade(trade) || '');
    const fromCatalogue = cat && Array.isArray(cat.services) ? cat.services.map((s) => s.name) : [];
    const kept = (Array.isArray(chosen) ? chosen : []).filter((s) => typeof s === 'string' && s.trim());
    return [...new Set([...fromCatalogue, ...kept])];
}

export const fullName = (v) => clean(`${v.firstName || ''} ${v.lastName || ''}`);

// ── Checks ───────────────────────────────────────────────────────────────────

/**
 * What stops a step from being complete, as { field: message }; {} when it is.
 * @param {string} step  one of STEP_IDS
 * @param {object} v     the form's values (see emptyValues)
 * @param {object} docs  { selfie, idFront, … } each { state: 'none'|'picked'|'stored' }
 * @param {{ now?: number }} [opts]
 */
export function stepProblems(step, v, docs = {}, { now = Date.now() } = {}) {
    const p = {};
    const phoneProblem = (raw, emptyMsg) => {
        if (!clean(raw)) return emptyMsg;
        return normalisePhone(raw) ? null : 'Enter a Ghana mobile number, like 024 123 4567.';
    };
    if (step === 'you') {
        if (!clean(v.firstName)) p.firstName = 'Enter your first name.';
        if (!clean(v.lastName)) p.lastName = 'Enter your last name.';
        const ph = phoneProblem(v.phone, 'Enter your mobile number.');
        if (ph) p.phone = ph;
        if (!v.dob) p.dob = 'Enter your date of birth.';
        else {
            const age = ageYears(v.dob, now);
            if (age === null) p.dob = 'Enter a real date.';
            else if (age < MIN_AGE) p.dob = 'You must be 18 or older to work on Fidus X.';
            else if (age > 100) p.dob = 'Check the year of your date of birth.';
        }
        if (v.gender && !GENDERS.includes(v.gender)) p.gender = 'Choose an option from the list.';
        if (clean(v.address).length < 3) p.address = 'Enter your home address.';
        else if (clean(v.address).length > 300) p.address = 'Shorten your address to 300 characters.';
        if (clean(v.gpsAddress).length > 32) p.gpsAddress = 'A Ghana Post GPS address is at most 32 characters.';
        if (clean(v.emergencyPhone) && !normalisePhone(v.emergencyPhone)) p.emergencyPhone = 'Enter a Ghana mobile number, or leave this empty.';
        if (!v.pin || typeof v.pin.lat !== 'number' || typeof v.pin.lng !== 'number') p.pin = 'Set your work location. Job requests are offered by distance from it.';
        if (!hasDoc(docs.selfie)) p.selfie = 'Add a photo of your face.';
    } else if (step === 'identity') {
        if (!clean(v.ghanaCard)) p.ghanaCard = 'Enter your Ghana Card number.';
        else if (!normaliseGhanaCard(v.ghanaCard)) p.ghanaCard = 'Enter it as on the card: GHA-123456789-0.';
        if (!hasDoc(docs.idFront)) p.idFront = 'Add a photo of the front of your Ghana Card.';
        if (!hasDoc(docs.idBack)) p.idBack = 'Add a photo of the back of your Ghana Card.';
        if (clean(v.tin).length > 32) p.tin = 'Check your TIN: it is at most 32 characters.';
    } else if (step === 'work') {
        if (!v.trade) p.trade = 'Choose your trade.';
        else if (isOtherTrade(v.trade)) {
            if (clean(v.otherDesc).length < 2) p.otherDesc = 'Describe your trade.';
            if (!canonicalTrade(v.otherBucket)) p.otherBucket = 'Choose the listed trade closest to yours.';
        } else if (!canonicalTrade(v.trade)) p.trade = 'Choose your trade.';
        const bio = clean(v.bio);
        if (bio.length < MIN_BIO) p.bio = `Write at least ${MIN_BIO} characters (${bio.length} so far).`;
        const yrs = String(v.experience ?? '').trim();
        if (yrs === '') p.experience = 'Enter your years of experience.';
        else if (!/^\d{1,2}$/.test(yrs) || Number(yrs) > MAX_YEARS) p.experience = `Enter a whole number of years, 0 to ${MAX_YEARS}.`;
        if (!RADIUS_CHOICES.includes(Number(v.radius))) p.radius = 'Choose how far you will travel.';
        const rate = String(v.baseRate ?? '').trim();
        if (rate && !(/^\d{1,6}(\.\d{1,2})?$/.test(rate))) p.baseRate = 'Enter an amount in cedis, or leave this empty.';
    } else if (step === 'payout') {
        if (!PROVIDER_IDS.includes(v.payProvider)) p.payProvider = 'Choose your Mobile Money provider.';
        const ph = phoneProblem(v.payNumber, 'Enter the Mobile Money number.');
        if (ph) p.payNumber = ph;
        if (clean(v.payName).length < 2) p.payName = 'Enter the name on the Mobile Money account.';
        else if (clean(v.payName).length > 120) p.payName = 'Shorten the name to 120 characters.';
    } else if (step === 'review') {
        if (!v.terms) p.terms = 'Agree to the Terms of Service and Privacy Policy to send your application.';
    }
    return p;
}

/** Every step's problems before submitting, in step order. */
export function applicationProblems(v, docs, opts) {
    const out = [];
    for (const id of STEP_IDS) {
        const p = stepProblems(id, v, docs, opts);
        if (Object.keys(p).length) out.push({ step: id, problems: p });
    }
    return out;
}

/** Where a returning artisan picks up: the first step that is not complete. */
export function resumeStep(v, docs, opts) {
    for (const id of STEP_IDS.slice(0, -1)) {
        if (Object.keys(stepProblems(id, v, docs, opts)).length) return id;
    }
    return 'review';
}

// ── Where the application stands (the server's word, never the form's) ──────

/**
 * fill    nothing sent yet (draft, or no status)
 * fix     a reviewer sent it back (rejected, re_verification_required)
 * review  sent and waiting, or a state the client may not change
 * approved
 */
export function applicationPhase(profile) {
    const vs = String((profile && profile.verificationStatus) || '').toLowerCase();
    if (vs === 'approved') return 'approved';
    if (vs === '' || vs === 'draft') return 'fill';
    if (vs === 'rejected' || vs === 're_verification_required') return 'fix';
    return 'review';
}

/** What the reviewer asked for, from the artisan's own request (owner-readable). */
export function fixNotice(profile, request) {
    const vs = String((profile && profile.verificationStatus) || '').toLowerCase();
    const r = request || {};
    const more = vs === 're_verification_required';
    const reason = clean(more ? r.infoRequestNotes : (r.rejectionReason || (profile && profile.rejectionReason)));
    return {
        title: more ? 'Fidus X needs more information' : 'Your application needs changes',
        reason: reason || 'No reason was recorded. Contact support if you are not sure what to change.',
        recorded: !!reason,
    };
}

// ── Reading back what is saved ───────────────────────────────────────────────

export function emptyValues() {
    return {
        firstName: '', lastName: '', phone: '', gender: '', dob: '', address: '', gpsAddress: '',
        emergencyName: '', emergencyPhone: '', pin: null,
        ghanaCard: '', tin: '',
        trade: '', otherDesc: '', otherBucket: '', skills: [], bio: '', experience: '', radius: DEFAULT_RADIUS, baseRate: '', days: [],
        payProvider: '', payNumber: '', payName: '',
        terms: false,
    };
}

/** The form, filled from the account's records. The terms box always starts unticked. */
export function prefill({ profile, kyc, contact, location, user } = {}) {
    const pr = profile || {}, k = kyc || {}, c = contact || {}, u = user || {};
    const v = emptyValues();
    const name = clean(pr.name || u.displayName || '');
    const parts = name ? name.split(' ') : [];
    v.firstName = parts[0] || '';
    v.lastName = parts.slice(1).join(' ');
    v.phone = typeof c.phone === 'string' ? c.phone : '';
    v.gender = GENDERS.includes(pr.gender) ? pr.gender : '';
    v.dob = typeof (k.dob || k.dateOfBirth) === 'string' ? (k.dob || k.dateOfBirth) : '';
    v.address = typeof k.address === 'string' ? k.address : '';
    v.gpsAddress = typeof k.gpsAddress === 'string' ? k.gpsAddress : '';
    const ec = k.emergencyContact && typeof k.emergencyContact === 'object' ? k.emergencyContact : {};
    v.emergencyName = typeof ec.name === 'string' ? ec.name : '';
    v.emergencyPhone = typeof ec.phone === 'string' ? ec.phone : '';
    if (location && typeof location.lat === 'number' && typeof location.lng === 'number') {
        v.pin = { lat: location.lat, lng: location.lng,
            accuracy: typeof location.accuracy === 'number' ? location.accuracy : null,
            setAt: typeof location.updatedAt === 'string' ? location.updatedAt : null };
    }
    v.ghanaCard = typeof k.ghanaCardNumber === 'string' ? k.ghanaCardNumber : '';
    v.tin = typeof k.tin === 'string' ? k.tin : '';
    const listed = canonicalTrade(pr.category);
    if (typeof pr.requestedService === 'string' && pr.requestedService.trim()) {
        v.trade = OTHER_TRADE; v.otherDesc = pr.requestedService.trim(); v.otherBucket = listed || '';
    } else {
        v.trade = listed || '';
    }
    v.skills = Array.isArray(pr.skills) ? pr.skills.filter((s) => typeof s === 'string' && s.trim()) : [];
    v.bio = typeof pr.bio === 'string' ? pr.bio : '';
    const yrs = Number(pr.yearsExperience);
    v.experience = Number.isInteger(yrs) && yrs > 0 && yrs <= MAX_YEARS ? String(yrs) : '';
    v.radius = radiusChoice(pr.workRadius);
    v.baseRate = typeof pr.baseRate === 'number' && pr.baseRate > 0 ? String(pr.baseRate) : '';
    v.days = Array.isArray(pr.availability) ? DAYS.filter((d) => pr.availability.includes(d)) : [];
    const pay = k.payoutAccount && typeof k.payoutAccount === 'object' ? k.payoutAccount : {};
    v.payProvider = PROVIDER_IDS.includes(pay.provider) ? pay.provider : '';
    v.payNumber = typeof pay.phone === 'string' ? pay.phone : '';
    v.payName = typeof pay.accountName === 'string' ? pay.accountName : '';
    return v;
}

/** The documents already on the account: the profile photo, and the request's documents. */
export function docsOnFile({ profile, request } = {}) {
    const out = {};
    for (const which of Object.keys(DOCS)) out[which] = { state: 'none' };
    if (profile && profile.profileImageId) out.selfie = { state: 'stored' };
    const docs = request && request.documents && typeof request.documents === 'object' ? request.documents : {};
    for (const [which, d] of Object.entries(DOCS)) {
        if (d.key && typeof docs[d.key] === 'string' && docs[d.key]) out[which] = { state: 'stored', url: docs[d.key] };
    }
    return out;
}

// ── What gets written ────────────────────────────────────────────────────────
// Each write is { path, id, data, merge }: the collection path, the document
// id, the fields. firestore.rules are the authority on every one of them;
// tests/artisan-privacy-rules.test.mjs runs these exact outputs against them.

const kycWrite = (uid, data, nowIso) => ({ path: `artisans/${uid}/private`, id: 'kyc', merge: true,
    data: { artisanId: uid, ...data, updatedAt: nowIso } });

const personal = (v) => ({
    dob: v.dob,
    address: clean(v.address),
    gpsAddress: clean(v.gpsAddress).toUpperCase() || null,
    emergencyContact: { name: clean(v.emergencyName), phone: normalisePhone(v.emergencyPhone) || '' },
});
const identity = (v) => ({ ghanaCardNumber: normaliseGhanaCard(v.ghanaCard), tin: clean(v.tin) || null });
const payout = (v) => ({ payoutAccount: { provider: v.payProvider, phone: normalisePhone(v.payNumber), accountName: clean(v.payName) } });

/** The precise work pin: private (artisan + admins); syncArtisanIndex reads it for dispatch. */
const locationWrite = (uid, pin, nowIso) => ({ path: `artisans/${uid}/private`, id: 'location', merge: true,
    data: { lat: pin.lat, lng: pin.lng, accuracy: typeof pin.accuracy === 'number' ? pin.accuracy : null, source: 'work_pin', updatedAt: nowIso } });

/** Phone and email (CONTACT-001): private; a customer gets the phone only inside a booking. */
const contactWrite = (uid, v, email, nowIso) => ({ path: `artisans/${uid}/private`, id: 'contact', merge: true,
    data: { artisanId: uid, phone: normalisePhone(v.phone), ...(isEmail(email) ? { email: String(email).trim().slice(0, 254) } : {}), updatedAt: nowIso } });

/** The public profile's share of "about you": the name, and the work area to ~1 km. */
const aboutProfile = (v, nowIso) => ({
    name: fullName(v),
    gender: v.gender || null,
    lat: coarseCoord(v.pin.lat),
    lng: coarseCoord(v.pin.lng),
    locationSetAt: v.pin.setAt || nowIso,
});

const workProfile = (v) => {
    const trade = effectiveTrade(v);
    const rate = String(v.baseRate ?? '').trim();
    return {
        category: trade,
        specialty: trade,
        requestedService: isOtherTrade(v.trade) ? clean(v.otherDesc) : null,
        skills: (Array.isArray(v.skills) ? v.skills : []).filter((s) => typeof s === 'string' && s.trim()),
        bio: clean(v.bio),
        yearsExperience: Number(v.experience) || 0,
        workRadius: radiusChoice(v.radius),
        baseRate: rate ? Number(rate) : null,
        availability: DAYS.filter((d) => (v.days || []).includes(d)),
    };
};

/**
 * What a completed step saves, so the artisan can come back to it. Called only
 * for a step with no problems. The identity record needs a verified email
 * (firestore.rules hasVerifiedEmail); without one, those answers stay on the
 * screen and `held` says so.
 * @returns {{ writes: Array, held: boolean }}
 */
export function draftWrites(step, { uid, email, v, emailVerified, nowIso }) {
    const writes = [];
    let held = false;
    const kyc = (data) => { if (emailVerified) writes.push(kycWrite(uid, data, nowIso)); else held = true; };
    if (step === 'you') {
        writes.push(contactWrite(uid, v, email, nowIso));
        writes.push(locationWrite(uid, v.pin, nowIso));
        writes.push({ path: 'artisans', id: uid, merge: true, data: { ...aboutProfile(v, nowIso), updatedAt: nowIso } });
        kyc(personal(v));
    } else if (step === 'identity') {
        kyc(identity(v));
    } else if (step === 'work') {
        writes.push({ path: 'artisans', id: uid, merge: true, data: { ...workProfile(v), updatedAt: nowIso } });
    } else if (step === 'payout') {
        kyc(payout(v));
    }
    return { writes, held };
}

/**
 * The submission: one atomic batch. `docUrls` maps DOCS keys (idFront, idBack,
 * bizReg, certs) to their stored download URLs.
 *
 * The profile write never names `status` (the rules refuse any client change to
 * it, and an artisan sent back for re-verification may be 'active'), nor
 * createdAt (the account's own date), nor any reviewer field. The request names
 * verificationStatus as well as status: a rejected request carries
 * verificationStatus 'rejected', and a resubmission that left it would be
 * refused (firestore.rules isApplicantStatus).
 */
export function submissionWrites({ uid, email, v, docUrls = {}, nowIso }) {
    const name = fullName(v);
    const trade = effectiveTrade(v);
    const phone = normalisePhone(v.phone);
    const documents = {};
    for (const d of Object.values(DOCS)) if (d.key && typeof docUrls[d.key] === 'string' && docUrls[d.key]) documents[d.key] = docUrls[d.key];
    return [
        kycWrite(uid, { ...identity(v), ...personal(v), ...payout(v) }, nowIso),
        locationWrite(uid, v.pin, nowIso),
        contactWrite(uid, v, email, nowIso),
        { path: 'artisans', id: uid, merge: true, data: {
            id: uid,
            userType: 'artisan',
            ...aboutProfile(v, nowIso),
            ...workProfile(v),
            isAvailable: false,
            verificationStatus: 'pending_review',
            updatedAt: nowIso,
        } },
        { path: 'verification_requests', id: uid, merge: true, data: {
            artisanId: uid,
            name,
            ...(isEmail(email) ? { email: String(email).trim() } : {}),
            phone,
            category: trade,
            ghanaCardNumber: normaliseGhanaCard(v.ghanaCard),
            documents,
            status: 'pending_review',
            verificationStatus: 'pending_review',
            submittedAt: nowIso,
            updatedAt: nowIso,
        } },
    ];
}

/** An "Other" trade is also recorded for Fidus X to consider adding (best effort, after the batch). */
export function serviceRequestWrite({ uid, v, nowIso }) {
    if (!isOtherTrade(v.trade)) return null;
    return { path: 'service_requests', id: uid, merge: false, data: {
        artisanId: uid, artisanName: fullName(v), requestedService: clean(v.otherDesc),
        operationalCategory: effectiveTrade(v), status: 'pending', createdAt: nowIso } };
}

// ── The review step ──────────────────────────────────────────────────────────

const maskDigits = (s) => { const d = String(s || '').replace(/\D/g, ''); return d.length > 4 ? `•••• ${d.slice(-4)}` : d; };
const DOC_WORD = (d) => (d && d.state === 'stored' ? 'On file' : d && d.state === 'picked' ? 'Ready to send' : 'Not added');

/** The summary the artisan checks, by step: [{ step, title, rows: [[label, value]] }]. Identity and payout numbers are masked. */
export function reviewSummary(v, docs = {}) {
    const trade = isOtherTrade(v.trade) ? `${clean(v.otherDesc)} (requests for ${effectiveTrade(v) || '—'})` : (canonicalTrade(v.trade) || '—');
    const provider = PAYOUT_PROVIDERS.find((p) => p.id === v.payProvider);
    const yrs = Number(v.experience);
    return [
        { step: 'you', title: 'About you', rows: [
            ['Name', fullName(v) || '—'],
            ['Mobile number', clean(v.phone) || '—'],
            ['Date of birth', v.dob || '—'],
            ['Home address', clean(v.address) || '—'],
            ['Work location', v.pin ? 'Set' : 'Not set'],
            ['Photo', DOC_WORD(docs.selfie)],
        ] },
        { step: 'identity', title: 'Your identity', rows: [
            ['Ghana Card', normaliseGhanaCard(v.ghanaCard) ? `GHA-•••••${normaliseGhanaCard(v.ghanaCard).slice(-6)}` : '—'],
            ['Card, front', DOC_WORD(docs.idFront)],
            ['Card, back', DOC_WORD(docs.idBack)],
        ] },
        { step: 'work', title: 'Your work', rows: [
            ['Trade', trade],
            ['Experience', String(v.experience).trim() === '' ? '—' : `${yrs} year${yrs === 1 ? '' : 's'}`],
            ['Travel', `Up to ${radiusChoice(v.radius)} km`],
        ] },
        { step: 'payout', title: 'Getting paid', rows: [
            ['Provider', provider ? provider.name : '—'],
            ['Number', maskDigits(v.payNumber) || '—'],
            ['Account name', clean(v.payName) || '—'],
        ] },
    ];
}

// ── Errors, in words ─────────────────────────────────────────────────────────

/** A failed save or submission: by code, never the SDK's own text. */
export function saveError(e, { submitting = false } = {}) {
    const code = String((e && e.code) || '').replace(/^(functions|firestore|storage)\//, '');
    if (code === 'permission-denied') {
        return submitting
            ? 'Fidus X could not accept this application. Reload the page to see where it stands, or contact support.'
            : 'This could not be saved to your account. Reload the page to see where your application stands.';
    }
    if (code === 'unavailable' || code === 'deadline-exceeded' || code === 'retry-limit-exceeded' || /timed out/i.test(String(e && e.message)))
        return "Can't reach the server. Your answers are still here — check your connection and try again.";
    return submitting
        ? 'Your application was not sent. Your answers are still here — try again.'
        : 'This could not be saved. Your answers are still here — try again.';
}

/** A file the artisan picked: refused here for what storage.rules would refuse. */
export function fileProblem(file, { image = false } = {}) {
    if (!file) return null;
    const type = String(file.type || '');
    const okType = image ? /^image\//.test(type) : (/^image\//.test(type) || type === 'application/pdf');
    if (!okType) return image ? 'Choose a photo (JPG or PNG).' : 'Choose a photo or a PDF.';
    if (file.size > MAX_FILE_BYTES) return 'Choose a file under 5 MB.';
    return null;
}
