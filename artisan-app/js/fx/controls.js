/**
 * artisan-app/js/fx/controls.js — behaviour for the small stateful components
 * (Phase 1): the segmented control, the countdown and the tab bar.
 *
 * Presentation lives in css/app.css; state lives in ARIA attributes, so the
 * CSS, assistive technology and tests all read the same thing.
 */
import { formatTimeLeft } from '../../../shared/js/domain/jobOffers.js';
import { icon } from './icons.js';

/**
 * Segmented control: a labelled group of toggle buttons, exactly one pressed.
 * Each segment is its own tab stop (a toggle-button group), so it works with
 * no roving-focus script and every state is announced ("pressed").
 *
 * @param {HTMLElement} group   .fx-seg[role="group"][aria-label]
 * @param {(value: string) => void} [onChange]
 */
export function bindSegmented(group, onChange) {
    const buttons = () => [...group.querySelectorAll('.fx-seg__btn')];
    function select(value, notify = true) {
        let changed = false;
        for (const b of buttons()) {
            const on = b.dataset.value === value;
            if (on && b.getAttribute('aria-pressed') !== 'true') changed = true;
            b.setAttribute('aria-pressed', on ? 'true' : 'false');
        }
        if (changed && notify && onChange) onChange(value);
    }
    group.addEventListener('click', (e) => {
        const b = e.target.closest('.fx-seg__btn');
        if (b && group.contains(b) && !b.disabled) select(b.dataset.value);
    });
    return { select, value: () => (buttons().find((b) => b.getAttribute('aria-pressed') === 'true') || {}).dataset?.value ?? null };
}

/**
 * Urgency of a countdown, the one rule every screen draws from.
 *   done  nothing left · now  under nowMs · soon  under soonMs · normal  otherwise
 */
export function countdownUrgency(leftMs, { soonMs = 30_000, nowMs = 10_000 } = {}) {
    if (!(leftMs > 0)) return 'done';
    if (leftMs <= nowMs) return 'now';
    if (leftMs <= soonMs) return 'soon';
    return 'normal';
}

/**
 * Drive an .fx-countdown from a deadline. The text (formatTimeLeft, the same
 * words the offer cards use) is the authority; the bar is a picture of it.
 *
 * @param {HTMLElement} el
 * @param {{ deadlineMs: number, totalMs: number, now?: () => number, onDone?: () => void }} opts
 * @returns {{ stop: () => void, tick: () => void }}
 */
export function bindCountdown(el, opts) {
    const { deadlineMs, totalMs, now = () => Date.now(), onDone = null } = opts;
    const value = el.querySelector('.fx-countdown__value');
    let timer = null;
    function tick() {
        const left = Math.max(0, deadlineMs - now());
        const urgency = countdownUrgency(left);
        el.dataset.urgency = urgency;
        el.style.setProperty('--fx-countdown', String(totalMs > 0 ? Math.min(1, left / totalMs) : 0));
        if (value) value.textContent = formatTimeLeft(Math.ceil(left / 1000));
        if (urgency === 'done') { stop(); if (onDone) onDone(); }
    }
    function stop() { if (timer) { clearInterval(timer); timer = null; } }
    tick();
    if (el.dataset.urgency !== 'done') timer = setInterval(tick, 1000);
    return { stop, tick };
}

/** The four artisan tabs (design decision 02). Hrefs are today's pages until each is rebuilt. */
export const ARTISAN_TABS = Object.freeze([
    { id: 'today',    label: 'Today',    href: 'dashboard.html', icon: 'today' },
    { id: 'jobs',     label: 'Jobs',     href: 'jobs.html',      icon: 'jobs' },
    { id: 'earnings', label: 'Earnings', href: 'wallet.html',    icon: 'earnings' },
    { id: 'account',  label: 'Account',  href: 'settings.html',  icon: 'account' },
]);

/**
 * Fill a <nav class="fx-tabbar" aria-label="Main"> with the four tabs.
 * @param {HTMLElement} nav
 * @param {{ current: string, badges?: Record<string, string>, tabs?: typeof ARTISAN_TABS }} opts
 *        badges: tab id → the words a screen reader hears ("2 new offers")
 */
export function renderTabbar(nav, { current, badges = {}, tabs = ARTISAN_TABS } = {}) {
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    nav.innerHTML = tabs.map((t) => {
        const isCurrent = t.id === current;
        const badge = badges[t.id] ? `<span class="fx-tab__badge"></span><span class="fx-sr">, ${esc(badges[t.id])}</span>` : '';
        return `<a class="fx-tab" href="${esc(t.href)}"${isCurrent ? ' aria-current="page"' : ''}>${icon(t.icon)}<span class="fx-tab__label">${esc(t.label)}</span>${badge}</a>`;
    }).join('');
}
