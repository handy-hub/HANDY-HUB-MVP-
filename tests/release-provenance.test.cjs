'use strict';

/**
 * tests/release-provenance.test.cjs — a release must say where it came from,
 * and must never claim more than it knows.
 *
 * Run: node tests/release-provenance.test.cjs
 *
 * WHAT THIS PROTECTS
 * ──────────────────
 * The 2026-10-19 forensics found production built from uncommitted states that
 * exist in no commit, with nothing recording which. scripts/release-provenance.cjs
 * stamps every hosting build and gates releases. The failure modes that matter:
 *
 *   • a dirty build presented as a clean commit (the stamp lies)
 *   • the gate letting a dirty, unpushed, untagged or untargeted release through
 *   • a manifest — which is served publicly — leaking file names, contents,
 *     environment values or identities
 *   • staging itself (build-admin-dashboard/ is tracked) making a clean source
 *     look dirty
 *   • a site with no manifest being reported as anything but UNKNOWN
 *
 * Every scenario runs in a throwaway Git repository under the OS temp dir,
 * with a local bare repository standing in for the remote. Nothing here
 * touches this repository, a network, or Firebase.
 */

require('./support/no-production.cjs');   // must stay the first statement (npm run lint:tests)
const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const { execFileSync } = require('child_process');

const prov = require(path.join(__dirname, '..', 'scripts', 'release-provenance.cjs'));

