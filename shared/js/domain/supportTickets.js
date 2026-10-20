/**
 * supportTickets.js — what a support request is (AR-11).
 *
 * Pure (no imports): the artisan support page, the admin support screen and
 * tests/support-tickets read the same statuses, topics and limits.
 * firestore.rules (support_tickets) enforces the same limits server-side.
 *
 *   support_tickets/{id}                 the request — owner + support admins
 *   support_tickets/{id}/messages/{mid}  the conversation — owner + support admins
 */

export const TICKET_STATUS = Object.freeze({
    OPEN:        'open',          // waiting for support
    IN_PROGRESS: 'in_progress',   // support is working on it
    ANSWERED:    'answered',      // support replied; waiting for the user
    CLOSED:      'closed',        // finished; no more replies
});

export const TICKET_TOPICS = Object.freeze([
    { id: 'payment',   label: 'Payment / Earnings issue' },
    { id: 'booking',   label: 'Booking problem' },
    { id: 'kyc',       label: 'KYC / Verification' },
    { id: 'account',   label: 'Account issue' },
    { id: 'technical', label: 'App not working' },
    { id: 'other',     label: 'Other' },
]);

export const TICKET_LIMITS = Object.freeze({ messageMin: 20, messageMax: 2000, replyMax: 2000 });

/** @returns {{ ok: boolean, error?: string }} */
export function validateTicket({ subject, message } = {}) {
    if (!TICKET_TOPICS.some((t) => t.id === subject)) return { ok: false, error: 'Please select a topic.' };
    const m = String(message || '').trim();
    if (!m) return { ok: false, error: 'Please describe your issue.' };
    if (m.length < TICKET_LIMITS.messageMin) {
        return { ok: false, error: `Please give a little more detail (at least ${TICKET_LIMITS.messageMin} characters).` };
    }
    if (m.length > TICKET_LIMITS.messageMax) {
        return { ok: false, error: `Please keep it under ${TICKET_LIMITS.messageMax} characters.` };
    }
    return { ok: true };
}

/** @returns {{ ok: boolean, error?: string }} */
export function validateReply(body) {
    const b = String(body || '').trim();
    if (!b) return { ok: false, error: 'Write a message first.' };
    if (b.length > TICKET_LIMITS.replyMax) return { ok: false, error: `Please keep it under ${TICKET_LIMITS.replyMax} characters.` };
    return { ok: true };
}

/** Status wording, for the person who raised it or for support staff. */
export function ticketStatusLabel(status, audience = 'user') {
    const staff = audience === 'support';
    switch (status) {
        case TICKET_STATUS.OPEN:        return staff ? 'Open — needs a reply' : 'Sent — waiting for support';
        case TICKET_STATUS.IN_PROGRESS: return staff ? 'In progress' : 'Support is looking into it';
        case TICKET_STATUS.ANSWERED:    return staff ? 'Answered — waiting for user' : 'Support replied';
        case TICKET_STATUS.CLOSED:      return 'Closed';
        default:                        return 'Unknown';
    }
}

/** The topic's label, or the raw id. */
export function topicLabel(id) {
    const t = TICKET_TOPICS.find((x) => x.id === id);
    return t ? t.label : String(id || '');
}
