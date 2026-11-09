'use strict';

/**
 * tests/legal-pages.test.cjs — what users accept, and what the home screen
 * claims, matches what the product does. (PL-08 / PL-37, 2026-10-28)
 *
 *   • Artisans asked to accept the Terms got the login page: the artisan app
 *     linked ../customer-app/settings-terms.html, which the artisan site does
 *     not serve. Every legal link must resolve inside its own site's bundle.
 *   • "Last updated" was document.lastModified — the visit date, every visit.
 *   • The Terms promised a late-cancellation fee of up to 20% (none exists),
 *     refunds in 3–5 business days (they are instant, to the wallet), and an
 *     old address. Money figures in them are held to functions/config.js.
 */

require('./support/no-production.cjs');   // must stay the first statement (npm run lint:tests)
const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

// Change with the text of the page (and its "Last updated" line).
const TERMS_VERSION   = '2026-10-28';
const PRIVACY_VERSION = '2026-10-28';

let passed = 0, failed = 0;
const failures = [];
async function t(name, fn) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { failed++; failures.push([name, e]); console.log(`  ✗ ${name}`); }
}

const config  = require(path.join(ROOT, 'functions', 'config.js'));
const support = read('shared/js/config/supportConfig.js').match(/email:\s*'([^']+)'/)[1];
const terms   = read('shared/legal/terms.html');
const privacy = read('shared/legal/privacy.html');
const visible = (html) => html.replace(/<!--[\s\S]*?-->/g, '').replace(/<script[\s\S]*?<\/script>/g, '');

