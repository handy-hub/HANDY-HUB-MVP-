'use strict';

const crypto = require('crypto');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const { HttpsError } = require('firebase-functions/v2/https');
const {
    FIRESTORE_DB_ID,
    CLOUDINARY_CLOUD_NAME,
    CLOUDINARY_API_KEY,
    CLOUDINARY_API_SECRET,
} = require('./config');

// Lazy singleton, matching emailOtp.js / securityPin.js / pricing.js. Calling
// getFirestore() at module load only worked because this require happens to sit
// after initializeApp() in index.js â€” reordering an import would break startup.
let _db;
function db() {
    if (!_db) _db = getFirestore(FIRESTORE_DB_ID);
    return _db;
}

const OPS = '_profile_photo_operations';
const CLEANUP = '_cloudinary_cleanup_jobs';
const OP_TTL_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 8;
const ACCOUNT_COLLECTIONS = { customer: 'customers', artisan: 'artisans' };

function requireCloudinaryConfig() {
    if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
        throw new HttpsError('failed-precondition', 'Profile photo storage is not configured.');
    }
}

function accountRef(uid, accountType) {
    const collection = ACCOUNT_COLLECTIONS[accountType];
    if (!collection) throw new HttpsError('invalid-argument', 'Invalid account type.');
    return db().collection(collection).doc(uid);
}

function ownsProfileAsset(publicId, uid, accountType) {
    if (!publicId || typeof publicId !== 'string') return false;
    const collection = ACCOUNT_COLLECTIONS[accountType];
    // Accept the canonical /profile/{operationId} shape and the historical
    // /{timestamp} shape already stored by both apps. The value is only ever
    // selected from authoritative profile/operation documents.
    const prefix = `${collection}/${uid}/`;
    return Boolean(collection) && publicId.startsWith(prefix) &&
        publicId.length > prefix.length &&
        /^[A-Za-z0-9/_-]+$/.test(publicId) &&
        !publicId.includes('..');
}

async function destroyCloudinaryAsset(publicId) {
    requireCloudinaryConfig();
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = crypto
        .createHash('sha1')
        .update(`invalidate=true&public_id=${publicId}&timestamp=${timestamp}${CLOUDINARY_API_SECRET}`)
        .digest('hex');
    const body = new URLSearchParams({
        public_id: publicId,
        timestamp: String(timestamp),
        api_key: CLOUDINARY_API_KEY,
        signature,
        invalidate: 'true',
    });
    const response = await fetch(
        `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/destroy`,
        { method: 'POST', body }
    );
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !['ok', 'not found'].includes(result.result)) {
        throw new Error(result.error?.message || `Cloudinary deletion failed (${response.status})`);
    }
    return result.result;
}

