/**
 * artisan-app/js/reputationScreen.js — draws the Reputation screen (Phase 4).
 *
 * Rendering only. Every figure, threshold and statement about matching comes
 * from shared/js/domain/artisanReputation.js, which uses the same rules
 * dispatch does (performanceMetrics.scoreCandidate, functions/artisanIndex.js,
 * functions/dispatch.js). Below a threshold a figure reads "Not enough yet",
 * never a number. Every string that came from a booking is escaped.
 */
import { icon } from './fx/icons.js';
import { serviceLabel } from '../../shared/js/domain/bookingTruth.js';
import { starFills, REPUTATION_STATUSES, REPUTATION_READ_LIMIT } from '../../shared/js/domain/artisanReputation.js';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const jobHref = (id) => `job.html?id=${encodeURIComponent(id)}`;

/** The read: the artisan's finished bookings, newest first, bounded. */
export function reputationQuery(uid) {
    return ['bookings',
        [{ field: 'artisanId', op: '==', value: uid }, { field: 'status', op: 'in', value: [...REPUTATION_STATUSES] }],
        { orderBy: { field: 'updatedAt', direction: 'desc' }, limit: REPUTATION_READ_LIMIT }];
}

const STAR = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.8l2.85 5.78 6.37.93-4.61 4.49 1.09 6.35L12 17.35l-5.7 3 1.09-6.35-4.61-4.49 6.37-.93z"/></svg>';

/** Five stars filled to the exact rating, read out as the number. */
export function starsHtml(rating) {
    const fills = starFills(rating);
    const r = Math.max(0, Math.min(5, Number(rating) || 0));
    return `<span class="fx-rep__stars" role="img" aria-label="${r.toFixed(1)} out of 5 stars">${fills.map((f) =>
        `<span class="fx-rep__star">${STAR}<span class="fx-rep__star-fill" style="width:${Math.round(f * 100)}%">${STAR}</span></span>`).join('')}</span>`;
}

/** "2 h ago", "3 days ago", or a date. */
export function ago(ms, nowMs) {
    if (ms === null || ms === undefined) return '';
    const s = Math.max(0, Math.round((nowMs - ms) / 1000));
    if (s < 90) return 'just now';
    const m = Math.round(s / 60); if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60); if (h < 24) return `${h} h ago`;
    const d = Math.round(h / 24); if (d < 30) return `${d} day${d === 1 ? '' : 's'} ago`;
    return new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

const row = (k, v, note = '', key = '') =>
    `<div class="fx-ledger__row"${key ? ` data-figure="${key}"` : ''}><dt class="fx-ledger__k">${esc(k)}</dt><dd class="fx-ledger__v">${v}</dd>${note ? `<dd class="fx-ledger__note">${esc(note)}</dd>` : ''}</div>`;
const sect = (id, title, body, extra = '') =>
    `<section class="fx-sect fx-rep__sect" aria-labelledby="${id}"${extra}><div class="fx-sect__head"><h2 class="fx-sect__title" id="${id}">${esc(title)}</h2></div>${body}</section>`;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The figures dispatch reads, each with its rule and the artisan's standing. */
