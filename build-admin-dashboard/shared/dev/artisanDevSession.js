/**
 * artisanDevSession.js — the ONE canonical development artisan session.
 *
 * When Artisan Development Access Mode is active (see shared/js/config/devAccess.js),
 * this is the single source of the mock artisan record and Firebase-user stand-in
 * that the route guard resolves instead of real auth. Every artisan page therefore
 * sees ONE consistent artisan across dashboard, jobs, bookings, wallet, profile,
 * settings, etc. — no page hardcodes its own fake values.
 *
 * The selected state lives in localStorage so it survives refreshes and deep links.
 * Switching states (via the dev switcher widget) reloads the page so the guard
 * re-resolves cleanly — exactly as a real auth/state change would.
 *
 * IMPORTANT: this data is deliberately, obviously non-production (uid 'dev-artisan-*',
 * @dev.handyhub emails). It is never written to Firestore by this module.
 */

export const DEV_STORAGE_KEY = 'hh_dev_artisan_state';
export const DEV_UID = 'dev-artisan-0001';
const NOW = '2026-07-17T00:00:00.000Z';

// Base record — real field shape the artisan app + guard expect. States below
// override only what differs, so every state stays consistent by construction.
const BASE = {
    id: DEV_UID,
    uid: DEV_UID,
    name: 'Kwabena Mensah',
    fullName: 'Kwabena Mensah',
    email: 'kwabena@dev.handyhub',
    phone: '0244000000',
    userType: 'artisan',
    status: 'active',
    verificationStatus: 'approved',
    category: 'Electrical',
    specialty: 'Electrical',
    skills: ['Wiring', 'Fault finding', 'Installations'],
    bio: 'Certified electrician. (Development mock artisan.)',
    profileImageId: null,          // → falls back to initials avatar
    profileImageVersion: null,
    location: 'Accra, Ghana',
    workRadius: 10,
    baseRate: 80,
    isOnline: true,
    isAvailable: true,
    rating: 4.8,
    reviewCount: 62,
    jobsCompleted: 148,
    completionRate: 97,
    responseRate: 95,
    availableBalance: 1240.5,
    pendingBalance: 180,
    totalEarned: 15840,
    withdrawnTotal: 14600,
    walletBalance: 1240.5,
    createdAt: NOW,
    updatedAt: NOW,
};

function make(overrides) { return { ...BASE, ...overrides }; }

/**
 * Ordered list of development states. `gate` mirrors what the REAL guard would do
 * for that record, so dev mode faithfully reproduces each access outcome:
 *   'enter'      → resolves into the app shell
 *   'suspended'  → suspended overlay
 *   'pending'    → KYC-pending overlay (on approval-required pages)
 *   'unauthorized' → error/unauthorized overlay
 */
export const DEV_STATES = [
    {
        key: 'new_artisan',
        label: 'New Artisan',
        note: 'Just registered — nothing completed.',
        gate: 'enter',
        artisan: make({
            name: 'New Dev Artisan', fullName: 'New Dev Artisan',
            verificationStatus: 'draft', status: 'pending',
            category: '', specialty: '', skills: [], bio: '',
            isOnline: false, isAvailable: false,
            rating: 0, reviewCount: 0, jobsCompleted: 0, completionRate: 0, responseRate: 0,
            availableBalance: 0, pendingBalance: 0, totalEarned: 0, withdrawnTotal: 0, walletBalance: 0,
        }),
    },
    {
        key: 'onboarding_incomplete',
        label: 'Onboarding Incomplete',
        note: 'Some profile fields, KYC not submitted.',
        gate: 'enter',
        artisan: make({
            verificationStatus: 'draft', status: 'pending',
            isOnline: false, isAvailable: false,
            rating: 0, reviewCount: 0, jobsCompleted: 0, completionRate: 0, responseRate: 0,
            availableBalance: 0, pendingBalance: 0, totalEarned: 0, withdrawnTotal: 0, walletBalance: 0,
        }),
    },
    {
        key: 'pending_approval',
        label: 'Pending Approval',
        note: 'Onboarding complete, awaiting admin review.',
        gate: 'pending',
        artisan: make({
            verificationStatus: 'pending_review', status: 'pending',
            isOnline: false, isAvailable: false,
            jobsCompleted: 0, totalEarned: 0, availableBalance: 0, pendingBalance: 0, walletBalance: 0,
        }),
    },
    {
        key: 'approved_no_jobs',
        label: 'Approved — No Jobs',
        note: 'Verified, but no bookings yet (empty states).',
        gate: 'enter',
        artisan: make({
            jobsCompleted: 0, completionRate: 0, responseRate: 100, reviewCount: 0, rating: 0,
            availableBalance: 0, pendingBalance: 0, totalEarned: 0, withdrawnTotal: 0, walletBalance: 0,
        }),
    },
    {
        key: 'approved_active',
        label: 'Approved — Active Jobs',
        note: 'The default. Verified with live work + earnings.',
        gate: 'enter',
        artisan: make({}),   // the rich BASE record
    },
    {
        key: 'approved_completed',
        label: 'Approved — Completed + Earnings',
        note: 'Long history, healthy wallet.',
        gate: 'enter',
        artisan: make({
            jobsCompleted: 312, reviewCount: 140, rating: 4.9,
            availableBalance: 3820, pendingBalance: 0, totalEarned: 41200, withdrawnTotal: 37380, walletBalance: 3820,
        }),
    },
    {
        key: 'suspended',
        label: 'Suspended / Restricted',
        note: 'Account restricted — suspended overlay.',
        gate: 'suspended',
        artisan: make({ status: 'suspended' }),
    },
    {
        key: 'data_error',
        label: 'Data / Offline Error',
        note: 'Simulates a failed profile load.',
        gate: 'unauthorized',
        artisan: null,
    },
];

const DEFAULT_STATE = 'approved_active';

export function listDevStates() {
    return DEV_STATES.map(({ key, label, note, gate }) => ({ key, label, note, gate }));
}

export function getDevStateKey() {
    try {
        const k = localStorage.getItem(DEV_STORAGE_KEY);
        if (k && DEV_STATES.some(s => s.key === k)) return k;
    } catch { /* storage blocked */ }
    return DEFAULT_STATE;
}

export function setDevStateKey(key) {
    if (!DEV_STATES.some(s => s.key === key)) return;
    try { localStorage.setItem(DEV_STORAGE_KEY, key); } catch { /* non-fatal */ }
}

/** Clear the selected dev state (used by dev-mode logout). */
export function endDevSession() {
    try { localStorage.removeItem(DEV_STORAGE_KEY); } catch { /* non-fatal */ }
}

/**
 * Resolve the current development session.
 * @returns {{ stateKey, gate, user, artisan }}
 *   user/artisan mirror what requireArtisanAuth resolves in production; artisan is
 *   null for the data-error state so the guard can exercise its error path.
 */
export function getDevArtisanSession() {
    const stateKey = getDevStateKey();
    const state = DEV_STATES.find(s => s.key === stateKey) || DEV_STATES.find(s => s.key === DEFAULT_STATE);
    const artisan = state.artisan ? { ...state.artisan } : null;
    const user = {
        uid: DEV_UID,
        email: artisan?.email || 'dev@dev.handyhub',
        displayName: artisan?.name || 'Dev Artisan',
        emailVerified: true,
        _devMock: true,
    };
    return { stateKey: state.key, gate: state.gate, user, artisan };
}
