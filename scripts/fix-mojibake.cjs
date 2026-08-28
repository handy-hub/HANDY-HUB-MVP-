#!/usr/bin/env node
/**
 * fix-mojibake.cjs — repair double-encoded UTF-8 across the apps.
 *
 * THE CAUSE
 * ─────────
 * These files were authored as UTF-8, then at some point re-saved by an editor
 * that read the bytes as Windows-1252 and encoded them again. Every non-ASCII
 * character therefore became the 2–3 Latin-1 characters that its UTF-8 bytes
 * happen to look like: "—" (E2 80 94) became "â€"", "·" (C2 B7) became "Â·",
 * "→" became "â†'".
 *
 * That is why JS-injected copy is clean and HTML-authored copy is not: the
 * corruption is in the bytes on disk, not in the rendering. The pages already
 * declare <meta charset="UTF-8"> and the server already serves UTF-8 — the
 * browser is faithfully displaying corrupt source. No amount of header or
 * charset configuration would fix it.
 *
 * THE FIX
 * ───────
 * Round-trip the mojibake back: take the corrupted text, encode it as
 * Windows-1252 (undoing the second encoding), then decode it as UTF-8 (the
 * original). Applied ONLY to runs that actually decode cleanly, so genuine
 * Latin-1 text — if any existed — is left alone.
 *
 *   node scripts/fix-mojibake.cjs          # report only
 *   node scripts/fix-mojibake.cjs --write  # apply
 */

'use strict';
const fs   = require('fs');
const path = require('path');

const ROOTS = ['customer-app', 'artisan-app', 'admin-dashboard', 'shared'];
const EXTS  = new Set(['.html', '.js', '.css', '.json', '.md']);
const SKIP  = new Set(['node_modules', '.git', 'build-customer-app', 'build-artisan-app']);

// Any character a single byte 0x80-0xFF becomes when misread as Windows-1252.
// Written as explicit unicode escapes rather than literals so this file cannot
// itself be corrupted into a subtly different pattern.
const CONT = '\u0080-\u00FF'
    + '\u20AC\u201A\u0192\u201E\u2026\u2020\u2021\u02C6\u2030\u0160'
    + '\u2039\u0152\u017D\u2018\u2019\u201C\u201D\u2022\u2013\u2014'
    + '\u02DC\u2122\u0161\u203A\u0153\u017E\u0178';

// A UTF-8 lead byte (C2-EF) misread as cp1252.
const LEAD = '\u00C2-\u00EF';

// Try 3 characters before 2, so a 3-byte sequence is never mis-split.
const MOJIBAKE_RUN = new RegExp('[' + LEAD + '][' + CONT + '][' + CONT + ']?', 'g');

// cp1252 → byte. Characters 0x80–0x9F are remapped by Windows-1252; the rest are
// Latin-1 identity.
const CP1252 = {
    0x20AC: 0x80, 0x201A: 0x82, 0x0192: 0x83, 0x201E: 0x84, 0x2026: 0x85,
    0x2020: 0x86, 0x2021: 0x87, 0x02C6: 0x88, 0x2030: 0x89, 0x0160: 0x8A,
    0x2039: 0x8B, 0x0152: 0x8C, 0x017D: 0x8E, 0x2018: 0x91, 0x2019: 0x92,
    0x201C: 0x93, 0x201D: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97,
    0x02DC: 0x98, 0x2122: 0x99, 0x0161: 0x9A, 0x203A: 0x9B, 0x0153: 0x9C,
    0x017E: 0x9E, 0x0178: 0x9F,
};

function toByte(ch) {
    const c = ch.codePointAt(0);
    if (c <= 0xFF) return c;
    return CP1252[c] ?? null;
}

/** Decode a run of exactly `n` characters, or null if it is not valid UTF-8. */
function decodeRun(run) {
    const bytes = [];
    for (const ch of run) {
        const b = toByte(ch);
        if (b === null) return null;
        bytes.push(b);
    }
    const out = Buffer.from(bytes).toString('utf8');
    // A clean decode contains no replacement character and shortens the string.
    if (out.includes('�') || out.length >= run.length) return null;
    return out;
}

/**
 * Undo one layer of encoding, longest-match-first WITH backtracking.
 *
 * The regex is greedy, so a 2-byte sequence followed by an unrelated accented
 * character matches as three. Without backtracking that 3-byte decode fails and
 * the whole run is left alone — which is how "Ã—" (a double-encoded ×) survived
 * a pass that reported zero remaining, in rendered output on the quote screen.
 * Returns the repaired prefix plus whatever tail was not part of the sequence.
 */
function repairRun(run) {
    for (let n = run.length; n >= 2; n--) {
        const out = decodeRun(run.slice(0, n));
        if (out !== null) return out + run.slice(n);
    }
    return null;
}

function repair(text) {
    let count = 0;
    const fixed = text.replace(MOJIBAKE_RUN, (run) => {
        const r = repairRun(run);
        if (r === null) return run;
        count++;
        return r;
    });
    return { fixed, count };
}

function walk(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (SKIP.has(entry.name)) continue;
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(p, out);
        else if (EXTS.has(path.extname(entry.name))) out.push(p);
    }
    return out;
}

const write = process.argv.includes('--write');
const root  = path.join(__dirname, '..');
let files = 0, total = 0;
const touched = [];

for (const r of ROOTS) {
    const dir = path.join(root, r);
    if (!fs.existsSync(dir)) continue;
    for (const file of walk(dir)) {
        const original = fs.readFileSync(file, 'utf8');
        const { fixed, count } = repair(original);
        if (!count) continue;
        files++; total += count;
        touched.push(`${count.toString().padStart(5)}  ${path.relative(root, file)}`);
        if (write) fs.writeFileSync(file, fixed, 'utf8');
    }
}

console.log(touched.sort((a, b) => parseInt(b) - parseInt(a)).join('\n'));
console.log(`\n${write ? 'Repaired' : 'Would repair'} ${total} sequence(s) across ${files} file(s).`);
if (!write && files) console.log('Run with --write to apply.');
process.exit(0);
