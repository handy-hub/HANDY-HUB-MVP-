'use strict';

/**
 * tests/functions-capacity.test.cjs — every function must fit inside the
 * region's Cloud Run CPU quota, all at once.
 *
 * Run: node tests/functions-capacity.test.cjs
 *
 * WHAT THIS PROTECTS
 * ──────────────────
 * europe-west1 allows 20 vCPU of RUNNING Cloud Run instances for this project
 * (run.googleapis.com/cpu_allocation = 20,000 milli-vCPU), idle instances
 * included, and the console will not raise it yet. On 2026-10-19 every function
 * sat at Firebase's default of 1 vCPU, so only ~20 of 56 could be warm at once:
 * the 21st cold start returned 503 and deploys failed their health checks.
 *
 * functions/index.js now defaults every function to gen1-sized CPU, and only
 * deliberately listed functions take more. This test loads the REAL
 * functions/index.js and reads each function's endpoint — the same object the
 * Firebase CLI deploys from — then checks the budget:
 *
 *   • only the listed burst functions get a full vCPU
 *   • no function can ever hold more than 1 vCPU (cpu × maxInstances)
 *   • every function warm once fits under 18 vCPU (2 spare for deploys)
 *   • only the listed user-facing callables scale past one instance, and
 *     admin tools, backfills, migrations and schedulers never do
 *   • nothing under 1 vCPU asks for more than one concurrent request (Cloud Run
 *     refuses that combination at deploy time)
 *
 * Adding a function: it is small and single-instance by default and needs no
 * change here. Giving it BURST_CPU or USER_FACING_SCALE means adding it to the
 * matching list below — on purpose, with the budget printed in front of you.
 *
 * Nothing here touches a network, Firebase or the emulator.
 */

const assert = require('assert');
const path   = require('path');

let passed = 0, failed = 0;
const failures = [];
function t(name, fn) {
    try { fn(); passed++; console.log(`  PASS  ${name}`); }
    catch (e) { failed++; failures.push([name, e]); console.log(`  FAIL  ${name}\n        ${e.message}`); }
}

const QUOTA_VCPU      = 20;   // run.googleapis.com/cpu_allocation, europe-west1
const WARM_BUDGET     = 18;   // every function warm once, with 2 vCPU spare for deploys
const MAX_PER_FUNCTION = 1;   // cpu × maxInstances

const BURST = [
    'paystackWebhook', 'onBookingStatusChanged', 'onBookingReviewed', 'onBookingCreated', 'syncArtisanIndex',
];
const USER_FACING = [
    'beginProfilePhotoReplacement', 'commitProfilePhotoReplacement', 'abortProfilePhotoReplacement',
    'setSecurityPin', 'initiateTopupCharge', 'verifyTopupNow', 'submitTopupOtp',
    'processWithdrawal', 'processArtisanWithdrawal',
    'submitJobQuote', 'approveJobQuote', 'rejectJobQuote', 'getPricingQuote',
    'createInspectionBooking', 'payCalloutFee', 'payEmergencyCallout', 'completeInspection',
    'cancelInspectionBooking', 'checkAccountDeletable', 'requestAccountDeletion', 'aiSearch',
    'requestSignupOtp', 'signUpArtisanDirect', 'resendSignupOtp', 'verifySignupOtp',
    'respondToJobOffer',
];

// The Firebase CLI's own resolution (firebase-tools lib/deploy/functions/
// prepare.js resolveCpuAndConcurrency + backend.js memoryToGen*Cpu).
const GEN1_CPU = { 128: 0.0833, 256: 0.1666, 512: 0.3333, 1024: 0.5833, 2048: 1, 4096: 2, 8192: 2, 16384: 4, 32768: 8 };
const GEN2_CPU = { 128: 1, 256: 1, 512: 1, 1024: 1, 2048: 1, 4096: 2, 8192: 2, 16384: 4, 32768: 8 };
// An option left unset is a ResetValue on the endpoint; the SDK sends it to the
// CLI as its toJSON() — null, "use the default" (firebase-functions
// lib/runtime/manifest.js stackToWire).
const wire = (v) => (v && typeof v === 'object' && typeof v.toJSON === 'function') ? v.toJSON() : v;
function resolve(ep) {
    const memory = wire(ep.availableMemoryMb) || 256;
    const cpuOpt = wire(ep.cpu);
    const cpu = cpuOpt === 'gcf_gen1' ? GEN1_CPU[memory] : (cpuOpt || GEN2_CPU[memory]);
    const concurrency = wire(ep.concurrency) || (cpu >= 1 ? 80 : 1);
    return { memory, cpu, concurrency, maxInstances: wire(ep.maxInstances) };
}

