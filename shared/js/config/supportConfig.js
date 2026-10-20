/**
 * supportConfig.js — the support contact details users are shown.
 *
 * EMPTY ON PURPOSE (AR-11, 2026-10-20). The artisan support page showed
 * wa.me/233000000000 and tel:+233000000000 — placeholders — beside two
 * different addresses (support@handyhub.app and support@handyhub.com) that
 * nobody has confirmed are monitored, under a brand the product no longer
 * uses, and promised "Mon–Fri, 8am–6pm" and "under 2 hours" with no process
 * behind either.
 *
 * Fill a value ONLY with a channel the owner has confirmed is staffed. Each
 * card appears on the support pages only when its value is set; until then the
 * in-app request (support_tickets, answered from admin-dashboard/support.html)
 * is the support channel, and it is described as exactly that.
 *
 *   email      'help@example.com'
 *   phone      '+233XXXXXXXXX'   (E.164, shown and dialled as given)
 *   whatsapp   '233XXXXXXXXX'    (digits only, for wa.me links)
 *   hours      'Mon–Fri, 8am–6pm GMT'  (only if those hours are actually staffed)
 */
export const SUPPORT_CONTACTS = Object.freeze({
    email:    null,
    phone:    null,
    whatsapp: null,
    hours:    null,
});
