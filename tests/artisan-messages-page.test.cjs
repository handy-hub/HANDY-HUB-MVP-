'use strict';
/**
 * tests/artisan-messages-page.test.cjs — artisan Messages screen findings from
 * the 28 Oct audit, run against the page's own code.
 *
 *   NAV-002  Back from an open conversation left Messages entirely.
 */
require('./support/no-production.cjs');   // must stay the first statement (npm run lint:tests)

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const page = fs.readFileSync(path.join(__dirname, '..', 'artisan-app', 'messages.html'), 'utf8').replace(/\r\n/g, '\n');

let passed = 0, failed = 0;
const failures = [];
async function t(name, fn) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { failed++; failures.push([name, e]); console.log(`  ✗ ${name}`); }
}

(async () => {
console.log('\n── NAV-002 · an open conversation is a history entry ──\n');

/** The page's own inboxUrl + pushThread over a fake location/history. */
function threadHistory(startUrl, startState = null) {
    const loc = { href: startUrl, get search() { return new URL(this.href).search; } };
    const stack = [{ url: startUrl, state: startState }];
    const history = {
        get state() { return stack[stack.length - 1].state; },
        replaceState(state, _t, url) { stack[stack.length - 1] = { url: String(url), state }; loc.href = String(url); },
        pushState(state, _t, url) { stack.push({ url: String(url), state }); loc.href = String(url); },
    };
    const src = page.slice(page.indexOf('function inboxUrl() {'), page.indexOf('const { repositories, services }'));
    // eslint-disable-next-line no-new-func
    const pushThread = new Function('location', 'history', 'URL', 'URLSearchParams', `${src}; return pushThread;`)(
        loc, history, URL, URLSearchParams);
    return { pushThread, stack };
}

await t('opening a thread from the inbox pushes ?chat=, with the inbox under it', () => {
    const h = threadHistory('https://a.example/artisan-app/messages.html');
    h.pushThread('c_1');
    assert.deepStrictEqual(h.stack.map((e) => e.url), [
        'https://a.example/artisan-app/messages.html',
        'https://a.example/artisan-app/messages.html?chat=c_1',
    ]);
    assert.deepStrictEqual(h.stack[0].state, { inbox: true });
    assert.deepStrictEqual(h.stack[1].state, { chat: 'c_1' });
});
await t('opened from a notification (?chatId=): Back lands on the inbox, not the notification link', () => {
    const h = threadHistory('https://a.example/artisan-app/messages.html?chatId=c_9&bookingId=HHB-1');
    h.pushThread('c_9');
    assert.deepStrictEqual(h.stack.map((e) => e.url), [
        'https://a.example/artisan-app/messages.html?bookingId=HHB-1',
        'https://a.example/artisan-app/messages.html?bookingId=HHB-1&chat=c_9',
    ]);
});
await t('re-opening the thread already in the URL (a reload, Back/Forward) pushes nothing', () => {
    const h = threadHistory('https://a.example/artisan-app/messages.html?chat=c_1', { chat: 'c_1' });
    h.pushThread('c_1');
    assert.strictEqual(h.stack.length, 1);
});
await t('the page wires it: open pushes, Back pops, popstate opens or closes', () => {
    assert.match(page, /async function openChat\(chatId, \{ fromHistory = false \} = \{\}\) \{\s*if \(!fromHistory\) pushThread\(chatId\);/);
    assert.match(page, /if \(history\.state && history\.state\.chat\) history\.back\(\);\s*else closeChat\(\);/);
    assert.match(page, /window\.addEventListener\('popstate', \(\) => \{\s*const chatId = new URLSearchParams\(location\.search\)\.get\('chat'\);\s*if \(chatId\) openChat\(chatId, \{ fromHistory: true \}\)/);
    assert.match(page, /\|\| new URLSearchParams\(location\.search\)\.get\('chat'\) \|\| null;/, 'a reload reopens the thread');
});

console.log(`\nartisan-messages-page: ${passed} passed, ${failed} failed`);
for (const [name, e] of failures) console.log(`\n  ✗ ${name}\n    ${e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n    ') : e}`);
process.exit(failed ? 1 : 0);
})();
