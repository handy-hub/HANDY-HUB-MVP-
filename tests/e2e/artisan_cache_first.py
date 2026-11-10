"""PERF-002 browser check: the CLAUDE.md §1 "return visit" test on five artisan
screens - notifications, performance, reviews, support ("Your requests") and
messages (the inbox).

Each page is opened twice in one browser profile (same localStorage):
  1. first visit   - the data source answers at once; the cache is written.
  2. return visit  - the data source is HELD for 1.5 s. The page must paint the
                     cached content immediately (time to first content is
                     measured), then refresh silently when the answer arrives,
                     without the skeleton coming back.
  3. third visit   - the data source FAILS. The cached content must stay.
It also checks pagehide tears the listener down, and that nothing the brief
forbids reaches localStorage: money (totalEarned), contact data (phone,
address, email), chat previews, notification metadata.

Real pages, real instantView/persistentCache and domain modules; auth, the
container/repositories and side services are in-page fakes. Served from the
fake origin http://fx.test by Playwright routing - every other host is
aborted: no server, port, emulator or network. (Not localhost: devAccess.js
treats localhost as development and would change the auth path.)

    python -I tests/e2e/artisan_cache_first.py          # this checkout
    python -I tests/e2e/artisan_cache_first.py <root>   # e.g. a checkout of 7b30154
"""
import sys, re, json, pathlib, mimetypes, atexit
from playwright.sync_api import sync_playwright
sys.stdout.reconfigure(encoding='utf-8')

ROOT = (pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else pathlib.Path(__file__).resolve().parents[2]).resolve()
ORIGIN = 'http://fx.test'
HOLD_MS = 1500

results, timings = [], []
def check(name, cond, detail=''):
    results.append((name, bool(cond), detail))
_done = False
def _report():
    for page, ms in timings:
        print(f"  time to first content on the return visit · {page}: {ms}")
    ok = sum(1 for _, c, _ in results if c)
    for n, c, d in results:
        print(f"  {'PASS' if c else 'FAIL'}  {n}" + ('' if c else f"   [{str(d)[:180]}]"))
    print(f"artisan cache-first ({ROOT.name}): {ok} passed, {len(results) - ok} failed" + ('' if _done else '  (aborted early)'))
atexit.register(_report)
exec(pathlib.Path(__file__).with_name('fx_theme_hook.py').read_text(encoding='utf-8'))   # FX_THEME=dark + the contrast audit

# ── In-page fakes ────────────────────────────────────────────────────────────
# window.__fx.mode: 'instant' answers at once; 'hold' answers when released
# (HOLD_MS later); 'fail' errors. window.__fx.data is the current dataset.
INIT = r"""
(() => {
  try { localStorage.setItem('hh_last_session_uid', 'A1'); } catch (e) {}   // what the real guard's setSessionUser writes
  let mode = 'instant';
  let data = null;
  try {
    mode = sessionStorage.getItem('fx_mode') || 'instant';
    data = JSON.parse(sessionStorage.getItem('fx_data') || 'null');
  } catch (e) { /* about:blank */ }
  const fx = window.__fx = { mode, data, held: [], subs: 0, unsubs: 0, t0: performance.now() };
  const any = () => new Proxy(function () {}, { get: (t, k) => (k === 'then' ? undefined : k === Symbol.toPrimitive ? () => '' : any()), apply: () => any() });
  fx.any = any;
  const go = (fn) => {
    if (!fx.data) return;   // the throwaway load before a visit's data is set: never answer
    if (fx.mode === 'instant') return setTimeout(fn, 0);
    if (fx.mode === 'hold') return fx.held.push(fn);
  };
  fx.release = () => { const h = fx.held.splice(0); h.forEach((fn) => fn()); };
  fx.listen = (key, onChange, onError) => {
    fx.subs++;
    const deliver = () => onChange(fx.make(key));
    if (fx.mode === 'fail' && fx.data) setTimeout(() => onError && onError(new Error('offline')), 0); else go(deliver);
    fx.redeliver = fx.redeliver || {};
    fx.redeliver[key] = deliver;
    return () => { fx.unsubs++; };
  };
  fx.fetch = (key) => new Promise((res, rej) => {
    if (fx.mode === 'fail' && fx.data) return setTimeout(() => rej(new Error('offline')), 0);
    go(() => res(fx.make(key)));
  });
  fx.make = (key) => JSON.parse(JSON.stringify(fx.data[key]));
})();
"""

