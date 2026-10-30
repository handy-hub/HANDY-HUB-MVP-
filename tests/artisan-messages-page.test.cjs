'use strict';
/**
 * tests/artisan-messages-page.test.cjs — artisan Messages screen findings from
 * the 28 Oct audit, run against the page's own code.
 *
 *   NAV-002  Back from an open conversation left Messages entirely.
 *   MSG-001  Every conversation was named "Customer".
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

console.log('\n── MSG-001 · a thread names the customer, from a first name set at creation ──\n');

/** chatRepository's own code, imports stubbed, over a fake database. */
function chatRepo(existing = null) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'shared', 'js', 'data', 'repositories', 'chatRepository.js'), 'utf8')
        .replace(/\r\n/g, '\n')
        .replace(/^import[\s\S]*?;\n/gm, '')
        .replace(/^export\s+(async\s+)?function\s+/gm, (_m, a) => `${a || ''}function `)
        .replace(/^export\s+const\s+/gm, 'const ');
    const writes = [];
    const db = {
        getDocument: async () => (existing ? { exists: true, data: existing } : { exists: false }),
        setDocument: async (col, id, data) => writes.push({ op: 'set', col, id, data }),
        updateDocument: async (col, id, data) => writes.push({ op: 'update', col, id, data }),
    };
    const noop = () => {};
    // eslint-disable-next-line no-new-func
    const mod = new Function('writeBatch', 'doc', 'collection', 'addDoc', 'increment', 'getDocs', 'query', 'where', 'fsLimit', 'firebaseDb',
        `${src}\nreturn { createChatRepository, firstNameOnly };`)(noop, noop, noop, noop, noop, noop, noop, noop, noop, {});
    return { repo: mod.createChatRepository({ databaseService: db }), firstNameOnly: mod.firstNameOnly, writes };
}

await t('only a first name is ever stored: the first word, at most 40 characters', () => {
    const { firstNameOnly } = chatRepo();
    assert.strictEqual(firstNameOnly('Ama Serwaa Owusu'), 'Ama');
    assert.strictEqual(firstNameOnly('  Kofi  '), 'Kofi');
    assert.strictEqual(firstNameOnly('A'.repeat(60)), 'A'.repeat(40));
    for (const none of ['', '   ', null, undefined]) assert.strictEqual(firstNameOnly(none), null);
});
await t('a NEW chat is created with it', async () => {
    const { repo, writes } = chatRepo(null);
    await repo.getOrCreateDirectChat('cust_1', 'art_1', { bookingId: 'HHB-1', customerFirstName: 'Ama Owusu' });
    assert.strictEqual(writes.length, 1);
    assert.strictEqual(writes[0].op, 'set');
    assert.strictEqual(writes[0].data.customerFirstName, 'Ama');
});
await t('without a name, the chat is created exactly as before (no field)', async () => {
    const { repo, writes } = chatRepo(null);
    await repo.getOrCreateDirectChat('cust_1', 'art_1', {});
    assert.ok(!('customerFirstName' in writes[0].data));
});
await t('an EXISTING chat is never given the name later (no backfill)', async () => {
    const { repo, writes } = chatRepo({ participants: ['art_1', 'cust_1'], bookingId: 'HHB-1' });
    await repo.getOrCreateDirectChat('cust_1', 'art_1', { bookingId: 'HHB-1', customerFirstName: 'Ama' });
    assert.ok(writes.every((w) => !('customerFirstName' in w.data)), JSON.stringify(writes));
});
await t('the artisan inbox and header read the chat\'s name before the "Customer" fallback', () => {
    const src = page.slice(page.indexOf('function withChatName(chatData, info) {'), page.indexOf('async function resolveOther('));
    // eslint-disable-next-line no-new-func
    const withChatName = new Function(`${src}; return withChatName;`)();
    const fallback = { name: 'Customer', photo: null };
    assert.deepStrictEqual(withChatName({ customerFirstName: 'Ama' }, fallback), { name: 'Ama', photo: null });
    assert.deepStrictEqual(withChatName({}, fallback), fallback, 'an older chat keeps the fallback');
    assert.deepStrictEqual(withChatName(null, fallback), fallback);
    assert.match(page, /const info = withChatName\(c\.data, await resolveOther\(o\)\);/);
    assert.match(page, /: withChatName\(chat && chat\.data, await resolveOther\(currentOtherUid\)\);/);
});
await t('both apps pass the name when they create a thread; nothing reads customers/{uid} newly', () => {
    assert.match(page, /customerFirstName: \(bookingCtx && bookingCtx\.customerId === openWith\) \? bookingCtx\.customerFirstName : undefined,/);
    const cust = fs.readFileSync(path.join(__dirname, '..', 'customer-app', 'messages.html'), 'utf8');
    assert.match(cust, /customerFirstName: _bookingCtx\.customerFirstName,/);
    assert.match(cust, /getOrCreateDirectChat\(uid, artisanId, \{ customerFirstName: ownName \}\)/);
    assert.match(cust, /customerRepository\.getById\(uid\)/, 'the customer reads only their OWN profile');
});

console.log(`\nartisan-messages-page: ${passed} passed, ${failed} failed`);
for (const [name, e] of failures) console.log(`\n  ✗ ${name}\n    ${e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n    ') : e}`);
process.exit(failed ? 1 : 0);
})();
