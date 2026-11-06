/**
 * artisan-app/js/today.js — draws the Today screen (Phase 2).
 *
 * Rendering only. What Today shows is decided by
 * shared/js/domain/artisanToday.js (resolveToday); which step a job is at, and
 * whether the rules accept it, by bookingTruth.resolveJourney. This module
 * turns that state into markup and touches nothing else: no Firebase, no
 * writes. The page (dashboard.html) owns the data and the actions, and finds
 * them through data-act attributes on the controls drawn here.
 *
 * Every string from a booking or an offer is escaped.
 */
import { icon } from './fx/icons.js';
import { countdownUrgency } from './fx/controls.js';
import { formatTimeLeft } from '../../shared/js/domain/jobOffers.js';
import { journeyStages, serviceLabel } from '../../shared/js/domain/bookingTruth.js';
import { TODAY_MODE, OFFER_KIND } from '../../shared/js/domain/artisanToday.js';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const jobHref = (id) => `job.html?id=${encodeURIComponent(id)}`;

/** The job actions Today can take, by resolveJourney's op. Anything else is not offered here. */
export const JOB_OPS = Object.freeze({
    enRoute:            { act: 'job-en-route',  busy: 'Updating…' },
    arrived:            { act: 'job-arrived',   busy: 'Updating…' },
    completeInspection: { act: 'job-inspected', busy: 'Updating…' },
    markDone:           { act: 'job-done',      busy: 'Updating…' },
    // The quote composer is mounted inline on the job screen: a link, not a write.
    submitQuote:        { href: (id) => `job.html?id=${encodeURIComponent(id)}` },
});

// The KYC copy the dashboard has always shown, one answer per state (COPY-KYC).
export function lockCopy(blocker) {
    switch (blocker && blocker.reason) {
        case 'under_review': return { title: 'Under review', body: 'We\'re reviewing your documents. This takes 1–2 business days.', avail: 'Under review', action: null };
        case 'unverified':   return { title: 'Verification needed', body: blocker.message, avail: 'Verification needed', action: { label: 'Complete verification', href: 'onboarding.html', onboarding: true } };
        case 'suspended':    return { title: 'Account on hold', body: blocker.message, avail: 'Account on hold', action: { label: 'Contact support', href: 'support.html' } };
        case 'inactive':     return { title: 'Account not active', body: blocker.message, avail: 'Not active', action: { label: 'Contact support', href: 'support.html' } };
        default:             return { title: 'Checking your account', body: blocker ? blocker.message : '', avail: 'Checking…', action: null };
    }
}

/**
 * The availability control in the app bar. Always there once the profile is
 * known, so it stays reachable while an offer or a job owns the screen.
 * @param {object} state  resolveToday()
 * @param {{ saving?: 'on'|'off'|null, cached?: boolean }} ui
 */
export function availView(state, ui = {}) {
    if (ui.saving) return { kind: 'saving', label: ui.saving === 'on' ? 'Going online…' : 'Going offline…', busy: true };
    if (state.mode === TODAY_MODE.UNKNOWN) return { kind: 'unknown', label: 'Checking…', busy: true };
    if (state.blocker) return { kind: 'locked', label: lockCopy(state.blocker).avail };
    // A cached profile is shown, never acted on: the switch waits for the server.
    if (state.available) return { kind: 'online', label: 'Online', pressed: true, act: 'stop-offers', waiting: !!ui.cached };
    return { kind: 'offline', label: 'Offline', pressed: false, act: 'go-online', waiting: !!ui.cached };
}

export function renderAvail(btn, view) {
    btn.hidden = false;
    btn.removeAttribute('aria-busy');
    btn.removeAttribute('aria-disabled');
    btn.removeAttribute('aria-pressed');
    btn.disabled = false;
    delete btn.dataset.act;
    let lead;
    if (view.busy) {
        btn.setAttribute('aria-busy', 'true');
        btn.disabled = true;
        lead = '<span class="fx-spin" aria-hidden="true"></span>';
    } else if (view.kind === 'locked') {
        btn.setAttribute('aria-disabled', 'true');
        btn.dataset.act = 'locked';
        lead = icon('lock');
    } else {
        btn.setAttribute('aria-pressed', view.pressed ? 'true' : 'false');
        if (view.waiting) btn.disabled = true;
        else btn.dataset.act = view.act;
        lead = `<span class="fx-dot ${view.pressed ? 'fx-dot--live' : 'fx-dot--off'}" aria-hidden="true"></span>`;
    }
    btn.innerHTML = `${lead}${esc(view.label)}`;
    btn.dataset.kind = view.kind;
}

