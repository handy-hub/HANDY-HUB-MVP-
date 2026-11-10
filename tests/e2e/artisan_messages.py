"""Messages on the artisan design system (Phase 6): the inbox and an open
conversation, in a browser.

The real artisan-app/messages.html with its real stylesheets, instantView and
fx modules; auth and the container (chat repository, bookings) are in-page
fakes. Served from the fake origin http://fx.test by Playwright routing - every
other host is aborted: no server, port, emulator or network.

What it shows:
  - the inbox is a list of real buttons with the four-tab bar (Jobs current);
  - a thread opens over it as a modal layer: the inbox is inert, Back and the
    phone's Back return to the inbox, a reload reopens the thread;
  - the thread header is on top (MSG-UI-001), measured against the real CSS;
  - a message is sent once with the artisan's uid; a failed send gives the
    text back and says so;
  - the other person's words are text, never markup;
  - a notification link (?chatId=) and a job link (?bookingId=) open the thread;
  - nothing overflows at 360 px and every control is at least 44 px;
  - with FX_THEME=dark the same run happens in the dark theme, and the shared
    hook measures the contrast of everything drawn.

    python -I tests/e2e/artisan_messages.py
    FX_THEME=dark python -I tests/e2e/artisan_messages.py
    FX_SHOTS=<dir> python -I tests/e2e/artisan_messages.py     # also save screenshots
"""
import sys, os, json, pathlib, mimetypes, atexit
from playwright.sync_api import sync_playwright
sys.stdout.reconfigure(encoding='utf-8')

ROOT = pathlib.Path(__file__).resolve().parents[2]
ORIGIN = 'http://fx.test'
PAGE = f'{ORIGIN}/artisan-app/messages.html'
SHOTS = os.environ.get('FX_SHOTS')

results = []
def check(name, cond, detail=''):
    results.append((name, bool(cond), detail))
_done = False
def _report():
    ok = sum(1 for _, c, _ in results if c)
    for n, c, d in results:
        print(f"  {'PASS' if c else 'FAIL'}  {n}" + ('' if c else f"   [{str(d)[:260]}]"))
    print(f"artisan-messages browser: {ok} passed, {len(results) - ok} failed" + ('' if _done else '  (aborted early)'))
atexit.register(_report)
exec(pathlib.Path(__file__).with_name('fx_theme_hook.py').read_text(encoding='utf-8'))   # FX_THEME=dark + the contrast audit

INIT = r"""
(() => {
  try { localStorage.setItem('hh_last_session_uid', 'A1'); } catch (e) {}
  let cfg = {};
  try { cfg = JSON.parse(sessionStorage.getItem('fx_cfg') || '{}'); } catch (e) {}
  window.__fx = { cfg, sent: [], read: [], created: [], msgSubs: 0, msgUnsubs: 0, push: null };
})();
"""

