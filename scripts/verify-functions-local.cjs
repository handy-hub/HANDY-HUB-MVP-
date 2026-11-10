#!/usr/bin/env node
'use strict';
/**
 * scripts/verify-functions-local.cjs — run the REAL Cloud Functions locally,
 * with no live secret anywhere near them.
 *
 *   npm run test:functions-emulator
 *
 * Why this exists: functions/.env on a developer machine holds live Paystack
 * and email keys, and the Functions emulator loads that file. So the functions
 * were never run locally (Phase 6 report), and every callable shipped verified
 * only by unit tests on fakes. This builds an isolated copy instead:
 *
 *   1. A fresh temp folder with firebase.json, the rules, and functions/ copied
 *      from this checkout, EXCLUDING every .env file and node_modules.
 *   2. A functions/.env with dummy values only (written here, below).
 *   3. functions/node_modules linked (a junction) to this checkout's, so no
 *      install runs; the link is removed as a link before the folder is deleted.
 *   4. `firebase emulators:exec` with Firestore, Auth, Functions and Storage
 *      under the demo project id `demo-fidusx` (firebase-tools never contacts
 *      Google for a demo- project), the test credential that cannot work, and
 *      tests/functions-emulator/netguard.cjs preloaded into every Node process:
 *      Paystack, Resend, SendGrid, Cloudinary and Anthropic are answered by a
 *      local mock, and any other outside address is refused and logged.
 *   5. tests/functions-emulator/verify.cjs calls the functions over HTTP as the
 *      apps do and checks the database: withdrawals while Paystack refuses
 *      payouts, approved-work cancellation, verification decisions, and the
 *      three privacy migrations.
 *
 * Needs Java (the Firestore emulator) and free ports 8080, 9099, 5001, 9199.
 * Takes about two minutes. Not part of `npm test`.
 */
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const KIT  = path.join(ROOT, 'tests', 'functions-emulator');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'fidusx-fnemu-'));
const FN   = path.join(WORK, 'functions');

const DUMMY_ENV = [
    '# LOCAL VERIFICATION ONLY. Every value is a dummy; no live key exists here.',
    'FIRESTORE_DB_ID=ai-studio-5589039d-72c4-40d8-ae39-f35c6c321eb6',
    'PAYSTACK_SECRET_KEY=sk_test_LOCAL_DUMMY_NOT_A_KEY',
    'PIN_PEPPER=local-verification-pepper-not-production',
    'RESEND_API_KEY=re_LOCAL_DUMMY',
    'EMAIL_FROM=noreply@fidusx.invalid',
    'CLOUDINARY_API_KEY=000000',
    'CLOUDINARY_API_SECRET=local-dummy',
    'CLOUDINARY_CLOUD_NAME=local-dummy',
    'ANTHROPIC_API_KEY=sk-ant-LOCAL-DUMMY',
    '',
].join('\n');

function copyTree(src, dest) {
    fs.mkdirSync(dest, { recursive: true });
    for (const e of fs.readdirSync(src, { withFileTypes: true })) {
        if (e.name === 'node_modules' || /^\.env/.test(e.name) || e.name === '.runtimeconfig.json') continue;
        const s = path.join(src, e.name), d = path.join(dest, e.name);
        if (e.isDirectory()) copyTree(s, d); else fs.copyFileSync(s, d);
    }
}

let code = 1;
try {
    for (const f of ['firebase.json', 'firestore.rules', 'firestore.indexes.json', 'storage.rules']) {
        fs.copyFileSync(path.join(ROOT, f), path.join(WORK, f));
    }
    copyTree(path.join(ROOT, 'functions'), FN);
    // Belt and braces: no live environment file may be present in the copy.
    const stray = fs.readdirSync(FN).filter((n) => /^\.env/.test(n) || n === '.runtimeconfig.json');
    if (stray.length) throw new Error(`refusing to run: ${stray.join(', ')} found in the copy`);
    fs.writeFileSync(path.join(FN, '.env'), DUMMY_ENV);
    fs.symlinkSync(path.join(ROOT, 'functions', 'node_modules'), path.join(FN, 'node_modules'), 'junction');

    const state = path.join(WORK, 'netguard-state.json');
    const log   = path.join(WORK, 'net.log');
    fs.writeFileSync(state, '{"transfer":"starter"}');
    fs.writeFileSync(log, '');
    const credential = path.join(os.tmpdir(), 'fidusx-tests-no-production-credential.json');
    require(path.join(ROOT, 'tests', 'support', 'no-production.cjs'));   // writes that credential

    const q = (p) => `"${p}"`;
    // firebase-tools' own entry script, run by this Node with no shell between:
    // a shell splits the script command below into several arguments.
    const npmRoot = spawnSync('npm', ['root', '-g'], { shell: true, encoding: 'utf8' }).stdout.trim();
    const cli = path.join(npmRoot, 'firebase-tools', 'lib', 'bin', 'firebase.js');
    if (!fs.existsSync(cli)) throw new Error(`firebase-tools not found at ${cli} (npm i -g firebase-tools)`);
    // verify.cjs reads the guard's state and log paths from the environment.
    const verify = `node ${q(path.join(KIT, 'verify.cjs').split(path.sep).join('/'))}`;
    console.log(`Isolated copy: ${WORK}\nStarting the emulators (demo-fidusx: Firestore, Auth, Functions, Storage)…\n`);
    const r = spawnSync(process.execPath, [cli, 'emulators:exec', '--only', 'firestore,auth,functions,storage', '--project', 'demo-fidusx', verify], {
        cwd: WORK, stdio: 'inherit',
        env: {
            ...process.env,
            GOOGLE_APPLICATION_CREDENTIALS: credential,
            // Forward slashes: Node reads backslashes in a quoted NODE_OPTIONS value as escapes.
            NODE_OPTIONS: `--require ${q(path.join(KIT, 'netguard.cjs').split(path.sep).join('/'))}`,
            FX_NETGUARD_LOG: log,
            FX_NETGUARD_STATE: state,
            FUNCTIONS_DISCOVERY_TIMEOUT: '90',
        },
    });
    code = r.status === null ? 1 : r.status;
    for (const f of ['verify-results.json', 'dryrun-reports.json', 'migration-reports.json', 'net.log']) {
        if (fs.existsSync(path.join(WORK, f))) fs.copyFileSync(path.join(WORK, f), path.join(os.tmpdir(), `fidusx-fnemu-last-${f}`));
    }
    console.log(`\nReports kept in ${os.tmpdir()} as fidusx-fnemu-last-*. Exit ${code}.`);
} catch (err) {
    console.error(`verify-functions-local: ${err.message}`);
    code = 1;
} finally {
    // Remove the junction as a link FIRST (never recursively: that would follow
    // it into the real node_modules), then the folder.
    const link = path.join(FN, 'node_modules');
    try { if (fs.lstatSync(link)) fs.rmdirSync(link); } catch (_) { /* not created */ }
    if (!fs.existsSync(link)) fs.rmSync(WORK, { recursive: true, force: true });
    else console.error(`left ${WORK} in place: the node_modules link could not be removed safely`);
}
process.exit(code);