const CHIP_TONE = { action: 'fx-chip--accent', live: 'fx-chip--info', waiting: 'fx-chip--warn', ended: '' };

function railHtml(booking, schedule) {
    const stages = journeyStages(booking, 'artisan', { schedule });
    const at = Math.max(0, stages.findIndex((s) => s.state === 'current'));
    const now = stages[at] || stages[0];
    return `<div class="fx-rail">
      <ol class="fx-rail__track" aria-hidden="true">${stages.map((s) =>
        `<li class="fx-rail__seg${s.state === 'done' ? ' fx-rail__seg--done' : s.state === 'current' ? ' fx-rail__seg--current' : ''}"></li>`).join('')}</ol>
      <p class="fx-rail__cap"><span class="fx-rail__now">${esc(now.label)}</span><span>Step ${at + 1} of ${stages.length}</span></p>
    </div>`;
}

function rowHtml(p, meta) {
    const b = p.booking;
    return `<li><a class="fx-row" href="${jobHref(b.id)}">
      <span class="fx-row__main"><span class="fx-row__title">${esc(serviceOf(b))}</span><span class="fx-row__meta">${esc(meta)}</span></span>
      <span class="fx-row__trail">${icon('next')}</span></a></li>`;
}

export function serviceOf(b) {
    return serviceLabel(b.serviceType) || serviceLabel(b.service) || serviceLabel(b.category) || 'Job';
}

function countdownHtml(view, nowMs) {
    const c = view.countdown;
    if (!c) {
        return `<p class="fx-meta fx-today__nolimit">${icon('clock')}<span>No countdown: this customer asked for you.</span></p>`;
    }
    const left = Math.max(0, c.expiresAtMs - nowMs);
    // The bar's fill is the one runtime value the gate allows (--fx-countdown);
    // it is set by the ticker after paint, never written inline here.
    return `<div class="fx-countdown" role="timer" aria-label="Time left to answer" data-expires="${c.expiresAtMs}"
        data-total="${c.totalMs || 0}" data-urgency="${countdownUrgency(left)}">
      <div class="fx-countdown__bar" aria-hidden="true"><div class="fx-countdown__fill"></div></div>
      <p class="fx-countdown__text"><span class="fx-countdown__value" data-countdown>${esc(formatTimeLeft(Math.floor(left / 1000)))}</span><span class="fx-countdown__label">left to answer</span></p>
    </div>`;
}

function offerHtml(state, nowMs) {
    const v = state.offer;
    const tone = v.kind === OFFER_KIND.EMERGENCY ? 'fx-chip--bad' : 'fx-chip--accent';
    const rows = [
        ['When', v.when],
        ['Distance', v.distance],
        ['Visit fee', v.visitFee, 'Charged to the customer'],
        ['Price on the request', v.jobPrice],
    ].filter((r) => r[1]);
    const also = state.alsoOnJob
        ? `<div class="fx-notice fx-notice--info" role="note">${icon('tools', 'fx-notice__icon')}<div class="fx-notice__body">
             <p class="fx-notice__title">You have a job under way</p>
             <p>${esc(serviceOf(state.alsoOnJob.booking))} · ${esc(state.alsoOnJob.journey.here)}. Accept only if you can take this one too.</p></div></div>`
        : '';
    return `<section class="fx-today__state fx-stack--4" aria-labelledby="today-h" data-mode="offer" data-offer="${esc(v.id)}">
      <span class="fx-chip ${tone}">${esc(v.heading)}</span>
      <h2 class="fx-title" id="today-h" tabindex="-1">${esc(v.service)}</h2>
      ${countdownHtml(v, nowMs)}
      ${v.problem ? `<p class="fx-body fx-today__problem">${esc(v.problem)}</p>` : ''}
      <dl class="fx-ledger">${rows.map(([k, val, note]) =>
        `<div class="fx-ledger__row"><dt class="fx-ledger__k">${esc(k)}${note ? `<span class="fx-ledger__note fx-today__note">${esc(note)}</span>` : ''}</dt><dd class="fx-ledger__v">${esc(val)}</dd></div>`).join('')}</dl>
      ${v.commitment ? `<div class="fx-notice fx-notice--warn" role="note">${icon('clock', 'fx-notice__icon')}<div class="fx-notice__body"><p>${esc(v.commitment)} Decline if you cannot make it.</p></div></div>` : ''}
      ${also}
      <p class="fx-meta">The exact address is shared once you accept.${v.photos.length ? ` <a class="fx-link" href="${jobHref(v.id)}">See ${v.photos.length === 1 ? 'the photo' : `${v.photos.length} photos`}</a>` : ''}</p>
      ${state.moreOffers ? `<p class="fx-meta">${state.moreOffers === 1 ? '1 more request is' : `${state.moreOffers} more requests are`} waiting after this one.</p>` : ''}
    </section>`;
}

