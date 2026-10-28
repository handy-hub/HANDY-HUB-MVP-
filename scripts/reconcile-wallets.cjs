#!/usr/bin/env node
'use strict';

/**
 * reconcile-wallets.cjs — READ-ONLY check that every stored balance agrees with
 * the records that justify it: artisans (AR-13) and customers (2026-10-22).
 *
 * Customers: walletBalance == Σ ledger rows (topup + refund − escrow_hold −
 * withdrawal that did not fail) and escrowBalance == Σ held/disputed escrow
 * (walletLedger.js reconcileCustomerWallet). A balance that is ahead of its
 * ledger was raised by something other than the server's money paths — e.g. a
 * console edit — and the server refuses to spend it.
 *
 * For each artisan it reports pass/fail for:
 *   earned     totalEarned      == Σ earning rows
 *   withdrawn  withdrawnTotal   == Σ withdrawal rows whose payout did not fail
 *   available  availableBalance == totalEarned − withdrawnTotal
 * and lists withdrawal rows whose stored status disagrees with their payout
 * (e.g. "processing" for a payout that failed and was refunded).
 *
 * It NEVER writes. There is deliberately no --apply: correcting a stale row's
 * status is a data migration and needs its own approval (docs: the proposed
 * repair is printed — set the row's status to the payout's, change nothing
 * else, and never touch a balance).
 *
 * Output names account ids, check names and row ids only — no names or phones.
 * Amounts are shown only with --detail (the operator investigating a mismatch).
 *
 * SPENDABLE: for every account it also prints what the server will let it
 * spend or withdraw — max(0, min(stored, verified ledger)) — exactly as
 * functions/financial/walletIntegrity.js computes it. "LIMITED" marks an account
 * whose stored balance is ahead of its evidence.
 *
 * Usage (needs `gcloud auth application-default login`):
 *   node scripts/reconcile-wallets.cjs --project lamax-4fd82
 */

const path = require('path');
const { createRequire } = require('module');

const ROOT = path.join(__dirname, '..');
const fnRequire = createRequire(path.join(ROOT, 'functions', 'package.json'));
const { reconcileArtisanWallet, reconcileCustomerWallet, verifiedCustomerPesewas, verifiedArtisanPesewas, spendablePesewas, backedHoldEscrowIds } = require(path.join(ROOT, 'functions', 'shared', 'walletLedger.js'));

const DB_FOR_PROJECT = {
    'lamax-4fd82':    'ai-studio-5589039d-72c4-40d8-ae39-f35c6c321eb6',
    'lamax-staging':  'handyhub-staging',
};

