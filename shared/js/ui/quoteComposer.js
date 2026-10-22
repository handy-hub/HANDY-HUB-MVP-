/**
 * quoteComposer.js — THE quote composition form, for both artisan surfaces.
 *
 * It used to exist only inside artisan-app/jobs.html, as markup plus a dozen
 * `window.*` handlers reading a module-scoped `_quoteBookingId`. That made the
 * job screen (job.html?id=…) unable to price the job it was already showing —
 * the artisan had to be bounced to the list, where the sheet re-derived which
 * booking it was pricing from a variable set by whichever card was tapped last.
 *
 * A quote is the single most consequential thing an artisan writes: it becomes
 * the price the customer is charged and the escrow that is held. "Which booking
 * is this for?" must never be answered by page-global state.
 *
 * So: the booking id is a REQUIRED argument, captured at mount time and closed
 * over. There is no module-level current-booking variable to go stale, and two
 * composers mounted at once would still each submit against their own booking.
 */

// The same validator submitJobQuote runs (AR-08): the artisan sees the
// server's own verdict and totals before sending, and nothing here is trusted.
import { validateQuoteInput } from '../domain/quoteMoney.js';

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const money = (n) => (Math.round(Number(n) * 100) / 100).toFixed(2);

/**
 * Mount the composer into a container.
 *
 * @param {object}   opts
 * @param {string}   opts.bookingId          REQUIRED — the booking being priced
 * @param {Element}  opts.mount              container to render into
 * @param {string}   [opts.serviceLabel]     shown so the artisan can see what they are pricing
 * @param {Function} [opts.onSubmitted]      (result) => void, after a successful submit
 * @param {Function} [opts.onCancel]         () => void
 * @param {Function} [opts.toast]            (msg) => void
 * @param {Function} [opts.submitQuote]      injected for tests; defaults to the callable
 * @returns {{ destroy: Function, bookingId: string }}
 */