let passed = 0, failed = 0;
const failures = [];
async function t(name, fn) {
    try { await fn(); passed++; console.log(`  PASS  ${name}`); }
    catch (e) { failed++; failures.push([name, e]); console.log(`  FAIL  ${name}\n        ${e.message}`); }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-release-'));
const IDENT = ['-c', 'user.name=Release Test', '-c', 'user.email=release-test@example.invalid',
               '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', '-c', 'core.autocrlf=false'];
const g = (cwd, ...args) => execFileSync('git', [...IDENT, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

let n = 0;
/** A fresh repo with one commit, an origin, and a .firebaserc. */
function repo({ push = false, tag = null } = {}) {
    const dir    = path.join(TMP, `r${++n}`);
    const remote = path.join(TMP, `r${n}.git`);
    fs.mkdirSync(dir);
    g(TMP, 'init', '--bare', '-q', remote);
    g(dir, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(dir, 'app.js'), 'console.log("v1");\n');
    fs.mkdirSync(path.join(dir, 'build-admin-dashboard'));
    fs.writeFileSync(path.join(dir, 'build-admin-dashboard', 'index.html'), '<p>v1</p>\n');
    fs.writeFileSync(path.join(dir, '.firebaserc'),
        JSON.stringify({ projects: { production: 'lamax-4fd82', staging: 'lamax-staging', other: 'someone-else' } }));
    g(dir, 'add', '-A');
    g(dir, 'commit', '-q', '-m', 'v1');
    g(dir, 'remote', 'add', 'origin', remote);
    if (push) g(dir, 'push', '-q', '-u', 'origin', 'main');
    if (tag)  g(dir, 'tag', tag);
    return dir;
}

(async () => {

console.log('\n── Provenance never claims more than it knows ──\n');

await t('a clean tree is stamped clean, with the exact commit', async () => {
    const dir = repo();
    const r = prov.readProvenance(dir);
    assert.strictEqual(r.provenance, 'clean');
    assert.strictEqual(r.commit, g(dir, 'rev-parse', 'HEAD'));
    assert.strictEqual(r.dirtyFingerprint, undefined);
});

await t('a modified tracked file makes the build DIRTY — the commit is only its base', async () => {
    const dir = repo();
    fs.writeFileSync(path.join(dir, 'app.js'), 'console.log("uncommitted");\n');
    const r = prov.readProvenance(dir);
    assert.strictEqual(r.provenance, 'dirty');
    assert.strictEqual(r.dirtyFiles, 1);
    assert.match(r.note, /Not reproducible from Git/);
});

await t('an untracked file also makes the build dirty', async () => {
    const dir = repo();
    fs.writeFileSync(path.join(dir, 'new-page.html'), '<p>new</p>\n');
    assert.strictEqual(prov.readProvenance(dir).provenance, 'dirty');
});

await t('outside a Git repository provenance is UNKNOWN and no commit is claimed', async () => {
    const dir = path.join(TMP, 'not-a-repo');
    fs.mkdirSync(dir);
    const r = prov.readProvenance(dir);
    assert.strictEqual(r.provenance, 'unknown');
    assert.strictEqual(r.commit, null);
});

await t('the dirty fingerprint is stable for one state and changes with the content', async () => {
    const dir = repo();
    fs.writeFileSync(path.join(dir, 'app.js'), 'console.log("a");\n');
    const a1 = prov.readProvenance(dir).dirtyFingerprint;
    const a2 = prov.readProvenance(dir).dirtyFingerprint;
    fs.writeFileSync(path.join(dir, 'app.js'), 'console.log("b");\n');
    const b  = prov.readProvenance(dir).dirtyFingerprint;
    assert.strictEqual(a1, a2);
    assert.notStrictEqual(a1, b);
});

await t('a large uncommitted state (diff > 1 MB) is still DIRTY with a fingerprint, never UNKNOWN', async () => {
    const dir = repo();
    // ~3 MB of incompressible text: well past Node's 1 MB execFileSync default.
    fs.writeFileSync(path.join(dir, 'app.js'), require('crypto').randomBytes(1_500_000).toString('hex') + '\n');
    const r = prov.readProvenance(dir);
    assert.strictEqual(r.provenance, 'dirty');
    assert.match(String(r.dirtyFingerprint), /^[0-9a-f]{16}$/);
});

console.log('\n── The public manifest leaks nothing ──\n');

await t('a manifest contains no file names, contents, env values or identities', async () => {
    const dir = repo();
    fs.writeFileSync(path.join(dir, '.env'), 'PAYSTACK_SECRET_KEY=sk_live_SHOULD_NEVER_APPEAR\n');
    fs.writeFileSync(path.join(dir, 'app.js'), 'const token = "SECRET_IN_SOURCE";\n');
    const out = path.join(dir, 'build-x');
    prov.stamp(out, 'customer-app', { cwd: dir });
    const text = fs.readFileSync(path.join(out, prov.MANIFEST), 'utf8');
    for (const banned of ['sk_live', 'SHOULD_NEVER_APPEAR', 'SECRET_IN_SOURCE', '.env', 'app.js',
                          'release-test@example.invalid', 'Release Test', os.userInfo().username]) {
        assert.ok(!text.includes(banned), `manifest leaked "${banned}"`);
    }
    const m = JSON.parse(text);
    assert.strictEqual(m.provenance, 'dirty');
    assert.strictEqual(m.app, 'customer-app');
});

console.log('\n── Staging cannot make a clean source look dirty ──\n');

await t('provenance read BEFORE staging stays clean even though staging rewrites tracked files', async () => {
    const dir = repo();
    const before = prov.readProvenance(dir);                     // what stage-hosting.cjs now does
    fs.writeFileSync(path.join(dir, 'build-admin-dashboard', 'index.html'), '<p>restaged</p>\n');
    const m = prov.stamp(path.join(dir, 'build-admin-dashboard'), 'admin-dashboard', { cwd: dir, record: before });
    assert.strictEqual(m.provenance, 'clean');
    // ...and reading AFTER would have been wrong, which is why the order matters.
    assert.strictEqual(prov.readProvenance(dir).provenance, 'dirty');
});

await t('stage-hosting.cjs reads provenance before it deletes or copies anything', async () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'stage-hosting.cjs'), 'utf8');
    const read = src.indexOf('readProvenance(root)');
    const wipe = src.indexOf('fs.rmSync(outDir');
    assert.ok(read > 0 && wipe > 0 && read < wipe, 'provenance must be read before the build dir is touched');
});

console.log('\n── The release gate ──\n');

await t('a clean, pushed, tagged release to a named known project passes', async () => {
    const dir = repo({ push: true, tag: 'release-2026-10-19.1' });
    const r = prov.check({ project: 'production', cwd: dir });
    assert.ok(r.ok, r.problems.join(' | '));
    assert.strictEqual(r.projectId, 'lamax-4fd82');
    assert.strictEqual(r.environment, 'production');
});

await t('staging resolves through .firebaserc too', async () => {
    const dir = repo({ push: true, tag: 'rc-1' });
    assert.strictEqual(prov.check({ project: 'staging', cwd: dir }).environment, 'staging');
});

await t('a dirty tree is refused', async () => {
    const dir = repo({ push: true, tag: 'rc-1' });
    fs.writeFileSync(path.join(dir, 'app.js'), 'changed\n');
    const r = prov.check({ project: 'production', cwd: dir });
    assert.ok(!r.ok);
    assert.ok(r.problems.some((p) => /uncommitted/.test(p)));
});

await t('an unpushed commit is refused', async () => {
    const dir = repo({ tag: 'rc-1' });
    const r = prov.check({ project: 'production', cwd: dir });
    assert.ok(!r.ok);
    assert.ok(r.problems.some((p) => /not on any remote/.test(p)));
});

await t('an untagged commit is refused', async () => {
    const dir = repo({ push: true });
    const r = prov.check({ project: 'production', cwd: dir });
    assert.ok(!r.ok);
    assert.ok(r.problems.some((p) => /no tag/.test(p)));
});

await t('no --project is refused — the active firebase project is never assumed', async () => {
    const dir = repo({ push: true, tag: 'rc-1' });
    const r = prov.check({ project: null, cwd: dir });
    assert.ok(!r.ok);
    assert.ok(r.problems.some((p) => /No target project/.test(p)));
});

await t('a project outside the allowlist is refused, even via an alias', async () => {
    const dir = repo({ push: true, tag: 'rc-1' });
    for (const p of ['other', 'someone-else', 'lamax-4fd82-typo']) {
        const r = prov.check({ project: p, cwd: dir });
        assert.ok(!r.ok, `${p} should be refused`);
        assert.ok(r.problems.some((x) => /Unknown project/.test(x)));
    }
});

await t('outside a repository the gate refuses', async () => {
    const dir = path.join(TMP, 'not-a-repo-2');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, '.firebaserc'), JSON.stringify({ projects: { production: 'lamax-4fd82' } }));
    const r = prov.check({ project: 'production', cwd: dir });
    assert.ok(!r.ok);
    assert.ok(r.problems.some((p) => /provenance cannot be established/.test(p)));
});