(async () => {
console.log('\n── Every legal link opens the document, on both sites ──\n');

await t('each Terms/Privacy link in both apps resolves to a file its own site serves', () => {
    // A site serves build-<app>/<app>/ and build-<app>/shared/ (scripts/stage-hosting.cjs).
    const LINK = /(?:href=|location\.href\s*=\s*|goTo\()["']([^"']*(?:terms|privacy)[^"']*\.html)["']/gi;
    let checked = 0;
    for (const app of ['customer-app', 'artisan-app']) {
        for (const f of fs.readdirSync(path.join(ROOT, app)).filter((x) => x.endsWith('.html'))) {
            const html = read(`${app}/${f}`);
            for (const m of html.matchAll(LINK)) {
                if (/^(https?:|mailto:)/.test(m[1])) continue;
                const target = path.posix.normalize(path.posix.join(app, m[1]));
                assert.ok(target.startsWith(`${app}/`) || target.startsWith('shared/'),
                    `${app}/${f} links ${m[1]}, which the ${app} site does not serve`);
                assert.ok(fs.existsSync(path.join(ROOT, target)), `${app}/${f} links ${m[1]}: no such file`);
                checked++;
            }
        }
    }
    assert.ok(checked >= 10, `expected the legal links of both apps, found ${checked}`);
});

await t('artisan onboarding opens the documents in a new tab (the half-filled form survives)', () => {
    const on = read('artisan-app/onboarding.html');
    assert.match(on, /href="\.\.\/shared\/legal\/terms\.html" target="_blank" rel="noopener"/);
    assert.match(on, /href="\.\.\/shared\/legal\/privacy\.html" target="_blank" rel="noopener"/);
});

await t('artisan sign-up links the documents it asks the artisan to accept (audit AUTH-001)', () => {
    const su = read('artisan-app/signup.html');
    assert.match(su, /<a (?:class="fx-link" )?href="\.\.\/shared\/legal\/terms\.html" target="_blank" rel="noopener">Terms of Service<\/a>/);
    assert.match(su, /<a (?:class="fx-link" )?href="\.\.\/shared\/legal\/privacy\.html" target="_blank" rel="noopener">Privacy Policy<\/a>/);
    // The agreement is still required: the box is unticked and gates the submit
    // (artisan-app/js/entry.js signupProblems refuses the form without it).
    assert.match(su, /<input type="checkbox" id="su-terms"\s/);
    assert.ok(!/id="su-terms"[^>]*\bchecked\b/.test(su), 'the agreement must not be pre-ticked');
    assert.match(read('artisan-app/js/entry.js'), /if \(!v\.terms\) out\.terms = 'Agree to the Terms of Service and Privacy Policy to continue\.';/);
    // An unticked box is a problem, and any problem stops the submission
    // before anything is sent (Phase 5: the button stays focusable and says why).
    assert.match(su, /terms: \$\('su-terms'\)\.checked,/);
    assert.match(su, /const first = Object\.keys\(FIELDS\)\.find\(\(k\) => problems\[k\]\);\s*if \(first\) \{ \$\(FIELDS\[first\]\)\.focus\(\); return; \}/);
});

await t('no Terms or Privacy link anywhere is a placeholder "#"', () => {
    // The check above resolves real links; a placeholder has no file name to
    // resolve, so it slipped past it. This is what let sign-up ship with "#".
    const PLACEHOLDER = /<a\b[^>]*href=["']#?["'][^>]*>\s*(?:Terms(?: of Service| and Conditions)?|Privacy(?: Policy)?)\s*<\/a>/gi;
    for (const app of ['customer-app', 'artisan-app']) {
        for (const f of fs.readdirSync(path.join(ROOT, app)).filter((x) => x.endsWith('.html'))) {
            const hits = visible(read(`${app}/${f}`)).match(PLACEHOLDER);
            assert.ok(!hits, `${app}/${f} has a legal link that goes nowhere: ${hits && hits[0]}`);
        }
    }
});

await t('the old customer addresses forward to the shared documents', () => {
    assert.match(read('customer-app/settings-terms.html'), /location\.replace\('\.\.\/shared\/legal\/terms\.html'\)/);
    assert.match(read('customer-app/settings-privacy-policy.html'), /location\.replace\('\.\.\/shared\/legal\/privacy\.html'\)/);
});

await t('back goes to where the reader came from, else the site\'s own home', () => {
    for (const [name, html] of [['terms', terms], ['privacy', privacy]]) {
        assert.match(html, /document\.referrer\.indexOf\(location\.origin \+ '\/'\) === 0\) history\.back\(\); else location\.href = '\/';/, name);
    }
});

console.log('\n── The date is the date the text changed ──\n');

await t('"Last updated" is fixed in the page, never computed from the visit', () => {
    for (const [name, html, v] of [['terms', terms, TERMS_VERSION], ['privacy', privacy, PRIVACY_VERSION]]) {
        const code = html.replace(/<!--[\s\S]*?-->/g, '');      // the comments explain the old bug by name
        assert.ok(!/lastModified|new Date\(/.test(code), `${name}: date must not be computed`);
        const [y, mo, d] = v.split('-').map(Number);
        const long = new Date(Date.UTC(y, mo - 1, d)).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
        assert.ok(visible(html).includes(`Version ${v} · Last updated ${long}`), `${name}: expected "Version ${v} · Last updated ${long}"`);
    }
});

console.log('\n── The Terms promise only what the product does ──\n');

await t('no late-cancellation fee and no "3–5 business days" refund promise', () => {
    const text = visible(terms);
    assert.ok(!/20\s*%/.test(text), 'a percentage fee nothing charges');
    assert.ok(!/business days/i.test(text), 'refunds are credited to the wallet at once');
    assert.ok(!/late cancellation/i.test(text));
    assert.match(text, /charges no cancellation fee/);
    assert.match(text, /credited to your Fidus X wallet as soon as it is decided/);
});

await t('the commission and the auto-release period are the configured ones', () => {
    const pct = Math.round(config.COMMISSION_RATE * 100);
    assert.match(visible(terms), new RegExp(`<span data-commission>${pct}%</span>`), `commission is ${pct}% in functions/config.js`);
    assert.match(visible(terms), new RegExp(`unconfirmed ${config.ESCROW_AUTO_RELEASE_DAYS} days after you paid`));
});

await t('both documents give the confirmed support address, and no retired one', () => {
    for (const [name, html] of [['terms', terms], ['privacy', privacy]]) {
        assert.ok(visible(html).includes(`mailto:${support}`), `${name}: contact must be ${support}`);
        assert.ok(!/handyhub/i.test(visible(html)), `${name}: retired HandyHub address`);
    }
});

await t('the privacy policy names what artisans submit and who processes payments', () => {
    const text = visible(privacy);
    for (const must of ['Ghana Card number', 'date of birth', 'Mobile Money account', 'precise location', 'Paystack']) {
        assert.ok(text.includes(must), `privacy policy must mention ${must}`);
    }
});

await t('a payout reaches Mobile Money narrated as Fidus X', () => {
    const tr = read('functions/financial/transfers.js');
    assert.match(tr, /reason: 'Fidus X Artisan Earnings'/);
    assert.match(tr, /reason: 'Fidus X Wallet Withdrawal'/);
    assert.ok(!/reason: 'HandyHub/.test(tr));
});

console.log(`\nlegal-pages: ${passed} passed, ${failed} failed`);
if (failed) { for (const [nm, e] of failures) console.error(`\n✗ ${nm}\n${e.stack}`); process.exit(1); }
process.exit(0);
})();