function jobHtml(state) {
    const p = state.job;
    const b = p.booking, j = p.journey;
    const others = state.jobs.slice(1);
    return `<section class="fx-today__state fx-stack--4" aria-labelledby="today-h" data-mode="job" data-job="${esc(b.id)}">
      <span class="fx-chip ${CHIP_TONE[j.tone] || ''}">${esc(j.here)}</span>
      <h2 class="fx-title" id="today-h" tabindex="-1">${esc(serviceOf(b))}</h2>
      ${p.schedule.scheduled ? `<p class="fx-meta fx-today__when">${icon('clock')}<span>Booked for ${esc(p.schedule.label)}</span></p>` : ''}
      ${railHtml(b, p.schedule)}
      <div class="fx-stack--2"><p class="fx-body">${esc(j.just)}</p>${j.next ? `<p class="fx-body fx-ink-2">${esc(j.next)}</p>` : ''}</div>
    </section>
    ${others.length ? `<section class="fx-sect" aria-labelledby="also-h"><div class="fx-sect__head"><h2 class="fx-sect__title" id="also-h">Also needs you</h2></div>
      <ul class="fx-list">${others.map((o) => rowHtml(o, o.journey.here)).join('')}</ul></section>` : ''}`;
}

function idleHtml(state, ui) {
    if (state.mode === TODAY_MODE.LOCKED) {
        const c = lockCopy(state.blocker);
        const action = c.action && (!c.action.onboarding || ui.onboarding)
            ? `<a class="fx-btn fx-btn--secondary" href="${c.action.href}">${esc(c.action.label)}</a>` : '';
        return `<section class="fx-today__state fx-stack--4" aria-labelledby="today-h" data-mode="locked">
          <span class="fx-chip fx-chip--warn">Not receiving jobs</span>
          <h2 class="fx-title" id="today-h" tabindex="-1">${esc(c.title)}</h2>
          <p class="fx-lead">${esc(c.body)}</p>${action}</section>`;
    }
    const online = state.mode === TODAY_MODE.ONLINE;
    return `<section class="fx-today__state fx-stack--4" aria-labelledby="today-h" data-mode="${state.mode}">
      <h2 class="fx-title" id="today-h" tabindex="-1">${online ? 'You are online' : 'You are offline'}</h2>
      <p class="fx-lead">${online ? 'Customers can find you and send you jobs. New requests appear here.'
                                 : 'Customers cannot find you — no new jobs will reach you.'}</p>
    </section>`;
}

const SKELETON = `<section class="fx-today__state fx-stack--4" data-mode="unknown" aria-busy="true">
  <span class="fx-skel fx-skel--title"></span><span class="fx-skel fx-skel--row"></span><span class="fx-skel fx-skel--row"></span></section>`;

/**
 * The dock: the screen's one primary action (and its pair).
 * @returns {{ note: string|null, html: string } | null}
 */
