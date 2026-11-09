/**
 * shared/js/domain/artisanTrades.js — the trades an artisan can register under.
 *
 * Exactly the trades a customer can book (shared/js/data/serviceCatalog.js,
 * SERVICE_CATEGORIES[].categoryLabel — pinned equal by
 * tests/artisan-trades.test.cjs), plus "Other" for a trade Fidus X does not
 * offer yet. Decision of 2026-11-09: the registration forms used to offer
 * Tiling, Roofing, Moving, Landscaping and Security, which no customer can book,
 * so an artisan who chose one never received a job; and no trade matched the
 * customers' Gardening.
 *
 * The stored value is the catalogue label ("AC Repair"), because a booking
 * carries that label as its serviceType and dispatch matches its first word
 * against the artisan's trade (functions/dispatch.js, artisanIndex._buildSkills).
 *
 * Dependency-free: mirrored to functions/shared/artisanTrades.js by
 * scripts/build-functions-shared.cjs, so sign-up (functions/emailOtp.js),
 * profile-change requests (functions/artisanAccount.js) and the forms in the
 * app validate against the same list.
 */

/** The bookable trades, in the order the forms list them. */
export const ARTISAN_TRADES = Object.freeze([
    'Electrical', 'Plumbing', 'Carpentry', 'AC Repair', 'Welding', 'Cleaning', 'Painting', 'Gardening',
]);

/** A trade Fidus X does not offer yet: described in words and reviewed by Fidus X. */
export const OTHER_TRADE = 'Other';

/**
 * Values written before this list, read as the trade they meant: the sign-up
 * form's ids and the old onboarding labels. A value with no bookable meaning
 * (Tiling, Roofing, Moving, Security) has none, and is never guessed.
 */
const LEGACY_TRADES = Object.freeze({
    'electrical': 'Electrical', 'electrical work': 'Electrical',
    'plumbing': 'Plumbing',
    'carpentry': 'Carpentry',
    'ac': 'AC Repair', 'ac_cooling': 'AC Repair', 'ac-repair': 'AC Repair', 'ac repair': 'AC Repair',
    'ac & appliance repair': 'AC Repair', 'a/c & cooling': 'AC Repair',
    'welding': 'Welding', 'welding & fabrication': 'Welding',
    'cleaning': 'Cleaning', 'cleaning services': 'Cleaning',
    'painting': 'Painting',
    'gardening': 'Gardening', 'landscaping': 'Gardening', 'landscaping & gardening': 'Gardening',
});

/** The bookable trade a stored or submitted value means, or null. */
export function canonicalTrade(value) {
    const v = String(value == null ? '' : value).trim().toLowerCase();
    if (!v) return null;
    for (const t of ARTISAN_TRADES) if (t.toLowerCase() === v) return t;
    return Object.prototype.hasOwnProperty.call(LEGACY_TRADES, v) ? LEGACY_TRADES[v] : null;
}

/** True only for one of the bookable trades, exactly as stored. */
export function isArtisanTrade(value) {
    return ARTISAN_TRADES.includes(value);
}

/** True for "Other" in any case. */
export function isOtherTrade(value) {
    return String(value == null ? '' : value).trim().toLowerCase() === 'other';
}
