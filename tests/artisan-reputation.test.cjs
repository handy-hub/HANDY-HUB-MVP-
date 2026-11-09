'use strict';
/**
 * tests/artisan-reputation.test.cjs — the artisan's Reputation says only what
 * production does (Phase 4).
 *
 * Every figure is held against the code that decides it: the artisan's real
 * dispatch index entry (functions/artisanIndex.js _buildIndexDoc +
 * applyLiveness), scored by the real ranking function (performanceMetrics
 * scoreCandidate, which functions/dispatch.js uses). Where the screen says a
 * figure "counts" or "does not count yet", the algorithm must agree — at each
 * threshold boundary. No figure is shown below its minimum sample, and nothing
 * is claimed to help matching that the algorithm ignores (completion rate,
 * levels).
 */
require('./support/no-production.cjs');   // must stay the first statement (npm run lint:tests)

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const { pathToFileURL } = require('url');

require('./support/fake-firebase.cjs').install();
const ROOT = path.join(__dirname, '..');
const artisanIndex = require(path.join(ROOT, 'functions', 'artisanIndex.js'));
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

let passed = 0, failed = 0;
const failures = [];
async function t(name, fn) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { failed++; failures.push([name, e]); console.log(`  ✗ ${name}\n      ${e.message}`); }
}