export function figuresHtml(m, nowMs) {
    const { rating: r, response: s, completion: c, online: o } = m;
    const rows = [
        row('Rating', r.measured ? `${starsHtml(r.value)} <span class="fx-num">${r.value.toFixed(1)}</span>` : 'Not enough yet',
            r.fault ? 'Your rating on file cannot be read. Fidus X support can correct it.'
            : r.measured ? `From ${plural(r.count, 'review')}. Counts in matching.`
            : `${r.count} of ${r.minimum} reviews. Until you have ${r.minimum}, matching counts you as ${r.neutral.toFixed(1)}, like every new professional.`, 'rating'),
        row('Response rate', s.measured ? `<span class="fx-num">${s.pct}%</span>` : 'Not enough yet',
            s.measured ? `${s.responded} of ${s.counted} job requests answered before they expired, in the last ${s.windowDays} days. Counts in matching.`
            : `${s.counted} of ${s.minimum} job requests in the last ${s.windowDays} days. Until then matching counts you as ${Math.round(s.neutral * 100)}%. Declining counts as an answer.`, 'response'),
        row('Completion rate', c.measured ? `<span class="fx-num">${c.pct}%</span>` : 'Not enough yet',
            (c.measured ? `${c.completed} completed, ${c.cancelledByArtisan} cancelled by you.` : `${c.ended} of ${c.minimum} finished jobs.`)
            + ' Cancellations by customers do not count. Not used in matching yet.'
            + (m.scope.complete ? '' : ` From your latest ${m.scope.read} finished jobs.`), 'completion'),
        row('Online', o.onlineNow ? 'Online now' : 'Not online',
            o.lastSeenMs !== null ? `Last seen in the app ${ago(o.lastSeenMs, nowMs)}. Counts in matching while you are online and seen in the last ${o.windowMinutes} minutes.`
            : `Counts in matching while you are online and seen in the app in the last ${o.windowMinutes} minutes.`, 'online'),
    ];
    return sect('rep-figures', 'Your figures', `<div class="fx-sect__body"><dl class="fx-ledger fx-rep__ledger">${rows.join('')}</dl></div>`);
}

export function recentHtml(m, nowMs) {
    const a = m.recent;
    const rows = [
        row(`Jobs completed, last ${a.days} days`, `<span class="fx-num">${a.completedRecent}</span>`, m.scope.complete ? '' : `Counted from your latest ${m.scope.read} finished jobs.`, 'recent-jobs'),
        row('Last job completed', a.lastCompletedAt ? esc(ago(a.lastCompletedAt, nowMs)) : 'None yet', '', 'last-job'),
        row('Last review', a.lastReviewAt ? esc(ago(a.lastReviewAt, nowMs)) : 'None yet', '', 'last-review'),
    ];
    return sect('rep-recent', 'Recent activity', `<div class="fx-sect__body"><dl class="fx-ledger fx-rep__ledger">${rows.join('')}</dl></div>`);
}

/** Who can be offered a job, then how candidates are ranked — in dispatch's own terms. */
export function matchingHtml(m) {
    const e = m.eligibility;
    const req = (ok, label, fix) => `<li class="fx-rep__req" data-ok="${ok}">${icon(ok ? 'check' : 'cancel')}<span>${esc(label)}${ok ? '' : ` — ${esc(fix)}`}</span></li>`;
    const reqs = [
        req(e.verified, 'Verified', 'finish verification in Account'),
        req(e.active, 'Account active', 'contact Fidus X support'),
        req(e.available, 'Available for jobs', 'go online on Today'),
        req(true, `Jobs within ${e.workRadiusKm} km${e.radiusDefaulted ? ' (the standard radius)' : ''} of where you are`, ''),
    ];
    const factors = m.factors.map((f) => `<li class="fx-rep__factor" data-factor="${f.key}"${f.counts ? '' : ' data-unused'}>
        <p class="fx-rep__factor-k">${esc(f.label)}</p>
        <p class="fx-rep__factor-effect">${esc(f.effect)}</p>
        <p class="fx-meta">You: ${esc(f.yours)}</p></li>`).join('');
    return sect('rep-matching', 'How jobs are matched',
        `<div class="fx-sect__body fx-stack">
          <p class="fx-body">Who can be offered a job:</p>
          <ul class="fx-rep__reqs">${reqs.join('')}</ul>
          <p class="fx-body">Then the professionals who qualify are ranked by:</p>
          <ul class="fx-rep__factors">${factors}</ul>
          <p class="fx-ledger__note">This is how ranking works today. It is not a promise of a place in any list. Nothing else — your level, the jobs you have completed or what you have earned — changes it.</p>
        </div>`);
}

