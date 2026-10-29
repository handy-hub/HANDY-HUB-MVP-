/**
 * support-thread.test.cjs — SUP-001: a support reply must not vanish.
 *
 * artisan-app/support.html rebuilt "Your requests" with innerHTML on every
 * ticket snapshot. Every reply (support's or the artisan's) updates the ticket,
 * so the open conversation collapsed and came back empty — and stayed empty,
 * because toggleTicket saw a listener already registered and never asked for
 * the messages again. A half-typed reply was wiped too.
 *
 * The page's module needs auth and Firestore, so these checks read its source
 * and pin the structure that prevents the bug: rows are keyed and updated in
 * place, a thread renders into the element captured with its row, one listener
 * per ticket, the reply box is rebuilt only when the request closes or reopens,
 * nothing is torn down on a refresh error, and pagehide releases everything.
 * Behaviour was verified in Chromium against the real page (17/17; the old page
 * fails 11 of the same checks) — see the SUP-001 report.
 */
'use strict';

require('./support/no-production.cjs');   // must stay the first statement (npm run lint:tests)
const assert = require('assert');
const path   = require('path');
const fs     = require('fs');

const html = fs.readFileSync(path.join(__dirname, '..', 'artisan-app', 'support.html'), 'utf8');
const code = html.replace(/^\s*\/\/.*$/gm, '');   // comments describing the old bug don't count

/** Source of a function declared in the page, up to the next top-level declaration. */
function fn(name) {
    const start = code.search(new RegExp(`^(async )?function ${name}\\(`, 'm'));
    assert.ok(start >= 0, `function ${name} not found`);
    const rest = code.slice(start + 1);
    const end = rest.search(/^(async function |function |const |let |window\.|ticketsEl\.addEventListener)/m);
    return code.slice(start, end < 0 ? undefined : start + 1 + end);
}

const failures = [];
let passed = 0;
function test(name, f) {
    try { f(); passed++; } catch (e) { failures.push([name, e]); }
}

test('the request list is never rebuilt wholesale', () => {
    assert.doesNotMatch(code, /ticketsEl\.innerHTML\s*=/, 'ticketsEl.innerHTML is assigned');
});

test('rows are keyed by ticket id and built only once', () => {
    const render = fn('renderTickets');
    assert.match(render, /let row = _rows\.get\(t\.id\);/);
    assert.match(render, /if \(!row\) \{ row = buildTicketRow\(t\); _rows\.set\(t\.id, row\); \}/);
    assert.match(render, /updateTicketRow\(row, t\);/);
    assert.doesNotMatch(render, /innerHTML/);
});

test('a row is moved only when out of place (moving it would blur the reply box)', () => {
    const render = fn('renderTickets');
    assert.match(render, /if \(at !== row\) ticketsEl\.insertBefore\(row, at \|\| null\);/);
    assert.doesNotMatch(render, /appendChild/);
});

test('an update changes the header, and the reply box only when the request closes or reopens', () => {
    const upd = fn('updateTicketRow');
    assert.match(upd, /\.tk-head'\)\.textContent = /);
    assert.match(upd, /if \(row\.dataset\.closed === closed\) return;/);
    assert.ok(upd.indexOf('row.dataset.closed === closed') < upd.indexOf(".tk-compose').innerHTML"),
        'the reply box is rebuilt before the closed-state check');
    assert.doesNotMatch(upd, /\.sp-faq-a'\)|classList/, 'an update touches the open state');
});

test('one thread listener per ticket, rendering into the element captured with its row', () => {
    const toggle = fn('toggleTicket');
    assert.match(toggle, /if \(open && !_threadUnsubs\.has\(id\)\)/);
    assert.match(toggle, /const threadEl = row\.querySelector\('\.tk-thread'\);/);
    assert.match(toggle, /threadEl\.innerHTML = /);
    assert.doesNotMatch(toggle, /getElementById/, 'the thread is looked up by id at callback time');
    assert.strictEqual((code.match(/subscribeToSubCollection\(/g) || []).length, 1);
});

test('a request that leaves the list releases its thread listener', () => {
    const drop = fn('dropTicketRow');
    assert.match(drop, /_threadUnsubs\.get\(id\)/);
    assert.match(drop, /_threadUnsubs\.delete\(id\)/);
    assert.match(fn('renderTickets'), /\.filter\(\(id\) => !live\.has\(id\)\)\.forEach\(dropTicketRow\)/);
});

test('no handler string is built from ticket data', () => {
    assert.doesNotMatch(code, /onclick="(toggleTicket|replyTicket)/);
    assert.doesNotMatch(code, /window\.(toggleTicket|replyTicket)\s*=/);
    assert.match(code, /ticketsEl\.addEventListener\('click'/);
});

test('a reply is written exactly as before: the message, then the ticket back to open', () => {
    const reply = fn('replyTicket');
    const msg = reply.indexOf("addSubDocument('support_tickets', id, 'messages'");
    const upd = reply.indexOf("updateDocument('support_tickets', id");
    assert.ok(msg > 0 && upd > msg, 'message then ticket update');
    assert.match(reply, /authorId: user\.uid, authorRole: 'user', body: ta\.value\.trim\(\), createdAt: now,/);
    assert.match(reply, /status: TICKET_STATUS\.OPEN, lastReplyAt: now, lastReplyBy: 'user', updatedAt: now,/);
});

test('a failed refresh does not blank requests already on screen', () => {
    // PERF-002: the list is a mountInstantView; its onError keeps content on screen.
    const view = code.slice(code.indexOf("mountInstantView({\n  key: 'artisan-support-requests'"));
    assert.ok(view.length > 0 && code.includes("key: 'artisan-support-requests'"), 'the requests view');
    const onErr = view.slice(view.indexOf('onError: (_err, { hasContent }) => {'), view.indexOf("window.addEventListener('pagehide'"));
    assert.match(onErr, /^onError: \(_err, \{ hasContent \}\) => \{\s*if \(hasContent\) return;/);
    assert.doesNotMatch(onErr, /innerHTML/);
});

test('pagehide releases the request listener and every thread listener', () => {
    const ph = code.slice(code.indexOf("window.addEventListener('pagehide'"));
    assert.match(ph, /_ticketsView\.destroy\(\)/);
    assert.match(ph, /_threadUnsubs\.forEach\(\(u\) => \{ try \{ u\(\); \} catch \(_\) \{\} \}\);/);
    assert.match(ph, /_threadUnsubs\.clear\(\);/);
});

for (const [name, e] of failures) console.error(`  FAIL  ${name}\n        ${e.message.split('\n')[0]}`);
console.log(`support-thread: ${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