console.log('\n── Live status reports UNKNOWN unless a manifest proves otherwise ──\n');

const res = (status, type, body) => ({
    ok: status >= 200 && status < 300,
    headers: { get: (k) => (k.toLowerCase() === 'content-type' ? type : null) },
    json: async () => body,
});
const one = (impl) => prov.status({ sites: { customer: 'https://example.invalid' }, fetchImpl: impl });

await t('a 404 is UNKNOWN', async () => {
    const [r] = await one(async () => res(404, 'text/html', null));
    assert.strictEqual(r.provenance, 'UNKNOWN');
});

await t('an HTML fallback page served with 200 is UNKNOWN, not a manifest', async () => {
    const [r] = await one(async () => res(200, 'text/html; charset=utf-8', null));
    assert.strictEqual(r.provenance, 'UNKNOWN');
});

await t('an unreachable site is UNKNOWN', async () => {
    const [r] = await one(async () => { throw new Error('ENOTFOUND'); });
    assert.strictEqual(r.provenance, 'UNKNOWN');
});

await t('a dirty manifest is reported as DIRTY with its base commit', async () => {
    const [r] = await one(async () => res(200, 'application/json',
        { provenance: 'dirty', commit: 'a'.repeat(40), dirtyFingerprint: 'f00d' }));
    assert.strictEqual(r.provenance, 'DIRTY');
    assert.match(r.detail, /Uncommitted build/);
});

await t('a clean manifest is compared with the local HEAD', async () => {
    const head = 'b'.repeat(40);
    const rows = await prov.status({
        sites: { customer: 'https://example.invalid' }, localHead: head,
        fetchImpl: async () => res(200, 'application/json', { provenance: 'clean', commit: head, tags: ['rc-1'] }),
    });
    assert.strictEqual(rows[0].provenance, 'CLEAN');
    assert.strictEqual(rows[0].matchesLocalHead, true);
});

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\nrelease-provenance: ${passed} passed, ${failed} failed`);
if (failed) { for (const [name, e] of failures) console.log(`\n✗ ${name}\n${e.stack}`); process.exit(1); }
})();
