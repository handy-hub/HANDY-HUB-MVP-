/**
 * import-paths.test.cjs — scripts/check-imports.cjs catches an import that
 * cannot load on the deployed site, and stays quiet when every import can.
 *
 * Why it exists: release-2026-11-01.1 shipped
 *   shared/js/services/notificationRepository.js
 *     import … from "../vendor/firebase/firebase-firestore.js"
 * which names shared/js/vendor — a folder that does not exist. Hosting served
 * an HTML page in its place, the browser refused it as a module, and the
 * artisan dashboard never started. Fixed in release-2026-11-02.2.
 *
 * Each case builds a small throwaway site tree in the OS temp dir (one artisan
 * app, one customer app, shared/) and scans it.
 */

require('./support/no-production.cjs');   // must stay the first statement (npm run lint:tests)
const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const ROOT = path.join(__dirname, '..');
const { scan } = require(path.join(ROOT, 'scripts', 'check-imports.cjs'));

let passed = 0, failed = 0;
const failures = [];
async function t(name, fn) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { failed++; failures.push([name, e]); console.log(`  ✗ ${name}`); }
}

const tmpRoots = [];
/** Build a tree from { 'path/file.js': 'contents' } and return its root. */
function tree(files) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-imports-'));
    tmpRoots.push(root);
    for (const [rel, body] of Object.entries(files)) {
        const p = path.join(root, rel);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, body);
    }
    return root;
}
const APPS = ['artisan-app', 'customer-app'];
const run  = (files) => scan({ root: tree(files), apps: APPS });

// A valid site: every specifier form the scanner reads, all resolving.
const VALID = {
    'shared/vendor/firebase/firebase-firestore.js': 'export const doc = 1;',
    'shared/js/services/notificationRepository.js':
        'import { doc } from "../../vendor/firebase/firebase-firestore.js";\nexport const n = doc;',
    'shared/js/services/multi.js':
        'import {\n  a,\n  b,\n} from \'./notificationRepository.js\';\nexport * from "./notificationRepository.js";',
    'artisan-app/js/page.js':
        "import '../../shared/js/services/multi.js';\n" +
        "const m = await import('../../shared/js/services/notificationRepository.js?v=3');\n" +
        "const computed = await import(base + '/js/anything.js');   // not checkable: skipped",
    'artisan-app/dashboard.html':
        '<script type="module" src="js/page.js"></script>\n' +
        '<script type="module">\n  import { n } from "../shared/js/services/notificationRepository.js";\n</script>\n' +
        '<script src="https://cdnjs.cloudflare.com/ajax/libs/x/1.0.0/x.min.js"></script>\n' +
        '<script type="module">import { s } from "/shared/js/services/multi.js";</script>',
    'customer-app/js/home.js': 'import { n } from "../../shared/js/services/notificationRepository.js";',
};

