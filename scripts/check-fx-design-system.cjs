#!/usr/bin/env node
'use strict';

/**
 * check-fx-design-system.cjs — the gate of the artisan design system (Phase 1).
 *
 * artisan-app/css/tokens.css is the ONLY place a raw colour, radius, shadow,
 * type value, z-index, duration or spacing length may appear. Everything built
 * on the system must reference the tokens:
 *
 *   artisan-app/css/app.css            the component foundation
 *   artisan-app/css/fx/**\/*.css        screen stylesheets built on the system
 *   artisan-app/*.html with <body class="… fx-app …">: their <style> blocks and
 *                                      style="" attributes (none are allowed)
 *
 * Rules (each violation names one):
 *   raw-colour     hex, rgb(), hsl() … or a named colour (system colours only
 *                  inside @media (forced-colors))
 *   raw-radius     border-radius other than var(--fx-r-*) or 0
 *   raw-shadow     box-shadow other than none or var(--fx-e-*|ring-*) tokens
 *   raw-type       font, font-size/-weight/-family, line-height, letter-spacing
 *                  that are not tokens
 *   raw-z          z-index other than var(--fx-z-*), 0 or auto
 *   raw-duration   a literal ms/s duration in transition/animation
 *   raw-space      a literal length in margin/padding/gap/inset (0, 1px hairline
 *                  offsets inside calc via tokens only)
 *   raw-custom     a custom property in a component file set to anything but var()
 *   important      !important outside reduced-motion / forced-colors / [hidden]
 *   id-selector    an #id selector
 *   specificity    more than 3 class/attribute/pseudo-class parts, or 3 elements
 *   scope          a selector that targets no .fx- class (it would style the
 *                  unmigrated pages)
 *   mixed-system   a reference to the old --ds-* tokens
 *   unknown-token  var(--fx-…) that tokens.css does not define
 *   inline-style   style="" on an opted-in page
 *
 * Exceptions: put  /* fx-allow: <reason> *\/  on the line of the declaration.
 * Every exception is printed, so none is silent. Files under ALLOW_FILES
 * (third-party code) are not scanned.
 *
 * Usage:  node scripts/check-fx-design-system.cjs          (exit 1 on violations)
 */

const fs   = require('fs');
const path = require('path');

const ROOT    = path.resolve(__dirname, '..');
const TOKENS  = path.join(ROOT, 'artisan-app', 'css', 'tokens.css');
const APP_CSS = path.join(ROOT, 'artisan-app', 'css', 'app.css');
const FX_DIR  = path.join(ROOT, 'artisan-app', 'css', 'fx');
const PAGES   = path.join(ROOT, 'artisan-app');
const ALLOW_FILES = [];                         // third-party stylesheets, by path, with a reason
const RUNTIME_PROPS = new Set(['--fx-countdown']);   // set by scripts at run time, always with a fallback

const NAMED_COLOURS = new Set(('aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen').split(' '));
const SYSTEM_COLOURS = new Set(['canvas', 'canvastext', 'buttontext', 'buttonface', 'buttonborder', 'highlight', 'highlighttext', 'linktext', 'graytext', 'field', 'fieldtext', 'mark', 'marktext', 'visitedtext', 'activetext', 'accentcolor', 'accentcolortext']);
const COLOUR_PROPS = /^(color|background(-color|-image)?|border(-(top|right|bottom|left|block|inline)(-(start|end))?)?(-color)?|outline(-color)?|fill|stroke|text-decoration(-color)?|caret-color|accent-color|column-rule(-color)?|box-shadow|text-shadow)$/;
const SPACE_PROPS  = /^(margin|padding)(-(top|right|bottom|left|block|inline)(-(start|end))?)?$|^(gap|row-gap|column-gap|inset(-(block|inline)(-(start|end))?)?|top|right|bottom|left)$/;
const TYPE_PROPS   = /^(font|font-size|font-weight|font-family|line-height|letter-spacing)$/;

