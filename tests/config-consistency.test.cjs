'use strict';

/**
 * tests/config-consistency.test.cjs — values that live in more than one place
 * stay identical, and the hardcoded-values audit (2026-10-22) stays fixed.
 *
 * Run: node tests/config-consistency.test.cjs
 *
 *   ADMIN    the super-admin allowlist is the same in firestore.rules,
 *            storage.rules, functions/config.js and shared appConfig.js (rules
 *            cannot import, so this is the link), and every one of them grants
 *            it only to a VERIFIED email. A suspended admin record is not an
 *            admin.
 *   MONEY    the figures the apps display (PLATFORM_CONFIG) equal what the
 *            server enforces (functions/config.js), and no page computes a
 *            commission from its own literal.
 *   CONTENT  no placeholder or unconfirmed support contact, no secret key in a
 *            tracked file, one Firebase config for all three apps.
 *
 * Firestore-rules behaviour itself is proven in tests/artisan-privacy-rules.test.mjs
 * (npm run test:privacy-rules, emulator).
 */

require('./support/no-production.cjs');   // must stay the first statement (npm run lint:tests)
const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const { execFileSync } = require('child_process');

const fake = require('./support/fake-firebase.cjs').install();
const ROOT = path.join(__dirname, '..');
const FN   = path.join(ROOT, 'functions');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

for (const k of ['COMMISSION_RATE', 'MIN_WITHDRAWAL', 'MIN_TOPUP_GHS']) delete process.env[k];
const config       = require(path.join(FN, 'config.js'));
const verification = require(path.join(FN, 'artisanVerification.js'));
const reviewAdmin  = require(path.join(FN, 'reviewAdmin.js'));
const escrow       = require(path.join(FN, 'financial', 'escrow.js'));

let passed = 0, failed = 0;
const failures = [];
async function t(name, fn) {
    try { await fn(); passed++; console.log(`  PASS  ${name}`); }
    catch (e) { failed++; failures.push([name, e]); console.log(`  FAIL  ${name}\n        ${e.message}`); }
}

/** Load an ES module's `export const` values without a browser. */
function esmConsts(rel) {
    const src = read(rel).replace(/^\s*import\s[\s\S]*?from\s+['"][^'"]+['"];?\s*\n/gm, '')
        .replace(/^export\s+(const|function)\s+/gm, '$1 ');
    const names = [...read(rel).matchAll(/^export\s+const\s+([A-Za-z0-9_]+)/gm)].map((m) => m[1]);
    // eslint-disable-next-line no-new-func
    return new Function(`${src}\nreturn { ${names.join(', ')} };`)();
}
const APP = esmConsts('shared/js/config/appConfig.js');
const quoted = (block) => [...block.matchAll(/'([^']+@[^']+)'/g)].map((m) => m[1]);

