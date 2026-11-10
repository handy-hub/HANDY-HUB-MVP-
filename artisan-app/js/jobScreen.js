/**
 * artisan-app/js/jobScreen.js — one booking, from request to closed (Phase 2).
 *
 * jobPlan() decides what the screen offers; renderJob() draws it. Neither
 * touches Firebase. Every decision is a shared module's:
 *   the step             bookingTruth.resolveJourney (only what the rules accept)
 *   cancel or get help   bookingActions.artisanCanCancel
 *   the booked slot      bookingSchedule.resolveSchedule / canStartWork
 *   the offer            artisanToday.offerView (server countdown, visit fee as charged)
 *   what may be shown    bookingTruth.resolveJobBrief (address, phone, name only once disclosed)
 * job.html owns the data and runs the actions, found through data-act.
 */
import { icon } from './fx/icons.js';
import { countdownUrgency } from './fx/controls.js';
import { resolveJourney, journeyStages, resolveJobBrief, formatDistance, formatMoney, JOB_PHASE } from '../../shared/js/domain/bookingTruth.js';
import { resolveSchedule, canStartWork } from '../../shared/js/domain/bookingSchedule.js';
import { artisanCanCancel } from '../../shared/js/domain/bookingActions.js';
import { offerView } from '../../shared/js/domain/artisanToday.js';
import { formatTimeLeft, LAPSED_OFFER_LABEL, LAPSED_OFFER_STATE_ATTRS } from '../../shared/js/domain/jobOffers.js';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** resolveJourney's op → what this screen runs. submitQuote is the composer, not a button. */
export const STEP_ACTS = Object.freeze({
    enRoute:            'en-route',
    arrived:            'arrived',
    completeInspection: 'complete-inspection',
    markDone:           'job-done',
});

const CHIP_TONE = { action: 'fx-chip--accent', live: 'fx-chip--info', waiting: 'fx-chip--warn', ended: '' };

/**
 * What the screen offers for this booking (or offer summary), right now.
 * @param {object} b  the booking, or { id, ...job_offers data } before acceptance
 * @param {{ offerGone?: boolean, nowMs?: number }} [opts]
 */
export function jobPlan(b, { offerGone = false, nowMs = Date.now() } = {}) {
    const schedule = resolveSchedule(b, nowMs);
    const journey = resolveJourney(b, 'artisan', { schedule });
    const brief = resolveJobBrief(b);
    const phase = brief.phase;

    if (phase === JOB_PHASE.REQUEST) {
        const offer = offerView(b, nowMs);
        const lapsed = !offer.answerable || offerGone;
        return {
            kind: 'offer', journey, schedule, offer, lapsed,
            lapsedNote: !lapsed ? null : offerGone ? 'This request is no longer open to you.'
                                               : 'The response time ran out. It is being offered to another professional.',
        };
    }

    // Cancel only where the server accepts it; otherwise the way out is Support
    // (Phase 0 WF-01): approved work is never "cancelled" by a button that fails.
    const help = artisanCanCancel(b)
        ? { act: 'cancel', label: 'Cancel job', danger: true }
        : { act: 'help', label: 'Get help with this job' };

    if (journey.terminal || phase === JOB_PHASE.CLOSED) {
        const st = String(b.status || '').toLowerCase();
        return { kind: 'closed', journey, schedule,
                 secondary: st === 'completed' ? [{ act: 'earnings', label: 'View earnings' }] : [{ act: 'help', label: 'Get help with this job' }] };
    }

    const op = journey.action && journey.action.op;
    const gate = canStartWork(b, nowMs);
    return {
        kind: 'job', journey, schedule,
        mountQuote: op === 'submitQuote',
        primary: STEP_ACTS[op] ? { act: STEP_ACTS[op], label: journey.action.label } : null,
        // A booked slot not yet open: the rules refuse setting out, so the screen says when it can.
        note: !gate.allowed && !op ? gate.reason : null,
        secondary: [help],
    };
}

function railHtml(b, schedule) {
    const stages = journeyStages(b, 'artisan', { schedule });
    const at = Math.max(0, stages.findIndex((s) => s.state === 'current'));
    const now = stages[at] || stages[0];
    return `<div class="fx-rail"><ol class="fx-rail__track" aria-hidden="true">${stages.map((s) =>
        `<li class="fx-rail__seg${s.state === 'done' ? ' fx-rail__seg--done' : s.state === 'current' ? ' fx-rail__seg--current' : ''}"></li>`).join('')}</ol>
      <p class="fx-rail__cap"><span class="fx-rail__now">${esc(now.label)}</span><span>Step ${at + 1} of ${stages.length}</span></p></div>`;
}