async function queueCleanup({ publicId, uid, accountType, reason }) {
    if (!ownsProfileAsset(publicId, uid, accountType)) return;
    const id = crypto.createHash('sha256').update(publicId).digest('hex');
    await db().collection(CLEANUP).doc(id).set({
        publicId, uid, accountType, reason,
        attempts: 0,
        nextAttemptAt: Timestamp.now(),
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
}

async function deleteOrQueue(details) {
    if (!ownsProfileAsset(details.publicId, details.uid, details.accountType)) return 'skipped';
    try {
        return await destroyCloudinaryAsset(details.publicId);
    } catch (error) {
        console.error('[profilePhotos] cleanup queued', { ...details, error: error.message });
        await queueCleanup(details);
        return 'queued';
    }
}

async function begin(auth, data = {}) {
    requireCloudinaryConfig();
    const uid = auth.uid;
    const accountType = data.accountType;
    const profileRef = accountRef(uid, accountType);
    const profileSnap = await profileRef.get();
    if (!profileSnap.exists) throw new HttpsError('not-found', 'Account profile not found.');
    const profile = profileSnap.data();
    if (profile.userType && profile.userType !== accountType) {
        throw new HttpsError('permission-denied', 'Account type does not match the signed-in user.');
    }

    const opRef = db().collection(OPS).doc();
    const publicId = `${ACCOUNT_COLLECTIONS[accountType]}/${uid}/profile/${opRef.id}`;
    await opRef.set({
        uid, accountType, publicId,
        previousPublicId: profile.profileImageId || null,
        previousVersion: profile.profileImageVersion ?? null,
        status: 'pending',
        createdAt: FieldValue.serverTimestamp(),
        expiresAt: Timestamp.fromMillis(Date.now() + OP_TTL_MS),
    });
    return { operationId: opRef.id, publicId, expiresInSeconds: OP_TTL_MS / 1000 };
}

async function commit(auth, data = {}) {
    const operationId = String(data.operationId || '');
    const version = Number(data.version);
    if (!/^[A-Za-z0-9]{10,80}$/.test(operationId) || !Number.isSafeInteger(version) || version <= 0) {
        throw new HttpsError('invalid-argument', 'Invalid photo operation.');
    }
    const opRef = db().collection(OPS).doc(operationId);
    let operation;
    try {
        await db().runTransaction(async transaction => {
            const opSnap = await transaction.get(opRef);
            if (!opSnap.exists) throw new HttpsError('not-found', 'Photo operation not found.');
            operation = opSnap.data();
            if (operation.uid !== auth.uid) throw new HttpsError('permission-denied', 'Photo operation is not yours.');
            if (operation.status === 'committed') return;
            if (operation.status !== 'pending' || operation.expiresAt.toMillis() < Date.now()) {
                throw new HttpsError('deadline-exceeded', 'Photo operation expired.');
            }
            if (!ownsProfileAsset(operation.publicId, auth.uid, operation.accountType)) {
                throw new HttpsError('permission-denied', 'Invalid stored asset ownership.');
            }
            const profileRef = accountRef(auth.uid, operation.accountType);
            const profileSnap = await transaction.get(profileRef);
            if (!profileSnap.exists) throw new HttpsError('not-found', 'Account profile not found.');
            const profile = profileSnap.data();
            if ((profile.profileImageId || null) !== operation.previousPublicId ||
                (profile.profileImageVersion ?? null) !== operation.previousVersion) {
                throw new HttpsError('aborted', 'A newer profile photo update already won.');
            }
            transaction.update(profileRef, {
                profileImageId: operation.publicId,
                profileImageVersion: version,
                updatedAt: FieldValue.serverTimestamp(),
            });
            transaction.update(opRef, { status: 'committed', version, committedAt: FieldValue.serverTimestamp() });
        });
    } catch (error) {
        if (operation?.uid === auth.uid && operation?.status === 'pending') {
            await deleteOrQueue({ ...operation, reason: 'commit-failed-new-asset' });
            await opRef.set({ status: 'failed', failedAt: FieldValue.serverTimestamp() }, { merge: true });
        }
        throw error;
    }

    const committedVersion = operation.version || version;
    const cleanup = operation.previousPublicId && operation.previousPublicId !== operation.publicId
        ? await deleteOrQueue({ ...operation, publicId: operation.previousPublicId, reason: 'replaced-profile-photo' })
        : 'skipped';
    return { publicId: operation.publicId, version: committedVersion, cleanup };
}

async function abort(auth, data = {}) {
    const operationId = String(data.operationId || '');
    const opRef = db().collection(OPS).doc(operationId);
    const snap = await opRef.get();
    if (!snap.exists) return { aborted: true };
    const operation = snap.data();
    if (operation.uid !== auth.uid) throw new HttpsError('permission-denied', 'Photo operation is not yours.');
    if (operation.status !== 'pending') return { aborted: operation.status !== 'committed' };
    await deleteOrQueue({ ...operation, reason: 'aborted-new-asset' });
    await opRef.set({ status: 'aborted', abortedAt: FieldValue.serverTimestamp() }, { merge: true });
    return { aborted: true };
}

async function retryCleanup() {
    const snap = await db().collection(CLEANUP).where('nextAttemptAt', '<=', Timestamp.now()).limit(50).get();
    for (const doc of snap.docs) {
        const job = doc.data();
        if (!ownsProfileAsset(job.publicId, job.uid, job.accountType)) {
            await doc.ref.delete();
            continue;
        }
        try {
            await destroyCloudinaryAsset(job.publicId);
            await doc.ref.delete();
        } catch (error) {
            const attempts = Number(job.attempts || 0) + 1;
            const delayMinutes = Math.min(24 * 60, 2 ** attempts * 5);
            await doc.ref.set({
                attempts,
                lastError: String(error.message).slice(0, 500),
                status: attempts >= MAX_ATTEMPTS ? 'manual_review' : 'retrying',
                nextAttemptAt: Timestamp.fromMillis(Date.now() + delayMinutes * 60_000),
                updatedAt: FieldValue.serverTimestamp(),
            }, { merge: true });
        }
    }
    return { processed: snap.size };
}

module.exports = { begin, commit, abort, retryCleanup, ownsProfileAsset };

