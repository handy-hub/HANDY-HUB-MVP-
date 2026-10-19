#!/usr/bin/env node
'use strict';

/**
 * scripts/release-provenance.cjs — say exactly what source a release came from.
 *
 * WHY
 * ───
 * Production has been deployed from whatever was on disk. The 2026-10-19
 * release forensics found the customer site, artisan site, admin dashboard and
 * Cloud Functions on different, mostly UNCOMMITTED states — 48 of 54 functions
 * run code that exists in no commit at all — and nothing anywhere recorded
 * which. This script makes provenance explicit, and refuses to guess.
 *
 * COMMANDS
 * ────────
 *   stamp <outDir> <app>
 *       Write <outDir>/release-manifest.json describing the source the build
 *       was staged from. Never blocks a deploy. A dirty or unreadable tree is
 *       stamped as such — a dirty build is never presented as a commit.
 *
 *   check --project <alias|id>
 *       Release gate. Exits non-zero unless the tree is clean, HEAD is pushed,
 *       HEAD is tagged, and the target project is named explicitly and known.
 *
 *   status
 *       Read release-manifest.json from each live hosting site (public GETs
 *       only) and report its provenance — UNKNOWN when there is none.
 *
 * PROVENANCE VALUES
 *   clean    — staged from a Git commit with no uncommitted or untracked
 *              changes. `commit` is the exact source.
 *   dirty    — staged from a working tree that differs from `commit`. The
 *              commit is only the BASE; `dirtyFingerprint` identifies the
 *              uncommitted state but cannot reproduce it.
 *   unknown  — Git could not be read. Nothing is claimed.
 *
 * A manifest never contains file contents, environment values, secrets,
 * user names or email addresses — only revision identifiers, counts and a
 * one-way fingerprint. It is served publicly.
 */

const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

const MANIFEST = 'release-manifest.json';
const SCHEMA   = 1;

// Projects a release may target. Aliases resolve through .firebaserc.
const KNOWN_PROJECTS = {
    'lamax-4fd82':   'production',
    'lamax-staging': 'staging',
};

// Live hosting sites, keyed by firebase.json hosting target.
const LIVE_SITES = {
    customer: 'https://lamax-4fd82.web.app',
    artisan:  'https://lamax-artisan.web.app',
    admin:    'https://lamax-admin.web.app',
};

// The dirty-state fingerprint hashes `git diff --binary`, which for a large
// uncommitted state (binary assets, logs) easily exceeds Node's 1 MB default
// and would otherwise throw — degrading an honest 'dirty' into 'unknown'.
const GIT_MAX_BUFFER = 512 * 1024 * 1024;

function git(cwd, args) {
    return execFileSync('git', args, {
        cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: GIT_MAX_BUFFER,
    }).trim();
}

/**
 * Describe the source tree at `cwd`. Pure apart from reading Git.
 * @returns {object} provenance record (no secrets, no contents)
 */
