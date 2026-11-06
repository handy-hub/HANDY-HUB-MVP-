/**
 * artisan-app/js/jobsScreen.js — draws the Jobs screen (Phase 3).
 *
 * Rendering only. Where each booking belongs, what its row says and how it
 * ended are decided by shared/js/domain/artisanJobs.js (on top of the same
 * placeJob Today uses); an offer reads as artisanToday.offerView says. Rows
 * open the job screen, where every action lives — so Jobs can never offer a
 * step that Today or the job screen would refuse. Every booking string is
 * escaped.
 */
import { icon } from './fx/icons.js';
import { formatTimeLeft } from '../../shared/js/domain/jobOffers.js';
import { offerView } from '../../shared/js/domain/artisanToday.js';
import { groupJobs, filterHistory, jobRow } from '../../shared/js/domain/artisanJobs.js';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const jobHref = (id) => `job.html?id=${encodeURIComponent(id)}`;

const TONE_CHIP = { action: 'fx-chip--accent', live: 'fx-chip--info', waiting: 'fx-chip--warn', bad: 'fx-chip--bad', ok: 'fx-chip--ok', ended: '' };

export const VIEW_LABELS = Object.freeze({ current: 'Current', upcoming: 'Upcoming', history: 'History' });
export const FILTER_LABELS = Object.freeze({ all: 'All', completed: 'Completed', cancelled: 'Cancelled' });

/** One booking row: service, status and next step, who and where, when. */
export function rowHtml(r) {
    const who = [r.customer, r.where].filter(Boolean).join(' · ');
    return `<li><a class="fx-row fx-jobs__row" href="${jobHref(r.id)}" data-row="${esc(r.id)}">
      <span class="fx-row__main">
        <span class="fx-row__title">${esc(r.service)}</span>
        <span class="fx-jobs__line"><span class="fx-chip ${TONE_CHIP[r.tone] || ''}">${esc(r.status)}</span>${r.next ? `<span class="fx-jobs__next">Next: ${esc(r.next)}</span>` : ''}</span>
        ${who ? `<span class="fx-row__meta">${esc(who)}</span>` : ''}
        ${r.when ? `<span class="fx-row__meta">${esc(r.when)}</span>` : ''}
        ${r.detail ? `<span class="fx-row__meta">${esc(r.detail)}</span>` : ''}
      </span>
      <span class="fx-row__trail">${icon('next')}</span></a></li>`;
}

/** An open offer: answered on its own screen (or Today), never from the list. */
export function offerRowHtml(v, nowMs) {
    const left = v.countdown ? Math.max(0, v.countdown.expiresAtMs - nowMs) : null;
    const meta = [v.when, v.distance].filter(Boolean).join(' · ');
    return `<li><a class="fx-row fx-jobs__row" href="${jobHref(v.id)}" data-offer="${esc(v.id)}">
      <span class="fx-row__main">
        <span class="fx-row__title">${esc(v.service)}</span>
        <span class="fx-jobs__line"><span class="fx-chip ${v.kind === 'emergency' ? 'fx-chip--bad' : 'fx-chip--accent'}">${esc(v.heading)}</span></span>
        ${meta ? `<span class="fx-row__meta">${esc(meta)}</span>` : ''}
      </span>
      <span class="fx-row__trail">${left === null
        ? '<span class="fx-jobs__left">No time limit</span>'
        : `<span class="fx-jobs__left fx-num" data-expires="${v.countdown.expiresAtMs}">${esc(formatTimeLeft(Math.floor(left / 1000)))} left</span>`}${icon('next')}</span></a></li>`;
}

const section = (id, title, items) => items.length
    ? `<section class="fx-sect fx-jobs__sect" aria-labelledby="${id}"><div class="fx-sect__head"><h2 class="fx-sect__title" id="${id}">${esc(title)} <span class="fx-num">(${items.length})</span></h2></div><ul class="fx-list">${items.join('')}</ul></section>`
    : '';

const empty = (title, body) => `<section class="fx-jobs__empty fx-stack--2" data-empty><p class="fx-heading">${esc(title)}</p>${body ? `<p class="fx-lead">${esc(body)}</p>` : ''}</section>`;

const SKELETON = `<section class="fx-jobs__empty fx-stack" aria-busy="true" data-skeleton>
  <span class="fx-skel fx-skel--row"></span><span class="fx-skel fx-skel--row"></span><span class="fx-skel fx-skel--row"></span></section>`;

/**
 * The view model: everything renderJobs draws, decided from the data.
 * @param {{ view: string, filter: string, active: object[], history: object[], offers: object[], nowMs: number,
 *           origin?: object }} input
 */