(async () => {
const rep = await import(pathToFileURL(path.join(ROOT, 'shared', 'js', 'domain', 'artisanReputation.js')).href);
const pm  = await import(pathToFileURL(path.join(ROOT, 'shared', 'js', 'domain', 'performanceMetrics.js')).href);
const NOW = Date.UTC(2026, 10, 7, 10, 0, 0);
const MIN = 60_000;

const base = { status: 'active', verificationStatus: 'approved', isAvailable: true, isOnline: true,
               lastHeartbeat: new Date(NOW - 2 * MIN).toISOString(), workRadius: 15, jobsCompleted: 0 };
/** The real index entry and the real score parts for this artisan profile. */
function dispatchSees(profile, nowMs = NOW) {
    const doc = artisanIndex._buildIndexDoc('a1', profile, 5.6, -0.19);
    const [live] = artisanIndex.applyLiveness([{ id: 'a1', ...doc }], nowMs);
    return pm.scoreCandidate({ ...live, _distKm: 2 }).parts;
}

console.log('\n── Rating: counted from 3 reviews, never before ──\n');

await t('boundaries: 0, 2 → not enough yet (no number); 3 → the rating, and dispatch counts it', () => {
    for (const [count, measured] of [[0, false], [2, false], [3, true], [10, true]]) {
        const a = { ...base, rating: 4.6, reviewCount: count };
        const r = rep.ratingFigure(a);
        assert.strictEqual(r.measured, measured, `${count} reviews`);
        assert.strictEqual(r.value, measured ? 4.6 : null, 'no number below the minimum');
        assert.strictEqual(r.needed, Math.max(0, 3 - count));
        assert.strictEqual(dispatchSees(a).rating.measured, measured, `dispatch agrees at ${count}`);
    }
});

await t('below the minimum dispatch counts the neutral 4.0 — the screen says exactly that', () => {
    const a = { ...base, rating: 2.0, reviewCount: 2 };
    assert.strictEqual(dispatchSees(a).rating.value, 4.0);
    const f = rep.matchingFactors({ rating: rep.ratingFigure(a), response: rep.responseFigure(a), completion: rep.completionFigure([]), online: rep.onlineFigure(a, NOW) });
    assert.strictEqual(f.find((x) => x.key === 'rating').yours, 'Counted as 4.0 until you have 3 reviews');
});

await t('a review count with an unusable score is a fault, not a zero-star rating', () => {
    const r = rep.ratingFigure({ reviewCount: 4, rating: 0 });
    assert.deepStrictEqual([r.measured, r.value, r.fault], [false, null, true]);
});

console.log('\n── Response rate: 5 requests in 90 days, from the server ──\n');

await t('boundaries: 4 counted → not enough yet; 5 → the rate, and dispatch counts it', () => {
    for (const [counted, sufficient] of [[0, false], [4, false], [5, true]]) {
        const rs = { responded: counted, missed: 0, counted, rate: sufficient ? 0.8 : null, sufficient, computedAt: '2026-11-07T09:00:00.000Z' };
        const a = { ...base, responseStats: rs };
        const f = rep.responseFigure(a);
        assert.strictEqual(f.measured, sufficient, `${counted}`);
        assert.strictEqual(f.pct, sufficient ? 80 : null);
        assert.strictEqual(f.needed, Math.max(0, 5 - counted));
        assert.strictEqual(dispatchSees(a).response.measured, sufficient, `dispatch agrees at ${counted}`);
    }
    assert.deepStrictEqual({ ...pm.RESPONSE_RATE_POLICY }, { windowDays: 90, minOffers: 5 });
});

console.log('\n── Completion rate: shown as a record, and NOT used for matching ──\n');

await t('boundaries: 4 ended → not enough yet; 5 → the rate (completed ÷ completed + cancelled by you)', () => {
    const ended = (c, x) => [...Array(c).fill({ status: 'completed' }), ...Array(x).fill({ status: 'cancelled', cancelledBy: 'artisan' })];
    assert.strictEqual(rep.completionFigure(ended(3, 1)).pct, null);
    assert.strictEqual(rep.completionFigure(ended(4, 1)).pct, 80);
    const others = [...ended(4, 0), { status: 'cancelled', cancelledBy: 'customer' }, { status: 'cancelled', cancelledBy: 'system' }, { status: 'cancelled' }];
    assert.strictEqual(rep.completionFigure(others).ended, 4, 'only cancellations by the artisan count against them');
});

await t('dispatch does not measure it today (artisan_index writes null) — the screen never says it helps', () => {
    assert.match(read('functions/artisanIndex.js'), /completionRate:\s+null,/);
    const a = { ...base };
    const parts = dispatchSees(a);
    assert.deepStrictEqual([parts.completion.measured, parts.completion.value], [false, 0.8], 'the same neutral value for everyone');
    const c = rep.completionFigure([]);
    assert.strictEqual(c.usedInMatching, false);
    const f = rep.matchingFactors({ rating: rep.ratingFigure(a), response: rep.responseFigure(a), completion: c, online: rep.onlineFigure(a, NOW) });
    assert.deepStrictEqual([f.find((x) => x.key === 'completion').counts, f.find((x) => x.key === 'completion').effect], [false, 'Not used yet']);
});

console.log('\n── Online: seen in the app within 15 minutes ──\n');

await t('the window is the server\'s; 14:59 ago counts, 15:01 does not — as dispatch decides', () => {
    assert.strictEqual(rep.LIVENESS_WINDOW_MS, artisanIndex.LIVENESS_WINDOW_MS);
    // The index rounds the heartbeat down to its 5-minute bucket, so compare on a bucket boundary.
    const bucket = artisanIndex.LIVENESS_BUCKET_MS;
    const seenAt = Math.floor((NOW - 5 * MIN) / bucket) * bucket;
    for (const [nowMs, online] of [[seenAt + 15 * MIN - 1000, true], [seenAt + 15 * MIN + 1000, false]]) {
        const a = { ...base, lastHeartbeat: new Date(seenAt).toISOString() };
        assert.strictEqual(rep.onlineFigure(a, nowMs).onlineNow, online, `${(nowMs - seenAt) / 1000}s`);
        assert.strictEqual(dispatchSees(a, nowMs).online.value, online, 'dispatch agrees');
    }
    assert.strictEqual(rep.onlineFigure({ ...base, isOnline: false }, NOW).onlineNow, false, 'online needs the stored flag too');
});

console.log('\n── Who can be offered a job, and levels ──\n');

await t('eligibility is the dispatch filters: verified, active, available, within the work radius (20 km unset)', () => {
    assert.deepStrictEqual(rep.eligibility(base), { verified: true, active: true, available: true, workRadiusKm: 15, radiusDefaulted: false });
    assert.strictEqual(rep.eligibility({ ...base, workRadius: undefined }).workRadiusKm, 20);
    assert.match(read('functions/dispatch.js'), /if \(dist > \(a\.workRadius \|\| 20\)\) return false;/);
    assert.match(read('functions/dispatch.js'), /\.where\('isAvailable',\s+'==', true\)\s*\.where\('status',\s+'==', 'active'\)\s*\.where\('verificationStatus', '==', 'approved'\)/);
});

await t('levels are milestones by completed jobs and change nothing in matching', () => {
    assert.deepStrictEqual([0, 19, 20, 49, 50, 99, 100].map((j) => rep.levelFigure({ jobsCompleted: j }).name),
                           ['New', 'New', 'Rising', 'Rising', 'Pro', 'Pro', 'Top Pro']);
    assert.deepStrictEqual(rep.levelFigure({ jobsCompleted: 12 }).next, { name: 'Rising', from: 20, toGo: 8 });
    const low = dispatchSees({ ...base, jobsCompleted: 0 }), high = dispatchSees({ ...base, jobsCompleted: 500 });
    assert.strictEqual(pm.scoreCandidate({ ...low }).score, pm.scoreCandidate({ ...high }).score, 'jobsCompleted does not move the score');
    assert.deepStrictEqual(Object.keys(low).sort(), ['completion', 'distance', 'online', 'rating', 'response'], 'the five inputs, no level');
});

await t('the factors quote the algorithm\'s own weights', () => {
    const a = { ...base, rating: 4.8, reviewCount: 7, responseStats: { counted: 9, responded: 9, missed: 0, rate: 1, sufficient: true } };
    const f = rep.matchingFactors({ rating: rep.ratingFigure(a), response: rep.responseFigure(a), completion: rep.completionFigure([]), online: rep.onlineFigure(a, NOW) });
    const W = pm.DISPATCH_WEIGHTS;
    assert.deepStrictEqual(f.map((x) => x.effect), [`${W.perKm} points less for every km`, `${W.online} points`, `${W.rating} points per star`, `Up to ${W.response} points`, 'Not used yet']);
    assert.deepStrictEqual(f.map((x) => x.yours).slice(1, 4), ['Online now', '4.8 counts', '100% counts']);
});

console.log('\n── Reviews: as the customers left them, and checked against the server\'s count ──\n');

await t('only real ratings (1–5), newest first, text as written', () => {
    const list = rep.reviewList([
        { id: 'b1', rating: 5, review: '  Great work ', reviewedAt: '2026-11-01T00:00:00.000Z', customerFirstName: 'Ama', serviceType: 'plumbing' },
        { id: 'b2', rating: 0 }, { id: 'b3', rating: 6 }, { id: 'b4', rating: 'x' },
        { id: 'b5', rating: 3, reviewedAt: '2026-11-05T00:00:00.000Z' },
    ]);
    assert.deepStrictEqual(list.map((r) => r.bookingId), ['b5', 'b1']);
    assert.deepStrictEqual([list[1].text, list[0].text], ['Great work', null]);
});

await t('the server\'s rating and count are checked against the reviews read, and a difference is reported', () => {
    const reviews = rep.reviewList([{ id: 'b1', rating: 5 }, { id: 'b2', rating: 4 }, { id: 'b3', rating: 3 }]);
    assert.deepStrictEqual(rep.ratingConsistency({ rating: 4, reviewCount: 3 }, reviews, true).ok, true);
    assert.strictEqual(rep.ratingConsistency({ rating: 4.5, reviewCount: 3 }, reviews, true).ok, false, 'a mean that differs');
    assert.strictEqual(rep.ratingConsistency({ rating: 4, reviewCount: 5 }, reviews, true).ok, false, 'a count that differs');
    assert.strictEqual(rep.ratingConsistency({ rating: 4, reviewCount: 5 }, reviews, false).checked, false, 'not every review read: no claim');
});

await t('the module invents nothing: no default rating, no fabricated figures', () => {
    const m = rep.reputationModel({ artisan: {}, nowMs: NOW });
    assert.deepStrictEqual([m.rating.value, m.response.pct, m.completion.pct, m.online.onlineNow, m.reviews.length], [null, null, null, false, 0]);
    const src = read('shared/js/domain/artisanReputation.js');
    assert.ok(!/document\.|window\.|firebase|Math\.random/.test(src));
});

console.log('\n── What the screen reads, and recent activity ──\n');

await t('reviews come from the finished bookings read; "all of them" only when the read was not cut short', () => {
    const ended = [{ id: 'b1', status: 'completed', rating: 5, reviewedAt: '2026-11-02T10:00:00.000Z', customerFirstName: 'Ama', serviceType: 'plumbing' },
                   { id: 'b2', status: 'completed', rating: null }, { id: 'b3', status: 'cancelled', cancelledBy: 'artisan' }];
    const m = rep.reputationModel({ artisan: { rating: 5, reviewCount: 1 }, endedBookings: ended, reviewsComplete: true, nowMs: NOW });
    assert.deepStrictEqual(m.reviews.map((r) => [r.bookingId, r.rating, r.customer]), [['b1', 5, 'Ama']]);
    assert.deepStrictEqual([m.consistency.checked, m.consistency.ok], [true, true]);
    assert.deepStrictEqual(m.scope, { complete: true, read: 3 });
    const cut = rep.reputationModel({ artisan: { rating: 5, reviewCount: 9 }, endedBookings: ended, reviewsComplete: false, nowMs: NOW });
    assert.strictEqual(cut.consistency.checked, false);
    // The read is the same query the Jobs history uses (one composite index).
    assert.deepStrictEqual([...rep.REPUTATION_STATUSES], ['completed', 'cancelled', 'resolved']);
    assert.strictEqual(rep.REPUTATION_READ_LIMIT, 200);
});

await t('recent activity: jobs completed in the last 30 days (boundary inclusive), the last job, the last review, last seen', () => {
    const day = 86_400_000;
    const at = (d) => new Date(NOW - d * day).toISOString();
    const ended = [{ status: 'completed', completedAt: at(0.5) }, { status: 'completed', completedAt: at(30) },
                   { status: 'completed', completedAt: at(30.01) }, { status: 'cancelled', updatedAt: at(1) },
                   { status: 'completed', updatedAt: at(2) }];
    const r = rep.recentActivity({ endedBookings: ended, reviews: [{ at: NOW - day }], online: { lastSeenMs: NOW - 60000 }, nowMs: NOW });
    assert.deepStrictEqual([r.days, r.completedRecent, r.lastCompletedAt, r.lastReviewAt, r.lastSeenMs],
        [30, 3, NOW - 0.5 * day, NOW - day, NOW - 60000]);
    assert.deepStrictEqual(rep.recentActivity({ nowMs: NOW }), { days: 30, completedRecent: 0, lastCompletedAt: null, lastReviewAt: null, lastSeenMs: null });
});

await t('stars are filled to the rating\'s fraction (UI-010), clamped, never rounded to a whole star', () => {
    assert.deepStrictEqual(rep.starFills(4.4), [1, 1, 1, 1, 0.4]);
    assert.deepStrictEqual(rep.starFills(4.5), [1, 1, 1, 1, 0.5]);
    assert.deepStrictEqual(rep.starFills(5), [1, 1, 1, 1, 1]);
    assert.deepStrictEqual(rep.starFills(0), [0, 0, 0, 0, 0]);
    assert.deepStrictEqual(rep.starFills(7), [1, 1, 1, 1, 1]);
    assert.deepStrictEqual(rep.starFills('x'), [0, 0, 0, 0, 0]);
});

console.log('\n── Where Reputation lives: under Account ──\n');

await t('Account links to Reputation; the nav lights Account on it and on the two pages that forward to it', () => {
    const settings = read('artisan-app/settings.html');
    // Phase 5: Account is on the design system (an fx row in "Your work").
    assert.match(settings, /<a class="fx-row" href="reputation\.html" id="reputation-row">[\s\S]*?<span class="fx-row__title">Reputation<\/span>/);
    const nav = read('artisan-app/js/artisanFloatingNav.js');
    for (const pg of ['reputation.html', 'performance.html', 'reviews.html']) {
        assert.match(nav, new RegExp(`'${pg.replace('.', '\\.')}'\\s*: 'account'`), pg);
    }
    assert.match(read('artisan-app/reputation.html'), /renderTabbar\(document\.getElementById\('tabbar'\), \{ current: 'account' \}\);/);
});

console.log(`\nartisan-reputation: ${passed} passed, ${failed} failed`);
if (failed) { for (const [n, e] of failures) console.log(`\n✗ ${n}\n${e.stack}`); process.exit(1); }
process.exit(0);
})();
