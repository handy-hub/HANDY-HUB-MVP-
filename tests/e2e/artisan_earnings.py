"""Phase 4 browser checks: the artisan Earnings screen (wallet.html), for real.

Runs the REAL artisan-app/wallet.html in Chromium with the REAL
walletRepository, walletLedger, artisanEarnings, earningsScreen, instantView
(localStorage cache), fx sheet and the shared Security PIN sheet. Only Firebase,
auth and the withdrawal callable are in-page fakes: the test plays the
server's records and the server's answers, and checks what the screen says.

  · every figure against the record it comes from, with the reconciliation
    (matches / a tampered balance / a partial ledger / a cached paint)
  · nothing private reaches the DOM or the cache (full phone, account name)
  · withdrawal: requested, paid, being confirmed, refused, failed-duplicate,
    uncertain (same request id retried), wrong PIN, double tap, gone offline
  · no payout account, no data at all, and the layout at 360 / 390 / 768 px
    and at 200% text; focus moves into the sheet and back

Network: NONE. Pages are served from the fake origin http://fx.test by
Playwright routing; EVERY other host is aborted. No emulator, no server.

    python -I tests/e2e/artisan_earnings.py
    FX_SHOTS=<dir> python -I tests/e2e/artisan_earnings.py
"""
import os, sys, re, json, copy, pathlib, mimetypes, atexit
from playwright.sync_api import sync_playwright
sys.stdout.reconfigure(encoding='utf-8')

ROOT = pathlib.Path(__file__).resolve().parents[2]
ORIGIN = 'http://fx.test'
SHOTS = os.environ.get('FX_SHOTS')

results = []
def check(name, cond, detail=''):
    results.append((name, bool(cond), detail))
_done = False
def _report():
    ok = sum(1 for _, c, _ in results if c)
    for n, c, d in results:
        print(f"  {'PASS' if c else 'FAIL'}  {n}" + ('' if c else f"   [{str(d)[:300]}]"))
    print(f"artisan-earnings browser: {ok} passed, {len(results) - ok} failed" + ('' if _done else '  (aborted early)'))
    sys.stdout.flush(); sys.stderr.flush()
    if ok != len(results) or not _done:
        os._exit(1)
atexit.register(_report)

# ── In-page fakes: the server's records and answers ──────────────────────────
INIT = r"""
(() => {
  const fx = window.__fx = { docs: {}, docSubs: [], colSubs: [], subSubs: [], reads: [], queries: [], toasts: [],
                             wcalls: [], wnext: [], wdelay: 0, full: null, fullReads: 0, recent: [] };
  window.HH_State = { currentUid: () => 'A1' };
  document.addEventListener('DOMContentLoaded', () => new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) {
    if (n.nodeType === 1 && n.classList.contains('fx-toast')) fx.toasts.push(n.querySelector('.fx-toast__text').textContent.trim()); } })
    .observe(document.body, { childList: true, subtree: true }));
  const any = () => new Proxy(function () {}, {
    get: (t, k) => (k === 'then' ? undefined : k === Symbol.toPrimitive ? () => '' : any()),
    apply: () => any(),
  });
  fx.any = any;
  const recs = (list) => (list || []).map((d) => ({ id: d.id, data: d }));
  fx.db = {
    subscribeToDocument(name, id, onChange, onErr) { fx.docSubs.push({ k: `${name}/${id}`, onChange, onErr }); return () => {}; },
    subscribeToCollection(name, cond, opts, onChange, onErr) { fx.colSubs.push({ name, cond, opts, onChange, onErr }); return () => {}; },
    subscribeToSubCollection(col, id, sub, cond, opts, onChange, onErr) { fx.subSubs.push({ k: `${col}/${id}/${sub}`, opts, onChange, onErr }); return () => {}; },
    async querySubCollection(col, id, sub, cond, opts) {
      fx.fullReads++; fx.fullOpts = opts;
      if (fx.fullFail) throw Object.assign(new Error('unavailable'), { code: 'unavailable' });
      return recs(fx.full);
    },
    async queryWithOptions(name, cond, opts) { fx.queries.push([name, cond, opts]); return recs(fx.recent); },
    async getDocument(name, id) { fx.reads.push(`${name}/${id}`); const d = fx.docs[`${name}/${id}`]; return d ? { exists: true, id, data: d } : { exists: false, id, data: null }; },
  };
  // The server's records, as the listeners deliver them.
  fx.emit = (s, fromCache = false) => {
    for (const x of fx.docSubs) if (x.k === 'artisans/A1') x.onChange({ id: 'A1', exists: true, data: s.artisan, fromCache, hasPendingWrites: false });
    for (const x of fx.colSubs) {
      if (x.name === 'escrow') x.onChange(recs(s.escrows), { fromCache });
      if (x.name === 'payouts') x.onChange(recs(s.payouts), { fromCache });
    }
    if (s.txns) for (const x of fx.subSubs) if (x.k === 'artisans/A1/transactions') x.onChange(recs(s.txns), { fromCache });
  };
  fx.failWallet = () => { for (const x of fx.docSubs) if (x.k === 'artisans/A1' && x.onErr) x.onErr(Object.assign(new Error('unavailable'), { code: 'unavailable' })); };
})();
"""

