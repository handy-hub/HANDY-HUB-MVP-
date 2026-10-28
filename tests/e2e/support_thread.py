"""SUP-001 browser check: a support reply must not vanish from "Your requests".

Runs the REAL artisan-app/support.html in Chromium. Only the auth guard, the
database container and the notification repository are replaced by in-page
fakes, and the page is served from a fake origin through Playwright routing:
no server, no ports, no emulator, no Firebase — nothing can reach production.

    python -I tests/e2e/support_thread.py                 # this checkout
    python -I tests/e2e/support_thread.py <root> <page>   # e.g. an older support.html

Against 9adc7e2's page (before SUP-001) it fails 11 checks: the open thread
collapses on a ticket snapshot, the support reply disappears, the draft is lost
and reopening never re-reads the messages.
"""
import sys, pathlib, mimetypes
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else pathlib.Path(__file__).resolve().parents[2]
PAGE_FILE = pathlib.Path(sys.argv[2]) if len(sys.argv) > 2 else ROOT / 'artisan-app' / 'support.html'
ORIGIN = 'http://fx.test'

STUBS = {
    '/shared/js/utils/global-app.js': '',
    '/artisan-app/js/utils/artisanAuthGuard.js':
        "export async function requireArtisanAuth(){ return { user:{uid:'A1',email:'a@x.test'}, artisan:{name:'Kofi',email:'a@x.test'} }; }",
    '/shared/js/services/notificationRepository.js': 'export async function createNotification(){ return "n"; }',
    '/shared/js/app/container.js': """
const fx = window.__fx = { ticketCbs: [], ticketErr: null, threadCbs: {}, threadUnsubs: {}, ticketsUnsubbed: false, writes: [] };
export function getAppContainer(){ return { services: { databaseService: {
  subscribeToCollection(c, cond, o, onChange, onErr){ fx.ticketCbs.push(onChange); fx.ticketErr = onErr; return () => { fx.ticketsUnsubbed = true; }; },
  subscribeToSubCollection(c, id, sub, cond, o, onChange){ (fx.threadCbs[id] ||= []).push(onChange); return () => { fx.threadUnsubs[id] = (fx.threadUnsubs[id] || 0) + 1; }; },
  async addDocument(){ return 'new'; },
  async addSubDocument(c, id, s, data){ fx.writes.push(['message', id, data.authorRole, data.body]); return 'm'; },
  async updateDocument(c, id, data){ fx.writes.push(['ticket', id, data.status, data.lastReplyBy]); },
}}}; }
""",
    '/artisan-app/js/artisanFloatingNav.js': '',
    '/artisan-app/js/pwa.js': '',
    '/shared/js/utils/themeManager.js': '',
}

def route(r):
    url = r.request.url
    if not url.startswith(ORIGIN):
        return r.abort()
    p = url[len(ORIGIN):].split('?')[0]
    if p in STUBS:
        return r.fulfill(status=200, content_type='text/javascript', body=STUBS[p])
    f = PAGE_FILE if p == '/artisan-app/support.html' else ROOT / p.lstrip('/')
    if not f.is_file():
        return r.fulfill(status=404, body='')
    ctype = mimetypes.guess_type(str(f))[0] or 'application/octet-stream'
    if f.suffix in ('.js', '.mjs'): ctype = 'text/javascript'
    return r.fulfill(status=200, content_type=ctype, body=f.read_bytes())

T = lambda id, status, at: {'id': id, 'data': {'userId': 'A1', 'subject': 'payment', 'message': f'Withdrawal {id} has not arrived since Monday.', 'status': status, 'createdAt': at}}
M = lambda id, role, body, at: {'id': id, 'data': {'authorRole': role, 'body': body, 'createdAt': at}}

results = []
def check(name, cond, detail=''):
    results.append((name, bool(cond), detail))

import atexit
def _report():
    ok = sum(1 for _, c, _ in results if c)
    for name, c, d in results:
        print(f"  {'PASS' if c else 'FAIL'}  {name}" + ('' if c else f"   [{str(d)[:160]}]"))
    print(f"support-thread browser: {ok} passed, {len(results) - ok} failed" + ('' if _done else '  (scenario aborted early)'))
_done = False
atexit.register(_report)