export function dockView(state, ui = {}) {
    const busy = ui.busy || new Map();
    if (state.mode === TODAY_MODE.OFFER) {
        const id = state.offer.id;
        const act = busy.get(id);
        const dis = act ? ' disabled' : '';
        return { note: null, html:
            `<button class="fx-btn fx-btn--secondary fx-btn--l" type="button" data-act="decline" data-id="${esc(id)}"${dis}${act === 'decline' ? ' aria-busy="true"' : ''}>${act === 'decline' ? '<span class="fx-spin" aria-hidden="true"></span>Declining…' : 'Decline'}</button>` +
            `<button class="fx-btn fx-btn--primary fx-btn--l" type="button" data-act="accept" data-id="${esc(id)}"${dis}${act === 'accept' ? ' aria-busy="true"' : ''}>${act === 'accept' ? '<span class="fx-spin" aria-hidden="true"></span>Accepting…' : (state.offer.commitment ? 'Accept this slot' : 'Accept')}</button>` };
    }
    if (state.mode === TODAY_MODE.JOB) {
        const b = state.job.booking, a = state.job.journey.action;
        const op = a && JOB_OPS[a.op];
        const open = `<a class="fx-btn fx-btn--secondary fx-btn--l" href="${jobHref(b.id)}">Open job</a>`;
        if (!op) return { note: null, html: open };
        if (op.href) return { note: null, html: open + `<a class="fx-btn fx-btn--primary fx-btn--l" href="${op.href(b.id)}">${esc(a.label)}</a>` };
        const inFlight = busy.has(b.id);
        return { note: null, html: open +
            `<button class="fx-btn fx-btn--primary fx-btn--l" type="button" data-act="${op.act}" data-id="${esc(b.id)}"${inFlight ? ' disabled aria-busy="true"' : ''}>${inFlight ? `<span class="fx-spin" aria-hidden="true"></span>${esc(op.busy)}` : esc(a.label)}</button>` };
    }
    if (state.mode === TODAY_MODE.OFFLINE) {
        const saving = ui.saving === 'on';
        return { note: 'You are offline. Go online to receive job requests.', html:
            `<button class="fx-btn fx-btn--primary fx-btn--l" type="button" data-act="go-online"${saving || ui.cached ? ' disabled' : ''}${saving ? ' aria-busy="true"' : ''}>${saving ? '<span class="fx-spin" aria-hidden="true"></span>Going online…' : 'Go online'}</button>` };
    }
    return null;
}

/**
 * Draw Today.
 * @param {{ avail: HTMLElement, main: HTMLElement, lists: HTMLElement, dock: HTMLElement }} dom
 * @param {object} state  resolveToday()
 * @param {{ nowMs: number, saving?: string|null, cached?: boolean, busy?: Map<string,string>, onboarding?: boolean, listsReady?: boolean }} ui
 */
export function renderToday(dom, state, ui) {
    renderAvail(dom.avail, availView(state, ui));

    dom.main.innerHTML =
        state.mode === TODAY_MODE.UNKNOWN || (!ui.listsReady && (state.mode === TODAY_MODE.ONLINE || state.mode === TODAY_MODE.OFFLINE)) ? SKELETON
      : state.mode === TODAY_MODE.OFFER ? offerHtml(state, ui.nowMs)
      : state.mode === TODAY_MODE.JOB   ? jobHtml(state)
      : idleHtml(state, ui);
    paintCountdowns(dom.main, ui.nowMs);

    const sect = (id, title, items) => items.length
        ? `<section class="fx-sect" aria-labelledby="${id}"><div class="fx-sect__head"><h2 class="fx-sect__title" id="${id}">${title}</h2></div><ul class="fx-list">${items.join('')}</ul></section>`
        : '';
    dom.lists.innerHTML =
        sect('waiting-h', 'Waiting on the customer', state.waiting.map((p) => rowHtml(p, p.journey.here))) +
        sect('upcoming-h', 'Coming up', state.upcoming.map((p) => rowHtml(p, p.schedule.label || p.journey.here)));

    const d = dockView(state, ui);
    dom.dock.hidden = !d;
    dom.dock.innerHTML = d ? `${d.note ? `<p class="fx-dock__note">${esc(d.note)}</p>` : ''}<div class="fx-dock__actions">${d.html}</div>` : '';
}

/**
 * Bring every countdown on screen to `nowMs` (one ticker for the page). Returns
 * the ids of offers whose time ran out, so the page can say so and move on.
 */
export function paintCountdowns(root, nowMs) {
    const lapsed = [];
    root.querySelectorAll('.fx-countdown[data-expires]').forEach((el) => {
        const left = Math.max(0, Number(el.dataset.expires) - nowMs);
        const total = Number(el.dataset.total) || 0;
        el.dataset.urgency = countdownUrgency(left);
        el.style.setProperty('--fx-countdown', String(total > 0 ? Math.min(1, left / total) : 0));
        const v = el.querySelector('[data-countdown]');
        if (v) v.textContent = formatTimeLeft(Math.floor(left / 1000));
        if (left === 0) {
            const host = el.closest('[data-offer]');
            if (host) lapsed.push(host.dataset.offer);
        }
    });
    return lapsed;
}
