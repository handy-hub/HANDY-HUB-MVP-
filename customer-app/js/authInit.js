import { requireAuth }                  from '../../shared/js/utils/authGuard.js';
import { flushPendingBookingWrites }     from '../../shared/js/utils/bookingConfirmNotify.js';
import { initializePushNotifications }  from '../../shared/js/services/pushNotificationService.js';
import { initQuoteModal, destroyQuoteModal } from './quoteModalService.js';
import { totalCharged }                  from '../../shared/js/domain/bookingTruth.js';

const user = await requireAuth();

if (user && user.uid) {
    // Request push notification permission and register FCM token.
    // Fire-and-forget — never blocks page load or other init steps.
    initializePushNotifications(user.uid, 'customer').catch((err) => {
        console.warn('[authInit] push notification init failed:', err);
    });

    try {
        const { getAppContainer } = await import('../../shared/js/app/container.js');
        const container = getAppContainer();
        const { services: { databaseService }, repositories: { bookingRepository } } = container;

        // ── Real-time notification badge ─────────────────────────────────────
        // helpers.js exposes window.HH_initNotifications; dashboardBadge.js also
        // manages the badge on its own pages. Both are safe to call here — the
        // subscription is idempotent and the DOM guard inside helpers.js is a no-op
        // when the element doesn't exist.
        let _unsubNotifBadge;
        if (typeof window.HH_initNotifications === 'function') {
            _unsubNotifBadge = window.HH_initNotifications(databaseService, user.uid);
        }

        // ── Flush bookings that failed to reach Firestore last session ────────
        flushPendingBookingWrites(databaseService).catch((err) => {
            console.warn('[authInit] pending booking flush failed:', err);
        });

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

                    // SHAPE: queryWithOptions returns toRecord() = { id, data }.
                    // This mapper previously read flat fields straight off that
                    // wrapper, so EVERY field except `id` resolved to undefined and
                    // fell to its default — the seeded cache looked populated while
                    // carrying `total: 0`, `status: 'pending'`, `service: ''` for
                    // every booking. `total: 0` is what fed the receipt's
                    // `(state.total || last.total || 65)`: zero is falsy, so the
                    // hardcoded literal won. Read from `r.data`.
                    var mapped = records.map(function (r) {
                        var d = (r && r.data) ? r.data : (r || {});
                        // Money lives in calloutFee/jobQuote on the inspection track;
                        // `total`/`price` do not exist there. totalCharged() is the one
                        // projection that knows the difference, and returns null — not
                        // zero — when the amount is genuinely unresolved.
                        var charged = totalCharged(d);
                        return {
                            id:          r.id,
                            service:     d.serviceType  || d.service     || '',
                            category:    d.category     || '',
                            proName:     d.artisanName  || d.proName     || '',
                            proType:     d.artisanCategory || d.proType  || '',
                            proPhoto:    d.artisanPhoto || d.proPhoto    || null,
                            proRating:   d.artisanRating ?? d.proRating  ?? null,
                            artisanId:   d.artisanId    || null,
                            dateDisplay: d.dateDisplay  || '',
                            date:        d.date         || (d.createdAt ? String(d.createdAt).slice(0, 10) : ''),
                            time:        d.time         || '',
                            // null means UNRESOLVED and must render as an absent
                            // state. It must never be coerced to 0, which reads as
                            // "free" and previously collapsed into an invented 65.
                            total:       charged,
                            payment:     d.payment      || 'Wallet',
                            notes:       d.notes        || '',
                            address:     d.address      || '',
                            status:      d.status       || null,
                            type:        d.type         || 'standard',
                            ts:          d.createdAt    || '',
                            reviewLeft:  d.rating != null,
                        };
                    });

                    // Write directly to the uid-scoped key (single localStorage write
                    // instead of 50 individual push() calls which each stringify the array).
                    var histKey = window.HH_State.scopedKey('hh_booking_history');
                    try { localStorage.setItem(histKey, JSON.stringify(mapped)); } catch (_) {}
                })
                .catch(function (err) {
                    console.warn('[authInit] booking history seed failed:', err);
                });
        }

    } catch (err) {
        console.warn('[authInit] init block failed:', err);
    }

    // Quote approval modal — active on every page that imports authInit
    initQuoteModal(user.uid);
    window.addEventListener('pagehide', () => {
        if (typeof _unsubNotifBadge === 'function') _unsubNotifBadge();
        destroyQuoteModal();
    }, { once: true });
}