CONTAINER = r"""
const fx = window.__fx;
const NOW = Date.now();
const iso = (minsAgo) => new Date(NOW - minsAgo * 60000).toISOString();
const CHATS = fx.cfg.empty ? [] : [
  { id: 'A1_C1', data: { participants: ['A1', 'C1'], customerFirstName: 'Ama', lastMessage: 'Is 10 o’clock still fine? I will be at the gate with the blue door, call when close', lastMessageAt: iso(4), unreadCount: { A1: 2 } } },
  { id: 'A1_C2', data: { participants: ['A1', 'C2'], lastMessage: 'Thank you', lastMessageAt: iso(60 * 30), unreadCount: { A1: 0 } } },
  { id: 'A1_C3', data: { participants: ['C3', 'A1'], customerFirstName: 'Abdul-Rahman', lastMessage: '<img src=x onerror="window.__xss=1">', lastMessageAt: iso(60 * 50), unreadCount: { A1: 120 } } },
];
const THREADS = {
  A1_C1: [
    { data: { senderId: 'C1', text: 'Good morning. Is 10 o’clock still fine?', createdAt: iso(9) } },
    { data: { senderId: 'A1', text: 'Yes. I am on my way.\nI will call at the gate.', createdAt: iso(6) } },
    { data: { senderId: 'C1', text: '<b>bold</b> <img src=x onerror="window.__xss=1"> ' + 'long'.repeat(40), createdAt: iso(4) } },
  ],
};
const chatRepository = {
  subscribeByUser(uid, onChange, onError) {
    if (fx.cfg.fail) { setTimeout(() => onError(new Error('offline')), 0); return () => {}; }
    setTimeout(() => onChange(JSON.parse(JSON.stringify(CHATS))), 0);
    return () => {};
  },
  subscribeToMessages(chatId, onChange) {
    fx.msgSubs++;
    fx.push = (m) => { (THREADS[chatId] = THREADS[chatId] || []).push(m); onChange(THREADS[chatId].slice()); };
    setTimeout(() => onChange((THREADS[chatId] || []).slice()), 0);
    return () => { fx.msgUnsubs++; };
  },
  async markChatRead(chatId, uid) { fx.read.push([chatId, uid]); },
  async sendMessage(chatId, msg) {
    fx.sent.push([chatId, msg]);
    if (fx.failSend) throw new Error('unavailable');
    fx.push && fx.push({ data: { senderId: msg.senderId, text: msg.text, createdAt: new Date().toISOString() } });
  },
  async getOrCreateDirectChat(a, b, opts) { fx.created.push([a, b, opts]); return 'A1_C1'; },
};
const customerRepository = { async getById() { throw new Error('permission-denied'); } };   // an artisan may not read customers/{uid}
const databaseService = {
  async getDocument(name, id) {
    if (name === 'bookings' && id === 'HHB-1') return { exists: true, id, data: { customerId: 'C1', customerFirstName: 'Ama', serviceType: 'Plumbing repair and installation' } };
    return { exists: false, id, data: null };
  },
};
export function getAppContainer() { return { services: { databaseService }, repositories: { chatRepository, customerRepository } }; }
"""