process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'lamax-4fd82';
const fns = require(path.join(__dirname, '..', 'functions', 'index.js'));
const all = Object.fromEntries(Object.entries(fns)
    .filter(([, f]) => f && f.__endpoint)
    .map(([name, f]) => [name, { ...resolve(f.__endpoint), trigger: Object.keys(f.__endpoint).find(k => /Trigger$/.test(k)) }]));
const names = Object.keys(all);
const fmt = (n) => n.toFixed(2);

t('functions/index.js exports the functions this budget was measured on', () => {
    assert.ok(names.length >= 56, `only ${names.length} functions found`);
    for (const n of [...BURST, ...USER_FACING]) assert.ok(all[n], `${n} is listed here but not exported`);
});

t('functions default to gen1-sized CPU (the global option is in place)', () => {
    assert.strictEqual(fns.checkExpiredDispatches.__endpoint.cpu, 'gcf_gen1');
    assert.strictEqual(all.checkExpiredDispatches.cpu, GEN1_CPU[256]);
});

t('only the listed burst functions take a full vCPU', () => {
    const full = names.filter(n => all[n].cpu >= 1).sort();
    assert.deepStrictEqual(full, [...BURST].sort());
    for (const n of BURST) {
        assert.strictEqual(all[n].cpu, 1, `${n} cpu`);
        assert.strictEqual(all[n].maxInstances, 1, `${n} maxInstances`);
    }
});

t(`no function can hold more than ${MAX_PER_FUNCTION} vCPU`, () => {
    for (const n of names) {
        const worst = all[n].cpu * all[n].maxInstances;
        assert.ok(worst <= MAX_PER_FUNCTION + 1e-9, `${n}: ${all[n].cpu} vCPU × ${all[n].maxInstances} = ${fmt(worst)}`);
    }
});

t(`every function warm once fits under ${WARM_BUDGET} of the ${QUOTA_VCPU} vCPU`, () => {
    const warm = names.reduce((s, n) => s + all[n].cpu, 0);
    const worst = names.reduce((s, n) => s + all[n].cpu * all[n].maxInstances, 0);
    console.log(`        warm once: ${fmt(warm)} vCPU · every instance at its cap: ${fmt(worst)} vCPU · quota ${QUOTA_VCPU}`);
    assert.ok(warm <= WARM_BUDGET, `${fmt(warm)} vCPU with every function warm once`);
});

t('only the listed user-facing callables scale past one instance', () => {
    const multi = names.filter(n => all[n].maxInstances > 1).sort();
    assert.deepStrictEqual(multi, [...USER_FACING].sort());
    for (const n of USER_FACING) assert.strictEqual(all[n].trigger, 'callableTrigger', `${n} is not a callable`);
});

t('admin tools, backfills, migrations and schedulers never run in parallel', () => {
    const single = names.filter(n => /^(admin|backfill)/.test(n) || all[n].trigger === 'scheduleTrigger'
        || ['releaseEscrow', 'refundBooking', 'raiseDispute', 'resolveDispute', 'holdBookingFunds',
            'cancelBookingAsAdmin', 'recomputeArtisanAggregate', 'reverseReview'].includes(n));
    assert.ok(single.length >= 14, `only ${single.length} matched`);
    for (const n of single) assert.strictEqual(all[n].maxInstances, 1, `${n} maxInstances`);
});

t('nothing under 1 vCPU asks for more than one concurrent request', () => {
    for (const n of names) if (all[n].cpu < 1) assert.strictEqual(all[n].concurrency, 1, `${n} concurrency`);
});

console.log(`\nfunctions-capacity: ${passed} passed, ${failed} failed`);
if (failed) { for (const [name, e] of failures) console.log(`\n✗ ${name}\n${e.stack}`); process.exit(1); }