ARTISAN = {'uid': 'A1', 'id': 'A1', 'userType': 'artisan', 'status': 'active', 'verificationStatus': 'approved', 'name': 'Kofi'}
WALLET_SERVICE = """
let n = 0;
export function newWithdrawalRequestId() { n++; return 'req' + String(n).padStart(29, '0'); }
export async function withdrawArtisan(args) {
  const fx = window.__fx;
  fx.wcalls.push(JSON.parse(JSON.stringify(args)));
  if (fx.wdelay) await new Promise((r) => setTimeout(r, fx.wdelay));
  const r = fx.wnext.length ? fx.wnext.shift() : { result: { status: 'processing', ref: 'AW-DEFAULT', payoutId: 'x' } };
  if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code, waitMs: r.error.waitMs });
  return r.result;
}
export default {};
"""
SPECIFIC = {
    '/shared/js/app/container.js':
        "export function getAppContainer(){ const fx = window.__fx; return { services: new Proxy({ databaseService: fx.db,"
        " authService: { waitForUser: async () => ({ uid: 'A1' }) } }, { get:(t,k)=> k in t ? t[k] : fx.any() }) }; }",
    '/shared/js/services/walletService.js': WALLET_SERVICE,
    # The liveness heartbeat (artisanFloatingNav.js follows the profile on every page).
    '/shared/js/services/presenceService.js':
        "export function startPresence(){} export function stopPresence(){} export function syncAvailability(){}"
        " export function ensurePresence(uid, db, available){ (window.__fx.ensure ||= []).push([uid, available]); }"
        " export function availabilityPending(){ return false; } export async function setAvailability(){ window.__fx.wroteAvailability = true; } export default {};",
    '/artisan-app/js/utils/artisanAuthGuard.js': f"""
const A = {json.dumps(ARTISAN)};
const U = {{ uid: 'A1', email: 'a@x.test', emailVerified: true }};
export async function requireArtisanAuth(){{ return {{ user: U, artisan: A }}; }}
export function subscribeToArtisanAuthState(cb){{ setTimeout(() => cb(U), 0); return () => {{}}; }}
export function signOutArtisan(){{}}
""",
}
CATCH_ALL = re.compile(r'^/shared/(vendor/firebase/|js/backend/|dev/)|^/shared/js/services/(pushNotificationService|notificationRepository)\.js$')
EMPTY = {'/shared/js/utils/global-app.js', '/shared/js/utils/themeManager.js', '/shared/js/components/fastLoader.js', '/artisan-app/js/pwa.js'}

def import_names(src, tail):
    names = set()
    for m in re.finditer(r'import\s*\{([^}]*)\}\s*from\s*[\'"]([^\'"]+)[\'"]', src):
        if m.group(2).endswith(tail):
            for part in m.group(1).split(','):
                part = part.strip()
                if part: names.add(part.split(' as ')[0].strip())
    return names
ALL_SRC = '\n'.join(p.read_text(encoding='utf-8', errors='ignore')
                    for p in list((ROOT / 'artisan-app').glob('*.html')) + list((ROOT / 'shared' / 'js').rglob('*.js')))

def route(r):
    url = r.request.url
    if not url.startswith(ORIGIN): return r.abort()
    p = url[len(ORIGIN):].split('?')[0]
    js = lambda body: r.fulfill(status=200, content_type='text/javascript', body=body)
    if p in SPECIFIC: return js(SPECIFIC[p])
    if p == '/shared/js/services/callable.js':
        # Every callable is recorded; setSecurityPin's is the one this screen can make.
        others = import_names(ALL_SRC, 'callable.js') - {'callable'}
        return js(''.join(f'export const {n} = window.__fx.any();\n' for n in sorted(others) if n.isidentifier())
                  + "export function callable(name) { return async (data) => { (window.__fx.callables ||= []).push([name, data]); return { data: { configured: true } }; }; }\n"
                  + 'export default window.__fx.any();')
    if p in EMPTY: return js('')
    if CATCH_ALL.search(p):
        names = import_names(ALL_SRC, p.split('/')[-1])
        return js(''.join(f'export const {n} = window.__fx.any();\n' for n in sorted(names) if n.isidentifier()) + 'export default window.__fx.any();')
    f = ROOT / p.lstrip('/')
    if not f.is_file(): return r.fulfill(status=404, body='')
    ctype = 'text/javascript' if f.suffix in ('.js', '.mjs') else (mimetypes.guess_type(str(f))[0] or 'application/octet-stream')
    return r.fulfill(status=200, content_type=ctype, body=f.read_bytes())

# ── The records: one consistent set (the server's arithmetic) ────────────────
PHONE = '0241234567'
def txn(id, type, amount, at, **o):
    d = {'id': id, 'type': type, 'amount': amount, 'createdAt': at, 'status': 'completed'}; d.update(o); return d