export function jobsModel({ view, filter = 'all', active = [], history = [], offers = [], nowMs, origin = {} }) {
    const g = groupJobs([...active, ...history], nowMs);
    const open = offers.map((o) => offerView(o, nowMs)).filter((v) => v.answerable)
        .sort((a, b) => (a.countdown?.expiresAtMs ?? Infinity) - (b.countdown?.expiresAtMs ?? Infinity));
    const rows = (list) => list.map((p) => jobRow(p, origin));
    return {
        view, filter,
        counts: { current: g.counts.current + open.length, upcoming: g.counts.upcoming },
        offers: open,
        needsYou: rows(g.needsYou), waiting: rows(g.waiting), onHold: rows(g.onHold),
        upcoming: rows(g.upcoming),
        history: rows(filterHistory(g.history, filter)),
    };
}

/**
 * Draw the screen.
 * @param {{ views: HTMLElement, filters: HTMLElement, list: HTMLElement, sub: HTMLElement }} dom
 * @param {object} m  jobsModel()
 * @param {{ nowMs: number, ready: { active: boolean, history: boolean }, more?: { can: boolean, busy: boolean, failed: boolean } }} ui
 */
export function renderJobs(dom, m, ui) {
    // The views, with how many each holds (History is paged, so it shows none).
    for (const btn of dom.views.querySelectorAll('[data-view]')) {
        const v = btn.dataset.view;
        btn.setAttribute('aria-pressed', v === m.view ? 'true' : 'false');
        const n = m.counts[v];
        btn.innerHTML = `${VIEW_LABELS[v]}${n ? ` <span class="fx-num">${n}</span>` : ''}`;
    }
    dom.filters.hidden = m.view !== 'history';
    for (const btn of dom.filters.querySelectorAll('[data-filter]')) {
        btn.setAttribute('aria-pressed', btn.dataset.filter === m.filter ? 'true' : 'false');
    }
    const needs = m.needsYou.length;
    dom.sub.textContent = needs ? `${needs} ${needs === 1 ? 'job needs' : 'jobs need'} you` : '';

    let html;
    if (m.view === 'current') {
        html = !ui.ready.active && !m.offers.length && !needs ? SKELETON
            : (section('offers-h', 'Requests for you', m.offers.map((v) => offerRowHtml(v, ui.nowMs))) +
               section('needs-h', 'Needs you', m.needsYou.map(rowHtml)) +
               section('waiting-h', 'Waiting on the customer', m.waiting.map(rowHtml)) +
               section('hold-h', 'On hold', m.onHold.map(rowHtml)))
              || empty('Nothing needs you right now', 'New requests appear on Today. Jobs you accept are listed here.');
    } else if (m.view === 'upcoming') {
        html = !ui.ready.active && !m.upcoming.length ? SKELETON
            : section('upcoming-h', 'Booked', m.upcoming.map(rowHtml))
              || empty('No upcoming bookings', 'A booked slot you accept is listed here until it opens.');
    } else {
        const EMPTY = { all: 'No past jobs yet', completed: 'No completed jobs yet', cancelled: 'No cancelled bookings' };
        const more = ui.more || {};
        html = !ui.ready.history && !m.history.length ? SKELETON
            : m.history.length
                ? `<section class="fx-sect fx-jobs__sect" aria-labelledby="history-h"><div class="fx-sect__head"><h2 class="fx-sect__title" id="history-h">Most recent first</h2></div>
                     <ul class="fx-list">${m.history.map(rowHtml).join('')}</ul></section>
                   ${more.failed ? `<div class="fx-pad"><div class="fx-notice fx-notice--warn" role="status">${icon('alert', 'fx-notice__icon')}<div class="fx-notice__body"><p>Could not load more. Check your connection.</p></div></div></div>` : ''}
                   ${more.can ? `<div class="fx-pad fx-jobs__more"><button class="fx-btn fx-btn--secondary fx-btn--block" type="button" data-act="more"${more.busy ? ' disabled aria-busy="true"' : ''}>${more.busy ? '<span class="fx-spin" aria-hidden="true"></span>Loading…' : (more.failed ? 'Try again' : 'Show more')}</button></div>` : ''}`
                : empty(EMPTY[m.filter] || EMPTY.all, null);
    }
    dom.list.innerHTML = html;
    tickOffers(dom.list, ui.nowMs);
}

/** Bring offer countdowns to nowMs; returns the ids whose time ran out. */
export function tickOffers(root, nowMs) {
    const lapsed = [];
    for (const el of root.querySelectorAll('[data-expires]')) {
        const left = Math.max(0, Number(el.dataset.expires) - nowMs);
        el.textContent = `${formatTimeLeft(Math.floor(left / 1000))} left`;
        if (left === 0) lapsed.push(el.closest('[data-offer]')?.dataset.offer);
    }
    return lapsed.filter(Boolean);
}
