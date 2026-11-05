"""FLOW-005 browser check: a job offer the server refuses as gone is retired on
every screen, and never handed a live button again.

Runs the REAL artisan dashboard.html, jobs.html and job.html in Chromium. The
domain modules (bookingActions, jobOffers, bookingTruth, bookingSchedule,
instantView...) are the real ones; Firebase, auth, the database container,
pricing and side services are in-page fakes.

Network: NONE. Pages are served from the fake origin http://fx.test by
Playwright routing - every request to it is fulfilled from this checkout or a
stub, and EVERY other host (fonts, CDNs, Google, Firebase) is aborted. No
server, no port, no emulator, nothing can reach production. (Not localhost:
devAccess.js treats localhost as development and would change the auth path
under test.)

    python -I tests/e2e/offer_refusal.py            # this checkout
    python -I tests/e2e/offer_refusal.py <root>     # e.g. a checkout of e9735ba

26/26 at 27e5dcc; e9735ba (before FLOW-005) fails 14 of the same checks.
"""
import sys, re, json, pathlib, mimetypes, atexit
from playwright.sync_api import sync_playwright
sys.stdout.reconfigure(encoding='utf-8')

ROOT = (pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else pathlib.Path(__file__).resolve().parents[2]).resolve()
ORIGIN = 'http://fx.test'

results = []
def check(name, cond, detail=''):
    results.append((name, bool(cond), detail))
_done = False
def _report():
    ok = sum(1 for _, c, _ in results if c)
    for n, c, d in results:
        print(f"  {'PASS' if c else 'FAIL'}  {n}" + ('' if c else f"   [{str(d)[:200]}]"))
    print(f"offer-refusal browser: {ok} passed, {len(results) - ok} failed" + ('' if _done else '  (aborted early)'))
atexit.register(_report)

# ── In-page fakes ────────────────────────────────────────────────────────────
INIT = r"""
(() => {
  const fx = window.__fx = { colCbs: {}, docCbs: {}, docErrs: {}, docs: {}, calls: [], refuse: null, intervals: new Set() };
  // Count live intervals so duplicate tickers and pagehide teardown are visible.
  const si = window.setInterval.bind(window), ci = window.clearInterval.bind(window);
  window.setInterval = (fn, ms, ...a) => { const id = si(fn, ms, ...a); fx.intervals.add(id); return id; };
  window.clearInterval = (id) => { fx.intervals.delete(id); return ci(id); };
  window.confirm = () => true;
  const any = () => new Proxy(function () {}, {
    get: (t, k) => (k === 'then' ? undefined : k === Symbol.toPrimitive ? () => '' : any()),
    apply: () => any(),
  });
  fx.any = any;
  fx.db = {
    subscribeToCollection(name, cond, opts, onChange, onErr) { (fx.colCbs[name] ||= []).push(onChange); return () => {}; },
    subscribeToDocument(name, id, onChange, onErr) {
      const k = `${name}/${id}`; (fx.docCbs[k] ||= []).push(onChange); (fx.docErrs[k] ||= []).push(onErr);
      return () => {};
    },
    async getDocument(name, id) { const d = fx.docs[`${name}/${id}`]; return d ? { exists: true, id, data: d } : { exists: false, id, data: null }; },
    async updateDocument() {}, async setDocument() {}, async addDocument() { return 'x'; },
    subscribeToSubCollection() { return () => {}; },
  };
  fx.pricing = new Proxy({
    async respondToJobOffer(bookingId, decision) {
      fx.calls.push([bookingId, decision]);
      const r = fx.refuse;
      if (r) throw Object.assign(new Error(r.message), { code: `functions/${r.code}`, details: r.reason ? { reason: r.reason } : undefined });
      return { status: decision === 'accept' ? 'accepted' : 'rejected' };
    },
  }, { get: (t, k) => (k in t ? t[k] : (k === 'then' ? undefined : any())) });
})();
"""

ARTISAN = {'uid': 'A1', 'id': 'A1', 'userType': 'artisan', 'status': 'active', 'verificationStatus': 'approved',
           'name': 'Kofi', 'email': 'a@x.test', 'isAvailable': True, 'availability': 'online'}

