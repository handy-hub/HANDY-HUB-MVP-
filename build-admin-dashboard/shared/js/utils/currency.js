/**
 * currency.js — the single source of truth for money formatting.
 *
 * HandyHub operates in Ghana Cedis. The ISO 4217 code is **GHS** (the old "GHC"
 * was retired in 2007 when the currency was redenominated). The app had drifted
 * to a mix of "GHC" and "GHS" — sometimes on the same screen — which is a direct
 * correctness/trust defect on a money platform. Every user-facing amount must go
 * through this module so the code, the symbol, and the decimal handling can never
 * diverge again.
 *
 * This module has NO imports so it evaluates in every browser context (customer,
 * artisan, admin) and can be pulled in from inline module scripts.
 *
 *   import { formatGHS, formatGHSShort, formatGHSRange } from '../shared/js/utils/currency.js';
 *   formatGHS(1234.5)        → "GHS 1,234.50"
 *   formatGHSShort(1500)     → "GHS 1.5k"
 *   formatGHSRange(50, 200)  → "GHS 50–200"
 */

export const CURRENCY_CODE = 'GHS';

/** Coerce anything to a finite number, defaulting to 0. */
function num(n) {
    const v = Number(n);
    return Number.isFinite(v) ? v : 0;
}

/**
 * Format an amount as "GHS 1,234.50" (thousands grouped, 2 decimals).
 * @param {number|string} amount
 * @param {{ decimals?: number, code?: boolean }} [opts]
 *   decimals — number of fraction digits (default 2)
 *   code     — include the "GHS " prefix (default true; false → "1,234.50")
 */
export function formatGHS(amount, { decimals = 2, code = true } = {}) {
    const v = num(amount);
    const body = v.toLocaleString('en-GH', {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
    });
    return code ? `${CURRENCY_CODE} ${body}` : body;
}

/**
 * Compact format for tight UI (stat tiles, chips): "GHS 1.5k", "GHS 2.3M".
 * Values under 1,000 render in full with no decimals ("GHS 850").
 */
export function formatGHSShort(amount) {
    const v = Math.abs(num(amount));
    const sign = num(amount) < 0 ? '-' : '';
    if (v >= 1_000_000) return `${CURRENCY_CODE} ${sign}${(v / 1_000_000).toFixed(1)}M`;
    if (v >= 1_000)     return `${CURRENCY_CODE} ${sign}${(v / 1_000).toFixed(1)}k`;
    return `${CURRENCY_CODE} ${sign}${v.toFixed(0)}`;
}

/**
 * Price-range label, e.g. "GHS 50–200" (en-dash, no decimals by default).
 * Accepts numbers or already-numeric strings.
 */
export function formatGHSRange(min, max, { decimals = 0 } = {}) {
    const lo = num(min).toFixed(decimals);
    const hi = num(max).toFixed(decimals);
    return `${CURRENCY_CODE} ${lo}–${hi}`;
}