const ledger = (rows) => `<dl class="fx-ledger">${rows.filter((r) => r[1]).map(([k, v, note]) =>
    `<div class="fx-ledger__row"><dt class="fx-ledger__k">${esc(k)}${note ? `<span class="fx-ledger__note fx-job__note">${esc(note)}</span>` : ''}</dt><dd class="fx-ledger__v">${esc(v)}</dd></div>`).join('')}</dl>`;

const sect = (id, title, body) =>
    `<section class="fx-sect" aria-labelledby="${id}"><div class="fx-sect__head"><h2 class="fx-sect__title" id="${id}">${esc(title)}</h2></div><div class="fx-sect__body fx-stack">${body}</div></section>`;

function photosHtml(photos) {
    if (!photos.length) return '';
    return sect('photos-h', `Photos from the customer (${photos.length})`,
        `<div class="fx-job__photos">${photos.map((u) => `<img class="fx-job__photo" src="${esc(u)}" alt="Customer photo" loading="lazy">`).join('')}</div>`);
}

function countdownHtml(offer, nowMs) {
    const c = offer.countdown;
    if (!c) return `<p class="fx-meta fx-job__inline">${icon('clock')}<span>No countdown: this customer asked for you.</span></p>`;
    const left = Math.max(0, c.expiresAtMs - nowMs);
    return `<div class="fx-countdown" id="jb-countdown" role="timer" aria-label="Time left to answer" data-expires="${c.expiresAtMs}"
        data-total="${c.totalMs || 0}" data-urgency="${countdownUrgency(left)}">
      <div class="fx-countdown__bar" aria-hidden="true"><div class="fx-countdown__fill"></div></div>
      <p class="fx-countdown__text"><span class="fx-countdown__value" data-countdown>${esc(formatTimeLeft(Math.floor(left / 1000)))}</span><span class="fx-countdown__label">left to answer</span></p></div>`;
}

/** Bring the countdown to nowMs; true once it has run out. */
export function paintCountdown(root, nowMs) {
    const el = root.querySelector('.fx-countdown[data-expires]');
    if (!el) return false;
    const left = Math.max(0, Number(el.dataset.expires) - nowMs);
    const total = Number(el.dataset.total) || 0;
    el.dataset.urgency = countdownUrgency(left);
    el.style.setProperty('--fx-countdown', String(total > 0 ? Math.min(1, left / total) : 0));
    const v = el.querySelector('[data-countdown]');
    if (v) v.textContent = formatTimeLeft(Math.floor(left / 1000));
    return left === 0;
}

function offerBody(b, plan, ctx) {
    const v = plan.offer;
    const brief = resolveJobBrief(b);
    return `
    <section class="fx-job__head fx-stack--4" aria-labelledby="jb-title">
      <span class="fx-chip ${v.kind === 'emergency' ? 'fx-chip--bad' : 'fx-chip--accent'}">${esc(v.heading)}</span>
      <h1 class="fx-title" id="jb-title" tabindex="-1">${esc(v.service)}</h1>
      ${plan.lapsed ? `<div class="fx-notice fx-notice--warn" role="status">${icon('clock', 'fx-notice__icon')}<div class="fx-notice__body"><p class="fx-notice__title">This request has expired</p><p>${esc(plan.lapsedNote)}</p></div></div>`
                    : countdownHtml(v, ctx.nowMs)}
      ${ledger([['When', v.when], ['Distance', v.distance], ['Visit fee', v.visitFee, 'Charged to the customer'], ['Price on the request', v.jobPrice]])}
      ${v.commitment && !plan.lapsed ? `<div class="fx-notice fx-notice--warn" role="note">${icon('clock', 'fx-notice__icon')}<div class="fx-notice__body"><p>${esc(v.commitment)} Decline if you cannot make it.</p></div></div>` : ''}
    </section>
    ${brief.problem ? sect('problem-h', 'What they described', `<p class="fx-body fx-job__words">${esc(brief.problem)}</p>`) : ''}
    ${photosHtml(brief.photos)}
    ${sect('where-h', 'Where', `<p class="fx-body">${esc(brief.location.note || 'Exact address shared once you accept.')}</p>`)}`;
}