SPECIFIC = {
    '/shared/js/app/container.js':
        "export function getAppContainer(){ const fx = window.__fx; return { services: new Proxy({ databaseService: fx.db, pricingService: fx.pricing }, { get:(t,k)=> k in t ? t[k] : fx.any() }) }; }",
    '/shared/js/services/pricingService.js': "export const pricingService = window.__fx.pricing; export default window.__fx.pricing;",
    '/artisan-app/js/utils/artisanAuthGuard.js': f"""
const A = {json.dumps(ARTISAN)};
const U = {{ uid: 'A1', email: 'a@x.test', emailVerified: true }};
export async function requireArtisanAuth(){{ return {{ user: U, artisan: A }}; }}
export function canAcceptJobs(a){{ return !!a && a.verificationStatus === 'approved' && a.status === 'active'; }}
export function subscribeToArtisanAuthState(cb){{ setTimeout(() => cb(U), 0); return () => {{}}; }}
export function signOutArtisan(){{}}
""",
}
# Modules faked with catch-alls (their export names are read from the importing page).
CATCH_ALL = re.compile(r'^/shared/(vendor/firebase/|js/backend/|dev/)|^/shared/js/services/(callable|presenceService|pushNotificationService|cloudinaryService|notificationRepository)\.js$'
                       r'|^/shared/js/data/repositories/|^/shared/js/ui/quoteComposer\.js$')
EMPTY = {'/shared/js/utils/global-app.js', '/shared/js/utils/themeManager.js', '/shared/js/components/fastLoader.js',
         '/artisan-app/js/artisanFloatingNav.js', '/artisan-app/js/pwa.js'}

def import_names(page_src, module_tail):
    names = set()
    for m in re.finditer(r'import\s*\{([^}]*)\}\s*from\s*[\'"]([^\'"]+)[\'"]', page_src):
        if m.group(2).endswith(module_tail):
            for part in m.group(1).split(','):
                part = part.strip()
                if part: names.add(part.split(' as ')[0].strip())
    for m in re.finditer(r'import\s+\*\s+as\s+\w+\s+from\s*[\'"]([^\'"]+)[\'"]', page_src):
        if m.group(1).endswith(module_tail): names.add('*')
    return names

def all_sources():
    srcs = []
    for p in list((ROOT / 'artisan-app').glob('*.html')) + list((ROOT / 'shared' / 'js').rglob('*.js')):
        try: srcs.append(p.read_text(encoding='utf-8', errors='ignore'))
        except Exception: pass
    return '\n'.join(srcs)
ALL_SRC = all_sources()

def route(r):
    url = r.request.url
    if not url.startswith(ORIGIN): return r.abort()
    p = url[len(ORIGIN):].split('?')[0]
    js = lambda body: r.fulfill(status=200, content_type='text/javascript', body=body)
    if p in SPECIFIC: return js(SPECIFIC[p])
    if p in EMPTY: return js('')
    if CATCH_ALL.search(p):
        names = import_names(ALL_SRC, p.split('/')[-1]) - {'*'}
        body = ''.join(f'export const {n} = window.__fx.any();\n' for n in sorted(names) if n.isidentifier())
        return js(body + 'export default window.__fx.any();')
    f = ROOT / p.lstrip('/')
    if not f.is_file(): return r.fulfill(status=404, body='')
    ctype = 'text/javascript' if f.suffix in ('.js', '.mjs') else (mimetypes.guess_type(str(f))[0] or 'application/octet-stream')
    return r.fulfill(status=200, content_type=ctype, body=f.read_bytes())

def offer(bid, now_ms, secs=None, prematched=False):
    d = {'bookingId': bid, 'artisanId': 'A1', 'offerStatus': 'open', 'status': 'pending', 'prematched': prematched,
         'round': None if prematched else 1, 'serviceType': 'plumbing', 'track': 'inspection', 'calloutFee': 60,
         'locationApproximate': True, 'distanceKm': 2.4, 'customerFirstName': 'Ama',
         'expiresAtMs': None if (prematched or secs is None) else now_ms + secs * 1000,
         'offeredAt': '2026-10-28T09:00:00.000Z', 'createdAt': '2026-10-28T09:00:00.000Z'}
    return d

def open_page(b, path):
    ctx = b.new_context(viewport={'width': 430, 'height': 900})
    ctx.add_init_script(INIT)
    pg = ctx.new_page()
    errors = []
    pg.on('pageerror', lambda e: errors.append(str(e)))
    pg.route('**/*', route)
    pg.set_default_timeout(4000)
    pg.goto(f'{ORIGIN}{path}', wait_until='domcontentloaded')
    return pg, errors

