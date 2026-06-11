'use strict';

/**
 * functions/artisanIndex.js — Dispatch search index maintenance
 *
 * artisan_index is a lightweight projection of the artisans collection.
 * It contains ONLY the fields dispatch needs for candidate selection:
 * geohash, skills, availability, status, rating, work radius, and enough
 * display data (name, photo, specialty) to build dispatch notifications
 * without a separate full-profile fetch.
 *
 * INVARIANTS — never break these:
 *   1. artisan_index is written ONLY by this module (syncArtisanIndex trigger).
 *   2. artisan_index is NEVER written by clients — Firestore rules deny all writes.
 *   3. artisan_index is NEVER read by clients — rules deny read access too.
 *      dispatch.js (Cloud Functions) reads it via Admin SDK which bypasses rules.
 *   4. artisan_index is always a full-overwrite (merge: false) so stale fields
 *      from schema changes can never accumulate.
 *   5. Artisans without valid lat/lng are NOT indexed — they cannot appear in
 *      proximity queries regardless, and indexing them wastes writes.
 *
 * Write cost: 1 Firestore write per artisan profile change.
 * Read savings: O(all artisans) → O(nearby artisans) per dispatch round.
 */

const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const { FieldValue }        = require('firebase-admin/firestore');
const { FIRESTORE_DB_ID, FUNCTIONS_REGION } = require('./config');

let _db;
function db() {
    if (!_db) {
        const { getFirestore } = require('firebase-admin/firestore');
        _db = getFirestore(FIRESTORE_DB_ID);
    }
    return _db;
}

// Skill normalization — mirrors artisanRepository.js CATEGORY_SYNONYMS.
// Keeps artisan_index.skills consistent with searchKeywords in artisans.
const CATEGORY_SYNONYMS = {
    'plumbing':   ['plumber', 'pipe', 'leak', 'drain', 'tap', 'water'],
    'electrical': ['electrician', 'wiring', 'power', 'socket', 'circuit'],
    'carpentry':  ['carpenter', 'wood', 'door', 'furniture', 'cabinet'],
    'painting':   ['painter', 'paint', 'wall', 'coat', 'colour', 'color'],
    'cooling':    ['ac', 'aircon', 'hvac', 'refrigeration', 'fridge'],
    'welding':    ['welder', 'metal', 'steel', 'gate', 'fence', 'iron'],
    'tiling':     ['tiler', 'tile', 'floor', 'flooring', 'ceramic'],
    'cleaning':   ['cleaner', 'clean', 'wash', 'housekeeping', 'domestic'],
    'masonry':    ['mason', 'brick', 'concrete', 'block', 'foundation'],
    'roofing':    ['roofer', 'roof', 'gutter', 'waterproofing'],
};

function _buildSkills(data) {
    const terms = new Set();
    const cat   = (data.category  || '').toLowerCase().trim();
    const spec  = (data.specialty || '').toLowerCase().trim();
    if (cat)  terms.add(cat);
    if (spec) terms.add(spec);
    const synonyms = CATEGORY_SYNONYMS[cat] || CATEGORY_SYNONYMS[spec] || [];
    synonyms.forEach(s => terms.add(s));
    (data.skills || []).forEach(s => { if (s) terms.add(String(s).toLowerCase().trim()); });
    return [...terms].filter(Boolean);
}

function _buildIndexDoc(artisanId, d, lat, lng) {
    return {
        artisanId,
        geohash:            d.geohash            || null,
        lat,
        lng,
        skills:             _buildSkills(d),
        isAvailable:        d.isAvailable         ?? false,
        isOnline:           d.isOnline            ?? false,
        status:             d.status              || 'pending',
        verificationStatus: d.verificationStatus  || 'pending',
        rating:             d.rating              ?? 0,
        workRadius:         d.workRadius          ?? 20,
        responseRate:       d.responseRate        ?? 0.7,
        completionRate:     d.completionRate      ?? 0.8,
        // Display fields — avoids a Phase 2 fetch in dispatch for the notification body
        name:               d.name               || 'Professional',
        profileImage:       d.profileImage        || null,
        specialty:          d.specialty           || d.category || '',
        updatedAt:          FieldValue.serverTimestamp(),
    };
}

// ── Trigger: artisans document written → sync artisan_index ──────────────────
const syncArtisanIndex = onDocumentWritten(
    { document: 'artisans/{artisanId}', region: FUNCTIONS_REGION },
    async (event) => {
        const artisanId = event.params.artisanId;
        const indexRef  = db().collection('artisan_index').doc(artisanId);

        // Artisan deleted — remove from index immediately.
        if (!event.data.after.exists) {
            await indexRef.delete();
            console.log(`[artisanIndex] Removed index for deleted artisan=${artisanId}`);
            return;
        }

        const d   = event.data.after.data();
        const lat = d.lat ?? d.latitude ?? null;
        const lng = d.lng ?? d.longitude ?? null;

        if (typeof lat !== 'number' || typeof lng !== 'number') {
            // No valid coordinates — cannot appear in geo queries. Delete any stale
            // index doc so this artisan isn't returned by the no-coords fallback path.
            await indexRef.delete().catch(() => {});
            console.log(`[artisanIndex] No coords for artisan=${artisanId} — index doc removed`);
            return;
        }

        await indexRef.set(_buildIndexDoc(artisanId, d, lat, lng), { merge: false });
        console.log(`[artisanIndex] Synced artisan=${artisanId} available=${d.isAvailable} geohash=${d.geohash}`);
    }
);

// ── Backfill helper (called from index.js admin callable) ─────────────────────
async function runBackfill() {
    const snap = await db().collection('artisans').get();
    let processed = 0, skipped = 0, errors = 0;

    const BATCH_SIZE = 400;
    let batch    = db().batch();
    let batchCnt = 0;

    for (const doc of snap.docs) {
        const d   = doc.data();
        const lat = d.lat ?? d.latitude ?? null;
        const lng = d.lng ?? d.longitude ?? null;

        if (typeof lat !== 'number' || typeof lng !== 'number') {
            skipped++;
            continue;
        }

        try {
            const indexRef = db().collection('artisan_index').doc(doc.id);
            batch.set(indexRef, _buildIndexDoc(doc.id, d, lat, lng), { merge: false });
            batchCnt++;
            processed++;

            if (batchCnt >= BATCH_SIZE) {
                await batch.commit();
                batch    = db().batch();
                batchCnt = 0;
            }
        } catch (e) {
            console.error(`[artisanIndex] backfill error artisan=${doc.id}:`, e.message);
            errors++;
        }
    }

    if (batchCnt > 0) await batch.commit();
    console.log(`[artisanIndex] backfill done — processed=${processed} skipped=${skipped} errors=${errors} total=${snap.size}`);
    return { processed, skipped, errors, total: snap.size };
}

module.exports = { syncArtisanIndex, runBackfill };