// ── A small CSS reader: rules, at-rules, declarations, with line numbers ────
function parse(css) {
    const out = [];                   // { prop, value, line, selectors[], at[] (enclosing at-rule preludes), important }
    const rules = [];                 // { selector, line, at[] }
    const stack = [];
    let i = 0, buf = '', bufStart = 0, line = 1, quote = null, paren = 0;
    const lineAt = (pos) => css.slice(0, pos).split('\n').length;
    // Blank comments, keeping offsets (and so line numbers) intact.
    css = css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
    const flushDecl = (end) => {
        const text = buf.trim();
        if (text) {
            const ctx = stack[stack.length - 1];
            const colon = text.indexOf(':');
            if (ctx && ctx.type === 'rule' && colon > 0) {
                let value = text.slice(colon + 1).trim();
                const important = /!important\s*$/i.test(value);
                value = value.replace(/!important\s*$/i, '').trim();
                out.push({ prop: text.slice(0, colon).trim().toLowerCase(), value, important,
                           line: lineAt(bufStart + buf.search(/\S/)), selector: ctx.selector,
                           at: stack.filter((s) => s.type === 'at').map((s) => s.prelude) });
            }
        }
        buf = ''; bufStart = end + 1;
    };
    for (i = 0; i < css.length; i++) {
        const ch = css[i];
        if (quote) { if (ch === quote && css[i - 1] !== '\\') quote = null; buf += ch; continue; }
        if (ch === '"' || ch === "'") { quote = ch; buf += ch; continue; }
        if (ch === '(') paren++;
        if (ch === ')') paren = Math.max(0, paren - 1);
        if (paren > 0) { buf += ch; continue; }
        if (ch === '{') {
            const prelude = buf.trim();
            const ln = lineAt(bufStart + buf.search(/\S/));
            if (prelude.startsWith('@')) stack.push({ type: 'at', prelude });
            else {
                const inKeyframes = stack.some((s) => s.type === 'at' && /^@(-webkit-)?keyframes/i.test(s.prelude));
                stack.push({ type: 'rule', selector: prelude, keyframe: inKeyframes });
                if (!inKeyframes) rules.push({ selector: prelude, line: ln, at: stack.filter((s) => s.type === 'at').map((s) => s.prelude) });
            }
            buf = ''; bufStart = i + 1; continue;
        }
        if (ch === ';') { flushDecl(i); continue; }
        if (ch === '}') { flushDecl(i); stack.pop(); continue; }
        if (!buf) bufStart = i;
        buf += ch;
    }
    return { decls: out, rules };
}