now = lambda pg: pg.evaluate('Date.now()')
emit_offers = lambda pg, recs: pg.evaluate("(r) => (window.__fx.colCbs.job_offers || []).forEach(cb => cb(r.map(d => ({ id: d.bookingId, data: d })), { fromCache: false }))", recs)
live_intervals = lambda pg: pg.evaluate('window.__fx.intervals.size')
def btn_state(pg, sel):
    r = pg.evaluate("(s) => { const b = document.querySelector(s); return b && { text: b.textContent.trim(), disabled: b.disabled, opacity: b.style.opacity, html: b.innerHTML }; }", sel)
    return r or {'text': None, 'disabled': None, 'opacity': None, 'html': ''}
def wait_lapsed(pg, sel, ms=4000):
    """Wait (up to ms) for an offer's Accept to be retired: tickers run once a second."""
    try:
        pg.wait_for_function("(s) => { const b = document.querySelector(s); return b && b.disabled && b.textContent.trim() === 'Expired'; }",
                             arg=sel, timeout=ms)
    except Exception:
        pass   # the check that follows reports the state it found
def text_of(pg, sel):
    return pg.evaluate("(s) => { const e = document.querySelector(s); return e ? e.textContent.trim() : ''; }", sel)

with sync_playwright() as pw:
    b = pw.chromium.launch()

    # ═══ DASHBOARD ════════════════════════════════════════════════════════════
    pg, errs = open_page(b, '/artisan-app/dashboard.html')
    pg.wait_for_function("(window.__fx.colCbs.job_offers || []).length > 0", timeout=15000)
    # The live profile (so acceptJob's KYC gate sees an approved, active artisan).
    pg.wait_for_function("(window.__fx.docCbs['artisans/A1'] || []).length > 0", timeout=5000)
    pg.evaluate("(a) => window.__fx.docCbs['artisans/A1'].forEach(cb => cb({ id: 'A1', exists: true, data: a, fromCache: false, hasPendingWrites: false }))", ARTISAN)
    t = now(pg)
    emit_offers(pg, [offer('B1', t, 120), offer('B2', t, 2), offer('B3', t, prematched=True)])
    pg.wait_for_selector('#job-B1 .btn-accept')
    check('dashboard: an open offer shows Accept and a countdown from formatTimeLeft',
          btn_state(pg, '#job-B1 .btn-accept')['disabled'] is False and re.match(r'^\d:\d\d$|^\d+s$', text_of(pg, '#job-B1 [data-countdown], #job-countdown-B1')),
          text_of(pg, '#job-B1 [data-countdown], #job-countdown-B1'))
    check('dashboard: a prematched offer (no deadline) has no countdown and stays answerable',
          pg.query_selector('#job-B3 [data-countdown]') is None and btn_state(pg, '#job-B3 .btn-accept')['disabled'] is False)
    wait_lapsed(pg, '#job-B2 .btn-accept')
    a, d = btn_state(pg, '#job-B2 .btn-accept'), btn_state(pg, '#job-B2 .btn-decline')
    check('dashboard: at expiresAtMs the ticker retires the card: Accept "Expired", BOTH disabled, opacity .5',
          a['text'] == 'Expired' and a['disabled'] and d['disabled'] and a['opacity'] == '0.5', (a, d))
    for _ in range(3): emit_offers(pg, [offer('B1', t, 120), offer('B3', t, prematched=True)])
    check('dashboard: re-rendering the list never adds a second ticker', live_intervals(pg) <= 2, live_intervals(pg))

    pg.evaluate("window.__fx.refuse = { code: 'failed-precondition', reason: 'expired', message: 'This request has expired and has been offered to another professional.' }")
    pg.click('#job-B1 .btn-accept')
    pg.wait_for_timeout(600)
    a, d = btn_state(pg, '#job-B1 .btn-accept'), btn_state(pg, '#job-B1 .btn-decline')
    check('dashboard: refused as expired → Accept "Expired", both disabled, NOT restored',
          a['text'] == 'Expired' and a['disabled'] and d['disabled'], (a, d))
    emit_offers(pg, [offer('B1', t, 120), offer('B3', t, prematched=True)])   # server still says "open"
    a = btn_state(pg, '#job-B1 .btn-accept')
    check('dashboard: the next snapshot (offer still "open" on the server) keeps it lapsed', a['text'] == 'Expired' and a['disabled'], a)

    pg.evaluate("window.__fx.refuse = { code: 'failed-precondition', reason: 'closed', message: 'This request is no longer open.' }")
    pg.click('#job-B3 .btn-decline')
    # Decline asks first in the app's own sheet since UI-011 (fc9c188, after this
    # test was written); the window.confirm stub above no longer answers it.
    pg.click('.ui-sheet-overlay.open .ui-sheet .ds-btn--danger, .ui-sheet-overlay.open .ui-sheet .ds-btn--primary')
    pg.wait_for_timeout(600)
    a, d = btn_state(pg, '#job-B3 .btn-accept'), btn_state(pg, '#job-B3 .btn-decline')
    check('dashboard: a prematched offer refused on DECLINE ("closed") → lapsed; Decline label not left "Declining…"',
          a['disabled'] and d['disabled'] and d['text'] == 'Decline' and a['text'] == 'Expired', (a, d))

    emit_offers(pg, [offer('B4', t, 300)])
    pg.wait_for_selector('#job-B4 .btn-accept')
    pg.evaluate("window.__fx.refuse = { code: 'unavailable', reason: null, message: 'unavailable' }")
    pg.click('#job-B4 .btn-accept')
    pg.wait_for_timeout(600)
    a = btn_state(pg, '#job-B4 .btn-accept')
    check('dashboard: a network failure gives Accept back exactly as drawn ("Accept", with its icon)',
          a['text'] == 'Accept' and not a['disabled'] and '<svg' in a['html'], a)

    pg.evaluate("window.dispatchEvent(new Event('pagehide'))")
    check('dashboard: pagehide clears the offer ticker', pg.evaluate("window.__fx.intervals.size") <= 1 and not pg.evaluate('typeof _offerTicker') == 'number',
          pg.evaluate('window.__fx.intervals.size'))
    check('dashboard: no page errors', not errs, errs[:3])
    pg.context.close()

    # ═══ JOBS LIST ════════════════════════════════════════════════════════════
    pg, errs = open_page(b, '/artisan-app/jobs.html')
    pg.wait_for_function("(window.__fx.colCbs.job_offers || []).length > 0", timeout=15000)
    t = now(pg)
    emit_offers(pg, [offer('J1', t, 120), offer('J2', t, 2), offer('J3', t, prematched=True)])
    pg.wait_for_selector('#jcard-J1 .job-btn-accept')
    tickers0 = live_intervals(pg)
    check('jobs: an open offer shows Accept (with icon) and a countdown',
          '<svg' in btn_state(pg, '#jcard-J1 .job-btn-accept')['html'] and pg.query_selector('#jcard-J1 .job-countdown') is not None)
    check('jobs: a prematched offer has no countdown and stays answerable',
          pg.query_selector('#jcard-J3 .job-countdown') is None and btn_state(pg, '#jcard-J3 .job-btn-accept')['disabled'] is False)
    wait_lapsed(pg, '#jcard-J2 .job-btn-accept')
    a, d = btn_state(pg, '#jcard-J2 .job-btn-accept'), btn_state(pg, '#jcard-J2 .job-btn-decline')
    check('jobs: at expiresAtMs the card wears the SAME lapsed look (accept-styled "Expired", both disabled, .5)',
          a and a['text'] == 'Expired' and a['disabled'] and d['disabled'] and a['opacity'] == '0.5', (a, d))
    check('jobs: one ticker, not one per render', live_intervals(pg) == tickers0, (tickers0, live_intervals(pg)))

    pg.evaluate("window.__fx.refuse = { code: 'permission-denied', reason: 'not_offered', message: 'This job request is not offered to you.' }")
    pg.click('#jcard-J1 .job-btn-accept')
    pg.wait_for_timeout(600)
    a, d = btn_state(pg, '#jcard-J1 .job-btn-accept'), btn_state(pg, '#jcard-J1 .job-btn-decline')
    check('jobs: refused as not_offered → lapsed, both disabled, NOT restored, countdown removed',
          a['text'] == 'Expired' and a['disabled'] and d['disabled'] and pg.query_selector('#jcard-J1 .job-countdown') is None, (a, d))

    emit_offers(pg, [offer('J5', t, 300)])
    pg.wait_for_selector('#jcard-J5 .job-btn-accept')
    pg.evaluate("window.__fx.refuse = { code: 'unavailable', reason: null, message: 'unavailable' }")
    pg.click('#jcard-J5 .job-btn-accept')
    pg.wait_for_timeout(600)
    a = btn_state(pg, '#jcard-J5 .job-btn-accept')
    check('jobs: a network failure restores Accept WITH its icon (textContent used to drop it)',
          not a['disabled'] and '<svg' in a['html'] and 'Accept' in a['text'], a)
    pg.evaluate("window.dispatchEvent(new Event('pagehide'))")
    check('jobs: pagehide clears the ticker', live_intervals(pg) < tickers0, (tickers0, live_intervals(pg)))
    check('jobs: no page errors', not errs, errs[:3])
    pg.context.close()

    # ═══ JOB SCREEN ═══════════════════════════════════════════════════════════
    def job_screen(bid, offer_doc, refuse):
        pg, errs = open_page(b, f'/artisan-app/job.html?id={bid}')
        pg.wait_for_function(f"(window.__fx.docErrs['bookings/{bid}'] || []).length > 0", timeout=15000)
        pg.evaluate(f"window.__fx.docErrs['bookings/{bid}'].forEach(e => e({{ code: 'permission-denied', message: 'permission-denied' }}))")
        pg.wait_for_function(f"(window.__fx.docCbs['job_offers/{bid}'] || []).length > 0", timeout=5000)
        emit = lambda: pg.evaluate("([k, d]) => window.__fx.docCbs[k].forEach(cb => cb({ exists: true, id: d.bookingId, data: d }))", [f'job_offers/{bid}', offer_doc])
        emit()
        pg.wait_for_selector('#jb-primary')
        before = btn_state(pg, '#jb-primary')
        pg.evaluate(f"window.__fx.refuse = {json.dumps(refuse)}")
        pg.click('#jb-primary')
        pg.wait_for_timeout(700)
        return pg, errs, before, emit

    t = int(__import__('time').time() * 1000)
    pg, errs, before, emit = job_screen('K1', offer('K1', t, 120), {'code': 'failed-precondition', 'reason': 'expired', 'message': 'This request has expired and has been offered to another professional.'})
    a, d = btn_state(pg, '.jb-actions .jb-primary'), btn_state(pg, '.jb-actions .jb-sec-btn')
    live_accept = pg.evaluate("[...document.querySelectorAll('button')].some(x => !x.disabled && /Accept/.test(x.textContent))")
    check('job: before, "Accept this job" is live', before['text'].startswith('Accept') and not before['disabled'], before)
    check('job: refused as expired → the SAME lapsed look, both disabled; finally does NOT re-enable Accept',
          a['text'] == 'Expired' and a['disabled'] and d['disabled'] and a['opacity'] == '0.5' and not live_accept, (a, d, live_accept))
    emit(); pg.wait_for_timeout(300)
    check('job: the next offer snapshot keeps it lapsed', btn_state(pg, '.jb-actions .jb-primary')['text'] == 'Expired')
    check('job: the countdown stopped (no live offer ticker)', pg.query_selector('#jb-countdown') is None)
    check('job: no page errors', not errs, errs[:3])
    pg.context.close()

    pg, errs, before, emit = job_screen('K2', offer('K2', t, prematched=True), {'code': 'failed-precondition', 'reason': 'closed', 'message': 'This request is no longer open.'})
    check('job: a prematched offer shows no countdown before answering', before and not before['disabled'])
    a = btn_state(pg, '.jb-actions .jb-primary')
    check('job: a prematched offer refused ("closed") is retired too', a['text'] == 'Expired' and a['disabled'], a)
    pg.context.close()

    pg, errs, before, emit = job_screen('K3', offer('K3', t, 120), {'code': 'unavailable', 'reason': None, 'message': 'unavailable'})
    a = btn_state(pg, '#jb-primary')
    check('job: a network failure gives "Accept this job" back (not gone)', a and a['text'].startswith('Accept') and not a['disabled'], a)
    pg.context.close()

    b.close()

_done = True
sys.exit(0 if all(c for _, c, _ in results) else 1)