function moneyHtml(comp) {
    if (!comp) return '';
    const amount = comp.amount !== null && comp.amount !== undefined
        ? `<p class="fx-heading fx-num">${esc(formatMoney(comp.amount))}${comp.conditional ? ' <span class="fx-chip fx-chip--warn">Not yet confirmed</span>' : ''}</p>`
        : '<p class="fx-body fx-ink-3">Not set yet</p>';
    // The heading is the figure's own name (resolveArtisanCompensation): a fee is
    // not called "your earnings" unless the server's figure is.
    return sect('money-h', comp.label || 'Payment', `${amount}${comp.note ? `<p class="fx-meta">${esc(comp.note)}</p>` : ''}`);
}

// Drawn from cache (ctx.cached), the record has no address, name or phone:
// those are never stored (artisanLists.js stripFields). Their place holds a
// placeholder until the live booking arrives, never "No address on this
// booking", which would be false.
const PENDING = '<span class="fx-skel" aria-hidden="true"></span>';

function whereHtml(b, brief, ctx, { contact: withContact = true } = {}) {
    if (ctx.cached) {
        return sect('where-h', 'Where', PENDING) + (withContact ? sect('contact-h', 'The customer', PENDING) : '');
    }
    const loc = brief.location;
    const dist = formatDistance(brief.distanceKm);
    const line = loc.address ? `<p class="fx-body">${esc(loc.address)}</p>`
               : loc.precision === 'removed' ? `<p class="fx-body fx-ink-3">${esc(loc.note)}</p>`
               : '<p class="fx-body fx-ink-3">No address on this booking</p>';
    const nav = loc.mapUrl
        // Navigation is the phone's own maps app, through a link (no map is embedded).
        ? `<a class="fx-btn fx-btn--secondary" href="${esc(loc.mapUrl)}" target="_blank" rel="noopener">${icon('navigate')}Open in Maps</a>` : '';
    const c = brief.customer;
    const contact = c.contactUnlocked
        ? `<div class="fx-btnrow">${c.phone ? `<a class="fx-btn fx-btn--secondary" href="tel:${esc(c.phone)}">${icon('phone')}Call</a>` : ''}
             <a class="fx-btn fx-btn--secondary" href="messages.html?bookingId=${encodeURIComponent(ctx.bookingId)}">${icon('message')}Message</a></div>`
        : '<p class="fx-meta">The customer\'s number unlocks once the visit is funded.</p>';
    return sect('where-h', 'Where', `${line}${dist ? `<p class="fx-meta">${esc(dist)}</p>` : ''}
      ${loc.precision === 'address-only' ? '<p class="fx-meta">Address only — no exact GPS fix from the customer.</p>' : ''}
      ${withContact ? nav : ''}`) + (withContact ? sect('contact-h', 'The customer', `${c.name ? `<p class="fx-body">${esc(c.name)}</p>` : ''}${contact}`) : '');
}

function jobBody(b, plan, ctx) {
    const j = plan.journey;
    const brief = resolveJobBrief(b, { originLat: ctx.originLat, originLng: ctx.originLng, escrow: ctx.escrow });
    return `
    <section class="fx-job__head fx-stack--4" aria-labelledby="jb-title">
      <span class="fx-chip ${CHIP_TONE[j.tone] || ''}">${esc(j.here)}</span>
      <h1 class="fx-title" id="jb-title" tabindex="-1">${esc(brief.service || 'Job')}</h1>
      ${plan.schedule.scheduled ? `<p class="fx-meta fx-job__inline">${icon('clock')}<span>Booked for ${esc(plan.schedule.label)}</span></p>` : ''}
      ${railHtml(b, plan.schedule)}
      <div class="fx-stack--2"><p class="fx-body">${esc(j.just)}</p>${j.next ? `<p class="fx-body fx-ink-2">${esc(j.next)}</p>` : ''}</div>
      ${plan.note ? `<div class="fx-notice fx-notice--info" role="note">${icon('clock', 'fx-notice__icon')}<div class="fx-notice__body"><p>${esc(plan.note)}</p></div></div>` : ''}
    </section>
    ${plan.mountQuote ? sect('quote-h', 'Send your quote', ctx.cached ? PENDING : '<div class="fx-job__quote" id="jb-quote-mount"></div>') : ''}
    ${brief.problem || brief.notes ? sect('problem-h', 'What they described',
        `${brief.problem ? `<p class="fx-body fx-job__words">${esc(brief.problem)}</p>` : ''}${brief.notes ? `<p class="fx-meta">Notes: ${esc(brief.notes)}</p>` : ''}`) : ''}
    ${photosHtml(brief.photos)}
    ${moneyHtml(brief.compensation)}
    ${plan.kind === 'closed' ? (brief.location.address || brief.location.precision === 'removed' ? whereHtml(b, brief, ctx, { contact: false }) : '')
                             : whereHtml(b, brief, ctx)}`;
}