function readProvenance(cwd) {
    let commit;
    try {
        commit = git(cwd, ['rev-parse', 'HEAD']);
    } catch {
        return { provenance: 'unknown', reason: 'Git metadata unavailable', commit: null };
    }

    let status;
    try {
        status = git(cwd, ['status', '--porcelain=v1', '--untracked-files=all']);
    } catch (err) {
        return { provenance: 'unknown', reason: `git status failed: ${err.code || err.message}`, commit };
    }
    const changed = status ? status.split('\n').filter(Boolean) : [];

    let branch = null, upstream = null, unpushed = null, tags = [];
    try { branch = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']); } catch { /* detached or none */ }
    try {
        upstream = git(cwd, ['rev-parse', '--abbrev-ref', '@{u}']);
        unpushed = Number(git(cwd, ['rev-list', '--count', '@{u}..HEAD']));
    } catch { /* no upstream configured */ }
    try { tags = git(cwd, ['tag', '--points-at', 'HEAD']).split('\n').filter(Boolean); } catch { /* none */ }
    let onRemote = false;
    try { onRemote = git(cwd, ['branch', '-r', '--contains', 'HEAD']).length > 0; } catch { /* none */ }

    const record = {
        provenance: changed.length ? 'dirty' : 'clean',
        commit,
        branch,
        tags,
        pushed: onRemote,
        upstream,
        unpushedCommits: unpushed,
    };

    if (changed.length) {
        // A one-way fingerprint of the uncommitted state: the diff against
        // HEAD plus the list of untracked paths. Two builds from the same dirty
        // tree get the same fingerprint; nothing about the content can be
        // recovered from it. File names are deliberately not published.
        record.dirtyFiles = changed.length;
        try {
            const h = crypto.createHash('sha256');
            h.update(git(cwd, ['diff', 'HEAD', '--binary']));
            h.update('\0untracked\0');
            h.update(git(cwd, ['ls-files', '--others', '--exclude-standard']));
            record.dirtyFingerprint = h.digest('hex').slice(0, 16);
        } catch (err) {
            // Still dirty — only the fingerprint is unavailable. Never upgrade
            // to 'clean' and never downgrade to 'unknown' for this.
            record.dirtyFingerprint = null;
            record.fingerprintError = String(err.code || err.message).slice(0, 80);
        }
        record.note = 'Built from uncommitted changes on top of `commit`. Not reproducible from Git.';
    }
    return record;
}

/**
 * Write the manifest. Pass `record` when the caller read provenance BEFORE
 * changing anything: build-admin-dashboard/ is tracked in Git, so staging
 * itself rewrites tracked files, and reading afterwards would stamp a clean
 * source as dirty.
 */
function stamp(outDir, app, { cwd = process.cwd(), now = new Date(), record = null } = {}) {
    if (!outDir || !app) throw new Error('usage: stamp <outDir> <app>');
    const manifest = {
        schema:   SCHEMA,
        app,
        stagedAt: now.toISOString(),
        ...(record || readProvenance(cwd)),
    };
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, MANIFEST), JSON.stringify(manifest, null, 2) + '\n');
    return manifest;
}

/** Resolve an alias or id through .firebaserc. Returns null when not given. */
function resolveProject(arg, cwd) {
    if (!arg) return null;
    try {
        const rc = JSON.parse(fs.readFileSync(path.join(cwd, '.firebaserc'), 'utf8'));
        if (rc.projects && rc.projects[arg]) return rc.projects[arg];
    } catch { /* no .firebaserc */ }
    return arg;
}

/** The release gate. Returns { ok, problems, record, projectId }. */
function check({ project, cwd = process.cwd() } = {}) {
    const problems = [];
    const record = readProvenance(cwd);

    if (record.provenance === 'unknown') problems.push('Git metadata is unavailable — provenance cannot be established.');
    if (record.provenance === 'dirty') {
        problems.push(`Working tree has ${record.dirtyFiles} uncommitted/untracked change(s). Release from a clean checkout of a tag.`);
    }
    if (record.provenance !== 'unknown') {
        if (!record.pushed) problems.push('HEAD is not on any remote branch. Push it, so the release source exists outside this machine.');
        if (!record.tags || !record.tags.length) problems.push('HEAD has no tag. Tag the release candidate (e.g. release-YYYY-MM-DD.N) before deploying.');
    }

    const projectId = resolveProject(project, cwd);
    if (!projectId) {
        problems.push('No target project. Pass --project explicitly; the active `firebase use` project is never assumed.');
    } else if (!KNOWN_PROJECTS[projectId]) {
        problems.push(`Unknown project "${projectId}". Known: ${Object.keys(KNOWN_PROJECTS).join(', ')}.`);
    }
    return { ok: problems.length === 0, problems, record, projectId, environment: KNOWN_PROJECTS[projectId] || null };
}

