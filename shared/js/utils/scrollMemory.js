/**
 * scrollMemory.js — return a screen to where the customer left it.
 *
 * THE PROBLEM THIS SOLVES
 * ──────────────────────
 * HandyHub is a multi-page app: every navigation is a full document load, so
 * the scroll position dies with the document. Scroll halfway down the bookings
 * list, open one, press back — and you are at the top again, hunting for your
 * place. On a long list that is the single most irritating thing about the app.
 *
 * WHY NOT `history.scrollRestoration`
 * ───────────────────────────────────
 * The browser's own restoration only fires when the document is restored from
 * bfcache or session history WITH its layout intact. These screens paint from
 * cache and then re-render asynchronously once Firestore answers, so at the
 * moment the browser would restore, the list is often still a skeleton and the
 * page is not yet tall enough to scroll to. It silently lands at the top.
 *
 * So this restores AFTER content exists, retrying briefly while the list grows.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * ────────────────────────────────
 * It stores a NUMBER, per screen, in sessionStorage — no data, nothing
 * sensitive, and nothing that outlives the tab. It never restores on a fresh
 * entry to a screen, only when the customer is coming BACK to one they had
 * already scrolled.
 */

const PREFIX = 'hh_scroll_';
const MAX_RESTORE_MS = 2500;   // stop trying once the list has clearly settled

/** One key per screen. The path is enough — query strings are the same screen. */
function keyFor(name) {
    const page = name || (location.pathname.split('/').pop() || 'index');
    return PREFIX + page;
}

function read(key) {
    try {
        const raw = sessionStorage.getItem(key);
        if (!raw) return null;
        const n = Number(raw);
        return Number.isFinite(n) && n > 0 ? n : null;
    } catch { return null; }
}

/**
 * Remember and restore this screen's scroll position.
 *
 * @param {object}  [opts]
 * @param {string}  [opts.name]       override the screen key
 * @param {Element} [opts.container]  a scrolling element, when the page itself
 *                                    does not scroll (sheet/shell layouts)
 * @returns {{ save: Function, forget: Function }}
 */