(async () => {
console.log('\n── A site whose imports all resolve passes ──\n');

await t('valid tree (static, multi-line, side-effect, re-export, dynamic, query string, HTML module + src, site-absolute) → no problems', () => {
    assert.deepStrictEqual(run(VALID), []);
});

await t('the real repository has no broken import', () => {
    const problems = scan({ root: ROOT });
    assert.deepStrictEqual(problems, [], problems.map((p) => `${p.file}:${p.line} ${p.spec} — ${p.problem}`).join('\n'));
});

console.log('\n── A broken import is caught ──\n');

await t('the production bug: shared/js/services importing ../vendor (one level too shallow)', () => {
    const problems = run({ ...VALID,
        'shared/js/services/notificationRepository.js':
            'import { doc } from "../vendor/firebase/firebase-firestore.js";\nexport const n = doc;' });
    assert.strictEqual(problems.length, 1);
    assert.strictEqual(problems[0].file, 'shared/js/services/notificationRepository.js');
    assert.strictEqual(problems[0].line, 1);
    assert.match(problems[0].problem, /shared\/js\/vendor\/firebase\/firebase-firestore\.js, which does not exist/);
});

await t('a missing file', () => {
    const problems = run({ ...VALID, 'customer-app/js/home.js': 'import { x } from "./gone.js";' });
    assert.strictEqual(problems.length, 1);
    assert.match(problems[0].problem, /customer-app\/js\/gone\.js, which does not exist/);
});

await t('a path too deep (escapes above the site root)', () => {
    const problems = run({ ...VALID, 'customer-app/js/home.js': 'import { n } from "../../../shared/js/services/notificationRepository.js";' });
    assert.strictEqual(problems.length, 1);
    assert.match(problems[0].problem, /outside what this site serves/);
});

await t('wrong letter case (passes on Windows, 404s on Firebase Hosting)', () => {
    const problems = run({ ...VALID, 'customer-app/js/home.js': 'import { n } from "../../shared/js/services/NotificationRepository.js";' });
    assert.strictEqual(problems.length, 1);
    // On a case-sensitive file system the file simply does not exist; either way it is caught.
    assert.match(problems[0].problem, /case-insensitively|does not exist/);
});

await t("one app reaching into another app's folder (that site does not serve it)", () => {
    const problems = run({ ...VALID,
        'customer-app/settings-terms.html': '<p>terms</p>',
        'artisan-app/js/page.js': "import '../../customer-app/js/home.js';" });
    assert.strictEqual(problems.length, 1);
    assert.match(problems[0].problem, /outside what this site serves \(artisan-app\/ \+ shared\/\)/);
});

await t('shared code reaching into an app (shared/ is served on every site, that app is not)', () => {
    const problems = run({ ...VALID, 'shared/js/services/multi.js': 'import { p } from "../../../artisan-app/js/page.js";' });
    assert.strictEqual(problems.length, 1);
    assert.match(problems[0].problem, /outside what this site serves \(shared\/\)/);
});

await t('a broken dynamic import(), a broken <script src> and a broken inline module are each caught', () => {
    const problems = run({ ...VALID,
        'artisan-app/js/page.js': "const m = await import('./missing-dynamic.js');",
        'artisan-app/dashboard.html':
            '<script src="js/missing-classic.js"></script>\n<script type="module">\n  import { z } from "../shared/missing-inline.js";\n</script>' });
    const specs = problems.map((p) => p.spec).sort();
    assert.deepStrictEqual(specs, ['../shared/missing-inline.js', './missing-dynamic.js', 'js/missing-classic.js'].sort());
});

console.log('\n── Comments are not imports ──\n');

await t('usage examples in doc comments, // lines and HTML comments are ignored', () => {
    const problems = run({ ...VALID,
        'shared/js/services/multi.js':
            '/**\n * Usage:\n *   import { x } from "../shared/js/does-not-exist.js";\n */\n' +
            '// import { y } from "./also-missing.js";\nexport const ok = 1;',
        'artisan-app/dashboard.html': '<!-- <script src="js/old-missing.js"></script> -->\n<script type="module" src="js/page.js"></script>' });
    assert.deepStrictEqual(problems, []);
});

console.log('\n── Wired in where it stops a deploy ──\n');

await t('npm run lint runs the check, and every hosting predeploy (stage-hosting.cjs) refuses to stage on a broken import', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    assert.strictEqual(pkg.scripts['lint:imports'], 'node scripts/check-imports.cjs');
    assert.match(pkg.scripts.lint, /npm run lint:imports/);
    const stage = fs.readFileSync(path.join(ROOT, 'scripts', 'stage-hosting.cjs'), 'utf8');
    assert.match(stage, /require\('\.\/check-imports\.cjs'\)/);
    assert.match(stage, /process\.exit\(1\)/);
    const fb = JSON.parse(fs.readFileSync(path.join(ROOT, 'firebase.json'), 'utf8'));
    for (const h of fb.hosting) assert.match(h.predeploy, /stage-hosting\.cjs/, `hosting target ${h.target} predeploy`);
});

for (const r of tmpRoots) fs.rmSync(r, { recursive: true, force: true });
console.log(`\nimport-paths: ${passed} passed, ${failed} failed`);
if (failed) { for (const [nm, e] of failures) console.error(`\n✗ ${nm}\n${e.stack}`); process.exit(1); }
process.exit(0);
})();
