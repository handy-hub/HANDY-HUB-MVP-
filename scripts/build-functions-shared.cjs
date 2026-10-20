#!/usr/bin/env node
'use strict';

/**
 * build-functions-shared.cjs — generate the Cloud Functions copy of a shared
 * domain module, and fail CI when the checked-in copy has drifted.
 *
 * WHY THIS EXISTS
 * ───────────────
 * firebase.json sets `functions.source: "functions"`, so ONLY that directory is
 * uploaded. A Cloud Function cannot reach `shared/js/domain/*` at runtime, and
 * the modules there are ES modules besides. The repo's existing answer to this
 * is a hand-maintained mirror (functions/shared/searchKeywords.js) kept in step
 * by a comment and a CI check.
 *
 * A hand-maintained mirror is exactly the wrong shape for booking schedule
 * rules, because the numbers in it are load-bearing in three places at once:
 * the browser tells the customer which slots are bookable, the Cloud Function
 * decides whether to accept one, and firestore.rules decides whether work may
 * begin. If those three ever disagree, the failure is silent and lands on a
 * real appointment — the customer is offered a slot the server refuses, or an
 * artisan is blocked from a job they can legitimately start.
 *
 * So the mirror is GENERATED, never edited. The ES module is the one source;
 * this script transliterates it to CommonJS. `--check` proves the checked-in
 * copy still matches, and is wired into `npm run lint`.
 *
 * Usage:
 *   node scripts/build-functions-shared.cjs           # write the mirror
 *   node scripts/build-functions-shared.cjs --check   # fail if stale
 */

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/** Modules mirrored into the Functions bundle. source → generated. */
const MIRRORS = [
    {
        source: 'shared/js/domain/bookingSchedule.js',
        target: 'functions/shared/bookingSchedule.js',
    },
    {
        source: 'shared/js/domain/quoteMoney.js',
        target: 'functions/shared/quoteMoney.js',
    },
    {
        source: 'shared/js/domain/performanceMetrics.js',
        target: 'functions/shared/performanceMetrics.js',
    },
];

const BANNER = [
    '/**',
    ' * GENERATED FILE — DO NOT EDIT.',
    ' *',
    ' * CommonJS mirror of %SOURCE%, produced by',
    ' * scripts/build-functions-shared.cjs so the Cloud Functions runtime (which',
    ' * only receives the functions/ directory, and cannot import an ES module)',
    ' * decides with exactly the same rules and the same numbers as the browser',
    ' * (and, for appointments, firestore.rules).',
    ' *',
    ' * Edit the source module and re-run:  node scripts/build-functions-shared.cjs',
    ' * `npm run lint` fails if this file has drifted from its source.',
    ' */',
    '',
    "'use strict';",
    '',
].join('\n');

/**
 * Transliterate ESM → CJS.
 *
 * Deliberately narrow: it handles exactly the export forms the mirrored modules
 * use and REFUSES anything else, rather than silently emitting a file that is
 * subtly not the module it claims to mirror. A module that needs a form this
 * does not cover should either avoid it or extend this function explicitly.
 */
function transpile(src, sourceRel) {
    if (/^\s*import\s/m.test(src)) {
        throw new Error(`${sourceRel} has an import — mirrored modules must be dependency-free.`);
    }
    if (/export\s+default/.test(src)) {
        throw new Error(`${sourceRel} has a default export — not supported by the mirror.`);
    }

    const names = [];
    const body = src
        .replace(/^\s*export\s+(async\s+)?function\s+([A-Za-z0-9_$]+)/gm, (_m, asyncKw, name) => {
            names.push(name);
            return `${asyncKw || ''}function ${name}`;
        })
        .replace(/^\s*export\s+(const|let|var)\s+([A-Za-z0-9_$]+)/gm, (_m, kw, name) => {
            names.push(name);
            return `${kw} ${name}`;
        });

    if (/^\s*export\s/m.test(body)) {
        throw new Error(`${sourceRel} has an export form the mirror does not understand.`);
    }
    if (!names.length) {
        throw new Error(`${sourceRel} exports nothing.`);
    }

    const exportsBlock = [
        '',
        '// ── CommonJS surface ─────────────────────────────────────────────────────────',
        'module.exports = {',
        ...names.map(n => `    ${n},`),
        '};',
        '',
    ].join('\n');

    return BANNER.replace('%SOURCE%', sourceRel) + body.trimEnd() + '\n' + exportsBlock;
}

const check = process.argv.includes('--check');
let stale = 0;

for (const { source, target } of MIRRORS) {
    const srcPath = path.join(ROOT, source);
    const dstPath = path.join(ROOT, target);

    let generated;
    try {
        generated = transpile(fs.readFileSync(srcPath, 'utf8'), source);
    } catch (err) {
        console.error(`✗ ${source}: ${err.message}`);
        process.exit(2);
    }

    const existing = fs.existsSync(dstPath) ? fs.readFileSync(dstPath, 'utf8') : null;

    if (existing === generated) {
        if (!check) console.log(`  = ${target} (up to date)`);
        continue;
    }

    if (check) {
        stale++;
        console.error(`✗ ${target} is stale — regenerate with: node scripts/build-functions-shared.cjs`);
        continue;
    }

    fs.mkdirSync(path.dirname(dstPath), { recursive: true });
    fs.writeFileSync(dstPath, generated, 'utf8');
    console.log(`  ✓ ${target} written from ${source}`);
}

// ── Third leg of the pin: firestore.rules ────────────────────────────────────
//
// Rules cannot import or require anything, so scheduleWindowOpen() hardcodes
// EARLY_START_GRACE_MS as a literal. That literal is the server's final word on
// whether an artisan may set out — if it drifts from the module the browser and
// the Cloud Function use, the client offers an action the server rejects (or,
// worse, the server permits one the product says it should not). Pin it here,
// where the other two legs are already being compared.
{
    const scheduleSrc = fs.readFileSync(
        path.join(ROOT, 'shared/js/domain/bookingSchedule.js'), 'utf8');
    const m = /export const EARLY_START_GRACE_MS\s*=\s*([^;]+);/.exec(scheduleSrc);
    if (!m) {
        console.error('✗ EARLY_START_GRACE_MS not found in bookingSchedule.js');
        process.exit(2);
    }
    // eslint-disable-next-line no-eval
    const graceMs = eval(m[1]);
    const rulesSrc = fs.readFileSync(path.join(ROOT, 'firestore.rules'), 'utf8');
    const ruleFn = /function scheduleWindowOpen\(\)\s*\{([\s\S]*?)\n    \}/.exec(rulesSrc);

    if (!ruleFn) {
        console.error('✗ scheduleWindowOpen() not found in firestore.rules — the appointment gate is missing.');
        process.exit(1);
    }
    if (!ruleFn[1].includes(String(graceMs))) {
        console.error(
            `✗ firestore.rules scheduleWindowOpen() does not use ${graceMs} ` +
            `(EARLY_START_GRACE_MS). The client and the server disagree about ` +
            `when work may begin.`);
        process.exit(1);
    }
    if (!check) console.log(`  = firestore.rules grace literal pinned at ${graceMs} ms`);
}

if (check && stale) {
    console.error(`\n${stale} generated mirror(s) out of date.`);
    process.exit(1);
}
if (check) console.log('✓ Cloud Functions shared mirrors and the rules grace literal are in sync.');