BASE = {
    'artisan': {'availableBalance': 115.07, 'totalEarned': 170.07, 'withdrawnTotal': 55, 'name': 'Kofi', 'status': 'active', 'verificationStatus': 'approved', 'isAvailable': True},
    'escrows': [
        {'id': 'bk_held', 'bookingId': 'bk_held', 'artisanId': 'A1', 'customerId': 'C9', 'kind': 'job', 'status': 'held', 'amount': 80, 'commission': 12, 'artisanShare': 68, 'createdAt': '2026-11-05T12:00:00.000Z'},
        {'id': 'bk_dis', 'bookingId': 'bk_dis', 'artisanId': 'A1', 'customerId': 'C9', 'kind': 'job', 'status': 'disputed', 'amount': 40, 'commission': 6, 'artisanShare': 34, 'createdAt': '2026-11-04T12:00:00.000Z', 'disputedAt': '2026-11-05T08:00:00.000Z'},
    ],
    'payouts': [
        {'id': 'p1', 'userId': 'A1', 'ref': 'AW-P1', 'amount': 40, 'provider': 'mtn', 'phone': PHONE, 'status': 'success', 'createdAt': '2026-11-03T09:00:00.000Z', 'completedAt': '2026-11-03T09:05:00.000Z', 'recipientCode': 'RCP_secret'},
        {'id': 'p2', 'userId': 'A1', 'ref': 'AW-P2', 'amount': 25, 'provider': 'mtn', 'phone': PHONE, 'status': 'failed', 'refundedAt': '2026-11-04T09:10:00.000Z', 'failedAt': '2026-11-04T09:10:00.000Z', 'createdAt': '2026-11-04T09:00:00.000Z', 'reason': 'rejected at initiation: starter business'},
        {'id': 'p3', 'userId': 'A1', 'ref': 'AW-P3', 'amount': 15, 'provider': 'mtn', 'phone': PHONE, 'status': 'reserved', 'createdAt': '2026-11-05T09:00:00.000Z'},
    ],
    'txns': [
        txn('w3', 'withdrawal', 15, '2026-11-05T09:00:00.000Z', payoutId='p3', ref='AW-P3', status='processing', provider='mtn', phone=PHONE),
        txn('w2', 'withdrawal', 25, '2026-11-04T09:00:00.000Z', payoutId='p2', ref='AW-P2', status='processing', provider='mtn', phone=PHONE),
        txn('w1', 'withdrawal', 40, '2026-11-03T09:00:00.000Z', payoutId='p1', ref='AW-P1', status='successful', provider='mtn', phone=PHONE),
        txn('t1', 'tip', 10, '2026-11-02T14:00:00.000Z', bookingId='bk_1', ref='TIP-1', commission=0),
        txn('e3', 'earning', 28.33, '2026-11-02T12:00:00.000Z', bookingId='bk_3', commission=5, totalAmount=33.33, commissionRate=0.15, ref='ERN-3', escrowId='bk_3'),
        txn('e2', 'earning', 46.74, '2026-11-02T10:00:00.000Z', bookingId='bk_2', commission=8.25, totalAmount=54.99, commissionRate=0.15, ref='ERN-2', escrowId='bk_2'),
        txn('e1', 'earning', 85, '2026-11-01T10:00:00.000Z', bookingId='bk_1', commission=15, totalAmount=100, commissionRate=0.15, ref='ERN-1', escrowId='bk_1'),
    ],
}
RECENT = [
    {'id': 'bk_held', **BASE['escrows'][0]},
    {'id': 'bk_ref', 'bookingId': 'bk_ref', 'artisanId': 'A1', 'kind': 'job', 'status': 'refunded', 'amount': 60, 'commission': 9, 'artisanShare': 51,
     'refundedBy': 'ops@fidus.test', 'refundReason': 'Booking cancelled by customer', 'refundedAt': '2026-11-04T12:00:00.000Z', 'createdAt': '2026-11-03T12:00:00.000Z'},
    {'id': 'bk_1', 'bookingId': 'bk_1', 'artisanId': 'A1', 'kind': 'job', 'status': 'released', 'amount': 100, 'commission': 15, 'artisanShare': 85, 'releasedAt': '2026-11-01T10:00:00.000Z', 'createdAt': '2026-10-31T10:00:00.000Z'},
]
DOCS = {
    'bookings/bk_1': {'serviceType': 'plumbing', 'customerFirstName': 'Ama'},
    'bookings/bk_2': {'serviceType': 'electrical', 'customerFirstName': 'Kojo'},
    'bookings/bk_held': {'serviceType': 'carpentry', 'customerFirstName': 'Efua'},
    'bookings/bk_ref': {'serviceType': 'cleaning', 'customerFirstName': 'Yaw'},
    'artisans/A1/private/kyc': {'payoutAccount': {'provider': 'mtn', 'phone': PHONE, 'accountName': 'Kofi Boateng'}},
    'artisans/A1/private/security': {'securityPinConfigured': True},
}

def new_ctx(b, width=390, height=900):
    ctx = b.new_context(viewport={'width': width, 'height': height})
    ctx.add_init_script(INIT)
    return ctx

def open_page(ctx, docs=DOCS, recent=RECENT):
    pg = ctx.new_page()
    errors = []
    pg.on('pageerror', lambda e: errors.append(str(e)))
    pg.route('**/*', route)
    pg.set_default_timeout(5000)
    pg.goto(f'{ORIGIN}/artisan-app/wallet.html', wait_until='domcontentloaded')
    pg.wait_for_function('window.__fx && window.__fx.docSubs.length > 0 && window.__fx.subSubs.length > 0')
    pg.evaluate('([d, r]) => { window.__fx.docs = d; window.__fx.recent = r; }', [docs, recent])
    return pg, errors

def emit(pg, s, from_cache=False):
    pg.evaluate('([s, c]) => window.__fx.emit(s, c)', [s, from_cache])
    pg.wait_for_timeout(150)

txt = lambda pg, sel: (pg.text_content(sel) or '').strip()
squash = lambda s: re.sub(r'\s+', ' ', s or '').strip()
def figure(pg, key):
    return squash(pg.evaluate("(k) => { const r = document.querySelector(`[data-figure='${k}'] .fx-ledger__v`); return r ? r.textContent : null; }", key) or '')
def wd_state(pg):
    return pg.evaluate("""() => ({ open: !document.getElementById('wd-sheet').hidden,
        confirm: document.getElementById('wd-confirm-btn').textContent.trim(), disabled: document.getElementById('wd-confirm-btn').disabled,
        msg: document.getElementById('wd-amount-msg').textContent.trim(),
        err: document.getElementById('wd-error').hidden ? '' : document.getElementById('wd-error').textContent.trim() })""")
def pin_open(pg):
    return pg.evaluate("() => !!document.querySelector('.hh-pin-input') && document.querySelector('.hh-pin-input').getClientRects().length > 0")
def enter_pin(pg, pin='2468'):
    pg.wait_for_selector('.hh-pin-input', state='visible')
    pg.fill('.hh-pin-input', pin)
    pg.dispatch_event('.hh-pin-input', 'input')
    pg.wait_for_function("() => { const b = document.querySelector('.hh-pin-confirm'); return b && !b.disabled; }")
    pg.click('.hh-pin-confirm')
def start_withdraw(pg, amount):
    # The last outcome's toast sits under the app bar, over the top of the screen.
    pg.evaluate("() => { document.querySelectorAll('.fx-toast').forEach((t) => t.remove()); window.scrollTo(0, 0); }")
    pg.click('#withdraw-btn')
    pg.wait_for_selector('#wd-sheet:not([hidden])')
    pg.fill('#wd-amount', str(amount))
    pg.dispatch_event('#wd-amount', 'input')

OVERFLOW_JS = """() => { const w = document.documentElement.clientWidth; const bad = [];
  for (const el of document.querySelectorAll('body *')) { if (el.closest('[hidden]')) continue;
    const r = el.getBoundingClientRect(); if (r.width && (r.right > w + 0.5 || r.left < -0.5)) bad.push(el.tagName + '.' + [...el.classList].join('.')); }
  return { scroll: document.documentElement.scrollWidth > w, bad: bad.slice(0, 5) }; }"""
