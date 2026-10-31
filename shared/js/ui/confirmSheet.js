/**
 * confirmSheet.js — "Are you sure?" as the app's own bottom sheet (audit UI-011).
 *
 * The artisan screens asked with the browser's native confirm(): an unstyled
 * box with the site's address in it, and wording that varied page to page.
 * This asks the same question in the canonical sheet
 * (shared/js/components/sheet.js: focus trap, Escape, backdrop and swipe to
 * dismiss, focus restored), laid out like Settings' own sign-out sheet.
 *
 *   if (!(await confirmSheet({ title: 'Decline this request?', confirmLabel: 'Decline', danger: true }))) return;
 *
 * Resolves true ONLY when the confirm button is pressed; Cancel, Escape, a tap
 * on the backdrop or a swipe all resolve false. Caller text is set with
 * textContent, never parsed as HTML. If the sheet itself cannot open, it falls
 * back to the native confirm() rather than leaving the action unreachable.
 */

import { openSheet } from '../components/sheet.js';

let _seq = 0;

/**
 * @param {{ title: string, message?: string, confirmLabel?: string,
 *           cancelLabel?: string, danger?: boolean }} opts
 * @returns {Promise<boolean>}
 */
export async function confirmSheet({ title, message = '', confirmLabel = 'Confirm',
                                     cancelLabel = 'Keep it', danger = false } = {}) {
    const n = ++_seq;
    const box = document.createElement('div');
    box.style.cssText = 'padding:0 var(--ds-gutter, 16px) var(--ds-5, 20px);';

    const head = document.createElement('p');
    head.id = `confirm-sheet-title-${n}`;
    head.textContent = String(title || 'Are you sure?');
    head.style.cssText = 'margin:0 0 var(--ds-2, 8px);font:800 18px/1.25 var(--ds-font, inherit);color:var(--ds-ink);';
    box.appendChild(head);

    let describedBy = '';
    if (message) {
        const sub = document.createElement('p');
        sub.id = `confirm-sheet-msg-${n}`;
        sub.textContent = String(message);
        sub.style.cssText = 'margin:0;font:500 14px/1.5 var(--ds-font, inherit);color:var(--ds-ink-2);';
        box.appendChild(sub);
        describedBy = sub.id;
    }

    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;flex-direction:column;gap:var(--ds-2, 8px);margin-top:var(--ds-5, 20px);';
    const yes = document.createElement('button');
    yes.type = 'button';
    yes.className = `ds-btn ${danger ? 'ds-btn--danger' : 'ds-btn--primary'} ds-btn--block`;
    yes.textContent = String(confirmLabel);
    yes.dataset.confirm = '';
    const no = document.createElement('button');
    no.type = 'button';
    no.className = 'ds-btn ds-btn--secondary ds-btn--block';
    no.textContent = String(cancelLabel);
    no.dataset.cancel = '';
    actions.append(yes, no);
    box.appendChild(actions);

    return new Promise((resolve) => {
        let answered = false;
        const answer = (v) => { if (!answered) { answered = true; resolve(v); } };
        openSheet({
            content: box,
            labelledBy: head.id,
            describedBy,
            initialFocus: '[data-cancel]',          // the safe choice has focus
            onClose: () => answer(false),            // any dismissal is "no"
        }).then((sheet) => {
            yes.addEventListener('click', () => { answer(true);  sheet.close('confirm'); });
            no.addEventListener('click',  () => { answer(false); sheet.close('cancel'); });
        }).catch(() => {
            // The sheet could not open (its stylesheet failed, say): still ask.
            answer(window.confirm([title, message].filter(Boolean).join('\n\n')));
        });
    });
}