with sync_playwright() as pw:
    b = pw.chromium.launch()
    page = b.new_page()
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.route('**/*', route)
    page.goto(f'{ORIGIN}/artisan-app/support.html', wait_until='domcontentloaded')
    page.wait_for_function('window.__fx && window.__fx.ticketCbs.length === 1', timeout=10000)

    emit_t = lambda recs: page.evaluate('(r) => window.__fx.ticketCbs.forEach((cb) => cb(r))', recs)
    emit_m = lambda tid, recs: page.evaluate('([t, r]) => (window.__fx.threadCbs[t] || []).forEach((cb) => cb(r))', [tid, recs])
    subs   = lambda tid: page.evaluate('(t) => (window.__fx.threadCbs[t] || []).length', tid)
    row    = lambda tid: f'#tk-{tid}'

    emit_t([T('T1', 'open', '2026-10-28T09:00:00Z'), T('T2', 'answered', '2026-10-27T09:00:00Z')])
    check('two requests render, newest first', page.eval_on_selector_all('#sp-tickets .sp-faq', 'els => els.map(e => e.id)') == ['tk-T1', 'tk-T2'])

    page.click(f'{row("T1")} .sp-faq-q')
    check('opening a request subscribes to its thread once', subs('T1') == 1, subs('T1'))
    emit_m('T1', [M('m1', 'user', 'Any news on this?', '2026-10-28T09:05:00Z')])
    page.fill(f'{row("T1")} textarea', 'half-typed follow-up')
    page.focus(f'{row("T1")} textarea')

    # Support replies: the admin page writes the message, then updates the ticket.
    emit_m('T1', [M('m1', 'user', 'Any news on this?', '2026-10-28T09:05:00Z'),
                  M('m2', 'support', 'Your withdrawal was sent this morning.', '2026-10-28T10:00:00Z')])
    emit_t([T('T1', 'answered', '2026-10-28T09:00:00Z'), T('T2', 'answered', '2026-10-27T09:00:00Z')])

    body_open = page.eval_on_selector(f'{row("T1")} .sp-faq-a', 'e => e.classList.contains("open")')
    thread = page.inner_text(f'{row("T1")} .sp-faq-a')
    check('after the ticket snapshot the thread is still open', body_open)
    check('...and the support reply is still on screen', 'Your withdrawal was sent this morning.' in thread and 'Fidus X support' in thread, thread[:200])
    check('...and the header shows the new status', 'Support replied' in page.inner_text(f'{row("T1")} .sp-faq-q'))
    check('...and the half-typed reply survived', page.input_value(f'{row("T1")} textarea') == 'half-typed follow-up')
    check('...and the reply box kept focus', page.evaluate('(s) => document.activeElement === document.querySelector(s)', f'{row("T1")} textarea'))
    check('...and no second thread listener was added', subs('T1') == 1, subs('T1'))

    page.click(f'{row("T1")} .sp-faq-q'); page.click(f'{row("T1")} .sp-faq-q')
    check('close + reopen: still one listener, thread still populated',
          subs('T1') == 1 and 'Your withdrawal was sent' in page.inner_text(f'{row("T1")} .sp-faq-a'), subs('T1'))

    page.set_default_timeout(3000)
    try:
        page.fill(f'{row("T1")} textarea', 'Thanks, received it.')
        page.click(f'{row("T1")} [data-action="reply"], {row("T1")} .sp-submit')
        page.wait_for_function('window.__fx.writes.length >= 2', timeout=3000)
    except Exception as e:
        check('the reply box is usable after a support reply', False, str(e).split('\n')[0])
    writes = page.evaluate('window.__fx.writes')
    check('sending a reply writes the message then reopens the ticket (unchanged writes)',
          writes[:2] == [['message', 'T1', 'user', 'Thanks, received it.'], ['ticket', 'T1', 'open', 'user']], writes)
    emit_t([T('T1', 'open', '2026-10-28T09:00:00Z'), T('T2', 'answered', '2026-10-27T09:00:00Z')])
    check('own reply: thread stays open after the ticket snapshot',
          page.eval_on_selector(f'{row("T1")} .sp-faq-a', 'e => e.classList.contains("open")'))

    emit_t([T('T1', 'closed', '2026-10-28T09:00:00Z'), T('T2', 'answered', '2026-10-27T09:00:00Z')])
    t1 = page.inner_text(f'{row("T1")} .sp-faq-a')
    check('closing: reply box replaced by the closed note, thread kept',
          'This request is closed' in t1 and page.query_selector(f'{row("T1")} textarea') is None and 'Your withdrawal was sent' in t1)

    page.click(f'{row("T2")} .sp-faq-q')
    emit_t([T('T1', 'closed', '2026-10-28T09:00:00Z')])
    check('a request that leaves the list is removed and its listener released',
          page.query_selector(row('T2')) is None and page.evaluate('window.__fx.threadUnsubs.T2 || 0') == 1)

    page.evaluate('window.__fx.ticketErr(new Error("offline"))')
    check('a failed refresh keeps the requests on screen', page.query_selector(row('T1')) is not None)

    emit_t([])
    check('empty list shows the empty note', page.inner_text('#sp-tickets-state') == 'You have not sent any requests yet.'
          and page.query_selector(row('T1')) is None)

    emit_t([T('T3', 'open', '2026-10-28T11:00:00Z')])
    page.click(f'{row("T3")} .sp-faq-q')
    page.evaluate('window.dispatchEvent(new Event("pagehide"))')
    check('pagehide releases the ticket listener and open thread listeners',
          page.evaluate('window.__fx.ticketsUnsubbed') and page.evaluate('window.__fx.threadUnsubs.T3 || 0') == 1)

    check('no page errors', not errors, errors)
    b.close()

_done = True
sys.exit(0 if all(c for _, c, _ in results) else 1)