STUBS = {
    '/shared/js/app/container.js': CONTAINER,
    '/artisan-app/js/utils/artisanAuthGuard.js': """
const A = { uid: 'A1', id: 'A1', name: 'Kofi', userType: 'artisan', status: 'active', verificationStatus: 'approved' };
export async function requireArtisanAuth() { return { user: { uid: 'A1' }, artisan: A }; }
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

def shot(pg, name):
    if not SHOTS: return
    pathlib.Path(SHOTS).mkdir(parents=True, exist_ok=True)
    pg.screenshot(path=str(pathlib.Path(SHOTS) / f'messages-{name}.png'))

def open_page(ctx, query='', cfg=None):
    pg = ctx.new_page()
    errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.on('console', lambda m: errs.append(m.text) if m.type == 'error' and 'Failed to load resource' not in m.text and '[messages]' not in m.text else None)
    if cfg is not None:
        pg.goto(PAGE, wait_until='commit')
        pg.evaluate("(c) => sessionStorage.setItem('fx_cfg', JSON.stringify(c))", cfg)
    pg.goto(PAGE + query, wait_until='domcontentloaded')
    return pg, errs

SMALL_JS = r"""() => {
  const out = [];
  const scope = document.getElementById('ms-chat').classList.contains('open') ? document.getElementById('ms-chat') : document.getElementById('ms-shell');
  for (const el of scope.querySelectorAll('button, a[href], textarea, input')) {
    if (el.closest('[hidden], .fx-skip')) continue;
    const r = el.getBoundingClientRect(); if (!r.width || !r.height) continue;
    let w = r.width, h = r.height;
    const a = getComputedStyle(el, '::after');
    if (a.content !== 'none' && a.position === 'absolute') { const n = (v) => (isNaN(parseFloat(v)) ? 0 : parseFloat(v)); h = r.height - n(a.top) - n(a.bottom); w = r.width - n(a.left) - n(a.right); }
    if (w < 43.5 || h < 43.5) out.push(`${el.id || el.className} ${Math.round(w)}x${Math.round(h)}`);
  }
  return out;
}"""
OVERFLOW_JS = "() => document.documentElement.scrollWidth - window.innerWidth"
HIT_JS = r"""(id) => { const el = document.getElementById(id); const r = el.getBoundingClientRect(); const h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return h ? ((h.closest('[id]') || h).id || h.className) : null; }"""
BUBBLES_JS = "() => [...document.querySelectorAll('#ms-msgs .ms-bubble')].map((b) => ({ me: b.classList.contains('me'), text: b.querySelector('.fx-msg__text').textContent, imgs: b.querySelectorAll('img, b').length, w: b.getBoundingClientRect().width, box: document.getElementById('ms-msgs').clientWidth }))"

with sync_playwright() as p:
    b = p.chromium.launch()

    for width in (360, 390):
        ctx = b.new_context(viewport={'width': width, 'height': 760})
        ctx.add_init_script(INIT)
        ctx.route('**/*', route)
        pg, errs = open_page(ctx)
        pg.wait_for_selector('#ms-list .ms-row')
        pg.wait_for_function("() => document.querySelector('#ms-list .ms-row-last').textContent.trim() !== ''")
        w = f'{width}px'

        rows = pg.evaluate("""() => [...document.querySelectorAll('#ms-list .ms-row')].map((r) => ({
            tag: r.tagName, type: r.type, name: r.querySelector('.fx-row__title').textContent.trim(),
            last: r.querySelector('.ms-row-last').textContent, lastW: r.querySelector('.ms-row-last').scrollWidth > r.querySelector('.ms-row-last').clientWidth,
            h: r.getBoundingClientRect().height, time: r.querySelector('.fx-msg__time').textContent.trim(),
            unread: r.querySelector('.fx-chip') ? r.querySelector('.fx-chip').innerText.trim() : null,
            unreadSr: r.querySelector('.fx-chip .fx-sr') ? r.querySelector('.fx-chip .fx-sr').textContent : null,
            imgs: r.querySelectorAll('img').length }))""")
        check(f'{w}: the inbox lists every conversation as a real button', len(rows) == 3 and all(r['tag'] == 'BUTTON' and r['type'] == 'button' for r in rows), rows)
        check(f'{w}: a thread is named from the chat itself, and falls back to "Customer"', [r['name'] for r in rows] == ['Ama', 'Customer', 'Abdul-Rahman'], [r['name'] for r in rows])
        check(f'{w}: a long preview stays on one line and is cut, not wrapped', rows[0]['lastW'] and rows[0]['h'] < 90, rows[0])
        check(f'{w}: unread counts are shown, capped at 99+, and said in words to a screen reader',
              rows[0]['unreadSr'] == '2 unread' and rows[1]['unread'] is None and rows[2]['unreadSr'] == '99+ unread', [(r['unread'], r['unreadSr']) for r in rows])
        check(f'{w}: a preview that looks like markup is shown as text', rows[2]['imgs'] == 0 and '<img' in rows[2]['last'] and not pg.evaluate('window.__xss'), rows[2])
        tab = pg.evaluate("() => { const t = document.querySelectorAll('#tabbar a, #tabbar button'); const cur = document.querySelector('#tabbar [aria-current=\"page\"]'); return { n: t.length, cur: cur ? cur.textContent.trim() : null }; }")
        check(f'{w}: the four-tab bar is there, with Jobs current', tab['n'] == 4 and tab['cur'] and tab['cur'].startswith('Jobs'), tab)
        check(f'{w}: nothing overflows the screen (inbox)', pg.evaluate(OVERFLOW_JS) <= 0, pg.evaluate(OVERFLOW_JS))
        check(f'{w}: every inbox control is at least 44 px', pg.evaluate(SMALL_JS) == [], pg.evaluate(SMALL_JS))
        check(f'{w}: one h1, and the skeleton is gone', pg.evaluate("document.querySelectorAll('h1').length") == 1 and pg.evaluate("document.querySelectorAll('.ms-skel').length") == 0)
        shot(pg, f'inbox-{width}')

        # ── Open a thread ──
        pg.click('#ms-list .ms-row >> nth=0')
        pg.wait_for_selector('#ms-msgs .ms-bubble')
        st = pg.evaluate("""() => ({ open: document.getElementById('ms-chat').classList.contains('open'), inert: document.getElementById('ms-shell').inert,
            name: document.getElementById('ms-chat-name').textContent, url: location.search, role: document.getElementById('ms-chat').getAttribute('role'),
            focusIn: document.getElementById('ms-chat').contains(document.activeElement), kb: document.activeElement.id })""")
        check(f'{w}: a tap opens the conversation as a layer over the inbox, named', st['open'] and st['name'] == 'Ama' and st['role'] == 'dialog', st)
        check(f'{w}: the inbox under it is inert and focus is in the conversation (without raising the keyboard)', st['inert'] and st['focusIn'] and st['kb'] != 'ms-input', st)
        check(f'{w}: the open conversation is a history entry (?chat=)', st['url'] == '?chat=A1_C1', st['url'])
        check(f'{w}: opening it marks it read for this artisan', pg.evaluate('window.__fx.read') == [['A1_C1', 'A1']], pg.evaluate('window.__fx.read'))
        check(f'{w}: the thread header is on top: a tap on its Back hits its Back (MSG-UI-001)', pg.evaluate(HIT_JS, 'ms-chat-back') == 'ms-chat-back', pg.evaluate(HIT_JS, 'ms-chat-back'))
        check(f'{w}: the inbox Back is covered by the conversation', pg.evaluate("() => { const r = document.getElementById('ms-back').getBoundingClientRect(); const h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!h && document.getElementById('ms-chat').contains(h); }"))
        bub = pg.evaluate(BUBBLES_JS)
        check(f'{w}: both sides of the conversation are drawn, mine and theirs', [x['me'] for x in bub] == [False, True, False], bub)
        check(f'{w}: a line break typed in a message is kept', bub[1]['text'] == 'Yes. I am on my way.\nI will call at the gate.' and pg.evaluate("getComputedStyle(document.querySelector('#ms-msgs .me .fx-msg__text')).whiteSpace") == 'pre-wrap', bub[1])
        check(f'{w}: the other person\'s words are text, never markup', bub[2]['imgs'] == 0 and '<b>bold</b>' in bub[2]['text'] and not pg.evaluate('window.__xss'), bub[2])
        check(f'{w}: a long unbroken message wraps inside its bubble', bub[2]['w'] <= bub[2]['box'] and pg.evaluate(OVERFLOW_JS) <= 0, bub[2])
        check(f'{w}: every conversation control is at least 44 px', pg.evaluate(SMALL_JS) == [], pg.evaluate(SMALL_JS))
        check(f'{w}: the message box has a name for a screen reader', pg.evaluate("() => { const l = document.querySelector('label[for=ms-input]'); return !!l && l.textContent.trim() === 'Message'; }"))
        shot(pg, f'thread-{width}')
        pg.hover('#ms-send')
        pg.wait_for_timeout(200)
        hov = pg.evaluate("""() => { const tok = (n) => { const p = document.createElement('i'); p.style.color = 'var(' + n + ')'; document.body.appendChild(p); const c = getComputedStyle(p).color; p.remove(); return c; };
            return [getComputedStyle(document.getElementById('ms-send')).backgroundColor, tok('--fx-accent-press'), tok('--fx-accent')]; }""")
        check(f'{w}: Send stays the filled orange action under the pointer', hov[0] in (hov[1], hov[2]), hov)
        pg.mouse.move(2, 300)

        # ── Send ──
        pg.fill('#ms-input', '  On my way now  ')
        pg.click('#ms-send')
        pg.wait_for_function("() => document.querySelectorAll('#ms-msgs .ms-bubble').length === 4")
        sent = pg.evaluate('window.__fx.sent')
        check(f'{w}: a message is sent once, trimmed, as this artisan', sent == [['A1_C1', {'senderId': 'A1', 'text': 'On my way now'}]], sent)
        check(f'{w}: the box is cleared and the new message is at the bottom', pg.input_value('#ms-input') == '' and pg.evaluate(BUBBLES_JS)[-1]['text'] == 'On my way now')
        pg.fill('#ms-input', '   '); pg.click('#ms-send'); pg.wait_for_timeout(120)
        check(f'{w}: an empty message is not sent', len(pg.evaluate('window.__fx.sent')) == 1)
        pg.evaluate('window.__fx.failSend = true')
        pg.fill('#ms-input', 'Will this arrive?')
        pg.press('#ms-input', 'Enter')
        pg.wait_for_selector('.fx-toast')
        toast = pg.inner_text('.fx-toast')
        check(f'{w}: a failed send says so and gives the words back', 'Message not sent' in toast and pg.input_value('#ms-input') == 'Will this arrive?', toast)
        shot(pg, f'send-failed-{width}')
        pg.evaluate('window.__fx.failSend = false')
        pg.fill('#ms-input', '')

        # ── Back ──
        pg.click('#ms-chat-back')
        pg.wait_for_function("() => !document.getElementById('ms-chat').classList.contains('open')")
        st = pg.evaluate("() => ({ inert: document.getElementById('ms-shell').inert, url: location.search, unsub: window.__fx.msgUnsubs, rows: document.querySelectorAll('#ms-list .ms-row').length })")
        check(f'{w}: Back returns to the inbox, usable again, and stops listening to the thread', not st['inert'] and st['url'] == '' and st['unsub'] == 1 and st['rows'] == 3, st)
        pg.go_forward()
        pg.wait_for_function("() => document.getElementById('ms-chat').classList.contains('open')")
        pg.go_back()
        pg.wait_for_function("() => !document.getElementById('ms-chat').classList.contains('open')")
        check(f'{w}: the phone\'s Back and Forward do the same', pg.evaluate('location.search') == '')
        check(f'{w}: no script errors', errs == [], errs)
        ctx.close()

    # ── Entry points ──
    ctx = b.new_context(viewport={'width': 390, 'height': 760})
    ctx.add_init_script(INIT)
    ctx.route('**/*', route)

    pg, errs = open_page(ctx, '?chatId=A1_C1')
    pg.wait_for_selector('#ms-msgs .ms-bubble')
    check('a notification link (?chatId=) opens that conversation', pg.evaluate("document.getElementById('ms-chat-name').textContent") == 'Ama' and pg.evaluate('location.search') == '?chat=A1_C1', pg.evaluate('location.search'))
    pg.reload(wait_until='domcontentloaded')
    pg.wait_for_selector('#ms-msgs .ms-bubble')
    check('a reload lands back in the open conversation', pg.evaluate("document.getElementById('ms-chat').classList.contains('open')"))
    pg.go_back()
    pg.wait_for_function("() => !document.getElementById('ms-chat').classList.contains('open')")
    check('Back from a linked conversation lands on the inbox, not outside Messages', pg.evaluate('location.pathname').endswith('/messages.html') and pg.evaluate("document.querySelectorAll('#ms-list .ms-row').length") == 3)
    pg.close()

    pg, errs = open_page(ctx, '?bookingId=HHB-1')
    pg.wait_for_selector('#ms-msgs .ms-bubble')
    chip = pg.evaluate("() => { const c = document.getElementById('ms-job-chip'); const r = c.getBoundingClientRect(); const t = document.getElementById('ms-job-text'); return { hidden: c.hidden, text: t.textContent, cut: t.scrollWidth > t.clientWidth, right: r.right, vw: window.innerWidth, name: document.getElementById('ms-chat-name').getBoundingClientRect().width }; }")
    created = pg.evaluate('window.__fx.created')
    check('a job link (?bookingId=) opens the conversation with that job\'s customer, passing only the first name',
          created == [['A1', 'C1', {'bookingId': 'HHB-1', 'customerFirstName': 'Ama'}]], created)
    check('the job is named in the header and a long name is cut, leaving the customer\'s name readable', (not chip['hidden']) and chip['text'].startswith('Plumbing') and chip['right'] <= chip['vw'] and chip['name'] > 30, chip)
    check('nothing overflows with the job named', pg.evaluate(OVERFLOW_JS) <= 0)
    shot(pg, 'thread-job')
    with pg.expect_navigation():
        pg.click('#ms-job-chip')
    check('the job in the header opens that job', pg.evaluate('location.pathname + location.search') == '/artisan-app/job.html?id=HHB-1', pg.evaluate('location.href'))
    pg.close()
    ctx.close()

    # ── Nothing yet, and nothing reachable ──
    for cfg, title, body, alert in (({'empty': True}, 'No messages yet', 'When a customer messages you about a job, the conversation appears here.', False),
                                    ({'fail': True}, "Couldn't load messages", 'Check your connection and try again.', True)):
        ctx = b.new_context(viewport={'width': 360, 'height': 760})
        ctx.add_init_script(INIT)
        ctx.route('**/*', route)
        pg, errs = open_page(ctx, cfg=cfg)
        pg.wait_for_selector('#ms-list .fx-msg__state')
        s = pg.evaluate("() => { const e = document.querySelector('#ms-list .fx-msg__state'); return { h: e.querySelector('h2').textContent, p: e.querySelector('p').textContent, role: e.getAttribute('role') }; }")
        check(f'{title}: said in words, with no skeleton left', s['h'] == title and s['p'] == body and (s['role'] == 'alert') == alert and pg.evaluate("document.querySelectorAll('.ms-skel').length") == 0, s)
        shot(pg, 'empty' if cfg.get('empty') else 'error')
        ctx.close()

    b.close()
    _done = True

sys.exit(0 if all(c for _, c, _ in results) else 1)
