'use strict';

/**
 * functions/artisanPrivacy.js — move artisan identity, payout and home-address
 * data out of the public profile.
 *
 * WHY
 * ───
 * artisans/{id} is readable by every signed-in account (customers browse it),
 * and Firestore rules cannot hide individual fields from a reader. Onboarding
 * used to write the Ghana Card number, TIN, date of birth, residential address,
 * Ghana Post GPS code, emergency contact and MoMo payout account into that same
 * document, so anyone who created a customer account could read them for every
 * artisan. New writes now go to artisans/{id}/private/kyc (owner + admin read
 * only — see firestore.rules). This module moves the data already written.
 *
 * MODES  (run in this order; each is safe to repeat)
 * ─────
 *   'dry-run'  (default) Report what would move. Writes nothing.
 *   'copy'     Copy each legacy field into the private record. A value already
 *              in the private record is NEVER overwritten — it is newer (written
 *              by the current onboarding) than the legacy copy.
 *   'strip'    Copy anything still missing, then remove the fields from the
 *              public profile. A field is only ever removed once the private
 *              record holds a value for it, in the same transaction, so nothing
 *              can be lost. Where the private record holds a DIFFERENT value it
 *              wins: since this change the profile can no longer receive these
 *              fields (firestore.rules), so its copy is necessarily the older
 *              one. Such fields are still stripped — a stale Ghana Card number
 *              is still a Ghana Card number — and reported as conflicts.
 *
 * Copy and strip are separate steps so the admin screens that read the private
 * record can be confirmed working before anything leaves the profile. Each
 * artisan is handled in its own transaction: the private write and the public
 * delete commit together or not at all.
 *
 * CONTACT-001 adds the artisan's phone and email (CONTACT_FIELDS), which go to
 * artisans/{id}/private/contact instead of private/kyc. That record may hold
 * only a valid phone and email (firestore.rules), so an alias or a malformed
 * value that cannot fill a slot is kept in private/contactLegacy (server-
 * written; artisan + admin read) rather than lost or left public. Artisans
 * already migrated (KYC copied, private records present, public fields gone)
 * are skipped or only stripped: every mode stays safe to repeat.
 *
 * DECISION RECORDS (release readiness, 2026-11-10). Verification decisions used
 * to write their reasons and the deciding admin's email onto the profile
 * (rejectionReason, banReason, approvedBy, bannedBy, …). The server no longer
 * does; this moves what is already there to verification_requests/{id}, the
 * record the artisan's application screen and the admin queue read. An artisan
 * with no request (a legacy or directly banned account) gets them in
 * private/decisionLegacy instead: server-written, artisan + admin read, and
 * not a request, so no one is put back in the review queue. A value already
 * on the request wins (it is the newer record). isVerified and the decision
 * timestamps stay public: they say what was decided, not who or why.
 *
 * Reports contain artisan ids and FIELD NAMES only, never values: the output
 * of a migration is itself a log, and must not become a second copy of the
 * data it is protecting.
 */

const { FieldValue, FieldPath } = require('firebase-admin/firestore');
const { FIRESTORE_DB_ID } = require('./config');

let _db;
function db() {
    if (!_db) {
        const { getFirestore } = require('firebase-admin/firestore');
        _db = getFirestore(FIRESTORE_DB_ID);
    }
    return _db;
}

/**
 * Fields that must never live on the public profile. Mirrors
 * artisanPrivateFields() in firestore.rules — keep the two lists identical.
 */
const ARTISAN_PRIVATE_FIELDS = Object.freeze([
    'ghanaCardNumber', 'tin', 'dob', 'dateOfBirth', 'emergencyContact',
    'payoutAccount', 'momoProvider', 'momoPhone', 'momoAccountName',
    'address', 'gpsAddress', 'businessRegNumber',
]);

/**
 * Contact details (CONTACT-001): never on the public profile; they move to
 * artisans/{id}/private/contact. Mirrors artisanContactFields() in
 * firestore.rules — keep the two lists identical.
 */
const CONTACT_FIELDS = Object.freeze(['phone', 'email', 'phoneNumber', 'contactEmail', 'whatsapp']);

// The private/contact slot each field fills. Order in CONTACT_FIELDS is the
// priority: the canonical field first, then its aliases.
const CONTACT_SLOT = Object.freeze({
    phone: 'phone', phoneNumber: 'phone', whatsapp: 'phone',
    email: 'email', contactEmail: 'email',
});

