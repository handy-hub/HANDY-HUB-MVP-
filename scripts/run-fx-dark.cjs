#!/usr/bin/env node
/**
 * scripts/run-fx-dark.cjs — the artisan browser suites again, in the dark theme.
 *
 *   npm run test:dark-browser
 *
 * Each suite below already runs in `npm test` in the light theme. With
 * FX_THEME=dark, tests/e2e/fx_theme_hook.py starts every browser context on a
 * device whose saved appearance is Dark, so the SAME functional checks run on
 * the dark screens, and the hook measures the contrast of everything a suite
 * draws (text, placeholders, input boundaries, icons) against WCAG AA.
 *
 * No server, emulator or network: the suites serve the repository's files to
 * the browser themselves. One suite failing does not stop the others; the exit
 * code is non-zero if any failed.
 */
'use strict';
const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SUITES = [
    'fx_design_system.py', 'artisan_today.py', 'offer_refusal.py', 'artisan_job.py', 'artisan_jobs.py',
    'artisan_earnings.py', 'artisan_reputation.py', 'artisan_entry.py', 'artisan_onboarding.py',
    'artisan_account.py', 'artisan_messages.py', 'artisan_cache_first.py',
];

const failed = [];
for (const suite of SUITES) {
    const r = spawnSync('python', ['-I', path.join('tests', 'e2e', suite)], {
        cwd: ROOT, encoding: 'utf8', env: { ...process.env, FX_THEME: 'dark', PYTHONIOENCODING: 'utf-8' },
    });
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    const lines = out.split(/\r?\n/).filter(Boolean);
    const summary = lines.filter((l) => /\d+ passed, \d+ failed/.test(l)).pop() || '(no summary line)';
    const audit = lines.find((l) => /PASS\s+contrast, dark theme/.test(l));
    const ok = r.status === 0 && /, 0 failed/.test(summary) && !!audit;
    console.log(`${ok ? '✓' : '✗'} dark · ${summary.trim()}`);
    if (audit) console.log(`    ${audit.trim().replace(/^PASS\s+/, '')}`);
    if (!ok) {
        failed.push(suite);
        for (const l of lines.filter((x) => /FAIL|contrast: |Error|Traceback/.test(x)).slice(0, 40)) console.log(`    ${l.trim()}`);
        if (!audit) console.log('    the dark contrast audit did not report (the suite must load tests/e2e/fx_theme_hook.py)');
    }
}
console.log(`\ndark browser suites: ${SUITES.length - failed.length} passed, ${failed.length} failed${failed.length ? ` (${failed.join(', ')})` : ''}`);
process.exit(failed.length ? 1 : 0);
