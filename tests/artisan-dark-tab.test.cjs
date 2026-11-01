'use strict';
/**
 * tests/artisan-dark-tab.test.cjs — UI-004: in dark mode the artisan app's
 * active tab stays orange.
 *
 * shared/css/components/tabs.css gives artisan tabs their brand colour with
 * `.ui-tabs--artisan .ui-tab…`, and dark mode with `[data-theme="dark"]
 * .ui-tab.active…` (the customer maroon). Same specificity, dark rule later,
 * so artisan tabs turned maroon in dark mode. A dark artisan rule, after it,
 * restores the brand colour; customer tabs are untouched.
 * Chromium: tests were run against jobs/notifications/reviews (orange in both
 * themes) and customer booking/saved (maroon in both).
 */
require('./support/no-production.cjs');   // must stay the first statement (npm run lint:tests)

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const css = fs.readFileSync(path.join(__dirname, '..', 'shared', 'css', 'components', 'tabs.css'), 'utf8')
    .replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '');

let passed = 0, failed = 0;
function t(name, fn) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.message.split('\n')[0]}`); }
}

/** Every rule as { selectors[], body }, in source order. */
const rules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .map((m) => ({ selectors: m[1].split(',').map((s) => s.trim()).filter(Boolean), body: m[2] }));
const indexOf = (sel) => rules.findIndex((r) => r.selectors.includes(sel));

t('a dark-mode artisan rule covers every active-tab form, with the brand token', () => {
    for (const sel of ['[data-theme="dark"] .ui-tabs--artisan .ui-tab.ui-tab--active',
                       '[data-theme="dark"] .ui-tabs--artisan .ui-tab.active',
                       '[data-theme="dark"] .ui-tabs--artisan .ui-tab[aria-selected="true"]']) {
        const i = indexOf(sel);
        assert.ok(i >= 0, `missing ${sel}`);
        assert.match(rules[i].body, /background:\s*var\(--ds-brand-500\)/);
    }
});

t('it comes after the generic dark active rule it must override', () => {
    assert.ok(indexOf('[data-theme="dark"] .ui-tabs--artisan .ui-tab.active') > indexOf('[data-theme="dark"] .ui-tab.active'));
});

t('customer tabs keep the maroon active rule in both themes', () => {
    const light = rules[indexOf('.ui-tab.active')];
    const dark  = rules[indexOf('html.dark .ui-tab.active')];
    assert.match(light.body, /background:\s*var\(--ui-primary, #730201\)/);
    assert.match(dark.body, /background:\s*var\(--ui-primary, #730201\)/);
    // The new rule names the artisan variant only.
    for (const r of rules) {
        if (r.selectors.some((s) => /data-theme="dark"\] \.ui-tabs--artisan/.test(s))) {
            assert.ok(r.selectors.every((s) => s.includes('.ui-tabs--artisan')), 'the artisan dark rule must not reach customer tabs');
        }
    }
});

console.log(`\nartisan-dark-tab: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
