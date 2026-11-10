// netguard.cjs — preloaded into every Cloud Functions emulator worker
// (NODE_OPTIONS=--require). Nothing the functions do may leave this machine.
//
//  • global fetch: Paystack, Resend, SendGrid, Cloudinary and Anthropic are
//    answered here by a mock; any other non-local address is REFUSED.
//  • http/https.request: only the local emulators (127.0.0.1, localhost) are
//    reachable; anything else is refused (firebase-admin's Google calls, FCM).
//  • Every intercepted call is appended to FX_NETGUARD_LOG as one JSON line,
//    so the test can show exactly what the functions tried to reach.
//
// Paystack behaviour comes from FX_NETGUARD_STATE (a JSON file the test
// rewrites between cases): { "transfer": "starter" | "accept" | "timeout" }.
'use strict';
const fs = require('fs');
const LOG = process.env.FX_NETGUARD_LOG;
const STATE = process.env.FX_NETGUARD_STATE;
const LOCAL = /^(127\.0\.0\.1|localhost|::1|\[::1\])$/i;

function log(entry) {
    if (!LOG) return;
    try { fs.appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...entry }) + '\n'); } catch (_) {}
}
function state() {
    try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch (_) { return {}; }
}
log({ event: 'preload', node: process.version });

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
let seq = 0;

function paystack(method, path, body) {
    const s = state();
    if (method === 'POST' && path === '/transferrecipient') {
        if (s.recipient === 'starter') return json(400, { status: false, message: 'You cannot create transfer recipients as a starter business' });
        return json(200, { status: true, message: 'Transfer recipient created', data: { recipient_code: `RCP_mock_${body.account_number}`, active: true } });
    }
    if (method === 'POST' && path === '/transfer') {
        if (s.transfer === 'starter') return json(400, { status: false, message: 'You cannot initiate third party payouts as a starter business' });
        if (s.transfer === 'timeout') throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
        return json(200, { status: true, message: 'Transfer has been queued', data: { status: 'pending', reference: body.reference, transfer_code: `TRF_mock_${++seq}`, amount: body.amount } });
    }
    if (method === 'GET' && path.startsWith('/transfer/verify/')) return json(404, { status: false, message: 'Transfer not found' });
    if (method === 'GET' && path.startsWith('/transaction/verify/')) return json(404, { status: false, message: 'Transaction reference not found' });
    return json(400, { status: false, message: `mock: no route for ${method} ${path}` });
}

const realFetch = globalThis.fetch;
globalThis.fetch = async function guardedFetch(input, init = {}) {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const method = (init.method || 'GET').toUpperCase();
    if (LOCAL.test(url.hostname)) return realFetch(input, init);
    let body = null;
    try { body = init.body ? JSON.parse(init.body) : null; } catch (_) { body = null; }
    const auth = String((init.headers && (init.headers.Authorization || init.headers.authorization)) || '');
    const entry = { event: 'fetch', method, host: url.hostname, path: url.pathname, keyKind: auth.replace(/^Bearer\s+/, '').slice(0, 8) };
    if (url.hostname === 'api.paystack.co') {
        const res = paystack(method, url.pathname, body || {});
        log({ ...entry, answered: 'mock', status: res.status, amount: body && body.amount, reference: body && body.reference });
        return res;
    }
    if (url.hostname === 'api.resend.com' || url.hostname === 'api.sendgrid.com') {
        log({ ...entry, answered: 'mock', to: body && (body.to || (body.personalizations && 'personalizations')), subject: body && body.subject });
        return json(200, { id: 'mock-email' });
    }
    if (url.hostname === 'api.cloudinary.com' || url.hostname === 'api.anthropic.com') {
        log({ ...entry, answered: 'refused-mock' });
        return json(503, { error: { message: 'mock: external service disabled in local verification' } });
    }
    log({ ...entry, answered: 'BLOCKED' });
    throw new Error(`netguard: blocked outbound fetch to ${url.hostname}`);
};

for (const modName of ['http', 'https']) {
    const mod = require(modName);
    for (const fn of ['request', 'get']) {
        const real = mod[fn];
        mod[fn] = function guarded(...args) {
            let host = '';
            const a = args[0];
            if (typeof a === 'string' || a instanceof URL) host = new URL(String(a)).hostname;
            else if (a && typeof a === 'object') host = String(a.hostname || a.host || '').replace(/:\d+$/, '');
            if (!host || LOCAL.test(host)) return real.apply(this, args);
            log({ event: `${modName}.${fn}`, host, answered: 'BLOCKED' });
            throw new Error(`netguard: blocked outbound ${modName} request to ${host}`);
        };
    }
}
