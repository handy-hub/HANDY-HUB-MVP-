/**
 * GENERATED FILE — DO NOT EDIT.
 *
 * CommonJS mirror of shared/js/domain/quoteMoney.js, produced by
 * scripts/build-functions-shared.cjs so the Cloud Functions runtime (which
 * only receives the functions/ directory, and cannot import an ES module)
 * decides with exactly the same rules and the same numbers as the browser
 * (and, for appointments, firestore.rules).
 *
 * Edit the source module and re-run:  node scripts/build-functions-shared.cjs
 * `npm run lint` fails if this file has drifted from its source.
 */

'use strict';
/**
 * quoteMoney.js — THE rules for the money in a job quote. (AR-08, 2026-10-20)
 *
 * WHY THIS EXISTS
 * ───────────────
 * submitJobQuote checked `Number(x) <= 0` and nothing else. `Number('abc')` is
 * NaN, and `NaN <= 0` is false, so a non-numeric labour charge, quantity or
 * unit price passed validation and became a NaN quote. Material lines had no
 * upper bound at all, and only the labour charge was capped. A NaN quote
 * cannot be approved — approveJobQuote refuses it — so the customer's only
 * moves were to reject it or let it expire, and on the inspection track both
 * pay the callout fee to the artisan.
 *
 * Every monetary input is now decided here, once, for the artisan's composer
 * (immediate feedback) and for submitJobQuote (the authority — the browser is
 * never trusted). functions/shared/quoteMoney.js is a GENERATED mirror
 * (scripts/build-functions-shared.cjs), so the two cannot drift.
 *
 * MONEY REPRESENTATION
 * ────────────────────
 * Amounts are Ghana cedis with pesewa precision (2 decimal places), stored as
 * numbers, which is what the ledger already uses. All arithmetic here happens
 * in whole pesewas, so 0.1 + 0.2 never becomes 0.30000000000000004, and the
 * total is exactly the sum of its rows. A value with more than two decimals is
 * REFUSED, not rounded: a price the artisan did not type is not a price.
 *
 * LIMITS
 * ──────
 *   maxQuoteGHS        the pricing policy's quote ceiling (functions/config.js
 *                      MAX_QUOTE_GHS, default 10 000), applied to the labour
 *                      charge, to every unit price, to every line, and to the
 *                      TOTAL — before, only labour was capped, so materials
 *                      could take a quote to any size.
 *   maxMaterialLines   30 — the approval screen lists every line for the
 *                      customer to read; a quote longer than that is not one
 *                      a customer can meaningfully approve.
 *   maxQuantity        1 000 per line, to two decimals (2.5 m of pipe).
 *   nameMax / noteMax  80 / 300 characters.
 */
const QUOTE_LIMITS = Object.freeze({
    maxQuoteGHS:      10000,
    maxMaterialLines: 30,
    maxQuantity:      1000,
    nameMax:          80,
    noteMax:          300,
});

// A plain decimal with at most two places: "120", "120.5", "120.50".
// No sign, exponent, hex, thousands separator or currency symbol.
const DECIMAL_2DP = /^\d+(\.\d{1,2})?$/;

/**
 * Read one amount as whole hundredths (pesewas for money, hundredths of a unit
 * for a quantity). Accepts a finite JS number or a canonical decimal string.
 * Returns { ok: true, hundredths } or { ok: false, message }.
 */
function toHundredths(value, label) {
    let n;
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) return { ok: false, message: `${label} must be a number.` };
        n = value;
    } else if (typeof value === 'string' && DECIMAL_2DP.test(value.trim())) {
        n = Number(value.trim());
    } else if (value === undefined || value === null || value === '') {
        return { ok: false, message: `${label} is required.` };
    } else {
        return { ok: false, message: `${label} must be a number.` };
    }
    if (n < 0) return { ok: false, message: `${label} cannot be negative.` };
    const scaled = n * 100;
    const hundredths = Math.round(scaled);
    if (Math.abs(scaled - hundredths) > 1e-6) {
        return { ok: false, message: `${label} can have at most 2 decimal places.` };
    }
    return { ok: true, hundredths };
}