// What the rules accept in private/contact (isOptionalString(…, 32), isValidEmail).
const EMAIL_RE = /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/;
const clean = (v) => (v == null ? '' : String(v).trim());
function slotValid(slot, raw) {
    if (typeof raw !== 'string' && typeof raw !== 'number') return false;
    const v = clean(raw);
    if (!v) return false;
    return slot === 'phone' ? v.length <= 32 : v.length <= 254 && EMAIL_RE.test(v);
}

/**
 * Decision records that must not stay on the public profile: who decided (an
 * admin's email), why, and the internal review fields. The private subset of
 * artisanDecisionFields() in firestore.rules (the rest, isVerified and the
 * *At timestamps, are public facts and stay).
 */
const DECISION_PRIVATE_FIELDS = Object.freeze([
    'rejectionReason', 'banReason', 'suspensionReason',
    'approvedBy', 'rejectedBy', 'suspendedBy', 'reinstatedBy', 'bannedBy', 'unbannedBy',
    'reviewedBy', 'adminNotes', 'trustScore',
]);

const MODES = new Set(['dry-run', 'copy', 'strip']);

// Order-insensitive deep equality for the plain values these fields hold
// (strings, null, and the small emergencyContact / payoutAccount maps).
function sameValue(a, b) {
    if (a === b) return true;
    if (a == null || b == null || typeof a !== 'object' || typeof b !== 'object') return false;
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    return ka.length === kb.length && ka.every((k, i) => k === kb[i] && sameValue(a[k], b[k]));
}

/**
 * @param {{ mode?: 'dry-run'|'copy'|'strip', pageSize?: number }} opts
 * @returns {Promise<{ mode, scanned, affected, copied, stripped, conflicts, errors, artisans }>}
 */
async function migrateArtisanPrivateData({ mode = 'dry-run', pageSize = 200 } = {}) {
    if (!MODES.has(mode)) throw new Error(`mode must be one of: ${[...MODES].join(', ')}.`);

    const report = { mode, scanned: 0, affected: 0, copied: 0, stripped: 0, conflicts: 0, errors: 0, artisans: [] };
    const artisans = db().collection('artisans');

    let cursor = null;
    for (;;) {
        let q = artisans.orderBy(FieldPath.documentId()).limit(pageSize);
        if (cursor) q = q.startAfter(cursor);
        const page = await q.get();
        if (page.empty) break;

        for (const doc of page.docs) {
            report.scanned++;
            const legacy = [...ARTISAN_PRIVATE_FIELDS, ...CONTACT_FIELDS, ...DECISION_PRIVATE_FIELDS].filter((f) => doc.data()[f] !== undefined);
            if (!legacy.length) continue;
            report.affected++;

            const entry = { artisanId: doc.id, fields: legacy, copied: [], stripped: [], conflicts: [] };
            try {
                await processOne(doc.ref, mode, entry);
            } catch (err) {
                report.errors++;
                entry.error = err.message;
            }
            report.copied    += entry.copied.length;
            report.stripped  += entry.stripped.length;
            report.conflicts += entry.conflicts.length;
            report.artisans.push(entry);
        }

        cursor = page.docs[page.docs.length - 1];
        if (page.docs.length < pageSize) break;
    }
    return report;
}

