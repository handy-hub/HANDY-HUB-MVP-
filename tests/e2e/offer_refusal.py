"""FLOW-005 browser check: a job offer the server refuses as gone is retired on
every screen, and never handed a live button again.

Runs the REAL artisan Today (dashboard.html), jobs.html and job.html in Chromium. The
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
  const fx = window.__fx = { colCbs: {}, docCbs: {}, docErrs: {}, docs: {}, calls: [], refuse: null, delay: 0, avail: [], toasts: [], intervals: new Set() };
  // Every toast the page shows, as it appears (they dismiss themselves).
  document.addEventListener('DOMContentLoaded', () => new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) {
    if (n.nodeType === 1 && n.classList.contains('fx-toast')) fx.toasts.push(n.querySelector('.fx-toast__text').textContent.trim()); } })
    .observe(document.body, { childList: true, subtree: true }));
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
      if (fx.delay) await new Promise((r) => setTimeout(r, fx.delay));
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
    # Availability is the artisan's explicit choice: record what the page asks for.
    '/shared/js/services/presenceService.js':
        "export function startPresence(){} export function stopPresence(){} export function syncAvailability(){} export function ensurePresence(){}"
        " export function availabilityPending(){ return false; }"
        " export async function setAvailability(uid, next){ window.__fx.avail.push(next); return { ok: true }; } export default {};",
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
CATCH_ALL = re.compile(r'^/shared/(vendor/firebase/|js/backend/|dev/)|^/shared/js/services/(callable|pushNotificationService|cloudinaryService|notificationRepository)\.js$'
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

    # ═══ TODAY (dashboard.html, Phase 2) ═════════════════════════════════════
    # The real page, its real data wiring (instantView, the offers / bookings /
    # profile listeners, performBookingAction, the countdown ticker), drawn by
    # the real artisan-app/js/today.js. Only Firebase and the server are fakes.
    pg, errs = open_page(b, '/artisan-app/dashboard.html')
    pg.wait_for_function("(window.__fx.colCbs.job_offers || []).length > 0 && (window.__fx.colCbs.bookings || []).length > 0", timeout=15000)
    pg.wait_for_function("(window.__fx.docCbs['artisans/A1'] || []).length > 0", timeout=5000)
    emit_profile = lambda a: pg.evaluate("(a) => window.__fx.docCbs['artisans/A1'].forEach(cb => cb({ id: 'A1', exists: true, data: a, fromCache: false, hasPendingWrites: false }))", a)
    emit_bookings = lambda recs: pg.evaluate("(r) => (window.__fx.colCbs.bookings || []).forEach(cb => cb(r.map(d => ({ id: d.id, data: d })), { fromCache: false }))", recs)
    toasts = lambda: pg.evaluate('window.__fx.toasts.slice()')
    clear_toasts = lambda: pg.evaluate('window.__fx.toasts.length = 0')
    mode = lambda: pg.evaluate("(document.querySelector('#today-state > section') || {}).dataset?.mode || null")
    shown_offer = lambda: pg.evaluate("(document.querySelector('#today-state [data-offer]') || {}).dataset?.offer || null")
    calls = lambda: pg.evaluate('window.__fx.calls.slice()')
    ACC, DEC = '#today-dock [data-act="accept"]', '#today-dock [data-act="decline"]'

    emit_profile(ARTISAN)
    emit_bookings([])
    t = now(pg)
    emit_offers(pg, [offer('B1', t, 120)])
    pg.wait_for_selector(ACC)
    check('Today: an open offer takes the screen, with the server countdown and a live Accept',
          shown_offer() == 'B1' and btn_state(pg, ACC)['disabled'] is False and re.match(r'^\d:\d\d$', text_of(pg, '[data-countdown]')),
          (shown_offer(), text_of(pg, '[data-countdown]')))
    check('Today: no customer name on the offer (the document carries "Ama")', 'Ama' not in text_of(pg, 'body'))

    # Accept, tapped twice while the server is slow: one call, one answer.
    pg.evaluate("window.__fx.delay = 700; window.__fx.refuse = null; window.__fx.calls.length = 0")
    clear_toasts()
    pg.click(ACC)
    pg.wait_for_timeout(100)
    a = btn_state(pg, ACC)
    check('Today: while accepting, Accept reads "Accepting…" and both answers are disabled',
          a['text'] == 'Accepting…' and a['disabled'] and btn_state(pg, DEC)['disabled'], a)
    pg.click(ACC, force=True)
    pg.evaluate("(s) => document.querySelector(s)?.click()", ACC)
    pg.wait_for_timeout(900)
    check('Today: a second tap during the first sends nothing (one respondToJobOffer call)', calls() == [['B1', 'accept']], calls())
    check("Today: accepted → the confirmation is said", 'Job accepted. The customer will be notified.' in toasts(), toasts())
    # The server closes the offer and opens the booking to the artisan (visit fee pending).
    emit_offers(pg, [])
    emit_bookings([{'id': 'B1', 'artisanId': 'A1', 'status': 'accepted', 'track': 'inspection', 'calloutPaid': False, 'serviceType': 'plumbing', 'calloutFee': 60}])
    pg.wait_for_timeout(200)
    check('Today: after accepting, the job is listed as waiting on the customer (visit fee), not lost',
          mode() == 'online' and 'Waiting for the customer' in text_of(pg, '#today-lists'), (mode(), text_of(pg, '#today-lists')))
    check('Today: an offer this screen answered is not reported as withdrawn', 'That job request is no longer available.' not in toasts(), toasts())
    pg.evaluate("window.__fx.delay = 0")

    # Expiry on the clock: the offer leaves the screen with a sentence; the server is never asked.
    clear_toasts(); pg.evaluate("window.__fx.calls.length = 0")
    emit_offers(pg, [offer('B2', now(pg), 2)])
    pg.wait_for_selector('#today-state [data-offer="B2"]')
    pg.wait_for_timeout(3200)
    check('Today: at expiresAtMs the offer leaves the screen and says why', shown_offer() is None
          and 'That request expired and has been offered to another professional.' in toasts(), (shown_offer(), toasts()))
    check('Today: an expired offer is never sent to the server', calls() == [], calls())

    # Refused by the server as expired: gone, and a later "still open" snapshot does not bring it back.
    clear_toasts()
    emit_offers(pg, [offer('B3', now(pg), 120)])
    pg.wait_for_selector('#today-state [data-offer="B3"]')
    pg.evaluate("window.__fx.refuse = { code: 'failed-precondition', reason: 'expired', message: 'This request has expired and has been offered to another professional.' }")
    pg.click(ACC); pg.wait_for_timeout(500)
    check("Today: refused as expired → the server's words, and the offer leaves the screen",
          shown_offer() is None and 'This request has expired and has been offered to another professional.' in toasts(), (shown_offer(), toasts()))
    emit_offers(pg, [offer('B3', now(pg), 120)])   # the server's offer document still says "open"
    pg.wait_for_timeout(200)
    check('Today: the next snapshot (offer still "open") does not bring it back', shown_offer() is None, shown_offer())

    # A network failure gives the answer back, unchanged.
    pg.evaluate("window.__fx.refuse = { code: 'unavailable', reason: null, message: 'unavailable' }")
    emit_offers(pg, [offer('B4', now(pg), 300)])
    pg.wait_for_selector('#today-state [data-offer="B4"]')
    pg.click(ACC); pg.wait_for_timeout(500)
    a = btn_state(pg, ACC)
    check('Today: a network failure leaves the offer answerable ("Accept", enabled)', shown_offer() == 'B4' and a['text'] == 'Accept' and not a['disabled'], a)

    # Decline asks first, in the app's own sheet; "Keep it" sends nothing.
    pg.evaluate("window.__fx.refuse = null; window.__fx.calls.length = 0")
    clear_toasts()
    pg.click(DEC)
    pg.wait_for_selector('#decline-sheet:not([hidden]) [role="dialog"]')
    pg.click('#decline-sheet [data-sheet-close]')
    pg.wait_for_timeout(450)
    check('Today: Decline opens a confirmation; "Keep it" sends nothing', calls() == [] and shown_offer() == 'B4', calls())
    pg.click(DEC)
    pg.wait_for_selector('#decline-sheet:not([hidden]) [data-confirm]')
    pg.click('#decline-sheet [data-confirm]'); pg.wait_for_timeout(600)
    check('Today: confirming declines it, once', calls() == [['B4', 'decline']] and 'Request declined.' in toasts(), (calls(), toasts()))
    emit_offers(pg, [])

    # Withdrawn while on screen (customer cancelled, or re-offered): said, without inventing a reason.
    clear_toasts()
    emit_offers(pg, [offer('B5', now(pg), 300)])
    pg.wait_for_selector('#today-state [data-offer="B5"]')
    emit_offers(pg, [])
    pg.wait_for_timeout(200)
    check('Today: an offer withdrawn while on screen → "no longer available", and Today moves on',
          shown_offer() is None and 'That job request is no longer available.' in toasts(), (shown_offer(), toasts()))

    # Mid-job (decision Q3): the offer leads and names the job under way; then the job's step.
    J1 = {'id': 'J1', 'artisanId': 'A1', 'status': 'en_route', 'track': 'inspection', 'calloutPaid': True, 'serviceType': 'electrical', 'calloutFee': 60}
    pg.evaluate("(d) => { window.__fx.docs['bookings/J1'] = d; }", J1)
    emit_bookings([J1])
    emit_offers(pg, [offer('B6', now(pg), 300)])
    pg.wait_for_selector('#today-state [data-offer="B6"]')
    check('Today (Q3): an offer during a job leads, and says a job is under way', 'You have a job under way' in text_of(pg, '#today-state'))
    check('Today: the availability control stays in the app bar while the offer owns the screen', text_of(pg, '#avail-btn') == 'Online')
    emit_offers(pg, [])
    pg.wait_for_selector('#today-dock [data-act="job-arrived"]')
    check('Today: with no offer, the job owns the screen with its one step (Mark arrived)',
          mode() == 'job' and text_of(pg, '#today-dock [data-act="job-arrived"]') == 'Mark arrived')
    clear_toasts()
    pg.click('#today-dock [data-act="job-arrived"]'); pg.wait_for_timeout(600)
    check('Today: Mark arrived goes through performBookingAction and says so', 'Job started. Customer notified.' in toasts(), toasts())

    # Availability: stop receiving offers asks first, then saves through setAvailability.
    pg.evaluate("window.__fx.avail.length = 0")
    pg.click('#avail-btn')
    pg.wait_for_selector('#offline-sheet:not([hidden]) [data-confirm]')
    pg.click('#offline-sheet [data-sheet-close]'); pg.wait_for_timeout(450)
    check('Today: "Stay online" keeps availability untouched', pg.evaluate('window.__fx.avail.slice()') == [])
    pg.click('#avail-btn')
    pg.wait_for_selector('#offline-sheet:not([hidden]) [data-confirm]')
    pg.click('#offline-sheet [data-confirm]'); pg.wait_for_timeout(400)
    check('Today: "Go offline" saves false through setAvailability', pg.evaluate('window.__fx.avail.slice()') == [False], pg.evaluate('window.__fx.avail.slice()'))
    emit_profile(dict(ARTISAN, isAvailable=False))
    emit_bookings([])
    pg.wait_for_selector('#today-dock [data-act="go-online"]')
    pg.click('#today-dock [data-act="go-online"]'); pg.wait_for_timeout(400)
    check("Today: offline, the dock's Go online saves true", pg.evaluate('window.__fx.avail.slice()') == [False, True], pg.evaluate('window.__fx.avail.slice()'))

    pg.evaluate("window.dispatchEvent(new Event('pagehide'))")
    check('Today: pagehide clears the offer ticker and the clock', pg.evaluate("window.__fx.intervals.size") == 0, pg.evaluate('window.__fx.intervals.size'))
    check('Today: no page errors', not errs, errs[:3])
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
    # job.html (Phase 2, on the design system): the offer summary until the
    # artisan accepts, then the booking itself.
    JACC = '#jb-dock [data-act="accept"]'
    def job_screen(bid, offer_doc, refuse):
        pg, errs = open_page(b, f'/artisan-app/job.html?id={bid}')
        pg.wait_for_function(f"(window.__fx.docErrs['bookings/{bid}'] || []).length > 0", timeout=15000)
        pg.evaluate(f"window.__fx.docErrs['bookings/{bid}'].forEach(e => e({{ code: 'permission-denied', message: 'permission-denied' }}))")
        pg.wait_for_function(f"(window.__fx.docCbs['job_offers/{bid}'] || []).length > 0", timeout=5000)
        emit = lambda: pg.evaluate("([k, d]) => window.__fx.docCbs[k].forEach(cb => cb({ exists: true, id: d.bookingId, data: d }))", [f'job_offers/{bid}', offer_doc])
        emit()
        pg.wait_for_selector(JACC)
        before = btn_state(pg, JACC)
        body = text_of(pg, '#jb-body')
        pg.evaluate(f"window.__fx.refuse = {json.dumps(refuse)}")
        pg.click(JACC)
        pg.wait_for_timeout(700)
        return pg, errs, before, emit, body

    t = int(__import__('time').time() * 1000)
    pg, errs, before, emit, body = job_screen('K1', offer('K1', t, 120), {'code': 'failed-precondition', 'reason': 'expired', 'message': 'This request has expired and has been offered to another professional.'})
    a, d = btn_state(pg, '#jb-dock .fx-btn--primary'), btn_state(pg, '#jb-dock .fx-btn--secondary')
    live_accept = pg.evaluate("[...document.querySelectorAll('button')].some(x => !x.disabled && /Accept/.test(x.textContent))")
    check('job: before, "Accept this job" is live', before['text'].startswith('Accept') and not before['disabled'], before)
    check('job: an unaccepted offer names nobody and shows no address (the document carries "Ama")',
          'Ama' not in body and 'Exact address shared once you accept.' in body, body[:200])
    check('job: refused as expired → the shared lapsed state, both disabled; the finally does NOT re-enable Accept',
          a['text'] == 'Expired' and a['disabled'] and d['disabled'] and not live_accept, (a, d, live_accept))
    check('job: the lapsed look is the design system\'s disabled state (no inline style)', a['opacity'] == '' and d['opacity'] == '', (a, d))
    emit(); pg.wait_for_timeout(300)
    check('job: the next offer snapshot keeps it lapsed', btn_state(pg, '#jb-dock .fx-btn--primary')['text'] == 'Expired')
    check('job: the countdown stopped (no live offer ticker)', pg.query_selector('#jb-countdown') is None)
    check('job: no page errors', not errs, errs[:3])
    pg.context.close()

    pg, errs, before, emit, body = job_screen('K2', offer('K2', t, prematched=True), {'code': 'failed-precondition', 'reason': 'closed', 'message': 'This request is no longer open.'})
    check('job: a prematched offer shows no countdown before answering', before and not before['disabled'] and 'No countdown' in body, body[:160])
    a = btn_state(pg, '#jb-dock .fx-btn--primary')
    check('job: a prematched offer refused ("closed") is retired too', a['text'] == 'Expired' and a['disabled'], a)
    pg.context.close()

    pg, errs, before, emit, body = job_screen('K3', offer('K3', t, 120), {'code': 'unavailable', 'reason': None, 'message': 'unavailable'})
    a = btn_state(pg, JACC)
    check('job: a network failure gives "Accept this job" back (not gone)', a and (a['text'] or '').startswith('Accept') and not a['disabled'], a)
    pg.context.close()

    # Accepted: the offer stays "Accepting…" until the booking arrives, then the
    # booking is the screen — now naming the customer, with Cancel where allowed.
    pg, errs = open_page(b, '/artisan-app/job.html?id=K4')
    pg.wait_for_function("(window.__fx.docErrs['bookings/K4'] || []).length > 0", timeout=15000)
    pg.evaluate("window.__fx.docErrs['bookings/K4'].forEach(e => e({ code: 'permission-denied', message: 'permission-denied' }))")
    pg.wait_for_function("(window.__fx.docCbs['job_offers/K4'] || []).length > 0", timeout=5000)
    pg.evaluate("(d) => window.__fx.docCbs['job_offers/K4'].forEach(cb => cb({ exists: true, id: 'K4', data: d }))", offer('K4', t, 120))
    pg.wait_for_selector(JACC)
    pg.evaluate("window.__fx.refuse = null; window.__fx.delay = 0; window.__fx.calls.length = 0")
    pg.click(JACC); pg.wait_for_timeout(500)
    a = btn_state(pg, '#jb-dock .fx-btn--primary')
    check('job: after a successful accept, Accept is not handed back before the booking arrives', a['text'] == 'Accepting…' and a['disabled'], a)
    pg.wait_for_function("(window.__fx.docCbs['bookings/K4'] || []).length > 1", timeout=5000)
    K4 = {'artisanId': 'A1', 'status': 'accepted', 'track': 'inspection', 'calloutPaid': False, 'serviceType': 'plumbing',
          'calloutFee': 60, 'customerFirstName': 'Ama', 'address': '12 Ring Road', 'lat': 5.61, 'lng': -0.19}
    pg.evaluate("(d) => window.__fx.docCbs['bookings/K4'].forEach(cb => cb({ exists: true, id: 'K4', data: d }))", K4)
    pg.wait_for_selector('#jb-dock [data-act="cancel"]')
    check('job: the accepted booking takes over: the customer is named, Cancel is offered (visit fee unpaid)',
          'Ama' in text_of(pg, '#jb-body') and text_of(pg, '#jb-dock [data-act="cancel"]') == 'Cancel job')
    check('job: one accept call', pg.evaluate('window.__fx.calls.slice()') == [['K4', 'accept']], pg.evaluate('window.__fx.calls.slice()'))
    check('job: before the visit fee is paid, no Call or Message', pg.query_selector('a[href^="tel:"], a[href^="messages.html"]') is None
          and "The customer's number unlocks once the visit is funded." in text_of(pg, '#jb-body'))
    pg.click('#jb-dock [data-act="cancel"]')
    pg.wait_for_selector('#confirm-sheet:not([hidden]) [data-confirm]')
    check('job: Cancel asks first, in the app\'s own sheet', text_of(pg, '#confirm-title') == 'Cancel this job?')
    pg.click('#confirm-sheet [data-sheet-close]'); pg.wait_for_timeout(450)
    check('job: "Go back" cancels nothing', pg.evaluate('window.__fx.calls.slice()') == [['K4', 'accept']] and pg.query_selector('#jb-dock [data-act="cancel"]') is not None)
    # On the way to the inspection (quote not yet approved): the server still lets the artisan cancel.
    pg.evaluate("(d) => window.__fx.docCbs['bookings/K4'].forEach(cb => cb({ exists: true, id: 'K4', data: d }))", dict(K4, status='en_route', calloutPaid=True))
    pg.wait_for_selector('#jb-dock [data-act="arrived"]')
    check('job: en route to the inspection → Mark arrived, and Cancel (artisanCanCancel allows it before approval)',
          text_of(pg, '#jb-dock [data-act="arrived"]') == 'Mark arrived' and text_of(pg, '#jb-dock [data-act="cancel"]') == 'Cancel job')
    # On the way to approved work: the way out is Support — never a Cancel the server refuses.
    pg.evaluate("(d) => window.__fx.docCbs['bookings/K4'].forEach(cb => cb({ exists: true, id: 'K4', data: d }))", dict(K4, status='en_route', calloutPaid=True, quoteApproved=True, jobQuote=300))
    pg.wait_for_selector('#jb-dock [data-act="help"]')
    check('job: en route to approved work → Mark arrived, and "Get help with this job" instead of Cancel',
          text_of(pg, '#jb-dock [data-act="arrived"]') == 'Mark arrived' and text_of(pg, '#jb-dock [data-act="help"]') == 'Get help with this job'
          and pg.query_selector('#jb-dock [data-act="cancel"]') is None)
    check('job: funded and under way → Message the customer, inside the booking; Maps by link only',
          pg.get_attribute('a[href^="messages.html"]', 'href') == 'messages.html?bookingId=K4'
          and (pg.get_attribute('a[target="_blank"][href^="https://www.google.com/maps/"]', 'rel') or '') == 'noopener'
          and pg.query_selector('iframe') is None)
    check('job (accepted path): no page errors', not errs, errs[:3])
    pg.context.close()

    b.close()

_done = True
sys.exit(0 if all(c for _, c, _ in results) else 1)
