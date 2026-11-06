/**
 * artisan-app/js/fx/icons.js — the artisan icon set (Phase 1, from the Workbench).
 *
 * One family: 24px grid, 1.75px stroke, round caps and joins, currentColor —
 * so an icon takes its colour from the component it sits in, never a tile.
 * Every icon is decorative (aria-hidden); the control around it carries the
 * accessible name.
 */

const P = {
    today:    '<rect x="3.5" y="4.5" width="17" height="16" rx="2"/><path d="M8 2.5v4M16 2.5v4M3.5 9.5h17"/><path d="M12 13v3l2 1.25"/>',
    jobs:     '<rect x="2.5" y="7" width="19" height="13.5" rx="2"/><path d="M8.5 7V5a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v2M2.5 12.5h19"/>',
    earnings: '<rect x="2.5" y="5.5" width="19" height="14" rx="2"/><path d="M2.5 10h19M6.5 15h4"/>',
    account:  '<circle cx="12" cy="8" r="4"/><path d="M4 20.5a8 8 0 0 1 16 0"/>',
    bell:     '<path d="M6 9a6 6 0 1 1 12 0c0 6.5 2.5 8.5 2.5 8.5h-17S6 15.5 6 9"/><path d="M10.2 20.5a2 2 0 0 0 3.6 0"/>',
    back:     '<path d="M15 18 9 12l6-6"/>',
    next:     '<path d="m9 18 6-6-6-6"/>',
    down:     '<path d="m6 9 6 6 6-6"/>',
    more:     '<circle cx="5.5" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="18.5" cy="12" r="1.4" fill="currentColor" stroke="none"/>',
    phone:    '<path d="M21 16.4v2.9a1.9 1.9 0 0 1-2.1 1.9 18.8 18.8 0 0 1-8.2-2.9 18.5 18.5 0 0 1-5.7-5.7A18.8 18.8 0 0 1 2.1 4.4 1.9 1.9 0 0 1 4 2.3h2.9a1.9 1.9 0 0 1 1.9 1.6c.1.9.4 1.8.7 2.7a1.9 1.9 0 0 1-.4 2L7.9 9.8a15.2 15.2 0 0 0 5.7 5.7l1.2-1.2a1.9 1.9 0 0 1 2-.4c.9.3 1.8.6 2.7.7a1.9 1.9 0 0 1 1.5 1.8z"/>',
    message:  '<path d="M20.5 14.5a2 2 0 0 1-2 2H8l-4.5 4v-15a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2z"/>',
    navigate: '<path d="M3 11.2 21 3l-8.2 18-2.3-7.5z"/>',
    pin:      '<path d="M19.5 10c0 5.6-7.5 11.5-7.5 11.5S4.5 15.6 4.5 10a7.5 7.5 0 0 1 15 0z"/><circle cx="12" cy="10" r="2.75"/>',
    check:    '<path d="M20 6.5 9.5 17 4 11.5"/>',
    close:    '<path d="M18 6 6 18M6 6l12 12"/>',
    alert:    '<path d="M10.3 4.2 2.2 18.2A2 2 0 0 0 3.9 21h16.2a2 2 0 0 0 1.7-2.8L13.7 4.2a2 2 0 0 0-3.4 0z"/><path d="M12 9.5v4.5M12 17.5h.01"/>',
    info:     '<circle cx="12" cy="12" r="9.5"/><path d="M12 16.5v-5M12 8h.01"/>',
    clock:    '<circle cx="12" cy="12" r="9.5"/><path d="M12 7v5l3.25 1.75"/>',
    lock:     '<rect x="4" y="10.5" width="16" height="10.5" rx="2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>',
    shield:   '<path d="M12 21.5s7.5-3.6 7.5-9.5V5.2L12 2.5 4.5 5.2V12c0 5.9 7.5 9.5 7.5 9.5z"/><path d="m8.8 11.8 2.3 2.3 4.2-4.3"/>',
    tools:    '<path d="M14.6 6.3a4 4 0 0 0 5.2 5.2l-8.6 8.6a2.1 2.1 0 0 1-3-3z"/><path d="M14.6 6.3 17 3.9l3.1 3.1-2.4 2.4"/>',
    send:     '<path d="M21.5 2.5 14 21.5l-3.5-8-8-3.5z"/><path d="m21.5 2.5-11 11"/>',
    plus:     '<path d="M12 5v14M5 12h14"/>',
    help:     '<circle cx="12" cy="12" r="9.5"/><path d="M9.3 9.2a2.8 2.8 0 0 1 5.4 1c0 1.8-2.7 2.6-2.7 2.6M12 16.8h.01"/>',
    cancel:   '<circle cx="12" cy="12" r="9.5"/><path d="m15 9-6 6M9 9l6 6"/>',
    wallet:   '<path d="M19.5 7.5v-2a2 2 0 0 0-2-2h-13a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1V12m0 4v2.5a2 2 0 0 1-2 2h-14a2 2 0 0 1-2-2v-13"/><path d="M21.5 12v4h-4a2 2 0 0 1 0-4z"/>',
};

export const ICON_NAMES = Object.freeze(Object.keys(P));

/** An inline SVG string; '' for an unknown name. Sized by the component's CSS. */
export function icon(name, className = '') {
    const body = P[name];
    if (!body) return '';
    const cls = className ? ` class="${className}"` : '';
    return `<svg${cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
}
