import { requireAuth }                  from '../../shared/js/utils/authGuard.js';
import { flushPendingBookingWrites }     from '../../shared/js/utils/bookingConfirmNotify.js';
import { initializePushNotifications }  from '../../shared/js/services/pushNotificationService.js';
import { initQuoteModal, destroyQuoteModal } from './quoteModalService.js';

const user = await requireAuth();

if (user && user.uid) {
    // Request push notification permission and register FCM token.
    // Fire-and-forget — never blocks page load or other init steps.
    initializePushNotifications(user.uid, 'customer').catch(() => {});

    try {
        const { getAppContainer } = await import('../../shared/js/app/container.js');
        const container = getAppContainer();
        const { services: { databaseService }, repositories: { bookingRepository } } = container;

        // ── Real-time notification badge ─────────────────────────────────────
        // helpers.js exposes window.HH_initNotifications; dashboardBadge.js also
        // manages the badge on its own pages. Both are safe to call here — the
        // subscription is idempotent and the DOM guard inside helpers.js is a no-op
        // when the element doesn't exist.
        if (typeof window.HH_initNotifications === 'function') {
            window.HH_initNotifications(databaseService, user.uid);
        }

        // ── Flush bookings that failed to reach Firestore last session ────────
        flushPendingBookingWrites(databaseService).catch(() => {});

        // ── Seed booking history from Firestore ───────────────────────────────
        // localStorage history is the source for bookingService.classify() and
        // the book-step4 instant render. On a new device (or after a cache clear)
        // the array is empty, making tabs like "Upcoming" appear blank even when
        // Firestore has data. We overwrite the local cache with the Firestore
        // truth on every login so cross-device divergence is resolved immediately.
        if (window.HH_State && bookingRepository) {
            bookingRepository.getByCustomerId(user.uid, { limit: 50 })
                .then(function (records) {
                    if (!Array.isArray(records) || records.length === 0) return;

                    // Map Firestore booking documents to the shape bookingService.js expects
                    var mapped = records.map(function (r) {
                        return {
                            id:          r.id,
                            service:     r.serviceType  || r.service     || '',
                            category:    r.category     || '',
                            proName:     r.proName      || '',
                            proType:     r.proType      || '',
                            proPhoto:    r.proPhoto     || null,
                            proPhone:    r.proPhone     || null,
                            proRating:   r.proRating    || null,
                            artisanId:   r.artisanId    || null,
                            dateDisplay: r.dateDisplay  || '',
                            date:        r.date         || (r.createdAt ? r.createdAt.slice(0, 10) : ''),
                            time:        r.time         || '',
                            total:       Number(r.total || r.price || 0),
                            payment:     r.payment      || 'Wallet',
                            notes:       r.notes        || '',
                            address:     r.address      || '',
                            status:      r.status       || 'pending',
                            type:        r.type         || 'standard',
                            ts:          r.createdAt    || '',
                            reviewLeft:  r.reviewLeft   || false,
                        };
                    });

                    // Write directly to the uid-scoped key (single localStorage write
                    // instead of 50 individual push() calls which each stringify the array).
                    var histKey = window.HH_State.scopedKey('hh_booking_history');
                    try { localStorage.setItem(histKey, JSON.stringify(mapped)); } catch (_) {}
                })
                .catch(function () {});
        }

    } catch (_) {}

    // Quote approval modal — active on every page that imports authInit
    initQuoteModal(user.uid);
    window.addEventListener('pagehide', () => destroyQuoteModal(), { once: true });
}