export function mountQuoteComposer(opts = {}) {
    const { bookingId, mount, serviceLabel, onSubmitted, onCancel, toast, submitQuote } = opts;

    if (!bookingId) throw new Error('mountQuoteComposer requires a bookingId.');
    if (!mount)     throw new Error('mountQuoteComposer requires a mount element.');

    const say = typeof toast === 'function' ? toast : (m) => console.log('[quote]', m);
    let needsMaterials = false;
    let busy = false;

    mount.innerHTML = `
      <div class="qc" data-booking="${esc(bookingId)}">
        <p class="qc-for">Quoting <strong>${esc(serviceLabel || 'this job')}</strong>
          <span class="qc-ref">${esc(bookingId)}</span></p>

        <div class="qc-field">
          <label class="qc-label" for="qc-labour">Your labour charge (GHS)</label>
          <input id="qc-labour" class="qc-input" type="number" min="0" step="0.01"
                 inputmode="decimal" placeholder="0.00">
        </div>

        <div class="qc-field">
          <span class="qc-label">Will you need to buy materials?</span>
          <div class="qc-toggle">
            <button type="button" id="qc-no"  class="qc-tog active">No</button>
            <button type="button" id="qc-yes" class="qc-tog">Yes</button>
          </div>
        </div>

        <div id="qc-mats" style="display:none">
          <div class="qc-mat-head"><span>Item</span><span>Qty</span><span>Price</span><span></span></div>
          <div id="qc-mat-rows"></div>
          <button type="button" class="qc-add" id="qc-add">+ Add item</button>
        </div>

        <div class="qc-sum">
          <div class="qc-sum-row"><span>Labour</span><span>GHS <span id="qc-s-lab">0.00</span></span></div>
          <div class="qc-sum-row" id="qc-s-matrow" style="display:none"><span>Materials</span><span>GHS <span id="qc-s-mat">0.00</span></span></div>
          <div class="qc-sum-row qc-total"><span>Total quote</span><span>GHS <span id="qc-s-tot">0.00</span></span></div>
        </div>

        <div class="qc-field">
          <label class="qc-label" for="qc-note">Note to customer (optional)</label>
          <textarea id="qc-note" class="qc-note" maxlength="300"
                    placeholder="e.g. price may change if extra parts are needed"></textarea>
        </div>

        <button type="button" id="qc-submit" class="qc-submit" disabled>Send quote to customer</button>
        ${onCancel ? '<button type="button" id="qc-cancel" class="qc-cancel">Cancel</button>' : ''}
      </div>`;

    const $ = (id) => mount.querySelector('#' + id);

    function addRow() {
        const row = document.createElement('div');
        row.className = 'qc-mat-row';
        row.innerHTML = `
          <input type="text"   class="qc-input" placeholder="Item name">
          <input type="number" class="qc-input" placeholder="Qty"   min="0.01" step="0.01" inputmode="decimal">
          <input type="number" class="qc-input" placeholder="Price" min="0" step="0.01" inputmode="decimal">
          <button type="button" class="qc-del" aria-label="Remove item">&times;</button>`;
        row.querySelectorAll('input').forEach(i => i.addEventListener('input', recalc));
        row.querySelector('.qc-del').addEventListener('click', () => { row.remove(); recalc(); });
        $('qc-mat-rows').appendChild(row);
        row.querySelector('input').focus();
    }

    // Raw strings go to the validator as typed: parseFloat('12abc') is 12, and
    // `|| 0` turned anything unreadable into a silent zero.
    function readInput() {
        const materials = needsMaterials
            ? [...mount.querySelectorAll('.qc-mat-row')].map(row => {
                const [nameEl, qtyEl, priceEl] = row.querySelectorAll('input');
                return { name: nameEl.value, qty: qtyEl.value.trim(), unitPrice: priceEl.value.trim() };
            })
            : [];
        return { labourCost: $('qc-labour').value.trim(), materials, note: $('qc-note').value };
    }

    function recalc() {
        const checked = validateQuoteInput(readInput());
        const q = checked.ok ? checked.quote : null;
        $('qc-s-lab').textContent = q ? money(q.labourCost) : '—';
        $('qc-s-mat').textContent = q ? money(q.materialsCost) : '—';
        $('qc-s-tot').textContent = q ? money(q.jobQuote) : '—';
        $('qc-submit').disabled = !q || busy;
    }

    function setMaterials(yes) {
        needsMaterials = yes;
        $('qc-no').classList.toggle('active', !yes);
        $('qc-yes').classList.toggle('active', yes);
        $('qc-mats').style.display = yes ? '' : 'none';
        $('qc-s-matrow').style.display = yes ? '' : 'none';
        if (yes && $('qc-mat-rows').children.length === 0) addRow();
        recalc();
    }

    async function submit() {
        if (busy) return;                       // duplicate taps do nothing
        const checked = validateQuoteInput(readInput());
        if (!checked.ok) { say(checked.message); return; }
        const { labourCost, materials, note } = checked.quote;

        busy = true;
        const btn = $('qc-submit');
        const label = btn.textContent;
        btn.disabled = true;
        btn.textContent = 'Sending…';

        try {
            // bookingId comes from the closure, NOT from any shared variable —
            // this is what makes it impossible for a quote to land on the job
            // the artisan happened to look at most recently.
            const send = submitQuote || (await defaultSubmit());
            const res = await send({
                bookingId,
                labourCost,
                materials: materials.map(({ name, qty, unitPrice }) => ({ name, qty, unitPrice })),
                note,
            });
            say('Quote sent. The customer has been notified.');
            if (typeof onSubmitted === 'function') onSubmitted(res, bookingId);
        } catch (e) {
            say(friendly(e));
            busy = false;
            btn.disabled = false;
            btn.textContent = label;
            return;
        }
        busy = false;
        btn.disabled = false;
        btn.textContent = label;
    }

    $('qc-labour').addEventListener('input', recalc);
    $('qc-no').addEventListener('click',  () => setMaterials(false));
    $('qc-yes').addEventListener('click', () => setMaterials(true));
    $('qc-add').addEventListener('click', addRow);
    $('qc-submit').addEventListener('click', submit);
    if (onCancel) $('qc-cancel').addEventListener('click', onCancel);

    recalc();

    return {
        bookingId,
        destroy() { mount.innerHTML = ''; },
    };
}

/** The real callable. Kept lazy so tests can inject without loading Firebase. */
async function defaultSubmit() {
    const { callable } = await import('../services/callable.js');
    const fn = callable('submitJobQuote');
    return (payload) => fn(payload).then(r => r.data);
}

