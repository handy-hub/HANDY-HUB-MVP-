/**
 * artisanDevData.js — structured mock DATA for artisan screens under Development
 * Access Mode. Pairs with artisanDevSession.js (which supplies the artisan record
 * + selected state). This module supplies the per-screen LISTS (job requests,
 * active jobs, schedule, notification count) so screens render realistic content
 * instead of blank empty-states.
 *
 * Bookings match the shape the pages' render functions expect: { id, data:{…} }.
 * Deliberately non-production (dev-* ids). Never written to Firestore.
 *
 * Consumers gate on isArtisanDevAccessEnabled() before using this, and skip the
 * real Firestore subscriptions in dev so nothing hits or writes production data.
 */

const nowIso = () => new Date().toISOString();
const minsAgo = (m) => new Date(Date.now() - m * 60_000).toISOString();
const inHours = (h) => new Date(Date.now() + h * 3_600_000).toISOString();
// responseDeadline is read as seconds (× 1000) → a future countdown.
const deadlineInMin = (m) => Math.floor((Date.now() + m * 60_000) / 1000);

function booking(id, data) { return { id: `dev-bk-${id}`, data }; }

const REQUESTS = [
    booking('req-1', {
        serviceType: 'Electrical fault — no power', address: 'East Legon, Accra',
        total: 120, type: 'standard', status: 'pending',
        createdAt: minsAgo(6), responseDeadline: deadlineInMin(25),
    }),
    booking('req-2', {
        serviceType: 'Socket & switch installation', address: 'Osu, Accra',
        total: 90, type: 'standard', status: 'pending', createdAt: minsAgo(41),
    }),
];

const ACTIVE = [
    booking('act-1', {
        serviceType: 'Ceiling fan wiring', address: 'Cantonments, Accra',
        status: 'in_progress', track: 'standard',
        acceptedAt: minsAgo(90), createdAt: minsAgo(140), updatedAt: minsAgo(20),
    }),
    booking('act-2', {
        serviceType: 'Water heater install', address: 'Airport Residential, Accra',
        status: 'accepted', track: 'standard',
        acceptedAt: minsAgo(15), createdAt: minsAgo(30), updatedAt: minsAgo(15),
    }),
];

const SCHEDULE = [
    booking('sch-1', {
        serviceType: 'Rewiring consultation', address: 'Spintex, Accra',
        status: 'accepted', createdAt: minsAgo(200), scheduledAt: inHours(3),
    }),
    booking('sch-2', {
        serviceType: 'Breaker replacement', address: 'Tema Community 1',
        status: 'accepted', createdAt: minsAgo(300), scheduledAt: inHours(26),
    }),
];

const EMPTY = { jobRequests: [], activeJobs: [], schedule: [], unreadCount: 0 };

// Per-state data. Non-approved states enter the dashboard (allowPending) but show
// the KYC banner + empty work lists, which is the correct real behaviour.
const BY_STATE = {
    approved_active:     { jobRequests: REQUESTS,             activeJobs: ACTIVE,            schedule: SCHEDULE,            unreadCount: 3 },
    approved_completed:  { jobRequests: REQUESTS.slice(0, 1), activeJobs: ACTIVE.slice(0, 1), schedule: SCHEDULE.slice(0, 1), unreadCount: 1 },
    approved_no_jobs:    EMPTY,
    new_artisan:         EMPTY,
    onboarding_incomplete: EMPTY,
    pending_approval:    EMPTY,
};

/** Dashboard lists for the selected dev state. */
export function getDevDashboardData(stateKey) {
    const d = BY_STATE[stateKey] || EMPTY;
    // Return shallow clones so consumers can't mutate the shared fixtures.
    return {
        jobRequests: d.jobRequests.map(b => ({ id: b.id, data: { ...b.data } })),
        activeJobs:  d.activeJobs.map(b => ({ id: b.id, data: { ...b.data } })),
        schedule:    d.schedule.map(b => ({ id: b.id, data: { ...b.data } })),
        unreadCount: d.unreadCount,
    };
}