function dockHtml(plan, ctx) {
    if (plan.kind === 'offer') {
        if (plan.lapsed) {
            return `<button class="fx-btn fx-btn--secondary fx-btn--l" type="button" ${LAPSED_OFFER_STATE_ATTRS}>Decline</button>` +
                   `<button class="fx-btn fx-btn--primary fx-btn--l" type="button" ${LAPSED_OFFER_STATE_ATTRS}>${LAPSED_OFFER_LABEL}</button>`;
        }
        const busy = ctx.busy;
        const off = busy || ctx.cached;   // nothing is answered from a cached copy
        return `<button class="fx-btn fx-btn--secondary fx-btn--l" type="button" data-act="decline"${off ? ' disabled' : ''}${busy === 'decline' ? ' aria-busy="true"' : ''}>${busy === 'decline' ? '<span class="fx-spin" aria-hidden="true"></span>Declining…' : 'Decline'}</button>` +
               `<button class="fx-btn fx-btn--primary fx-btn--l" type="button" data-act="accept"${off ? ' disabled' : ''}${busy === 'accept' ? ' aria-busy="true"' : ''}>${busy === 'accept' ? '<span class="fx-spin" aria-hidden="true"></span>Accepting…' : (plan.offer.commitment ? 'Accept this slot' : 'Accept this job')}</button>`;
    }
    const sec = (plan.secondary || []).map((s) =>
        `<button class="fx-btn ${s.danger ? 'fx-btn--danger' : 'fx-btn--secondary'} fx-btn--l" type="button" data-act="${s.act}"${ctx.busy || ctx.cached ? ' disabled' : ''}>${esc(s.label)}</button>`).join('');
    const p = plan.primary;
    // From cache every step waits for the live booking: a step is a decision
    // about money and the customer, never taken on a stored copy (CLAUDE.md §1).
    const prim = p ? `<button class="fx-btn fx-btn--primary fx-btn--l" type="button" data-act="${p.act}"${ctx.busy ? ' disabled aria-busy="true"' : ctx.cached ? ' disabled' : ''}>${ctx.busy ? '<span class="fx-spin" aria-hidden="true"></span>Working…' : esc(p.label)}</button>` : '';
    return sec + prim;
}

/**
 * Draw the screen.
 * @param {{ body: HTMLElement, dock: HTMLElement, sub: HTMLElement }} dom
 * @param {object} b      booking (or offer summary)
 * @param {object} plan   jobPlan(b)
 * @param {{ nowMs: number, bookingId: string, busy?: string|null, cached?: boolean, originLat?: number|null, originLng?: number|null, escrow?: object|null }} ctx
 *        cached: drawn from the stored list before the live booking; nothing private, no action
 */
export function renderJob(dom, b, plan, ctx) {
    dom.sub.textContent = resolveJobBrief(b).bookingId || '';
    dom.body.innerHTML = plan.kind === 'offer' ? offerBody(b, plan, ctx) : jobBody(b, plan, ctx);
    dom.body.setAttribute('aria-busy', ctx.cached ? 'true' : 'false');
    paintCountdown(dom.body, ctx.nowMs);
    const html = dockHtml(plan, ctx);
    dom.dock.hidden = !html;
    dom.dock.innerHTML = html ? `<div class="fx-dock__actions">${html}</div>` : '';
}

/** A whole-screen message (no job, not found, not yours, could not load). */
export function renderMessage(dom, title, body, cta = { label: 'Back to my jobs', href: 'jobs.html' }) {
    dom.body.innerHTML = `<section class="fx-job__head fx-stack--4" aria-labelledby="jb-title" data-state="message">
      <h1 class="fx-title" id="jb-title" tabindex="-1">${esc(title)}</h1><p class="fx-lead">${esc(body)}</p>
      <a class="fx-btn fx-btn--secondary" href="${esc(cta.href)}">${esc(cta.label)}</a></section>`;
    dom.dock.hidden = true;
    dom.dock.innerHTML = '';
}