// Specificity of one complex selector: [ids, classes/attrs/pseudo-classes, elements].
function specificity(sel) {
    let s = sel.replace(/:where\((?:[^()]|\([^()]*\))*\)/g, '');           // :where() adds nothing
    s = s.replace(/:(not|is|has)\(((?:[^()]|\([^()]*\))*)\)/g, (m, fn, inner) => {   // the most specific argument
        const best = inner.split(',').map((x) => specificity(x)).sort((a, b) => b[0] - a[0] || b[1] - a[1] || b[2] - a[2])[0] || [0, 0, 0];
        return ' ' + 'A'.repeat(best[0]) + ' ' + '.x'.repeat(best[1]) + ' ' + 'e '.repeat(best[2]);
    });
    s = s.replace(/"[^"]*"|'[^']*'/g, '""');
    const ids = (s.match(/#[\w-]+/g) || []).length + (s.match(/A/g) || []).length;
    const cls = (s.match(/\.[\w-]+|\[[^\]]*\]/g) || []).length + (s.match(/(?<!:):(?!:)[\w-]+/g) || []).length;
    const el  = (s.replace(/\[[^\]]*\]|\.[\w-]+|#[\w-]+|::?[\w-]+(\([^)]*\))?/g, ' ').match(/(^|[\s>+~])([a-z][\w-]*)(?=$|[\s>+~])/gi) || []).length
              + (s.match(/::[\w-]+/g) || []).length;
    return [ids, cls, el];
}

function definedTokens() {
    const css = fs.readFileSync(TOKENS, 'utf8');
    return new Set([...css.matchAll(/(--fx-[\w-]+)\s*:/g)].map((m) => m[1]));
}

function stripVars(value) {            // drop var(...) bodies so their names cannot read as raw values
    let v = value, prev;
    do { prev = v; v = v.replace(/var\((?:[^()]|\([^()]*\))*\)/g, ' V '); } while (v !== prev);
    return v;
}

function checkDecl(d, file, tokens, isComponentFile) {
    const out = [];
    const v = d.value;
    const bare = stripVars(v);
    const lower = bare.toLowerCase();
    const inForced = d.at.some((a) => /forced-colors/i.test(a));
    const inReduced = d.at.some((a) => /prefers-reduced-motion/i.test(a));
    const add = (rule, msg) => out.push({ file, line: d.line, rule, msg: `${msg}  (${d.prop}: ${v})` });

    if (/--ds-[\w-]+/.test(v)) add('mixed-system', 'the old --ds-* tokens do not mix with the --fx-* system');
    for (const m of v.matchAll(/var\(\s*(--fx-[\w-]+)/g)) {
        if (!tokens.has(m[1]) && !RUNTIME_PROPS.has(m[1])) add('unknown-token', `${m[1]} is not defined in tokens.css`);
    }
    if (d.prop.startsWith('--')) {
        if (isComponentFile && !/^var\(/.test(v.trim())) add('raw-custom', 'a component may only re-point a custom property to another token');
        return out;
    }
    // Colour
    if (/#[0-9a-f]{3,8}\b/i.test(bare) || /\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/i.test(bare)) add('raw-colour', 'raw colour');
    else if (COLOUR_PROPS.test(d.prop)) {
        for (const word of lower.match(/[a-z]+/g) || []) {
            if (NAMED_COLOURS.has(word)) add('raw-colour', `named colour "${word}"`);
            if (SYSTEM_COLOURS.has(word) && !inForced) add('raw-colour', `system colour "${word}" outside @media (forced-colors)`);
        }
    }
    // Radius
    if (/radius$/.test(d.prop)) {
        const parts = bare.trim().split(/\s+|\//).filter(Boolean);
        if (parts.some((p) => !['V', '0', 'inherit'].includes(p))) add('raw-radius', 'radius must be a --fx-r-* token');
    }
    // Shadow
    if (d.prop === 'box-shadow' || d.prop === 'text-shadow') {
        const items = v.split(/,(?![^(]*\))/).map((s) => s.trim());
        const ok = items.every((s) => s === 'none' || /^var\(--fx-(e|ring)-[\w-]+\)$/.test(s));
        if (!ok) add('raw-shadow', 'shadow must be none or a --fx-e-* / --fx-ring-* token');
    }
    // Type
    if (TYPE_PROPS.test(d.prop)) {
        const allowed = ['V', 'inherit', 'normal', '0'];
        if (bare.trim().split(/\s+|\//).filter(Boolean).some((p) => !allowed.includes(p))) add('raw-type', 'type must come from --fx-t-*, --fx-size-*, --fx-w-* or --fx-track-* tokens');
    }
    // Layers
    if (d.prop === 'z-index' && !['V', '0', 'auto'].includes(bare.trim())) add('raw-z', 'z-index must be a --fx-z-* token');
    // Motion
    if (/^(transition|animation)(-duration|-delay)?$/.test(d.prop) && /(^|[\s,(])\d*\.?\d+m?s\b/.test(bare.replace(/\b0s\b/g, ''))) add('raw-duration', 'durations come from --fx-d-* tokens');
    // Space
    if (SPACE_PROPS.test(d.prop)) {
        const lengths = (bare.replace(/env\([^)]*\)/g, ' ').match(/-?\d*\.?\d+(px|rem|em|vh|vw|dvh)\b/g) || []).filter((x) => !/^-?0(px|rem|em)?$/.test(x));
        if (lengths.length) add('raw-space', `spacing must use --fx-space-* / --fx-gutter tokens (${lengths.join(', ')})`);
    }
    // !important
    if (d.important && !inReduced && !inForced && !/\[hidden\]/.test(d.selector)) add('important', '!important is reserved for reduced motion, forced colours and [hidden]');
    return out;
}

function checkRule(r, file) {
    const out = [];
    for (const sel of r.selector.split(/,(?![^(]*\))/).map((s) => s.trim()).filter(Boolean)) {
        const noStrings = sel.replace(/"[^"]*"|'[^']*'/g, '""');
        if (/#[A-Za-z_-]/.test(noStrings)) out.push({ file, line: r.line, rule: 'id-selector', msg: `id selector: ${sel}` });
        const [, b, c] = specificity(sel);
        if (b > 3 || c > 3) out.push({ file, line: r.line, rule: 'specificity', msg: `specificity (${specificity(sel).join(',')}) exceeds (0,3,3): ${sel}` });
        if (!/\.fx-[\w-]+/.test(sel) && !/^:root$/.test(sel)) out.push({ file, line: r.line, rule: 'scope', msg: `selector targets no .fx- class: ${sel}` });
    }
    return out;
}

function allowedLines(text) {
    const set = new Map();
    text.split('\n').forEach((l, idx) => {
        const m = l.match(/\/\*\s*fx-allow:\s*([^*]+?)\s*\*\//);
        if (m) set.set(idx + 1, m[1]);
    });
    return set;
}

/** Lint one stylesheet's text. Returns { violations, exceptions }. */
function lintCss(text, file, tokens = definedTokens(), { component = true } = {}) {
    const allow = allowedLines(text);
    const { decls, rules } = parse(text);
    const violations = [], exceptions = [];
    for (const d of decls) {
        for (const v of checkDecl(d, file, tokens, component)) (allow.has(v.line) ? exceptions : violations).push(allow.has(v.line) ? { ...v, reason: allow.get(v.line) } : v);
    }
    for (const r of rules) {
        if (r.at.some((a) => /keyframes/i.test(a))) continue;
        for (const v of checkRule(r, file)) (allow.has(v.line) ? exceptions : violations).push(allow.has(v.line) ? { ...v, reason: allow.get(v.line) } : v);
    }
    return { violations, exceptions };
}

/** Lint an HTML page that opted in (<body class="… fx-app …">). */
function lintPage(html, file, tokens = definedTokens()) {
    if (!/<body[^>]*class="[^"]*\bfx-app\b/.test(html)) return { violations: [], exceptions: [], optedIn: false };
    const violations = [], exceptions = [];
    const lineAt = (pos) => html.slice(0, pos).split('\n').length;
    for (const m of html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) {
        const offset = lineAt(m.index) - 1;
        const r = lintCss(m[1], file, tokens);
        violations.push(...r.violations.map((v) => ({ ...v, line: v.line + offset })));
        exceptions.push(...r.exceptions.map((v) => ({ ...v, line: v.line + offset })));
    }
    for (const m of html.matchAll(/\sstyle\s*=\s*"([^"]*)"/g)) {
        violations.push({ file, line: lineAt(m.index), rule: 'inline-style', msg: `inline style on an opted-in page: style="${m[1].slice(0, 60)}"` });
    }
    return { violations, exceptions, optedIn: true };
}

function files() {
    const list = [APP_CSS];
    const walk = (dir) => { if (!fs.existsSync(dir)) return; for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p); else if (e.name.endsWith('.css')) list.push(p);
    } };
    walk(FX_DIR);
    return list.filter((f) => !ALLOW_FILES.includes(path.relative(ROOT, f).replace(/\\/g, '/')));
}

function main() {
    const tokens = definedTokens();
    const violations = [], exceptions = [];
    let pages = 0;
    for (const f of files()) {
        const r = lintCss(fs.readFileSync(f, 'utf8'), path.relative(ROOT, f).replace(/\\/g, '/'), tokens);
        violations.push(...r.violations); exceptions.push(...r.exceptions);
    }
    for (const name of fs.readdirSync(PAGES).filter((n) => n.endsWith('.html'))) {
        const r = lintPage(fs.readFileSync(path.join(PAGES, name), 'utf8'), `artisan-app/${name}`, tokens);
        if (r.optedIn) pages++;
        violations.push(...r.violations); exceptions.push(...r.exceptions);
    }
    for (const e of exceptions) console.log(`  allowed  ${e.file}:${e.line}  ${e.rule} — ${e.reason}`);
    if (violations.length) {
        for (const v of violations) console.error(`  ✗ ${v.file}:${v.line}  ${v.rule}  ${v.msg}`);
        console.error(`\n✗ ${violations.length} design-system violation(s). Use a token from artisan-app/css/tokens.css, or mark a genuine exception with /* fx-allow: reason */.`);
        process.exit(1);
    }
    console.log(`✓ Artisan design system: ${files().length} stylesheet(s) and ${pages} opted-in page(s) use tokens only (${tokens.size} tokens, ${exceptions.length} documented exception(s)).`);
}

if (require.main === module) main();
module.exports = { lintCss, lintPage, specificity, definedTokens, parse };
