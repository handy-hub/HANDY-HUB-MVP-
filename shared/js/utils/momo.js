/**
 * momo.js — the single frontend source of Ghana Mobile Money logic: provider
 * lookup, network detection from a phone number, and phone normalisation/masking.
 *
 * Built on MOMO_PROVIDERS in appConfig.js so provider identity + Paystack codes
 * are defined ONCE. The payment-method forms, the internal top-up charge flow, and
 * the withdrawal flow all import from here — no page invents its own provider list,
 * prefix table, or phone formatter.
 *
 * Paystack uses different codes for charges vs transfers; both live on the provider
 * record (chargeCode / transferBank). This module never picks between them — the
 * caller asks for the code it needs.
 */

import { MOMO_PROVIDERS } from '../config/appConfig.js';

/** All valid internal provider keys ('mtn' | 'telecel' | 'airteltigo'). */
export const MOMO_KEYS = Object.keys(MOMO_PROVIDERS);

/** Provider record for an internal key, or null. Includes the key on the object. */
export function providerByKey(key) {
    const k = String(key || '').toLowerCase();
    return MOMO_PROVIDERS[k] ? { key: k, ...MOMO_PROVIDERS[k] } : null;
}

/** Normalise any input to local Ghana format 0XXXXXXXXX (10 digits). */
export function normaliseLocal(phone) {
    let d = String(phone || '').replace(/\D/g, '');
    if (d.startsWith('233')) d = '0' + d.slice(3);
    else if (d.length === 9 && !d.startsWith('0')) d = '0' + d;
    return d;
}

/** Normalise to E.164 (+233XXXXXXXXX). Returns '' when a valid number can't be formed. */
export function toE164(phone) {
    const local = normaliseLocal(phone);
    if (!/^0\d{9}$/.test(local)) return '';
    return '+233' + local.slice(1);
}

/** Mask all but the last 4 digits, e.g. 0244123456 → ······3456. */
export function maskPhone(phone) {
    const d = String(phone || '').replace(/\D/g, '');
    if (d.length < 4) return String(phone || '');
    return d.slice(0, -4).replace(/\d/g, '·') + d.slice(-4);
}

/** Detect the network from a Ghana phone number by prefix. @returns key | null */
export function detectProvider(phone) {
    const local = normaliseLocal(phone);
    if (local.length < 3) return null;
    const prefix = local.slice(0, 3);
    for (const [key, p] of Object.entries(MOMO_PROVIDERS)) {
        if ((p.prefixes || []).includes(prefix)) return key;
    }
    return null;
}

/** Paystack Charge API provider code for a saved method's internal key, or null. */
export function chargeCodeFor(key) {
    const p = providerByKey(key);
    return p ? p.chargeCode : null;
}

/** Paystack Transfer API bank_code for a saved method's internal key, or null. */
export function transferBankFor(key) {
    const p = providerByKey(key);
    return p ? p.transferBank : null;
}