/** Fetch each live manifest. Public GETs only; nothing is written. */
async function status({ sites = LIVE_SITES, fetchImpl = globalThis.fetch, localHead = null } = {}) {
    const rows = [];
    for (const [target, base] of Object.entries(sites)) {
        let row = { target, site: base, provenance: 'UNKNOWN', detail: '' };
        try {
            const res = await fetchImpl(`${base}/${MANIFEST}`, { headers: { 'Cache-Control': 'no-cache' } });
            const type = (res.headers && res.headers.get && res.headers.get('content-type')) || '';
            if (!res.ok || !/json/i.test(type)) {
                row.detail = 'No release manifest — deployed before provenance stamping, or by an unstamped path.';
            } else {
                const m = await res.json();
                row = {
                    target, site: base,
                    provenance: String(m.provenance || 'unknown').toUpperCase(),
                    commit: m.commit ? m.commit.slice(0, 12) : null,
                    tags: m.tags || [],
                    stagedAt: m.stagedAt || null,
                    detail: m.provenance === 'dirty'
                        ? `Uncommitted build on top of ${String(m.commit).slice(0, 12)} (fingerprint ${m.dirtyFingerprint}).`
                        : m.provenance === 'clean' ? 'Built from a clean commit.' : (m.reason || ''),
                };
                if (localHead && m.commit && m.provenance === 'clean') {
                    row.matchesLocalHead = m.commit === localHead;
                }
            }
        } catch (err) {
            row.detail = `Could not reach site: ${err.message}`;
        }
        rows.push(row);
    }
    return rows;
}

// ── CLI ───────────────────────────────────────────────────────────────────────
async function main(argv) {
    const [cmd, ...rest] = argv;
    if (cmd === 'stamp') {
        const m = stamp(rest[0], rest[1]);
        const label = m.provenance === 'clean'
            ? `clean @ ${m.commit.slice(0, 12)}`
            : m.provenance === 'dirty'
                ? `DIRTY (${m.dirtyFiles} change(s) on ${m.commit.slice(0, 12)}) — not a reproducible release`
                : 'UNKNOWN provenance';
        console.log(`[release-provenance] ${rest[1]}: ${label}`);
        return 0;
    }
    if (cmd === 'check') {
        const i = rest.indexOf('--project');
        const r = check({ project: i >= 0 ? rest[i + 1] : null });
        if (r.ok) {
            console.log(`[release-check] OK — ${r.record.commit.slice(0, 12)} (${r.record.tags.join(', ')}) → ${r.projectId} (${r.environment})`);
            return 0;
        }
        console.error('[release-check] REFUSED:');
        for (const p of r.problems) console.error(`  • ${p}`);
        return 1;
    }
    if (cmd === 'status') {
        let head = null;
        try { head = git(process.cwd(), ['rev-parse', 'HEAD']); } catch { /* none */ }
        const rows = await status({ localHead: head });
        for (const r of rows) {
            const extra = r.commit ? ` ${r.commit}${r.tags && r.tags.length ? ` [${r.tags.join(', ')}]` : ''}` : '';
            const match = r.matchesLocalHead === undefined ? '' : r.matchesLocalHead ? ' (= local HEAD)' : ' (≠ local HEAD)';
            console.log(`${r.target.padEnd(9)} ${r.provenance.padEnd(8)}${extra}${match}  ${r.detail}`);
        }
        console.log('\nCloud Functions and rules are not covered here — see docs/RELEASE.md (verification).');
        return 0;
    }
    console.error('usage: release-provenance.cjs stamp <outDir> <app> | check --project <alias> | status');
    return 2;
}

if (require.main === module) {
    main(process.argv.slice(2)).then((code) => process.exit(code), (err) => {
        console.error(`[release-provenance] ${err.message}`);
        process.exit(2);
    });
}

module.exports = { readProvenance, stamp, check, status, resolveProject, KNOWN_PROJECTS, LIVE_SITES, MANIFEST };
