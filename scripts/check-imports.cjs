#!/usr/bin/env node
/**
 * check-imports.cjs — every relative import must resolve on the deployed site.
 *
 * release-2026-11-01.1 shipped `shared/js/services/notificationRepository.js`
 * importing "../vendor/firebase/firebase-firestore.js" — one level too shallow,
 * so it named shared/js/vendor, which does not exist. Hosting answers a missing
 * file with an HTML page, the browser refuses it as a module, and every page
 * that imported the repository never started (the artisan dashboard among
 * them). Lint, 800+ Node tests and the deploy all passed, because nothing
 * loads the module graph. This does, statically.
 *
 * For every .js/.mjs/.html file under artisan-app/, customer-app/,
 * admin-dashboard/ and shared/, each import specifier that is relative
 * ('./', '../') or site-absolute ('/shared/…') must:
 *
 *   1. resolve to a file that exists;
 *   2. match it with EXACT case — Windows ignores case, Firebase Hosting does
 *      not, so a wrong-case import works locally and 404s in production;
 *   3. stay inside what that file's site serves. stage-hosting.cjs builds each
 *      site from its own app dir plus shared/, so app code may reach its app
 *      and shared/, and shared/ (served on every site) may reach only shared/.
 *
 * Covered: static `import … from`, side-effect `import '…'`, `export … from`,
 * dynamic `import('…')` with a literal, and HTML <script src> (page-relative,
 * so "js/page.js" counts too; https:, data: and // URLs do not). Computed
 * specifiers (`import(root + '/x.js')`) cannot be checked statically and are
 * skipped. Lines that are comments (`*`, `//`, `/*`) are ignored, so usage
 * examples in doc blocks do not count.
 *
 * Run:   node scripts/check-imports.cjs            (all four apps; `npm run lint`)
 * API:   scan({ root, apps }) → problems[]        (stage-hosting.cjs, tests)
 */
'use strict';
const fs   = require('fs');
const path = require('path');

const APPS    = ['artisan-app', 'customer-app', 'admin-dashboard'];
const SHARED  = 'shared';
const SKIP    = new Set(['node_modules', '.git']);

const JS_SPEC = [
    /\bfrom\s*(['"])([^'"\n]+)\1/g,             // import … from '…' · export … from '…'
    /\bimport\s*(['"])([^'"\n]+)\1/g,           // import '…'
    /\bimport\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g, // import('…')
];
const HTML_SRC = /<script\b[^>]*?\bsrc\s*=\s*(['"])([^'"]+)\1/gi;

const isChecked = (spec) => /^\.{1,2}\//.test(spec) || (spec.startsWith('/') && !spec.startsWith('//'));

function lineAt(text, index) {
    const start = text.lastIndexOf('\n', index - 1) + 1;
    const end = text.indexOf('\n', index);
    return { no: text.slice(0, index).split('\n').length, text: text.slice(start, end < 0 ? undefined : end) };
}
const isCommentLine = (line) => /^\s*(\*|\/\/|\/\*)/.test(line);

// Blank HTML comments, keeping newlines so line numbers stay true.
const blankHtmlComments = (s) => s.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));

function specifiers(file, text) {
    const out = [];
    const isHtml = file.endsWith('.html');
    const src = isHtml ? blankHtmlComments(text) : text;
    for (const re of JS_SPEC) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(src))) {
            const line = lineAt(src, m.index);
            if (!isCommentLine(line.text)) out.push({ spec: m[2], line: line.no });
        }
    }
    if (isHtml) {
        // A src attribute is a URL, so "js/page.js" is page-relative too; only
        // a scheme (https:, data:) or protocol-relative // URL is external.
        HTML_SRC.lastIndex = 0;
        let m;
        while ((m = HTML_SRC.exec(src))) {
            const url = m[2];
            if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('//') || url.includes('${')) continue;
            out.push({ spec: /^(\.{1,2})?\//.test(url) ? url : './' + url, line: lineAt(src, m.index).no, shown: url });
        }
    }
    // One report per specifier per line (the patterns overlap on `import x from`).
    const seen = new Set();
    return out
        .filter((s) => isChecked(s.spec) && !seen.has(s.line + s.spec) && seen.add(s.line + s.spec))
        .map(({ spec, line, shown }) => ({ spec, line, shown: shown ?? spec }));
}

/** Does `abs` exist with exactly this case, segment by segment, under root? */
function existsExactCase(root, abs, cache) {
    const rel = path.relative(root, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return fs.existsSync(abs);
    let dir = root;
    for (const seg of rel.split(path.sep)) {
        if (!cache.has(dir)) {
            try { cache.set(dir, new Set(fs.readdirSync(dir))); } catch { cache.set(dir, new Set()); }
        }
        if (!cache.get(dir).has(seg)) return false;
        dir = path.join(dir, seg);
    }
    return fs.statSync(abs).isFile();
}

function walk(dir, files = []) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return files; }
    for (const e of entries) {
        if (SKIP.has(e.name)) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, files);
        else if (/\.(m?js|html)$/.test(e.name)) files.push(p);
    }
    return files;
}

/**
 * @param {{ root: string, apps?: string[] }} opts  apps: the app dirs to check
 *        (shared/ is always checked — every site serves it).
 * @returns {{ file: string, line: number, spec: string, problem: string }[]}
 */
function scan({ root, apps = APPS }) {
    root = path.resolve(root);
    const cache = new Map();
    const problems = [];
    for (const owner of [...apps, SHARED]) {
        const ownerDir = path.join(root, owner);
        if (!fs.existsSync(ownerDir)) continue;
        // What the site that serves this file contains.
        const reachable = owner === SHARED ? [SHARED] : [owner, SHARED];
        for (const file of walk(ownerDir)) {
            const text = fs.readFileSync(file, 'utf8');
            for (const { spec, line, shown } of specifiers(file, text)) {
                const clean = spec.split(/[?#]/)[0];
                const target = clean.startsWith('/')
                    ? path.join(root, clean)                      // site-absolute: the site root mirrors the repo root
                    : path.resolve(path.dirname(file), clean);
                const rel = path.relative(root, target).split(path.sep).join('/');
                const where = { file: path.relative(root, file).split(path.sep).join('/'), line, spec: shown };
                const top = rel.split('/')[0];
                if (rel.startsWith('..') || !reachable.includes(top)) {
                    problems.push({ ...where, problem: `resolves to ${rel}, outside what this site serves (${reachable.map((r) => r + '/').join(' + ')})` });
                } else if (!fs.existsSync(target)) {
                    problems.push({ ...where, problem: `resolves to ${rel}, which does not exist` });
                } else if (!existsExactCase(root, target, cache)) {
                    problems.push({ ...where, problem: `resolves to ${rel} only case-insensitively — Firebase Hosting is case-sensitive` });
                }
            }
        }
    }
    return problems;
}

function report(problems, label) {
    if (!problems.length) { console.log(`✓ Every relative import resolves on its site (${label}).`); return 0; }
    console.error(`✗ ${problems.length} import(s) will not load in production (${label}):\n`);
    for (const p of problems) console.error(`  ${p.file}:${p.line}  '${p.spec}'\n      ${p.problem}`);
    console.error('\n  A module that fails to load stops every page that imports it. Fix the path before deploying.');
    return 1;
}

module.exports = { scan, report, specifiers };

if (require.main === module) {
    const root = path.resolve(__dirname, '..');
    const apps = process.argv.slice(2).length ? process.argv.slice(2) : APPS;
    process.exit(report(scan({ root, apps }), apps.join(', ')));
}
