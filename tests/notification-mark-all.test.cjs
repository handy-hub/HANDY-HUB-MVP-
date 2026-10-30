'use strict';
/**
 * tests/notification-mark-all.test.cjs — "Mark all read" is one batched write
 * (28 Oct audit NOTIF-004).
 *
 * Up to 200 separate updates used to fly at once; leaving the page cut them off
 * part-way, so some notifications stayed unread. The repository's own
 * markAllNotificationsRead runs here with its imports stubbed.
 */
require('./support/no-production.cjs');   // must stay the first statement (npm run lint:tests)

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

let passed = 0, failed = 0;
const failures = [];
async function t(name, fn) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { failed++; failures.push([name, e]); console.log(`  ✗ ${name}`); }
}

const SRC = fs.readFileSync(path.join(__dirname, '..', 'shared', 'js', 'services', 'notificationRepository.js'), 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/^import[\s\S]*?;\n/gm, '')                       // stubs are injected below
    .replace(/^export\s+(async\s+)?function\s+/gm, (_m, a) => `${a || ''}function `)
    .replace(/^export\s+const\s+/gm, 'const ');

/** Load the repository with a fake database and a fake batch. */
function load({ unread, batchFails = false }) {
    const log = { batches: [], single: [] };
    const db = {
        queryWithOptions: async () => unread.map((id) => ({ id, data: { isRead: false } })),
        updateDocument:   async (col, id, fields) => { log.single.push({ col, id, fields }); },
    };
    const writeBatch = () => {
        const ops = [];
        return {
            update: (ref, fields) => ops.push({ ref, fields }),
            commit: async () => { if (batchFails) throw new Error('PERMISSION_DENIED'); log.batches.push(ops); },
        };
    };
    const doc = (_db, col, id) => `${col}/${id}`;
    // eslint-disable-next-line no-new-func
    const api = new Function('getAppContainer', 'writeBatch', 'doc', 'firebaseDb', `${SRC}\nreturn { markAllNotificationsRead };`)(
        () => ({ services: { databaseService: db, authService: {} } }), writeBatch, doc, {});
    return { api, log };
}

(async () => {
console.log('\n── NOTIF-004 · "Mark all read" is one write, not two hundred ──\n');

await t('every unread notification is marked in ONE batched commit', async () => {
    const ids = Array.from({ length: 37 }, (_, i) => `n${i}`);
    const { api, log } = load({ unread: ids });
    await api.markAllNotificationsRead('art_1');
    assert.strictEqual(log.batches.length, 1, 'one commit');
    assert.strictEqual(log.batches[0].length, 37);
    assert.deepStrictEqual(log.batches[0].map((o) => o.ref), ids.map((id) => `customer_notifications/${id}`));
    for (const o of log.batches[0]) {
        assert.deepStrictEqual(Object.keys(o.fields).sort(), ['isRead', 'readAt'], 'the same two fields the rules allow');
        assert.strictEqual(o.fields.isRead, true);
    }
    assert.strictEqual(log.single.length, 0, 'no separate writes');
});
await t('if the batch is refused, each is still marked separately', async () => {
    const { api, log } = load({ unread: ['a', 'b', 'c'], batchFails: true });
    await api.markAllNotificationsRead('art_1');
    assert.strictEqual(log.batches.length, 0);
    assert.deepStrictEqual(log.single.map((w) => w.id), ['a', 'b', 'c']);
});
await t('nothing unread → nothing written', async () => {
    const { api, log } = load({ unread: [] });
    await api.markAllNotificationsRead('art_1');
    assert.strictEqual(log.batches.length + log.single.length, 0);
});

console.log(`\nnotification-mark-all: ${passed} passed, ${failed} failed`);
for (const [name, e] of failures) console.log(`\n  ✗ ${name}\n    ${e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n    ') : e}`);
process.exit(failed ? 1 : 0);
})();