export function rememberScroll(opts = {}) {
    const key = keyFor(opts.name);

    // WHICH ELEMENT ACTUALLY SCROLLS?
    //
    // Several HandyHub screens are app shells: `body { overflow:hidden;
    // height:100dvh }` with a flex column inside, so the WINDOW never scrolls —
    // an inner pane does. booking.css does exactly this. A version of this
    // module that assumed `window` silently did nothing on those screens.
    //
    // Rather than hard-code a selector per page (which rots the moment a layout
    // changes), find the element that is genuinely scrollable right now. The
    // window is the fallback, and it is re-checked on restore because the pane
    // may not have any content yet on first paint.
    let el = opts.container || null;

    function findScroller() {
        if (opts.container) return opts.container;
        const docScrolls =
            (document.documentElement.scrollHeight - window.innerHeight) > 40;
        if (docScrolls) return null;                 // null === use the window
        let best = null, bestH = 0;
        for (const c of document.querySelectorAll('div, main, section, ul')) {
            const st = getComputedStyle(c);
            if (!/auto|scroll/.test(st.overflowY)) continue;
            const over = c.scrollHeight - c.clientHeight;
            if (over > 40 && over > bestH) { best = c; bestH = over; }
        }
        return best;
    }

    el = findScroller();

    // ── The selected tab ────────────────────────────────────────────────────
    // Scroll position on a tabbed screen is meaningless without the tab. Come
    // back to the bookings list and it reopens on "Upcoming"; a scroll offset
    // saved while reading "Completed" then has nothing to restore into.
    //
    // Tabs are identified by their INDEX among [role="tab"] rather than by any
    // page-specific API, so this works on any screen that marks its tabs up
    // correctly — and quietly does nothing on screens that do not.
    const TAB_KEY = key + '_tab';
    const tabs = () => Array.from(document.querySelectorAll('[role="tab"]'));

    function saveTab() {
        try {
            const i = tabs().findIndex(t =>
                t.getAttribute('aria-selected') === 'true' || t.classList.contains('active'));
            if (i >= 0) sessionStorage.setItem(TAB_KEY, String(i));
        } catch (_) {}
    }

    function restoreTab() {
        try {
            const raw = sessionStorage.getItem(TAB_KEY);
            if (raw === null) return false;
            const want = Number(raw);
            const list = tabs();
            if (!Number.isInteger(want) || want < 0 || want >= list.length) return false;
            const target = list[want];
            const already = target.getAttribute('aria-selected') === 'true'
                         || target.classList.contains('active');
            if (already) return false;

            // These tabs use inline onclick="switchTab('completed', this)", and
            // that global is defined by a module that loads AFTER this one.
            // Clicking too early throws "switchTab is not defined" — an inline
            // handler's exception surfaces as an uncaught error, so a try/catch
            // around .click() does not contain it. Wait until the function the
            // markup names actually exists.
            const inline = target.getAttribute('onclick') || '';
            const fnName = (inline.match(/([A-Za-z_$][\w$]*)\s*\(/) || [])[1];
            if (fnName && typeof window[fnName] !== 'function') return false;   // retry later

            // Click rather than reach into page internals: the page's own tab
            // handler runs, so filtering, counts and aria stay consistent.
            target.click();
            return true;
        } catch (_) { return false; }
    }

    document.addEventListener('click', (e) => {
        if (e.target && e.target.closest && e.target.closest('[role="tab"]')) {
            setTimeout(saveTab, 0);          // after the page updates aria-selected
        }
    }, true);

    const getY = () => (el ? el.scrollTop : (window.scrollY || document.documentElement.scrollTop || 0));
    const setY = (y) => { if (el) el.scrollTop = y; else window.scrollTo(0, y); };

    // The browser's own attempt lands at the top on an async-rendered list, and
    // then fights ours. Take control.
    try { if ('scrollRestoration' in history) history.scrollRestoration = 'manual'; } catch (_) {}

    const save = () => {
        try {
            saveTab();
            const y = getY();
            if (y > 0) sessionStorage.setItem(key, String(Math.round(y)));
            else sessionStorage.removeItem(key);
        } catch (_) {}
    };

    // Save on the events that actually precede a navigation. `pagehide` covers
    // both a normal unload and going into bfcache; `visibilitychange` covers the
    // app being backgrounded on mobile, where pagehide is not guaranteed.
    window.addEventListener('pagehide', save);
    document.addEventListener('visibilitychange', () => { if (document.hidden) save(); });

    let raf = 0;
    const onScroll = () => {
        if (raf) return;
        raf = requestAnimationFrame(() => { raf = 0; save(); });
    };
    // Capture-phase document listener catches scrolls from ANY pane, including
    // one that only becomes scrollable after a tab switch or a list growing.
    document.addEventListener('scroll', (e) => {
        if (!opts.container && e.target && e.target !== document && e.target.nodeType === 1) {
            el = e.target;                            // adopt the pane being scrolled
        }
        onScroll();
    }, { passive: true, capture: true });
    window.addEventListener('scroll', onScroll, { passive: true });

    // ── Restore ─────────────────────────────────────────────────────────────
    // Put the screen back on the right tab before trying to restore a position
    // within it. Retried briefly because the tab strip may render after this runs.
    (function restoreTabWhenReady(tries = 0) {
        if (restoreTab() || tries > 40) return;   // ~5s for late modules
        setTimeout(() => restoreTabWhenReady(tries + 1), 120);
    })();

    const target = read(key);
    if (target) {
        const started = Date.now();
        const tryRestore = () => {
            if (!opts.container) el = findScroller();   // re-detect as content arrives
            const max = el
                ? el.scrollHeight - el.clientHeight
                : document.documentElement.scrollHeight - window.innerHeight;

            // Content tall enough to honour the request — do it and stop.
            if (max >= target) { setY(target); return; }

            // Still rendering. Keep trying briefly, then give up rather than
            // yanking the page around after the customer has started reading.
            if (Date.now() - started < MAX_RESTORE_MS) requestAnimationFrame(tryRestore);
        };
        requestAnimationFrame(tryRestore);
    }

    return {
        save,
        forget() { try { sessionStorage.removeItem(key); } catch (_) {} },
    };
}