DB = """
const fx = window.__fx;
const db = {
  subscribeToCollection(name, cond, opts, onChange, onError) {
    if (name === 'support_tickets') return fx.listen('tickets', onChange, onError);
    return () => {};
  },
  queryWithOptions(name) { return fx.fetch('bookings'); },
  async getDocument(name, id) {
    if (name === 'artisans') { const a = await fx.fetch('artisan'); return { exists: true, id, data: a }; }
    return { exists: false, id, data: null };
  },
  subscribeToSubCollection() { return () => {}; },
  async addDocument() { return 'x'; }, async addSubDocument() { return 'x'; }, async updateDocument() {},
};
const chatRepository = new Proxy({
  subscribeByUser(uid, onChange, onError) { return fx.listen('chats', onChange, onError); },
  subscribeToMessages() { return () => {}; },
  markChatRead: async () => {}, sendMessage: async () => {}, getOrCreateDirectChat: async () => 'x',
}, { get: (t, k) => (k in t ? t[k] : fx.any()) });
const customerRepository = { async getById(id) { const c = await fx.fetch('customer'); return { exists: true, data: c }; } };
export function getAppContainer() {
  return {
    services: new Proxy({ databaseService: db }, { get: (t, k) => (k in t ? t[k] : fx.any()) }),
    repositories: new Proxy({ chatRepository, customerRepository }, { get: (t, k) => (k in t ? t[k] : fx.any()) }),
  };
}
"""

STUBS = {
    '/shared/js/app/container.js': DB,
    '/artisan-app/js/utils/artisanAuthGuard.js': """
const A = { uid: 'A1', id: 'A1', name: 'Kofi', email: 'kofi@x.test', userType: 'artisan', status: 'active', verificationStatus: 'approved' };
export async function requireArtisanAuth() { return { user: { uid: 'A1', email: 'kofi@x.test' }, artisan: A }; }
export function subscribeToArtisanAuthState(cb) { setTimeout(() => cb({ uid: 'A1' }), 0); return () => {}; }
export const canAcceptJobs = () => true;
""",
    '/shared/js/services/notificationRepository.js': """
const fx = window.__fx;
export function subscribeToUserNotifications(uid, onChange, onError) {
  return fx.listen('notifs', (list) => onChange(list.map((n) => ({ ...n, createdAt: new Date(n.createdAt) }))), onError);
}
export async function markNotificationRead() {} export async function markAllNotificationsRead() {}
export async function deleteNotification() {} export async function createNotification() { return 'n'; }
export function subscribeToUnreadCount() { return () => {}; }
""",
    '/shared/js/utils/global-app.js': '', '/artisan-app/js/artisanFloatingNav.js': '', '/artisan-app/js/pwa.js': '',
}

def route(r):
    url = r.request.url
    if not url.startswith(ORIGIN): return r.abort()
    p = url[len(ORIGIN):].split('?')[0]
    if p in STUBS: return r.fulfill(status=200, content_type='text/javascript', body=STUBS[p])
    f = ROOT / p.lstrip('/')
    if not f.is_file(): return r.fulfill(status=404, body='')
    ctype = 'text/javascript' if f.suffix in ('.js', '.mjs') else (mimetypes.guess_type(str(f))[0] or 'application/octet-stream')
    return r.fulfill(status=200, content_type=ctype, body=f.read_bytes())

