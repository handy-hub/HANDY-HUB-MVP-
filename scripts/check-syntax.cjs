#!/usr/bin/env node
'use strict';

/**
 * check-syntax.cjs — zero-dependency parse gate (CX-7).
 *
 * WHY THIS EXISTS
 * ───────────────
 * Three separate external audits reported a fatal "SyntaxError: Illegal return
 * statement" in an entry point. It turned out to be a false positive (top-level
 * `return` IS legal inside <script type="module">, and their harness parsed the
 * module as a classic script). But the reason nobody could refute it instantly is
 * that NOTHING in this repo mechanically proves the code parses. A real parse
 * error in an inline <script> would ship silently — the browser just stops.
 *
 * This gate closes that hole with no new dependencies (no npm install, no ESLint):
 *   • every .js file is parsed with `node --check`, using the right goal
 *     (CommonJS for functions/ and *.cjs, ES module for everything else)
 *   • every inline <script> in every .html is EXTRACTED and parsed with the goal
 *     implied by its type attribute — `type="module"` → module, otherwise script
 *
 * That second half is the important one: it is exactly where the class of bug the
 * audits kept alleging would actually live, and it is the part no standard linter
 * checks by default.
 *
 * Usage:  npm run lint:syntax
 */

const fs   = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

// Directories that are build output, vendored, or otherwise not source.
const SKIP_DIR = /(^|[\\/])(node_modules|\.git|build-customer-app|build-artisan-app|web-app|coverage)([\\/]|$)/;

const SOURCE_DIRS = [
    'functions', 'shared', 'customer-app', 'artisan-app', 'admin-dashboard', 'scripts',
];

function walk(dir, out = []) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
    for (const e of entries) {
        const p = path.join(dir, e.name);
        if (SKIP_DIR.test(p)) continue;
        if (e.isDirectory()) walk(p, out);
        else out.push(p);
    }
    return out;
}

/** Parse `code` with node's checker. goal: 'module' | 'commonjs'. */
function parses(code, goal) {
    try {
        execFileSync(process.execPath, ['--input-type=' + goal, '--check'], {
            input: code,
            stdio: ['pipe', 'ignore', 'pipe'],
        });
        return null;
    } catch (err) {
        const msg = (err.stderr || Buffer.from('')).toString().trim().split('\n');
        // Surface the first meaningful line (the SyntaxError itself).
        const line = msg.find(l => /Error/.test(l)) || msg[0] || 'parse failed';
        return line.trim();
    }
}

/** Cloud Functions are CommonJS; .cjs is CommonJS; everything else is an ES module. */
function goalForJsFile(rel) {
    if (rel.endsWith('.cjs')) return 'commonjs';
    if (rel.split(path.sep)[0] === 'functions') return 'commonjs';
    return 'module';
}

/**
 * Pull every <script> out of an HTML file, preserving whether it is a module.
 * Skips scripts with a `src` (nothing inline to parse) and non-JS types
 * (importmap, application/json, text/template …).
 */
function inlineScripts(html) {
    const out = [];

    // Blank out HTML comments FIRST, preserving newlines so reported line numbers
    // stay accurate. Without this, a comment that merely *mentions* `<script
    // type="module">` in its prose (profile.html does exactly that) gets matched
    // as a real script and its English text is "parsed" as JavaScript — producing
    // a bogus SyntaxError. That is the same false-positive class the external
    // audits hit; a parse gate that repeats it is worse than none.
    const scrubbed = html.replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, ' '));

    const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
    let m;
    while ((m = re.exec(scrubbed)) !== null) {
        const attrs = m[1] || '';
        const body  = m[2] || '';
        if (/\bsrc\s*=/i.test(attrs)) continue;          // external
        if (!body.trim()) continue;                       // empty
        const typeMatch = attrs.match(/\btype\s*=\s*["']([^"']+)["']/i);
        const type = typeMatch ? typeMatch[1].toLowerCase() : '';
        if (type && !/^(module|text\/javascript|application\/javascript)$/.test(type)) continue;
        const isModule = type === 'module';
        // Line number of the opening tag, for a useful error location. Offsets are
        // valid against `scrubbed` because comment-blanking preserved every newline.
        const line = scrubbed.slice(0, m.index).split('\n').length;
        out.push({ code: body, goal: isModule ? 'module' : 'commonjs', line, isModule });
    }
    return out;
}

// ── Run ──────────────────────────────────────────────────────────────────────
const files = SOURCE_DIRS.flatMap(d => walk(path.join(ROOT, d)));

let jsChecked = 0, htmlChecked = 0, inlineChecked = 0;
const failures = [];

for (const abs of files) {
    const rel = path.relative(ROOT, abs);

    if (abs.endsWith('.js') || abs.endsWith('.cjs') || abs.endsWith('.mjs')) {
        const goal = abs.endsWith('.mjs') ? 'module' : goalForJsFile(rel);
        const code = fs.readFileSync(abs, 'utf8');
        const err  = parses(code, goal);
        jsChecked++;
        if (err) failures.push(`${rel}  [${goal}]  ${err}`);

    } else if (abs.endsWith('.html')) {
        const html = fs.readFileSync(abs, 'utf8');
        htmlChecked++;
        for (const s of inlineScripts(html)) {
            inlineChecked++;
            const err = parses(s.code, s.goal);
            if (err) {
                failures.push(
                    `${rel}:${s.line}  [inline ${s.isModule ? 'module' : 'classic script'}]  ${err}`
                );
            }
        }
    }
}

console.log(
    `Syntax gate: ${jsChecked} JS file(s), ${inlineChecked} inline script(s) across ${htmlChecked} HTML file(s).`
);

if (failures.length) {
    console.error(`\n✗ ${failures.length} file(s) failed to parse:\n`);
    for (const f of failures) console.error('  ' + f);
    console.error(
        '\nA parse error in an inline <script> ships silently — the browser stops executing.\n' +
        'Note: top-level `return` is LEGAL in <script type="module"> and ILLEGAL in a classic\n' +
        '<script>. If you see that error, check the type attribute before "fixing" the code.\n'
    );
    process.exit(1);
}

console.log('✓ Everything parses.');
