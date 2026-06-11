'use strict';

/**
 * functions/shared/searchKeywords.js
 *
 * Artisan search keyword generation — used by Cloud Functions when approving
 * artisans and by the backfill utility. Kept in sync with CATEGORY_SYNONYMS
 * in shared/js/data/repositories/artisanRepository.js (the frontend copy).
 *
 * To add a new service category:
 *   1. Add it here.
 *   2. Add it to CATEGORY_SYNONYMS in artisanRepository.js (same keys/values).
 *   3. Run the backfillSearchKeywords Cloud Function to update existing artisans.
 */

const CATEGORY_SYNONYMS = {
    'plumbing':   ['plumber', 'plumbers', 'pipe', 'pipes', 'leak', 'leaking', 'drainage', 'drain', 'tap', 'toilet', 'sink', 'water'],
    'electrical': ['electrician', 'electricians', 'wiring', 'wire', 'power', 'socket', 'switch', 'fan', 'light', 'circuit', 'fuse'],
    'carpentry':  ['carpenter', 'carpenters', 'wood', 'door', 'doors', 'furniture', 'cabinet', 'shelves', 'joinery', 'shelf'],
    'painting':   ['painter', 'painters', 'paint', 'wall', 'walls', 'coat', 'interior', 'exterior', 'colour', 'color', 'gloss'],
    'cooling':    ['ac', 'air conditioner', 'air conditioning', 'hvac', 'aircon', 'refrigeration', 'fridge', 'freezer', 'cold'],
    'welding':    ['welder', 'welders', 'weld', 'metal', 'steel', 'fabrication', 'gate', 'fence', 'iron', 'grill'],
    'tiling':     ['tiler', 'tilers', 'tile', 'tiles', 'floor', 'flooring', 'ceramic', 'mosaic', 'grout'],
    'cleaning':   ['cleaner', 'cleaners', 'clean', 'mop', 'sweep', 'laundry', 'wash', 'housekeeping', 'domestic', 'dusting'],
    'masonry':    ['mason', 'masons', 'brick', 'bricks', 'concrete', 'block', 'blocks', 'foundation', 'screed', 'plastering'],
    'roofing':    ['roofer', 'roofers', 'roof', 'gutter', 'gutters', 'waterproofing', 'flashing'],
};

/**
 * Build the searchKeywords array from an artisan's Firestore document data.
 *
 * Produces:
 *   - Full name + each name token (for "Kwame Asante" → ["kwame asante", "kwame", "asante"])
 *   - specialty and category verbatim
 *   - All synonyms for the artisan's category (e.g. "plumbing" → ["plumber", "pipe", ...])
 *   - Natural-language intent phrases ("emergency plumber", "fix plumbing", "repair plumbing")
 *   - Any artisan- or admin-supplied commonSearchPhrases
 *
 * @param {object} data  Artisan Firestore document data
 * @returns {string[]}   Deduplicated lowercase keyword array
 */
function buildSearchKeywords(data) {
    const terms = new Set();

    const name      = (data.name      || '').toLowerCase().trim();
    const specialty = (data.specialty || '').toLowerCase().trim();
    const category  = (data.category  || '').toLowerCase().trim();

    if (name) {
        terms.add(name);
        name.split(/\s+/).filter(Boolean).forEach(w => terms.add(w));
    }
    if (specialty) terms.add(specialty);
    if (category)  terms.add(category);

    const synonyms = CATEGORY_SYNONYMS[category] || CATEGORY_SYNONYMS[specialty] || [];
    synonyms.forEach(s => terms.add(s));

    const primary = specialty || category;
    if (primary) {
        terms.add(`emergency ${primary}`);
        terms.add(`fix ${primary}`);
        terms.add(`repair ${primary}`);
    }

    (data.commonSearchPhrases || []).forEach(p => {
        if (p) terms.add(String(p).toLowerCase().trim());
    });

    return [...terms].filter(Boolean);
}

module.exports = { buildSearchKeywords, CATEGORY_SYNONYMS };