(async () => {
console.log('\n── ADMIN · one allowlist, verified emails only ──\n');

const rulesList = (rel, fnName) => {
    const m = new RegExp(`function ${fnName}\\(\\)\\s*\\{([\\s\\S]*?)\\n    \\}`).exec(read(rel));
    assert.ok(m, `${fnName}() not found in ${rel}`);
    return m[1];
};
const FS_BODY = rulesList('firestore.rules', 'isSuperAdminEmail');
const ST_BODY = rulesList('storage.rules', 'isSuperAdmin');

await t('the allowlist is identical in firestore.rules, storage.rules, functions and the admin dashboard', () => {
    const lists = {
        'functions/config.js': config.ADMIN_EMAILS,
        'firestore.rules':     quoted(FS_BODY),
        'storage.rules':       quoted(ST_BODY),
        'appConfig.js':        APP.SUPER_ADMIN_EMAILS,
    };
    for (const [where, list] of Object.entries(lists)) {
        assert.ok(list.length > 0, `${where} has no list`);
        assert.deepStrictEqual([...list].sort(), [...config.ADMIN_EMAILS].sort(), `${where} differs`);
    }
});

await t('both rules files grant the allowlist only with email_verified == true', () => {
    assert.match(FS_BODY, /request\.auth\.token\.email_verified == true &&/);
    assert.match(ST_BODY, /request\.auth\.token\.email_verified == true &&/);
});

await t('isAllowlistedAdmin: a verified allowlisted email only', () => {
    const e = config.ADMIN_EMAILS[0];
    assert.strictEqual(config.isAllowlistedAdmin({ email: e, email_verified: true }), true);
    for (const tok of [{ email: e }, { email: e, email_verified: false }, { email: e, email_verified: 'true' },
        { email: 'someone@example.com', email_verified: true }, {}, null, undefined]) {
        assert.strictEqual(config.isAllowlistedAdmin(tok), false, JSON.stringify(tok));
    }
});

await t('no server check matches the allowlist by email alone', () => {
    const files = execFileSync('git', ['ls-files', 'functions/*.js', 'functions/**/*.js'], { cwd: ROOT, encoding: 'utf8' })
        .split('\n').filter((f) => f && !f.includes('node_modules') && f !== 'functions/config.js');
    const offenders = files.filter((f) => fs.existsSync(path.join(ROOT, f)) && /ADMIN_EMAILS\.includes\(/.test(read(f)));
    assert.deepStrictEqual(offenders, []);
});

await t('the admin dashboard gates on a verified allowlisted user (UI only — the server decides)', () => {
    for (const rel of ['admin-dashboard/js/auth-guard.js', 'admin-dashboard/login.html', 'admin-dashboard/promotions.html']) {
        for (const line of read(rel).split('\n').filter((l) => /SUPER_ADMIN_EMAILS\.includes\(/.test(l))) {
            assert.ok(/emailVerified/.test(line), `${rel}: "${line.trim()}" does not check emailVerified`);
        }
    }
});

const ADMIN_EMAIL = config.ADMIN_EMAILS[0];
const unverified = { uid: 'imposter', token: { email: ADMIN_EMAIL, email_verified: false } };
const verifiedAdm = { uid: 'owner', token: { email: ADMIN_EMAIL, email_verified: true } };

await t('artisan verification: an unverified account with an admin email is refused', async () => {
    fake.db._reset();
    await assert.rejects(() => verification.requireAdmin(unverified), /Unauthorized/);
    assert.strictEqual(await verification.requireAdmin(verifiedAdm), true);
});

await t('artisan verification and review admin: a SUSPENDED admin record is not an admin; an active one is', async () => {
    fake.db._reset();
    fake.db._set('admins/adm_s', { status: 'suspended', role: 'super_admin' });
    fake.db._set('admins/adm_a', { status: 'active', role: 'super_admin' });
    const suspended = { uid: 'adm_s', token: { email: 'ops@example.com', email_verified: true } };
    const active    = { uid: 'adm_a', token: { email: 'ops2@example.com', email_verified: true } };
    await assert.rejects(() => verification.requireAdmin(suspended), /Unauthorized/);
    assert.strictEqual(await verification.requireAdmin(active), true);
    await assert.rejects(() => reviewAdmin.reverseReview(suspended, { reviewId: 'r1', reason: 'x' }), /Unauthorized/);
});

await t('escrow / disputes / bookings admin check: unverified allowlisted email is not an admin', async () => {
    fake.db._reset();
    assert.strictEqual(await escrow.isAdminAuth(unverified), false);
    assert.strictEqual(await escrow.isAdminAuth(verifiedAdm), true);
});

console.log('\n── MONEY · the apps show what the server enforces ──\n');

await t('PLATFORM_CONFIG equals the server defaults: commission, minimum withdrawal, minimum top-up', () => {
    assert.strictEqual(APP.PLATFORM_CONFIG.commissionRate, config.COMMISSION_RATE);
    assert.strictEqual(APP.PLATFORM_CONFIG.minWithdrawalGHS, config.MIN_WITHDRAWAL);
    assert.strictEqual(APP.PLATFORM_CONFIG.minTopupGHS, config.MIN_TOPUP_GHS);
});

await t('functions/.env (when present) does not override them behind the apps\' back', () => {
    const envPath = path.join(FN, '.env');
    if (!fs.existsSync(envPath)) return;
    const keys = fs.readFileSync(envPath, 'utf8').split('\n').map((l) => l.split('=')[0].trim());
    for (const k of ['COMMISSION_RATE', 'MIN_WITHDRAWAL', 'MIN_TOPUP_GHS']) {
        assert.ok(!keys.includes(k), `functions/.env sets ${k}: update PLATFORM_CONFIG to match, then remove this guard's exception`);
    }
});

await t('no page computes a commission from its own literal', () => {
    const files = execFileSync('git', ['ls-files', 'customer-app', 'artisan-app', 'admin-dashboard', 'shared/js'], { cwd: ROOT, encoding: 'utf8' })
        .split('\n').filter((f) => /\.(js|html)$/.test(f) && fs.existsSync(path.join(ROOT, f)));
    const bad = [];
    for (const f of files) {
        read(f).split('\n').forEach((line, i) => {
            // Money expressions only (an animation's `progress * 0.85` is not a commission).
            if (/(amt|amount|total|price|fee|quote|earn|gross)\w*\)?\s*\*\s*0\.(15|85)\b|rate\s*\|\|\s*0\.15\b/i.test(line)) {
                bad.push(`${f}:${i + 1}`);
            }
        });
    }
    assert.deepStrictEqual(bad, []);
});

await t('artisan pages state the commission and minimum withdrawal from PLATFORM_CONFIG', () => {
    const onboarding = read('artisan-app/onboarding.html');
    assert.strictEqual((onboarding.match(/data-fx-commission/g) || []).length >= 2, true);
    assert.match(onboarding, /PLATFORM_CONFIG\.commissionRate/);
    assert.ok(!/paid directly to your MoMo account within 24 hours/.test(onboarding), 'the payout promise that did not match the product');
    const wallet = read('artisan-app/wallet.html');
    assert.match(wallet, /getElementById\('commission-rate'\)\.textContent = /);
    assert.match(wallet, /getElementById\('min-withdrawal'\)\.textContent  = /);
    const support = read('artisan-app/support.html');
    assert.match(support, /\$\{COMMISSION_PCT\}% commission/);
    assert.match(support, /GHS \$\{MIN_WITHDRAWAL\}/);
    assert.ok(!/insurance/i.test(support), 'no insurance exists');
    assert.ok(!/reliability score/i.test(support), 'no reliability score exists');
});

console.log('\n── CONTENT · contacts, claims, secrets, one config ──\n');

await t('no placeholder phone number, unconfirmed old-brand address or invented policy in the help pages', () => {
    const help = read('customer-app/settings-help.html');
    for (const re of [/\+233302123456|302 123 456/, /bank card/i, /more than 2 hours before/i, /within 24 hours of job completion/i,
        /within 48 hours/i, /24–48 hours/]) {
        assert.ok(!re.test(help), `customer help still says ${re}`);
    }
    assert.ok(!/support@handyhub\.app/.test(read('artisan-app/js/utils/artisanAuthGuard.js')));
    assert.match(read('artisan-app/js/utils/artisanAuthGuard.js'), /SUPPORT_CONTACTS\.email \?/);
});

await t('no secret API key in any tracked file', () => {
    const out = (() => {
        try {
            return execFileSync('git', ['grep', '-nIE', 'sk_(live|test)_[0-9A-Za-z]{10,}', '--', '.', ':!shared/vendor/*'],
                { cwd: ROOT, encoding: 'utf8' });
        } catch (e) { return e.status === 1 ? '' : (() => { throw e; })(); }
    })();
    const hits = out.split('\n').filter(Boolean).map((l) => l.split(':').slice(0, 2).join(':'));
    assert.deepStrictEqual(hits, [], 'secret key prefix found (location only shown)');
});

await t('the admin dashboard uses the shared Firebase config — no second copy', () => {
    const adm = read('admin-dashboard/js/firebase-admin.js');
    assert.ok(!/apiKey\s*:/.test(adm), 'firebase-admin.js defines its own apiKey');
    assert.ok(!/const FUNCTIONS_REGION\s*=/.test(adm));
    assert.match(adm, /FIREBASE_CONFIG, FIRESTORE_DB_ID, FUNCTIONS_REGION/);
    assert.strictEqual(APP.FUNCTIONS_REGION, config.FUNCTIONS_REGION);
    assert.strictEqual(APP.FIRESTORE_DB_ID, config.FIRESTORE_DB_ID);
});

await t('product name: the live config says Fidus X', () => {
    assert.strictEqual(APP.APP_META.name, 'Fidus X');
    assert.ok(!fs.existsSync(path.join(ROOT, 'shared/js/utils/constants.js')), 'the dead HandyHub constants file is gone');
});

console.log(`\nconfig-consistency: ${passed} passed, ${failed} failed`);
if (failed) {
    for (const [n, e] of failures) console.error(`\n✗ ${n}\n${e.stack}`);
    process.exit(1);
}
process.exit(0);
})();