# ── Data: version 1 (first visit) and version 2 (the refresh) ───────────────
NOW = '2026-10-28T09:00:00.000Z'
def dataset(v):
    t = 'Welcome to Fidus X' + (' (updated)' if v == 2 else '')
    bookings = [
        {'id': 'b1', 'data': {'status': 'completed', 'createdAt': NOW, 'rating': 5, 'reviewedAt': NOW, 'review': 'Great work',
                              'customerName': 'Ama Mensah', 'serviceType': 'plumbing', 'price': 480, 'jobQuote': 480,
                              'address': '12 Secret Street', 'customerPhone': '+233555000111'}},
    ]
    if v == 2:
        bookings.append({'id': 'b2', 'data': {'status': 'completed', 'createdAt': NOW, 'rating': 4, 'reviewedAt': NOW,
                                              'review': 'Second review', 'customerName': 'Yaw', 'serviceType': 'electrical'}})
    return {
        'notifs': [{'id': 'n1', 'type': 'System', 'title': t, 'message': 'Your account is ready.', 'isRead': False,
                    'actionUrl': None, 'metadata': {'secretMeta': 'META-SECRET'}, 'senderId': 'S9', 'receiverId': 'A1',
                    'readAt': None, 'createdAt': NOW},
                   # A chat notification: its text is the other person's words (here with a phone number).
                   {'id': 'n2', 'type': 'Messages', 'title': 'New message from Ama', 'message': 'Call me on 0555000111',
                    'isRead': False, 'actionUrl': 'messages.html?chatId=A1_C1', 'metadata': {}, 'senderId': 'C1',
                    'receiverId': 'A1', 'readAt': None, 'createdAt': NOW}],
        'bookings': bookings,
        'artisan': {'totalEarned': 1234.5, 'responseStats': {'sufficient': True, 'rate': 0.9, 'responded': 9, 'counted': 10, 'windowDays': 90}},
        'tickets': [{'id': 'T1', 'data': {'subject': 'payment', 'message': 'My withdrawal has not arrived since Monday.',
                     'status': 'answered' if v == 2 else 'open', 'createdAt': NOW, 'updatedAt': NOW,
                     'userEmail': 'kofi@x.test', 'userName': 'Kofi Boateng', 'userId': 'A1'}}],
        'chats': [{'id': 'A1_C1', 'data': {'participants': ['A1', 'C1'], 'lastMessage': 'Call me on 0555000111',
                   'lastMessageAt': NOW, 'unreadCount': {'A1': 3 if v == 2 else 2}}}],
        'customer': {'fullName': 'Ama Mensah', 'phone': '+233555000111'},
    }

PAGES = [
    # name, path, content selector, text seen after the refresh (version 2), skeleton selector
    ('notifications', '/artisan-app/notifications.html', '#notif-list .notif-item', '(updated)', '#notif-loading'),
    # Phase 4: performance and reviews are one screen (performance.html / reviews.html forward).
    ('reputation',    '/artisan-app/reputation.html',    '#rep-body [data-figure="rating"]', 'Second review', '#rep-body [data-skeleton]'),
    ('support',       '/artisan-app/support.html',       '#sp-tickets [id^="tk-"]', 'Support replied', None),
    ('messages',      '/artisan-app/messages.html',      '#ms-list .ms-row', None, '#ms-list .ms-skel'),
]
FORBIDDEN = ['+233555000111', '0555000111', '12 Secret Street', 'kofi@x.test', 'Kofi Boateng', 'META-SECRET', '"totalEarned"', '1234.5', '"price"', 'Call me on']

def visible(pg, sel):
    return pg.evaluate("(s) => { const e = document.querySelector(s); return !!e && !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length); }", sel)