# Inline text links are exempt (WCAG 2.5.8); .fx-btn--s draws a 44px hit area with ::after.
TARGETS_JS = """() => { const out = [];
  for (const el of document.querySelectorAll('button, a[href]')) {
    if (el.closest('[hidden], .fx-skip') || el.classList.contains('fx-link') || el.classList.contains('fx-btn--s')) continue;
    const r = el.getBoundingClientRect(); if (!r.width) continue;
    if (r.width < 43.5 || r.height < 43.5) out.push(el.tagName + ' "' + el.textContent.trim().slice(0, 20) + '" ' + Math.round(r.width) + 'x' + Math.round(r.height)); }
  return out; }"""

def shot(pg, name):
    if SHOTS:
        pathlib.Path(SHOTS).mkdir(parents=True, exist_ok=True)
        pg.screenshot(path=str(pathlib.Path(SHOTS) / f'earnings-{name}.png'), full_page=True)

with sync_playwright() as p:
    b = p.chromium.launch()

    # ═══ 1. Every figure from its record ═════════════════════════════════════
    ctx = new_ctx(b)
    pg, errs = open_page(ctx)
    check('first visit: the skeleton, until the records answer', pg.query_selector('#earn-body [data-skeleton]') is not None)
    emit(pg, BASE)
    pg.wait_for_function("() => document.querySelector('[data-check]') !== null")
    pg.wait_for_timeout(250)
    check('Available to withdraw = artisans.availableBalance', txt(pg, '#available-balance') == 'GHS 115.07', txt(pg, '#available-balance'))
    check('Your money: each figure from its record (held = Σ artisanShare held; dispute; open payouts; paid out; earned)',
          [figure(pg, k) for k in ('available', 'held', 'dispute', 'transit', 'paid', 'earned')]
          == ['GHS 115.07', 'GHS 68.00', 'GHS 34.00', 'GHS 15.00', 'GHS 40.00', 'GHS 170.07'],
          [figure(pg, k) for k in ('available', 'held', 'dispute', 'transit', 'paid', 'earned')])
    check('held is labelled with its job count and is never called withdrawable',
          'Held for jobs in progress (1)' in squash(txt(pg, '[data-figure="held"]')) and 'Not yours to withdraw yet' in txt(pg, '[data-figure="held"]'))
    check('the fee, from the earning rows: customers paid · platform fee · you received · tips',
          [figure(pg, k) for k in ('gross', 'fee', 'net', 'tips')] == ['GHS 188.32', '− GHS 28.25', 'GHS 160.07', 'GHS 10.00']
          and 'From all 3 job payments on your record.' in txt(pg, '#earn-fees + * , section[aria-labelledby="earn-fees"]'),
          [figure(pg, k) for k in ('gross', 'fee', 'net', 'tips')])
    check('the stored totals are checked against all 7 records, and agree',
          txt(pg, '[data-check]') == 'Your balance matches your records (7 records checked).', txt(pg, '[data-check]'))
    held = squash(txt(pg, 'section[aria-labelledby="earn-held"]'))
    check('held for your jobs: the job by name, its state, the customer\'s payment and fee, your share, a link to the job',
          'Carpentry · Efua' in held and 'Held until the customer confirms' in held and 'Customer paid GHS 80.00 · fee GHS 12.00' in held
          and 'GHS 68.00' in held and 'In dispute · Fidus X support is reviewing' in held
          and pg.query_selector('section[aria-labelledby="earn-held"] a[href="job.html?id=bk_held"]') is not None, held)
    ret = squash(txt(pg, 'section[aria-labelledby="earn-returned"]'))
    check('returned to customers: the refunded job, the amount returned — not who refunded it or why',
          'Cleaning · Yaw' in ret and 'GHS 60.00 returned to the customer' in ret
          and 'ops@fidus.test' not in pg.content() and 'Booking cancelled by customer' not in pg.content(), ret)
    pays = pg.eval_on_selector_all('section[aria-labelledby="earn-payouts"] [data-payout]', 'els => els.map(e => [e.dataset.payout, e.querySelector(".fx-chip").textContent.trim(), e.querySelector(".fx-row__value").textContent.trim()])')
    check('withdrawals read as the payouts collection records them, newest first',
          pays == [['p3', 'Requested', 'GHS 15.00'], ['p2', 'Failed · balance restored', 'GHS 25.00'], ['p1', 'Paid out', 'GHS 40.00']], pays)
    acts = pg.eval_on_selector_all('section[aria-labelledby="earn-activity"] [data-txn]', 'els => els.map(e => [e.querySelector(".fx-row__title").textContent.trim(), e.querySelector(".fx-chip").textContent.trim(), e.querySelector(".fx-row__value").textContent.trim()])')
    check('activity: a withdrawal takes its payout\'s state (w2 says "processing" in its row; its payout failed)',
          acts[1] == ['Withdrawal to MTN MoMo 024 ••• 4567', 'Failed · balance restored', '− GHS 25.00'], acts[:3])
    check('activity: job payments and the tip name their job and read as money in',
          ['Tip · Plumbing · Ama', 'Paid to your balance', '+ GHS 10.00'] in acts and ['Job payment · Electrical · Kojo', 'Paid to your balance', '+ GHS 46.74'] in acts, acts)
    check('booking names are read once each, and only bookings the screen shows',
          sorted(r for r in pg.evaluate('window.__fx.reads') if r.startswith('bookings/')) == ['bookings/bk_1', 'bookings/bk_2', 'bookings/bk_3', 'bookings/bk_dis', 'bookings/bk_held', 'bookings/bk_ref'],
          pg.evaluate('window.__fx.reads'))
    check('the platform fee and smallest withdrawal are the configured ones', txt(pg, '#commission-rate') == '15%' and txt(pg, '#min-withdrawal') == 'GHS 5')
    body = pg.content()
    # The artisan sees their own account holder's name where it says where money goes
    # (the "Paid to" line); the full number, the provider's recipient code and the
    # provider's failure reason are never on the page.
    names_at = pg.evaluate("""() => { const out = []; const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        while (w.nextNode()) if (w.currentNode.nodeValue.includes('Kofi Boateng')) out.push(w.currentNode.parentElement.closest('[id]').id); return out; }""")
    check('the full payout number, recipient code and failure reason never reach the page; the account name only says where money goes',
          PHONE not in body and 'RCP_secret' not in body and 'starter business' not in body and names_at == ['earn-body'], names_at)
    check('Withdraw is on, with the account it pays', not pg.is_disabled('#withdraw-btn') and 'Paid to MTN MoMo · 024 ••• 4567 · Kofi Boateng' in squash(txt(pg, '.fx-earn__hero')), squash(txt(pg, '.fx-earn__hero')))
    check('one tab bar, Earnings current', len(pg.query_selector_all('nav.fx-tabbar')) == 1 and txt(pg, '#tabbar [aria-current="page"]') == 'Earnings')
    check('an available artisan stays in dispatch while on Earnings: the heartbeat runs, availability is never written',
          ['A1', True] in (pg.evaluate('window.__fx.ensure || []') or []) and not pg.evaluate('!!window.__fx.wroteAvailability'),
          pg.evaluate('window.__fx.ensure || []'))
    shot(pg, 'live-390')

    # The detail of one row
    pg.click('[data-txn="e2"]')
    pg.wait_for_selector('#txn-sheet:not([hidden])')
    det = squash(pg.inner_text('#txn-sheet'))
    check('a payment\'s details: what the customer paid, the fee and its rate, what you received, its reference, its job',
          'Customer paid GHS 54.99' in det and 'Platform fee (15%) − GHS 8.25' in det and 'You received GHS 46.74' in det and 'Reference ERN-2' in det
          and pg.query_selector('#txn-sheet a[href="job.html?id=bk_2"]') is not None, det)
    check('the details sheet takes focus', pg.evaluate("() => document.getElementById('txn-sheet').contains(document.activeElement)"))
    pg.keyboard.press('Escape'); pg.wait_for_timeout(450)
    check('Escape closes it and focus returns to the row', pg.evaluate("() => document.activeElement && document.activeElement.dataset.txn === 'e2'"),
          pg.evaluate("() => document.activeElement && document.activeElement.outerHTML.slice(0, 80)"))
    pg.click('[data-txn="w2"]'); pg.wait_for_selector('#txn-sheet:not([hidden])')
    det = squash(pg.inner_text('#txn-sheet'))
    check('a withdrawal\'s details: its payout\'s state and reference', 'Status Failed · balance restored' in det and 'Reference AW-P2' in det, det)
    pg.keyboard.press('Escape'); pg.wait_for_timeout(450)

    # Layout
    for w in (360, 390, 768):
        pg.set_viewport_size({'width': w, 'height': 800}); pg.wait_for_timeout(100)
        o = pg.evaluate(OVERFLOW_JS)
        check(f'{w}px: no horizontal overflow', not o['scroll'] and not o['bad'], o)
        t = pg.evaluate(TARGETS_JS)
        check(f'{w}px: every control is at least 44px', not t, t)
    pg.set_viewport_size({'width': 360, 'height': 800})
    pg.add_style_tag(content='html { font-size: 200% !important; }'); pg.wait_for_timeout(150)
    o = pg.evaluate(OVERFLOW_JS)
    shot(pg, 'live-360-200pct')
    check('360px at 200% text: no horizontal overflow', not o['scroll'] and not o['bad'], o)
    check('no page errors on the live screen', not errs, errs)
    pg.close()

    # ═══ 2. The next visit paints from the cache — and acts on nothing ═══════
    pg, errs = open_page(ctx)
    pg.wait_for_timeout(300)
    check('a return visit paints the figures at once, before any record answers',
          txt(pg, '#available-balance') == 'GHS 115.07' and figure(pg, 'held') == 'GHS 68.00' and pg.query_selector('#earn-body [data-skeleton]') is None,
          txt(pg, '#available-balance'))
    check('…says they are the last known figures', txt(pg, '#earn-sub') == 'Showing your last figures · checking for updates', txt(pg, '#earn-sub'))
    check('…keeps Withdraw off, and says why', pg.is_disabled('#withdraw-btn') and txt(pg, '#withdraw-why') == 'Checking your balance with Fidus X…', txt(pg, '#withdraw-why'))
    check('…and claims no reconciliation from cached figures', pg.query_selector('[data-check]') is None)
    store = pg.evaluate('() => JSON.stringify(Object.fromEntries(Object.keys(localStorage).map(k => [k, localStorage.getItem(k)])))')
    check('the cache holds no phone number, account name, provider code or refund note',
          PHONE not in store and '4567' not in store and 'Kofi Boateng' not in store and 'RCP_secret' not in store and 'ops@fidus.test' not in store
          and 'artisan-wallet-view' in store and 'artisan-wallet-txns' in store, store[:400])
    emit(pg, BASE)
    pg.wait_for_function("() => document.querySelector('[data-check]') !== null")
    check('the live records take over: Withdraw on, no "last figures" line', not pg.is_disabled('#withdraw-btn') and txt(pg, '#earn-sub') == '')
    pg.close(); ctx.close()

    # ═══ 3. Inconsistencies are shown ════════════════════════════════════════
    ctx = new_ctx(b); pg, errs = open_page(ctx)
    tampered = copy.deepcopy(BASE); tampered['artisan']['availableBalance'] = 165.07   # raised outside the money paths
    emit(pg, tampered)
    pg.wait_for_timeout(600)
    check('a mismatch is not announced while the listeners may still be catching up', pg.query_selector('[data-check="mismatch"]') is None)
    pg.wait_for_selector('[data-check="mismatch"]', timeout=4000)
    mm = squash(txt(pg, '[data-check="mismatch"]'))
    check('a balance that does not match the records is said, with both figures, and where to go',
          'Your figures do not match your records' in mm and 'Your available balance (GHS 165.07) does not match your records (GHS 115.07).' in mm
          and pg.query_selector('[data-check="mismatch"] a[href="support.html"]') is not None, mm)
    check('the figure on screen is still the server\'s, not "corrected"', txt(pg, '#available-balance') == 'GHS 165.07')
    shot(pg, 'mismatch')
    emit(pg, BASE); pg.wait_for_timeout(300)
    check('when the records agree again, the notice goes', pg.query_selector('[data-check="mismatch"]') is None and txt(pg, '[data-check]').startswith('Your balance matches'))
    pg.close(); ctx.close()

    # ═══ 4. A ledger longer than the live page ═══════════════════════════════
    ctx = new_ctx(b); pg, errs = open_page(ctx)
    many = [txn(f'r{i:03d}', 'earning', 1, f'2026-10-{1 + i // 24:02d}T{i % 24:02d}:00:00.000Z', commission=0.18, totalAmount=1.18, commissionRate=0.15) for i in range(75)]
    many.sort(key=lambda x: x['createdAt'], reverse=True)
    long = {'artisan': {'availableBalance': 75, 'totalEarned': 75, 'withdrawnTotal': 0}, 'escrows': [], 'payouts': [], 'txns': many[:60]}
    pg.evaluate('(f) => { window.__fx.full = f; }', many)
    emit(pg, long)
    pg.wait_for_selector('[data-check="partial"]')
    check('60 rows (the live page\'s limit) are not called the whole ledger: no verdict, an offer to check',
          'once all of them have loaded' in txt(pg, '[data-check="partial"]') and pg.query_selector('[data-act="check"]') is not None
          and 'From your latest 60 job payments.' in txt(pg, 'section[aria-labelledby="earn-fees"]'), txt(pg, '[data-check="partial"]'))
    check('…and older activity can be shown', pg.query_selector('[data-act="older"]') is not None)
    check('nothing more is read until asked', pg.evaluate('window.__fx.fullReads') == 0)
    pg.click('[data-act="check"]')
    pg.wait_for_selector('[data-check="ok"]')
    check('checking reads the whole ledger once (newest first, bounded) and checks all 75 records',
          pg.evaluate('window.__fx.fullReads') == 1 and pg.evaluate('window.__fx.fullOpts') == {'orderBy': {'field': 'createdAt', 'direction': 'desc'}, 'limit': 1000}
          and txt(pg, '[data-check="ok"]') == 'Your balance matches your records (75 records checked).'
          and len(pg.query_selector_all('section[aria-labelledby="earn-activity"] [data-txn]')) == 75
          and pg.query_selector('[data-act="older"]') is None, txt(pg, '[data-check]'))
    pg.close(); ctx.close()

    ctx = new_ctx(b); pg, errs = open_page(ctx)
    pg.evaluate('() => { window.__fx.fullFail = true; }')
    emit(pg, long)
    pg.click('[data-act="check"]'); pg.wait_for_timeout(300)
    check('a failed read says so and offers to try again; the activity on screen stays',
          'could not load all your records' in txt(pg, '[data-check="partial"]') and txt(pg, '[data-act="check"]') == 'Try again'
          and len(pg.query_selector_all('[data-txn]')) == 60, txt(pg, '[data-check]'))
    pg.close(); ctx.close()

    # ═══ 5. Withdrawing ══════════════════════════════════════════════════════
    def fresh(width=390):
        c = new_ctx(b, width=width); pg_, e_ = open_page(c); emit(pg_, BASE)
        pg_.wait_for_function("() => !document.getElementById('withdraw-btn').disabled")
        return c, pg_, e_

    ctx, pg, errs = fresh()
    pg.click('#withdraw-btn'); pg.wait_for_selector('#wd-sheet:not([hidden])')
    check('the sheet opens with focus in the amount, the balance and the account it pays',
          pg.evaluate("() => document.activeElement.id") == 'wd-amount' and txt(pg, '#wd-avail') == 'GHS 115.07'
          and txt(pg, '#wd-account') == 'MTN MoMo 024 ••• 4567 · Kofi Boateng', [pg.evaluate("() => document.activeElement.id"), txt(pg, '#wd-account')])
    quick = pg.eval_on_selector_all('#wd-quick [data-amount]', 'els => els.map(e => e.textContent.trim())')
    check('quick amounts are only ones that can be withdrawn, plus "All"', quick == ['GHS 20', 'GHS 50', 'GHS 100', 'All · GHS 115.07'], quick)
    for raw, expect in (('2', 'The minimum withdrawal is GHS 5.00.'), ('120', 'That is more than you can withdraw (GHS 115.07).'), ('50.555', 'Use at most 2 decimal places (pesewas).')):
        pg.fill('#wd-amount', raw); pg.dispatch_event('#wd-amount', 'input')
        s = wd_state(pg)
        check(f'{raw}: Confirm is off and the reason is said', s['disabled'] and s['msg'] == expect, s)
    shot(pg, 'withdraw-sheet')
    pg.fill('#wd-amount', '50'); pg.dispatch_event('#wd-amount', 'input')
    check('a valid amount names itself on the button', wd_state(pg)['confirm'] == 'Withdraw GHS 50.00' and not wd_state(pg)['disabled'], wd_state(pg))
    pg.evaluate("() => window.__fx.wnext.push({ result: { status: 'processing', ref: 'AW-NEW1', payoutId: 'p9' } })")
    pg.click('#wd-confirm-btn')
    pg.wait_for_selector('.hh-pin-input', state='visible')
    shot(pg, 'pin-sheet')
    check('the Security PIN is asked for, on the PIN sheet', pin_open(pg) and 'Withdrawal · GHS 50.00' in pg.text_content('body'))
    enter_pin(pg)
    pg.wait_for_function("() => window.__fx.toasts.length > 0")
    pg.wait_for_timeout(450)
    calls = pg.evaluate('window.__fx.wcalls')
    check('the server gets the amount, the PIN and a request id — never a destination',
          len(calls) == 1 and set(calls[0]) == {'amount', 'pin', 'requestId'} and calls[0]['amount'] == 50 and calls[0]['pin'] == '2468', calls)
    toast = pg.evaluate('window.__fx.toasts')[-1]
    check('accepted, not settled: "requested" — never "paid"',
          toast == 'GHS 50.00 to MTN MoMo 024 ••• 4567 has been requested. It shows under Withdrawals until the provider confirms it; we\'ll notify you. Ref AW-NEW1.'
          and not wd_state(pg)['open'], [toast, wd_state(pg)])
    check('focus returns to Withdraw', pg.evaluate("() => document.activeElement && document.activeElement.id") == 'withdraw-btn',
          pg.evaluate("() => document.activeElement && document.activeElement.outerHTML.slice(0, 60)"))

    start_withdraw(pg, 40)
    pg.evaluate("() => window.__fx.wnext.push({ result: { status: 'success', ref: 'AW-NEW2', payoutId: 'p10' } })")
    pg.click('#wd-confirm-btn'); enter_pin(pg)
    pg.wait_for_function("() => window.__fx.toasts.length > 1")
    check('only the provider\'s success reads "paid"', pg.evaluate('window.__fx.toasts')[-1] == 'GHS 40.00 was paid to MTN MoMo 024 ••• 4567. Ref AW-NEW2.', pg.evaluate('window.__fx.toasts'))
    pg.wait_for_timeout(450)

    start_withdraw(pg, 30)
    pg.evaluate("() => window.__fx.wnext.push({ result: { status: 'unknown', ref: 'AW-NEW3', payoutId: 'p11' } })")
    pg.click('#wd-confirm-btn'); enter_pin(pg)
    pg.wait_for_function("() => window.__fx.toasts.length > 2")
    check('an outcome nobody knows yet reads "being confirmed", the amount held',
          pg.evaluate('window.__fx.toasts')[-1].startswith('GHS 30.00 is being confirmed with the provider. The amount stays held until it settles'), pg.evaluate('window.__fx.toasts'))
    pg.wait_for_timeout(450)

    # Refused by the provider (today's Paystack tier), and then the same request again
    start_withdraw(pg, 25)
    pg.evaluate("() => window.__fx.wnext.push({ error: { code: 'functions/failed-precondition', message: 'Your withdrawal could not be started. Your balance has been restored.' } })")
    pg.click('#wd-confirm-btn'); enter_pin(pg)
    pg.wait_for_function("() => !document.getElementById('wd-error').hidden")
    s = wd_state(pg)
    check('a refusal stays on the sheet, in the server\'s words; nothing reads as sent',
          s['open'] and s['err'] == 'Your withdrawal could not be started. Your balance has been restored.' and not pin_open(pg)
          and len(pg.evaluate('window.__fx.toasts')) == 3, s)
    rid_refused = pg.evaluate('window.__fx.wcalls')[-1]['requestId']
    pg.evaluate("() => window.__fx.wnext.push({ result: { status: 'failed', ref: 'AW-OLD', payoutId: 'p12', duplicate: true } })")
    pg.click('#wd-confirm-btn'); enter_pin(pg)
    pg.wait_for_timeout(400)
    s = wd_state(pg)
    check('after a refusal the next try is a NEW request', pg.evaluate('window.__fx.wcalls')[-1]['requestId'] != rid_refused)
    check('an answer that is an existing FAILED payout reads "did not go through", never "requested"',
          s['open'] and s['err'].startswith('Your withdrawal did not go through.') and len(pg.evaluate('window.__fx.toasts')) == 3, s)

    # An answer that never arrived: the same request is retried; a new amount is a new request
    pg.evaluate("() => window.__fx.wnext.push({ error: { code: 'functions/deadline-exceeded', message: 'deadline-exceeded' } })")
    pg.click('#wd-confirm-btn'); enter_pin(pg)
    pg.wait_for_function("() => !document.getElementById('wd-error').hidden")
    s = wd_state(pg)
    rid_unsure = pg.evaluate('window.__fx.wcalls')[-1]['requestId']
    check('an answer that never arrived says so, and to look before trying again', s['err'].startswith('We could not confirm whether your withdrawal started.'), s)
    pg.evaluate("() => window.__fx.wnext.push({ result: { status: 'processing', ref: 'AW-SAME', payoutId: 'p13', duplicate: true } })")
    pg.click('#wd-confirm-btn'); enter_pin(pg)
    pg.wait_for_function("() => window.__fx.toasts.length > 3")
    check('retrying the same amount sends the SAME request id (the server cannot pay it twice)', pg.evaluate('window.__fx.wcalls')[-1]['requestId'] == rid_unsure)
    check('…and the existing payout is described as such', pg.evaluate('window.__fx.toasts')[-1].startswith('Your withdrawal to MTN MoMo 024 ••• 4567 has been requested.'), pg.evaluate('window.__fx.toasts'))
    pg.wait_for_timeout(450)

    start_withdraw(pg, 22)
    pg.evaluate("() => window.__fx.wnext.push({ error: { code: 'functions/deadline-exceeded', message: 'x' } })")
    pg.click('#wd-confirm-btn'); enter_pin(pg)
    pg.wait_for_function("() => !document.getElementById('wd-error').hidden")
    rid_a = pg.evaluate('window.__fx.wcalls')[-1]['requestId']
    pg.fill('#wd-amount', '21'); pg.dispatch_event('#wd-amount', 'input')
    pg.evaluate("() => window.__fx.wnext.push({ result: { status: 'processing', ref: 'AW-21', payoutId: 'p14' } })")
    pg.click('#wd-confirm-btn'); enter_pin(pg)
    pg.wait_for_function("() => window.__fx.toasts.length > 4")
    check('a different amount after an uncertain answer is a new request', pg.evaluate('window.__fx.wcalls')[-1]['requestId'] != rid_a)
    pg.wait_for_timeout(450)

    # Wrong PIN, then the right one
    start_withdraw(pg, 20)
    n_calls = len(pg.evaluate('window.__fx.wcalls'))
    pg.evaluate("() => window.__fx.wnext.push({ error: { code: 'functions/permission-denied', message: 'Incorrect PIN.' } })")
    pg.click('#wd-confirm-btn'); enter_pin(pg, '1357')
    pg.wait_for_function("() => (document.querySelector('.hh-pin-error') || {}).textContent")
    check('a wrong PIN is said on the PIN sheet, which stays open; the withdraw sheet shows no error',
          pin_open(pg) and txt(pg, '.hh-pin-error') == 'Incorrect PIN. Try again.' and wd_state(pg)['err'] == '', [txt(pg, '.hh-pin-error'), wd_state(pg)])
    pg.keyboard.press('Escape'); pg.wait_for_timeout(500)
    check('one call was made for the wrong PIN', len(pg.evaluate('window.__fx.wcalls')) == n_calls + 1)

    # A slow answer: nothing can be sent twice while it is in flight
    pg.evaluate("() => { window.__fx.wdelay = 800; window.__fx.wnext.push({ result: { status: 'processing', ref: 'AW-SLOW', payoutId: 'p15' } }); }")
    if not wd_state(pg)['open']:
        start_withdraw(pg, 20)
    pg.click('#wd-confirm-btn'); enter_pin(pg)
    pg.wait_for_timeout(150)
    inflight = wd_state(pg)
    before = len(pg.evaluate('window.__fx.wcalls'))
    pg.evaluate("() => document.getElementById('wd-confirm-btn').click()")
    pg.wait_for_timeout(1000)
    check('while a withdrawal is in flight Withdraw is off, and a second tap sends nothing',
          inflight['disabled'] and len(pg.evaluate('window.__fx.wcalls')) == before, [inflight, before, len(pg.evaluate('window.__fx.wcalls'))])
    pg.evaluate("() => { window.__fx.wdelay = 0; }")
    pg.wait_for_timeout(450)

    # Gone offline with the sheet open
    start_withdraw(pg, 20)
    emit(pg, BASE, from_cache=True)
    s = wd_state(pg)
    check('figures from Firestore\'s cache (offline) turn Withdraw off, in words, even with the sheet open',
          s['disabled'] and s['err'] == 'Checking your balance with Fidus X…' and pg.is_disabled('#withdraw-btn'), s)
    emit(pg, BASE); pg.wait_for_timeout(200)
    check('…and back on when the server answers', not wd_state(pg)['disabled'] and wd_state(pg)['err'] == '', wd_state(pg))
    check('no page errors while withdrawing', not errs, errs)
    pg.close(); ctx.close()

    # A PIN not yet set up: created on the way, then the withdrawal is sent
    ctx = new_ctx(b); docs = copy.deepcopy(DOCS); docs['artisans/A1/private/security'] = {}
    pg, errs = open_page(ctx, docs=docs); emit(pg, BASE)
    pg.wait_for_function("() => !document.getElementById('withdraw-btn').disabled")
    start_withdraw(pg, 20)
    pg.evaluate("() => window.__fx.wnext.push({ result: { status: 'processing', ref: 'AW-PIN', payoutId: 'p16' } })")
    pg.click('#wd-confirm-btn')
    pg.wait_for_selector('.hh-pin-input', state='visible')
    check('no Security PIN on file: one is created first, on the PIN sheet', txt(pg, '.hh-pin-title') == 'Create your PIN', txt(pg, '.hh-pin-title'))
    # The create step has no button: the 4th digit moves on to "Confirm your PIN".
    pg.fill('.hh-pin-input', '2580'); pg.dispatch_event('.hh-pin-input', 'input')
    pg.wait_for_function("() => (document.querySelector('.hh-pin-title') || {}).textContent === 'Confirm your PIN'")
    enter_pin(pg, '2580')
    pg.wait_for_function("() => window.__fx.toasts.length > 0")
    check('…set by the server (setSecurityPin), then the same withdrawal is sent with it',
          pg.evaluate('window.__fx.callables') == [['setSecurityPin', {'pin': '2580'}]]
          and [c['pin'] for c in pg.evaluate('window.__fx.wcalls')] == ['2580']
          and pg.evaluate('window.__fx.toasts')[-1].startswith('GHS 20.00 to MTN MoMo 024 ••• 4567 has been requested.'),
          [pg.evaluate('window.__fx.callables'), pg.evaluate('window.__fx.wcalls'), pg.evaluate('window.__fx.toasts')])
    check('no page errors creating a PIN', not errs, errs)
    pg.close(); ctx.close()

    # ═══ 6. Without an account, without data ═════════════════════════════════
    ctx = new_ctx(b); docs = copy.deepcopy(DOCS); del docs['artisans/A1/private/kyc']
    pg, errs = open_page(ctx, docs=docs); emit(pg, BASE); pg.wait_for_timeout(300)
    check('no payout account on file: Withdraw is off, and the screen says how to add one',
          pg.is_disabled('#withdraw-btn') and txt(pg, '#withdraw-why') == 'You have no payout account on file. Contact support to add one. Contact support'
          and pg.query_selector('#withdraw-why a[href="support.html"]') is not None, txt(pg, '#withdraw-why'))
    pg.close(); ctx.close()

    ctx = new_ctx(b); pg, errs = open_page(ctx)
    pg.evaluate('() => window.__fx.failWallet()'); pg.wait_for_timeout(200)
    check('nothing cached and Fidus X unreachable: said plainly, with Retry — never a zero balance',
          'can\'t be shown yet' in txt(pg, '#earn-notices') and 'GHS 0.00' not in pg.text_content('#earn-body')
          and pg.query_selector('#earn-notices button') is not None, txt(pg, '#earn-notices'))
    pg.close(); ctx.close()

    ctx = new_ctx(b); pg, errs = open_page(ctx)
    emit(pg, {'artisan': {'availableBalance': 0, 'totalEarned': 0, 'withdrawnTotal': 0}, 'escrows': [], 'payouts': [], 'txns': []}); pg.wait_for_timeout(300)
    check('a new artisan: zeros from the records, empty states in words, nothing invented',
          txt(pg, '#available-balance') == 'GHS 0.00' and 'No withdrawals yet.' in txt(pg, '#earn-body') and 'No activity yet.' in txt(pg, '#earn-body')
          and 'Nothing is held for you right now.' in txt(pg, '#earn-body') and pg.query_selector('section[aria-labelledby="earn-fees"]') is None
          and txt(pg, '#withdraw-why') == 'You can withdraw once you have GHS 5.00 available.', txt(pg, '#earn-body')[:300])
    shot(pg, 'new-artisan')
    pg.close(); ctx.close()

    b.close()
    _done = True