async function processOne(publicRef, mode, entry) {
    const privateCol = publicRef.collection('private');
    const kycRef     = privateCol.doc('kyc');
    const contactRef = privateCol.doc('contact');
    const keptRef    = privateCol.doc('contactLegacy');
    const requestRef = db().collection('verification_requests').doc(publicRef.id);
    const decidedRef = privateCol.doc('decisionLegacy');

    await db().runTransaction(async (txn) => {
        const [pubSnap, kycSnap, contactSnap, keptSnap, requestSnap, decidedSnap] = await Promise.all(
            [txn.get(publicRef), txn.get(kycRef), txn.get(contactRef), txn.get(keptRef), txn.get(requestRef), txn.get(decidedRef)]);
        const pub     = pubSnap.exists     ? pubSnap.data()     : {};
        const kyc     = kycSnap.exists     ? kycSnap.data()     : {};
        const contact = contactSnap.exists ? contactSnap.data() : {};
        const kept    = keptSnap.exists    ? keptSnap.data()    : {};
        const request = requestSnap.exists ? requestSnap.data() : null;
        const decided = decidedSnap.exists ? decidedSnap.data() : {};

        // Reset per attempt: a transaction callback may run more than once.
        entry.copied = []; entry.stripped = []; entry.conflicts = [];

        const toKyc = {}, toContact = {}, toKept = {}, toStrip = {};
        for (const f of ARTISAN_PRIVATE_FIELDS) {
            if (pub[f] === undefined) continue;
            if (kyc[f] === undefined) {
                toKyc[f] = pub[f];           // never overwrites: only fills a gap
                entry.copied.push(f);
            } else if (!sameValue(kyc[f], pub[f])) {
                entry.conflicts.push(f);     // private wins; reported, not copied
            }
            // Once this transaction commits, the private record holds a value
            // for f (copied now, or already there), so f may leave the profile.
            toStrip[f] = FieldValue.delete();
            entry.stripped.push(f);
        }

        // Contact details. private/contact may hold only a valid phone and email
        // (firestore.rules), or the artisan's next Settings save is refused — so
        // a value fills its slot only when the slot is empty and the value valid.
        // Anything else (a second number, a malformed email, an alias that
        // disagrees) is kept in private/contactLegacy: server-written, readable
        // by the artisan and admins only. Nothing is lost; nothing stays public.
        const held = { phone: clean(contact.phone), email: clean(contact.email) };
        for (const f of CONTACT_FIELDS) {
            if (pub[f] === undefined) continue;
            const slot = CONTACT_SLOT[f];
            const v    = clean(pub[f]);
            if (v === '') {
                // An empty placeholder ("" / null): nothing to keep.
            } else if (held[slot] === '' && slotValid(slot, pub[f])) {
                toContact[slot] = v; held[slot] = v;
                entry.copied.push(f);
            } else if (held[slot] !== v) {
                if (held[slot] !== '') entry.conflicts.push(f);   // the private value wins
                if (kept[f] === undefined) { toKept[f] = pub[f]; if (!entry.copied.includes(f)) entry.copied.push(f); }
                else if (!sameValue(kept[f], pub[f]) && !entry.conflicts.includes(f)) entry.conflicts.push(f);
            }
            toStrip[f] = FieldValue.delete();
            entry.stripped.push(f);
        }

        // Decision records: to the artisan's request when there is one, else to
        // private/decisionLegacy. An empty value (bannedBy: null after an unban)
        // is simply removed. A value the destination already holds wins.
        const toRequest = {}, toDecided = {};
        for (const f of DECISION_PRIVATE_FIELDS) {
            if (pub[f] === undefined) continue;
            if (pub[f] !== null && pub[f] !== '') {
                const dest = request ? request : decided;
                const into = request ? toRequest : toDecided;
                if (dest[f] === undefined || dest[f] === null || dest[f] === '') { into[f] = pub[f]; entry.copied.push(f); }
                else if (!sameValue(dest[f], pub[f])) entry.conflicts.push(f);
            }
            toStrip[f] = FieldValue.delete();
            entry.stripped.push(f);
        }

        if (mode !== 'strip') entry.stripped = [];
        if (mode === 'dry-run') return;

        const now = new Date().toISOString();
        const put = (ref, snap, data) => {
            if (!Object.keys(data).length) return;
            txn.set(ref, {
                ...data,
                artisanId: publicRef.id,
                ...(snap.exists ? {} : { createdAt: now }),
                updatedAt: now,
            }, { merge: true });
        };
        put(kycRef, kycSnap, toKyc);
        put(contactRef, contactSnap, toContact);
        put(keptRef, keptSnap, toKept);
        put(decidedRef, decidedSnap, toDecided);
        // The request already exists; only its missing decision fields are filled.
        if (Object.keys(toRequest).length) txn.set(requestRef, { ...toRequest, updatedAt: now }, { merge: true });
        if (mode === 'strip') {
            txn.update(publicRef, { ...toStrip, updatedAt: now });
        }
    });

    // A dry run reports what WOULD be copied; nothing was.
    if (mode === 'dry-run') { entry.wouldCopy = entry.copied; entry.copied = []; }
}

module.exports = { migrateArtisanPrivateData, ARTISAN_PRIVATE_FIELDS, CONTACT_FIELDS, DECISION_PRIVATE_FIELDS };