function friendly(e) {
    const m = String(e?.message || '');
    if (/already/i.test(m))                    return 'A quote has already been sent for this job.';
    if (/permission|unauthenticated/i.test(m)) return 'You are not able to quote this job.';
    if (/network|unavailable/i.test(m))        return 'Connection problem — the quote was not sent.';
    return m || 'The quote could not be sent.';
}

/** Styles, injected once per document. */
export function quoteComposerStyles() {
    return `
    .qc-for { font:500 13px/1.4 var(--ds-font, inherit); color: var(--ds-ink-2, #475067); margin:0 0 14px; }
    .qc-ref { font:600 10.5px/1 ui-monospace, monospace; color: var(--ds-ink-3, #8A93A6); display:block; margin-top:3px; }
    .qc-field { margin-bottom: 14px; }
    .qc-label { display:block; font:600 13px/1 var(--ds-font, inherit); color: var(--ds-ink-2, #475067); margin-bottom:7px; }
    .qc-input { width:100%; height:48px; border:1.5px solid transparent; border-radius:12px; padding:0 14px;
                font:500 15px/1 var(--ds-font, inherit); color: var(--ds-ink, #0F1216);
                background: var(--ds-surface-2, #F2F4F7); box-sizing:border-box; outline:none; }
    .qc-input:focus { background: var(--ds-surface, #fff); border-color: var(--ds-brand-500, #F97316); }
    .qc-toggle { display:flex; gap:8px; }
    .qc-tog { flex:1; height:44px; border-radius:12px; font:700 14px/1 var(--ds-font, inherit);
              border:1px solid var(--ds-line-strong, #E2E5EA); background: var(--ds-surface, #fff);
              color: var(--ds-ink-2, #475067); cursor:pointer; }
    .qc-tog.active { background: var(--ds-brand-500, #F97316); color:#fff; border-color: var(--ds-brand-500, #F97316); }
    .qc-mat-head { display:grid; grid-template-columns:1fr 68px 80px 28px; gap:6px; margin-bottom:4px; }
    .qc-mat-head span { font:700 10px/1 var(--ds-font, inherit); color: var(--ds-ink-3, #8A93A6);
                        text-transform:uppercase; letter-spacing:.4px; }
    .qc-mat-row { display:grid; grid-template-columns:1fr 68px 80px 28px; gap:6px; margin-bottom:8px; align-items:center; }
    .qc-mat-row .qc-input { height:42px; font-size:13px; }
    .qc-del { width:28px; height:28px; border:none; background: var(--ds-danger-bg, #FDECEC); border-radius:8px;
              font-size:16px; cursor:pointer; color: var(--ds-danger, #C0392B); }
    .qc-add { background:none; border:1px dashed var(--ds-line-strong, #E2E5EA); border-radius:10px;
              width:100%; height:40px; font:700 13px/1 var(--ds-font, inherit);
              color: var(--ds-brand-600, #EA580C); cursor:pointer; margin-bottom:14px; }
    .qc-sum { background: var(--ds-surface-2, #F2F4F7); border-radius:12px; padding:14px; margin-bottom:14px; }
    .qc-sum-row { display:flex; justify-content:space-between; font:500 13.5px/1.6 var(--ds-font, inherit);
                  color: var(--ds-ink-2, #475067); }
    .qc-sum-row.qc-total { font-weight:800; color: var(--ds-ink, #0F1216); font-size:15px;
                           border-top:1px solid var(--ds-line, #ECEEF2); margin-top:8px; padding-top:8px; }
    .qc-note { width:100%; min-height:74px; border:1.5px solid transparent; border-radius:12px; padding:12px 14px;
               font:500 14px/1.5 var(--ds-font, inherit); background: var(--ds-surface-2, #F2F4F7);
               box-sizing:border-box; outline:none; resize:vertical; color: var(--ds-ink, #0F1216); }
    .qc-submit { width:100%; height:52px; border:none; border-radius:14px; background: var(--ds-brand-500, #F97316);
                 color:#fff; font:800 15.5px/1 var(--ds-font, inherit); cursor:pointer; }
    .qc-submit:disabled { opacity:.5; cursor:default; }
    .qc-cancel { width:100%; height:44px; margin-top:8px; border:none; background:none;
                 font:700 14px/1 var(--ds-font, inherit); color: var(--ds-ink-3, #8A93A6); cursor:pointer; }`;
}