const toGHS = (pesewas) => pesewas / 100;
const fmtGHS = (ghs) => `GHS ${Number(ghs).toLocaleString('en-GH', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

/**
 * Validate a quote as the artisan submits it.
 *
 * @param {{ labourCost, materials?, note? }} input
 * @param {{ maxQuoteGHS? }} [opts]
 * @returns {{ ok: true, quote: { labourCost, materials, materialsCost, jobQuote, note } }
 *         | { ok: false, errors: Array<{ field, message }>, message }}
 */
function validateQuoteInput(input, opts = {}) {
    const maxQuoteGHS = Number.isFinite(opts.maxQuoteGHS) && opts.maxQuoteGHS > 0
        ? opts.maxQuoteGHS : QUOTE_LIMITS.maxQuoteGHS;
    const maxPesewas = Math.round(maxQuoteGHS * 100);
    const errors = [];
    const fail = (field, message) => { errors.push({ field, message }); };
    const src = input && typeof input === 'object' ? input : {};

    // ── Labour ──────────────────────────────────────────────────────────────
    const labour = toHundredths(src.labourCost, 'Labour cost');
    let labourP = 0;
    if (!labour.ok) fail('labourCost', labour.message);
    else if (labour.hundredths <= 0) fail('labourCost', 'Labour cost must be greater than 0.');
    else if (labour.hundredths > maxPesewas) fail('labourCost', `Labour cost cannot exceed ${fmtGHS(maxQuoteGHS)}.`);
    else labourP = labour.hundredths;

    // ── Materials ───────────────────────────────────────────────────────────
    const rawMaterials = src.materials === undefined || src.materials === null ? [] : src.materials;
    const materials = [];
    let materialsP = 0;
    if (!Array.isArray(rawMaterials)) {
        fail('materials', 'Materials must be a list.');
    } else if (rawMaterials.length > QUOTE_LIMITS.maxMaterialLines) {
        fail('materials', `A quote can list at most ${QUOTE_LIMITS.maxMaterialLines} materials.`);
    } else {
        rawMaterials.forEach((item, i) => {
            const row = item && typeof item === 'object' ? item : {};
            const name = typeof row.name === 'string' ? row.name.trim() : '';
            const label = name ? `"${name.slice(0, 40)}"` : `material ${i + 1}`;
            if (!name) { fail(`materials[${i}].name`, `Give material ${i + 1} a name.`); return; }
            if (name.length > QUOTE_LIMITS.nameMax) {
                fail(`materials[${i}].name`, `The name of ${label} is too long (max ${QUOTE_LIMITS.nameMax} characters).`);
                return;
            }
            const qty = toHundredths(row.qty, `Quantity for ${label}`);
            const unit = toHundredths(row.unitPrice, `Price for ${label}`);
            if (!qty.ok)  { fail(`materials[${i}].qty`, qty.message); return; }
            if (!unit.ok) { fail(`materials[${i}].unitPrice`, unit.message); return; }
            if (qty.hundredths <= 0)  { fail(`materials[${i}].qty`, `Quantity for ${label} must be greater than 0.`); return; }
            if (qty.hundredths > QUOTE_LIMITS.maxQuantity * 100) {
                fail(`materials[${i}].qty`, `Quantity for ${label} cannot exceed ${QUOTE_LIMITS.maxQuantity}.`); return;
            }
            if (unit.hundredths <= 0) { fail(`materials[${i}].unitPrice`, `Price for ${label} must be greater than 0.`); return; }
            if (unit.hundredths > maxPesewas) {
                fail(`materials[${i}].unitPrice`, `Price for ${label} cannot exceed ${fmtGHS(maxQuoteGHS)}.`); return;
            }
            // qty is in hundredths of a unit, price in pesewas: the line total in
            // pesewas is qty × price / 100, rounded half-up to the pesewa.
            const lineP = Math.round((qty.hundredths * unit.hundredths) / 100);
            if (lineP > maxPesewas) {
                fail(`materials[${i}]`, `The total for ${label} cannot exceed ${fmtGHS(maxQuoteGHS)}.`); return;
            }
            materialsP += lineP;
            materials.push({ name, qty: qty.hundredths / 100, unitPrice: toGHS(unit.hundredths), total: toGHS(lineP) });
        });
    }

    // ── Note ────────────────────────────────────────────────────────────────
    let note = '';
    if (src.note !== undefined && src.note !== null) {
        if (typeof src.note !== 'string') fail('note', 'The note must be text.');
        else note = src.note.trim().slice(0, QUOTE_LIMITS.noteMax);
    }

    // ── Total ───────────────────────────────────────────────────────────────
    const totalP = labourP + materialsP;
    if (!errors.length && totalP > maxPesewas) {
        fail('jobQuote', `The quote total cannot exceed ${fmtGHS(maxQuoteGHS)}.`);
    }

    if (errors.length) return { ok: false, errors, message: errors[0].message };
    return {
        ok: true,
        quote: {
            labourCost:    toGHS(labourP),
            materials,
            materialsCost: toGHS(materialsP),
            jobQuote:      toGHS(totalP),
            note,
        },
    };
}

/**
 * Is the quote ALREADY STORED on a booking one that may move money?
 *
 * New quotes are validated on the way in, but a booking written before this
 * module existed may hold anything. Approval, rejection and expiry ask this
 * first, so a malformed legacy quote is set aside (see voidInvalidQuote in
 * functions/quotes.js) instead of being charged, or of paying the callout fee
 * through a rejection or an expiry the customer was forced into.
 *
 * @returns {{ ok: boolean, problems: string[] }}
 */
function checkStoredQuote(booking, opts = {}) {
    const b = booking && typeof booking === 'object' ? booking : {};
    const maxQuoteGHS = Number.isFinite(opts.maxQuoteGHS) && opts.maxQuoteGHS > 0
        ? opts.maxQuoteGHS : QUOTE_LIMITS.maxQuoteGHS;
    const problems = [];
    const money = (v) => (typeof v === 'number' ? toHundredths(v, 'x') : { ok: false });

    const total = money(b.jobQuote);
    if (!total.ok || total.hundredths <= 0) problems.push('jobQuote');
    else if (total.hundredths > Math.round(maxQuoteGHS * 100)) problems.push('jobQuote_over_limit');

    // Components are optional on very old quotes, but when present they must
    // be well-formed and add up to the total.
    let sumP = 0, haveParts = false;
    if (b.labourCost !== undefined) {
        haveParts = true;
        const l = money(b.labourCost);
        if (!l.ok || l.hundredths <= 0) problems.push('labourCost'); else sumP += l.hundredths;
    }
    if (b.materials !== undefined && b.materials !== null) {
        if (!Array.isArray(b.materials)) problems.push('materials');
        else b.materials.forEach((m, i) => {
            const t = m && typeof m === 'object' ? money(m.total) : { ok: false };
            const q = m && typeof m === 'object' ? money(m.qty) : { ok: false };
            const u = m && typeof m === 'object' ? money(m.unitPrice) : { ok: false };
            if (!t.ok || !q.ok || !u.ok || q.hundredths <= 0 || u.hundredths <= 0) problems.push(`materials[${i}]`);
        });
    }
    if (b.materialsCost !== undefined) {
        haveParts = true;
        const mc = money(b.materialsCost);
        if (!mc.ok) problems.push('materialsCost'); else sumP += mc.hundredths;
    }
    if (haveParts && total.ok && !problems.length && sumP !== total.hundredths) problems.push('total_mismatch');

    return { ok: problems.length === 0, problems };
}

// ── CommonJS surface ─────────────────────────────────────────────────────────
module.exports = {
    toHundredths,
    validateQuoteInput,
    checkStoredQuote,
    QUOTE_LIMITS,
};
