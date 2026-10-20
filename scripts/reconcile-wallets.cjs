#!/usr/bin/env node
'use strict';

/**
 * reconcile-wallets.cjs — READ-ONLY check that every artisan's stored balances
 * agree with their own ledger and payouts (AR-13).
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
 * Output names artisan ids, check names and row ids only — no names, phones or
 * amounts per person.
 *
 * Usage (needs `gcloud auth application-default login`):
 *   node scripts/reconcile-wallets.cjs --project lamax-4fd82
 */

const path = require('path');
const { createRequire } = require('module');

const ROOT = path.join(__dirname, '..');
const fnRequire = createRequire(path.join(ROOT, 'functions', 'package.json'));
const { reconcileArtisanWallet } = require(path.join(ROOT, 'functions', 'shared', 'walletLedger.js'));

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
        stale += r.staleRows.length;
        console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${a.id}${bad.length ? `  mismatched: ${bad.join(', ')}` : ''}`);
        for (const s of r.staleRows) {
            console.log(`       stale row ${s.id}: stored "${s.stored}", payout says "${s.actual}"  → proposed repair: status := "${s.actual}"`);
        }
    }
    console.log(`\n${artisans.size} artisan(s): ${failing} with mismatched balances, ${stale} stale ledger row(s). Nothing was written.`);
    process.exit(failing ? 1 : 0);
}

main().catch((e) => { console.error('reconcile failed:', e.message); process.exit(2); });