/** Customers' reviews, as they left them: the first name only, the trade, the date, the words. */
export function reviewRowHtml(v, nowMs) {
    const who = [v.customer, serviceLabel(v.service)].filter(Boolean).join(' · ') || 'Customer';
    return `<li class="fx-rep__review" data-review="${esc(v.bookingId)}">
      <div class="fx-rep__review-head">${starsHtml(v.rating)}<span class="fx-meta">${esc(v.at ? ago(v.at, nowMs) : '')}</span></div>
      <p class="fx-row__title">${esc(who)}</p>
      ${v.text ? `<p class="fx-body fx-rep__words">${esc(v.text)}</p>` : '<p class="fx-meta">No written review.</p>'}
      ${v.bookingId ? `<a class="fx-link fx-meta" href="${jobHref(v.bookingId)}">Open the job</a>` : ''}
    </li>`;
}

export function reviewsHtml(m, ui) {
    const r = m.rating, list = m.reviews, k = m.consistency;
    const head = r.count > 0 && !r.fault
        ? `<p class="fx-rep__avg">${starsHtml(Number(ui.artisanRating))} <span class="fx-num">${Number(ui.artisanRating).toFixed(1)}</span> <span class="fx-meta">· ${plural(r.count, 'review')}</span></p>`
        : '';
    const check = k.checked && !k.ok
        ? `<div class="fx-notice fx-notice--warn" role="status" data-check="rating">${icon('alert', 'fx-notice__icon')}<div class="fx-notice__body"><p>Your rating on file (${esc(Number(ui.artisanRating).toFixed(1))} from ${plural(k.serverCount, 'review')}) does not match the ${plural(k.count, 'review')} found${k.mean !== null ? `, which average ${esc(k.mean.toFixed(2))}` : ''}. Matching uses the rating on file. Fidus X support can recount it.</p><div class="fx-notice__actions"><a class="fx-btn fx-btn--secondary fx-btn--s" href="support.html">Contact support</a></div></div></div>`
        : '';
    const shown = list.slice(0, ui.reviewsShown);
    const body = list.length
        ? `<ul class="fx-rep__reviews">${shown.map((v) => reviewRowHtml(v, ui.nowMs)).join('')}</ul>
           ${list.length > shown.length ? `<div class="fx-rep__more"><button class="fx-btn fx-btn--secondary fx-btn--block" type="button" data-act="more-reviews">Show more reviews (${list.length - shown.length})</button></div>` : ''}`
        : `<p class="fx-meta fx-rep__empty">${r.count > 0 ? 'Your reviews could not be found among your recent jobs.' : 'No reviews yet. Customers can review a job once it is completed.'}</p>`;
    return sect('rep-reviews', `Reviews${list.length ? ` (${list.length})` : ''}`,
        `<div class="fx-sect__body fx-stack">${head}${check}</div>${body}${!m.scope.complete && list.length ? `<div class="fx-sect__body"><p class="fx-ledger__note">From your latest ${m.scope.read} finished jobs.</p></div>` : ''}`, ' id="reviews"');
}

/** Milestones: recognition for completed jobs, and nothing more. */
export function levelHtml(m) {
    const l = m.level;
    return sect('rep-level', 'Milestones',
        `<div class="fx-sect__body"><dl class="fx-ledger fx-rep__ledger">${row(l.name, `<span class="fx-num">${plural(l.jobs, 'job')}</span>`,
            l.next ? `${l.next.toGo} more completed ${l.next.toGo === 1 ? 'job' : 'jobs'} to ${l.next.name}.` : 'The highest milestone.', 'level')}</dl>
          <p class="fx-ledger__note">Milestones recognise the jobs you complete. They do not change how jobs are matched.</p></div>`);
}

export function renderReputation(dom, m, ui) {
    dom.main.innerHTML = [figuresHtml(m, ui.nowMs), matchingHtml(m), reviewsHtml(m, ui), recentHtml(m, ui.nowMs), levelHtml(m)].join('');
}
