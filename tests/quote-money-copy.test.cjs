'use strict';
/**
 * tests/quote-money-copy.test.cjs — shared/js/domain/quoteMoney.js messages and
 * previews (via its generated CommonJS mirror, functions/shared/quoteMoney.js).
 *
 *   QM-COPY-001  "12.345" was told it "must be a number"; it is a number with
 *                too many decimals. Message routing only: what is accepted or
 *                rejected, and how amounts round, are pinned unchanged below.
 */
require('./support/no-production.cjs');   // must stay the first statement (npm run lint:tests)

const assert = require('assert');
const path   = require('path');

const QM = require(path.join(__dirname, '..', 'functions', 'shared', 'quoteMoney.js'));

let passed = 0, failed = 0;
const failures = [];
async function t(name, fn) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { failed++; failures.push([name, e]); console.log(`  ✗ ${name}`); }
}

(async () => {
console.log('\n── QM-COPY-001 · a too-precise amount is told so ──\n');

const L = 'Labour cost';
const h = (v) => QM.toHundredths(v, L);

await t('a well-formed number with 3+ decimals reads "at most 2 decimal places"', () => {
    for (const v of ['12.345', '0.001', ' 150.125 ', '7.0000']) {
        assert.deepStrictEqual(h(v), { ok: false, message: `${L} can have at most 2 decimal places.` }, v);
    }
});
await t('anything that is not a plain number still reads "must be a number"', () => {
    for (const v of ['abc', '-1', '1e3', '0x10', '1,000', 'GHS 5', '.5', '5.', '1..2', '-12.345', ' ', NaN, Infinity]) {
        assert.deepStrictEqual(h(v), { ok: false, message: `${L} must be a number.` }, String(v));
    }
});
await t('accepted values and their rounding are unchanged', () => {
    const accepted = { '0': 0, '5': 500, '5.5': 550, '5.50': 550, ' 12.34 ': 1234, '150': 15000, '99999.99': 9999999 };
    for (const [v, want] of Object.entries(accepted)) assert.deepStrictEqual(h(v), { ok: true, hundredths: want }, v);
    assert.deepStrictEqual(h(12.34), { ok: true, hundredths: 1234 });
    assert.deepStrictEqual(h(0.1 + 0.2), { ok: true, hundredths: 30 }, 'float noise still rounds the same way');
});
await t('the other rejections keep their own messages', () => {
    assert.deepStrictEqual(h(''), { ok: false, message: `${L} is required.` });
    assert.deepStrictEqual(h(null), { ok: false, message: `${L} is required.` });
    assert.deepStrictEqual(h(-1), { ok: false, message: `${L} cannot be negative.` });
    assert.deepStrictEqual(h(12.345), { ok: false, message: `${L} can have at most 2 decimal places.` }, 'a NUMBER with 3dp was already told this');
});
await t('the quote form shows the new message for a too-precise labour cost', () => {
    const r = QM.validateQuoteInput({ labourCost: '120.555' });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.message, 'Labour cost can have at most 2 decimal places.');
});

console.log(`\nquote-money-copy: ${passed} passed, ${failed} failed`);
for (const [name, e] of failures) console.log(`\n  ✗ ${name}\n    ${e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n    ') : e}`);
process.exit(failed ? 1 : 0);
})();