with sync_playwright() as pw:
    b = pw.chromium.launch()
    for name, path, content, refreshed_text, skel in PAGES:
        ctx = b.new_context(viewport={'width': 430, 'height': 900})
        ctx.add_init_script(INIT)
        pg = ctx.new_page(); pg.set_default_timeout(6000)
        errors = []
        pg.on('pageerror', lambda e: errors.append(str(e)))
        pg.route('**/*', route)
        def visit(mode, v):
            # The mode must be in sessionStorage before the page's scripts run:
            # open the page, set it, then load it again (the measured load).
            pg.goto(f'{ORIGIN}{path}', wait_until='commit')
            pg.evaluate("([m, d]) => { sessionStorage.setItem('fx_mode', m); sessionStorage.setItem('fx_data', JSON.stringify(d)); }", [mode, dataset(v)])
            pg.reload(wait_until='commit')

        # 1. First visit: answers at once.
        visit('instant', 1)
        try:
            pg.wait_for_selector(content, state='attached')
            first_ok = True
        except Exception:
            first_ok = False
        check(f'{name}: first visit shows the content', first_ok)
        pg.wait_for_timeout(300)

        # 2. Return visit: the data source is held for HOLD_MS.
        visit('hold', 2)
        t_first, from_cache = None, False
        try:
            pg.wait_for_selector(content, state='attached', timeout=HOLD_MS - 300)
            t_first, from_cache = round(pg.evaluate('performance.now()')), True
        except Exception:
            pass
        skel_hidden = (skel is None) or not visible(pg, skel)
        check(f'{name}: the return visit paints from cache before the network answers', from_cache, t_first)
        check(f'{name}: no skeleton while cached content is shown', from_cache and skel_hidden)
        now = pg.evaluate('performance.now()')
        if now < HOLD_MS: pg.wait_for_timeout(HOLD_MS - now)
        # Release until nothing is held: an answer can start another request
        # (the inbox resolves each customer's name after the chat list).
        for _ in range(5):
            pg.evaluate('window.__fx.release()')
            pg.wait_for_timeout(150)
        if not from_cache:
            try:
                pg.wait_for_selector(content, state='attached', timeout=3000)
                t_first = round(pg.evaluate('performance.now()'))
            except Exception:
                t_first = None
        timings.append((name, f"{t_first} ms ({'from cache' if from_cache else 'after the network'}; network held {HOLD_MS} ms)"))
        body = pg.evaluate('document.body.innerText')
        if name == 'performance':
            refreshed = '2' in pg.evaluate("[...document.querySelectorAll('.pf-sc-value')].map(e => e.textContent).join('|')")
        elif name == 'messages':
            refreshed = 'Call me on 0555000111' in body   # the preview arrives with the LIVE list
        else:
            refreshed = refreshed_text in body
        if name == 'notifications':
            check('notifications: the live list shows the chat text', 'Call me on 0555000111' in body)
        check(f'{name}: the refresh arrives silently (content updated, skeleton not back)',
              refreshed and ((skel is None) or not visible(pg, skel)), body[:160])

        # What reached localStorage.
        stored = pg.evaluate("() => Object.keys(localStorage).map(k => k + '=' + localStorage.getItem(k)).join('\\n')")
        leaks = [f for f in FORBIDDEN if f in stored]
        check(f'{name}: the cache holds no money, contact data, previews or metadata', not leaks, leaks)
        if name == 'performance':
            earned = pg.evaluate("[...document.querySelectorAll('.pf-score-card')].find(c => /Earned/.test(c.textContent))?.querySelector('.pf-sc-value')?.textContent")
            check('performance: Earned shows the live figure once the server answers', earned and '1' in earned, earned)

        # 3. Third visit: the refresh fails; the cached content stays.
        visit('fail', 2)
        pg.wait_for_timeout(700)
        check(f'{name}: a failed refresh keeps the cached content', pg.query_selector(content) is not None,
              pg.evaluate('document.body.innerText')[:160])
        if name == 'performance':
            earned = pg.evaluate("[...document.querySelectorAll('.pf-score-card')].find(c => /Earned/.test(c.textContent))?.querySelector('.pf-sc-value')?.textContent")
            check('performance: on a cached paint Earned is "—" (money is never cached)', earned == '—', earned)
        if name == 'notifications':
            row = pg.evaluate("""() => { const r = document.getElementById('ni-n2');
                return r && { title: r.querySelector('.notif-item-title')?.textContent, msg: !!r.querySelector('.notif-item-msg') }; }""")
            check('notifications: a cached chat notification shows its title alone (no chat text cached)',
                  row and row['title'] == 'New message from Ama' and row['msg'] is False, row)
        if name == 'messages':
            prev = pg.evaluate("document.querySelector('#ms-list .ms-row-last')?.textContent")
            check('messages: a cached row shows no preview (never cached)', prev == '', prev)

        # pagehide tears the listener down (subscription screens).
        if name in ('notifications', 'support', 'messages'):
            visit('instant', 2)
            pg.wait_for_selector(content, state='attached')
            before = pg.evaluate('window.__fx.unsubs')
            pg.evaluate("window.dispatchEvent(new Event('pagehide'))")
            check(f'{name}: pagehide releases the listener', pg.evaluate('window.__fx.unsubs') > before)
        check(f'{name}: no page errors', not errors, errors[:2])
        ctx.close()
    b.close()

_done = True
sys.exit(0 if all(c for _, c, _ in results) else 1)