async function main() {
    const i = process.argv.indexOf('--project');
    const project = i > 0 ? process.argv[i + 1] : null;
    if (!project || !(project in DB_FOR_PROJECT)) {
        console.error(`Name the project: --project ${Object.keys(DB_FOR_PROJECT).join(' | ')}`);
        process.exit(2);
    }
    fnRequire('firebase-admin/app').initializeApp({ projectId: project });
    const db = fnRequire('firebase-admin/firestore').getFirestore(DB_FOR_PROJECT[project]);

    const detail = process.argv.includes('--detail');
    const spendLines = [];
    let limited = 0;
    const summarise = (rows) => Object.entries(rows.reduce((m, r) => ((m[`${r.type}:${r.reason}`] = (m[`${r.type}:${r.reason}`] || 0) + 1), m), {}))
        .map(([k, v]) => `${k}×${v}`).join(', ');
    async function escrowsFor(rows) {
        const ids = [...new Set(rows.filter((t) => (t.type === 'refund' || t.type === 'earning') && t.escrowId).map((t) => t.escrowId))];
        const snaps = await Promise.all(ids.map((id) => db.collection('escrow').doc(id).get()));
        return new Map(snaps.filter((x) => x.exists).map((x) => [x.id, x.data()]));
    }
    // A customer's ledger and the records behind its credits — exactly what
    // walletIntegrity.js readCustomerEvidence reads inside a debit.
    const evidenceCache = new Map();
    async function customerEvidence(uid) {
        if (evidenceCache.has(uid)) return evidenceCache.get(uid);
        const [txns, payouts] = await Promise.all([
            db.collection('customers').doc(uid).collection('transactions').get(),
            db.collection('payouts').where('userId', '==', uid).get(),
        ]);
        const rows = txns.docs.map((d) => ({ id: d.id, ...d.data() }));
        const refs = [...new Set(rows.filter((t) => t.type === 'topup' && t.paystackRef).map((t) => t.paystackRef))];
        const lockSnaps = await Promise.all(refs.map((ref) => db.collection('webhookLocks').doc(ref).get()));
        const ev = {
            customerId: uid, transactions: rows,
            payouts: payouts.docs.map((d) => ({ id: d.id, ...d.data() })),
            locks: new Map(lockSnaps.filter((x) => x.exists).map((x) => [x.id, x.data()])),
            escrows: await escrowsFor(rows),
        };
        evidenceCache.set(uid, ev);
        return ev;
    }
    // Escrows made before applyHold marked fundingVerified, proven by replaying
    // their customers' ledgers (walletLedger backedHoldEscrowIds).
    async function backedLegacyEscrows(escrows) {
        const backed = new Set();
        const owners = [...new Set([...escrows.values()].filter((e) => e.fundingVerified !== true && e.customerId).map((e) => e.customerId))];
        for (const uid of owners) for (const id of backedHoldEscrowIds(await customerEvidence(uid))) backed.add(id);
        return backed;
    }
    async function tipsFor(rows) {
        const ids = [...new Set(rows.filter((t) => t.type === 'tip' && t.bookingId).map((t) => t.bookingId))];
        const snaps = await Promise.all(ids.map((id) => db.collection('tips').doc(id).get()));
        return new Map(snaps.filter((x) => x.exists).map((x) => [x.id, x.data()]));
    }
    const artisans = await db.collection('artisans').get();
    let failing = 0, stale = 0;
    for (const a of artisans.docs) {
        const [txns, payouts] = await Promise.all([
            a.ref.collection('transactions').get(),
            db.collection('payouts').where('userId', '==', a.id).get(),
        ]);
        const r = reconcileArtisanWallet({
            artisan: a.data(),
            transactions: txns.docs.map((d) => ({ id: d.id, ...d.data() })),
            payouts: payouts.docs.map((d) => ({ id: d.id, ...d.data() })),
        });
        const bad = r.checks.filter((c) => !c.ok).map((c) => c.name);
        if (bad.length) failing++;
        const aRows = txns.docs.map((d) => ({ id: d.id, ...d.data() }));
        const aEsc = await escrowsFor(aRows);
        const av = verifiedArtisanPesewas({ artisanId: a.id, transactions: aRows,
            payouts: payouts.docs.map((d) => ({ id: d.id, ...d.data() })), escrows: aEsc,
            tips: await tipsFor(aRows), backedEscrows: await backedLegacyEscrows(aEsc) });
        const aStored = Math.round(Number(a.data().availableBalance || 0) * 100);
        if (aStored > av.pesewas) limited++;
        spendLines.push(`${aStored > av.pesewas ? 'LIMITED' : 'ok     '} artisan  ${a.id}` + (detail
            ? `  stored ${aStored / 100} verified ${av.pesewas / 100} spendable ${spendablePesewas(aStored / 100, av.pesewas) / 100}` +
              (av.unverified.length ? `  unverified: ${summarise(av.unverified)}` : '')
            : ''));
        stale += r.staleRows.length;
        console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${a.id}${bad.length ? `  mismatched: ${bad.join(', ')}` : ''}`);
        for (const s of r.staleRows) {
            console.log(`       stale row ${s.id}: stored "${s.stored}", payout says "${s.actual}"  → proposed repair: status := "${s.actual}"`);
        }
    }
    console.log(`\n${artisans.size} artisan(s): ${failing} with mismatched balances, ${stale} stale ledger row(s).`);

    // ── Customers ─────────────────────────────────────────────────────────────
    const customers = await db.collection('customers').get();
    let custFailing = 0;
    console.log('');
    for (const c of customers.docs) {
        const [txns, payouts, escrows] = await Promise.all([
            c.ref.collection('transactions').get(),
            db.collection('payouts').where('userId', '==', c.id).get(),
            db.collection('escrow').where('customerId', '==', c.id).get(),
        ]);
        const r = reconcileCustomerWallet({
            customer: c.data(),
            transactions: txns.docs.map((d) => ({ id: d.id, ...d.data() })),
            payouts: payouts.docs.map((d) => ({ id: d.id, ...d.data() })),
            escrows: escrows.docs.map((d) => d.data()),
        });
        if (!r.ok) custFailing++;
        const rows = txns.docs.map((d) => ({ id: d.id, ...d.data() }));
        const refs = [...new Set(rows.filter((t) => t.type === 'topup' && t.paystackRef).map((t) => t.paystackRef))];
        const lockSnaps = await Promise.all(refs.map((ref) => db.collection('webhookLocks').doc(ref).get()));
        const locks = new Map(lockSnaps.filter((x) => x.exists).map((x) => [x.id, x.data()]));
        const cv = verifiedCustomerPesewas({ customerId: c.id, transactions: rows,
            payouts: payouts.docs.map((d) => ({ id: d.id, ...d.data() })), locks, escrows: await escrowsFor(rows) });
        const cStored = Math.round(Number(c.data().walletBalance || 0) * 100);
        if (cStored > cv.pesewas) limited++;
        spendLines.push(`${cStored > cv.pesewas ? 'LIMITED' : 'ok     '} customer ${c.id}` + (detail
            ? `  stored ${cStored / 100} verified ${cv.pesewas / 100} spendable ${spendablePesewas(cStored / 100, cv.pesewas) / 100}` +
              (cv.unverified.length ? `  unverified: ${summarise(cv.unverified)}` : '')
            : ''));
        const bad = r.checks.filter((x) => !x.ok);
        const what = bad.map((x) => (detail ? `${x.name} stored ${x.actual} ledger ${x.expected} (diff ${x.difference})` : x.name));
        if (r.unknownTypes.length) what.push(`unknown row types: ${r.unknownTypes.join(', ')}`);
        console.log(`${r.ok ? 'OK  ' : 'FAIL'} customer ${c.id}${what.length ? '  ' + what.join('; ') : ''}`);
    }
    console.log(`\n${customers.size} customer(s): ${custFailing} whose wallet does not match its ledger/escrow.`);
    console.log('\n── What the server will let each account spend (walletIntegrity) ──');
    for (const l of spendLines) if (detail || l.startsWith('LIMITED')) console.log(l);
    console.log(`\n${limited} account(s) LIMITED: stored balance ahead of its verified ledger. Nothing was written.`);
    process.exit(failing || custFailing ? 1 : 0);
}

main().catch((e) => { console.error('reconcile failed:', e.message); process.exit(2); });
