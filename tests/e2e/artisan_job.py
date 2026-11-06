"""Phase 2 browser checks: the artisan job screen, rendered, at every booking state.

The REAL artisan-app/job.html markup and stylesheets, drawn by the REAL
artisan-app/js/jobScreen.js (via tests/e2e/job_harness.html) from bookings in
the shapes the server writes, with a fixed clock. No Firebase: job.html's own
wiring (listeners, accept, refusal, cancel sheet) is driven in
tests/e2e/offer_refusal.py.

For each state: the one step offered (resolveJourney's, so only what the rules
accept), the way out (Cancel only where artisanCanCancel says the server
accepts it, otherwise Get help), the quote composer slot, contact and
navigation only once disclosed, the money as the server recorded it, and the
layout at 360 / 390 / 768 px and at 200% text.

Network: NONE (Playwright routing to the fake origin http://fx.test).

    python -I tests/e2e/artisan_job.py
    FX_SHOTS=<dir> python -I tests/e2e/artisan_job.py   # also save screenshots
"""
import os, sys, pathlib, mimetypes, atexit
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright
sys.stdout.reconfigure(encoding='utf-8')

ROOT = pathlib.Path(__file__).resolve().parents[2]
ORIGIN = 'http://fx.test'
URL = f'{ORIGIN}/tests/e2e/job_harness.html'
SHOTS = os.environ.get('FX_SHOTS')

results = []
def check(name, cond, detail=''):
    results.append((name, bool(cond), detail))
_done = False
def _report():
    ok = sum(1 for _, c, _ in results if c)
    for n, c, d in results:
        print(f"  {'PASS' if c else 'FAIL'}  {n}" + ('' if c else f"   [{str(d)[:300]}]"))
    print(f"artisan-job browser: {ok} passed, {len(results) - ok} failed" + ('' if _done else '  (aborted early)'))
    sys.stdout.flush(); sys.stderr.flush()
    if ok != len(results) or not _done:
        os._exit(1)
atexit.register(_report)

def route(r):
    u = urlparse(r.request.url)
    if f'{u.scheme}://{u.netloc}' != ORIGIN:
        return r.abort()
    f = (ROOT / u.path.lstrip('/')).resolve()
    if ROOT not in f.parents or not f.is_file():
        return r.fulfill(status=404, body='')
    ctype = 'text/javascript' if f.suffix in ('.js', '.mjs') else (mimetypes.guess_type(str(f))[0] or 'application/octet-stream')
    return r.fulfill(status=200, content_type=ctype, body=f.read_bytes())

NOW = 1_794_045_600_000            # 2026-11-07 10:00 Accra (UTC+0)
DAY = 86_400_000

def offer(**o):
    d = {'id': 'K1', 'bookingId': 'K1', 'artisanId': 'A1', 'offerStatus': 'open', 'status': 'pending', 'prematched': False,
         'serviceType': 'plumbing', 'description': 'Kitchen tap leaking under the sink', 'photos': ['https://res.example/a.jpg'],
         'track': 'inspection', 'calloutFee': 60, 'customerFirstName': 'Ama', 'lat': 5.61, 'lng': -0.19,
         'locationApproximate': True, 'distanceKm': 2.4, 'offeredAt': NOW - 60_000, 'expiresAtMs': NOW + 120_000}
    d.update(o); return d

def bk(status, **o):
    d = {'id': 'HHB-1', 'bookingId': 'HHB-261107-1000-A1B2', 'artisanId': 'A1', 'serviceType': 'electrical', 'track': 'inspection',
         'calloutFee': 60, 'calloutPaid': True, 'customerFirstName': 'Kofi', 'address': '4 Oxford Street, Osu',
         'lat': 5.556, 'lng': -0.182, 'description': 'Sockets in the kitchen spark when used', 'status': status}
    d.update(o); return d

PHONE = '+233200000001'
# name → (booking, expected primary act, expected secondary acts, extra expectations)
JOBS = {
    'awaiting-callout': (bk('accepted', calloutPaid=False), None, ['cancel'], {'contact': False, 'name': True}),
    'insp-due':         (bk('inspection_scheduled'), 'en-route', ['cancel'], {}),
    'insp-booked':      (bk('inspection_scheduled', scheduledForMs=NOW + 2 * DAY, scheduleWindowMins=180), None, ['cancel'], {'note': 'You can set out from'}),
    'insp-enroute':     (bk('en_route', customerPhone=PHONE), 'arrived', ['cancel'], {'contact': True, 'phone': True}),
    'insp-onsite':      (bk('in_progress', customerPhone=PHONE), 'complete-inspection', ['cancel'], {}),
    'insp-done':        (bk('inspection_done'), None, ['cancel'], {'quote': True}),
    'quoted':           (bk('quoted', jobQuote=300), None, ['cancel'], {}),
    'std-quote-first':  (bk('accepted', track='standard', calloutPaid=False), None, ['cancel'], {'quote': True}),
    'work-approved':    (bk('accepted', quoteApproved=True, jobQuote=300, artisanEarns=270), 'en-route', ['help'], {}),
    'work-onsite':      (bk('in_progress', quoteApproved=True, jobQuote=300, artisanEarns=270, customerPhone=PHONE), 'job-done', ['help'], {'money': 'GHS 270.00'}),
    'emerg-onsite':     (bk('in_progress', track='emergency', isEmergency=True), None, ['help'], {'quote': True}),
    'awaiting-confirm': (bk('awaiting', quoteApproved=True, jobQuote=300, artisanEarns=270), None, ['help'], {}),
    'disputed':         (bk('disputed', quoteApproved=True, jobQuote=300, artisanEarns=270), None, ['help'], {'chip': 'In dispute'}),
    'completed':        (bk('completed', quoteApproved=True, jobQuote=300, artisanEarns=270), None, ['earnings'], {'closed': True}),
    'cancelled':        (bk('cancelled'), None, ['help'], {'closed': True}),
    'removed':          (bk('completed', quoteApproved=True, jobQuote=300, artisanEarns=270, address=None, lat=None, lng=None,
                            locationRemovedAt='2026-11-21T00:00:00.000Z'), None, ['earnings'], {'closed': True, 'removed': True}),
}

OVERFLOW_JS = """() => { const w = document.documentElement.clientWidth; const bad = [];
  for (const el of document.querySelectorAll('body *')) { if (el.closest('[hidden]')) continue;
    const r = el.getBoundingClientRect(); if (r.width && (r.right > w + 0.5 || r.left < -0.5)) bad.push(el.tagName + '.' + [...el.classList].join('.') + ' ' + Math.round(r.left) + '..' + Math.round(r.right)); }
  return { scroll: document.documentElement.scrollWidth > w, bad: bad.slice(0, 5) }; }"""
TARGETS_JS = """() => { const out = [];
  for (const el of document.querySelectorAll('button, a[href]')) {
    if (el.closest('[hidden], .fx-skip, .fx-overlay')) continue;
    const r = el.getBoundingClientRect(); if (!r.width) continue;
    if (r.width < 43.5 || r.height < 43.5) out.push(el.tagName + ' "' + (el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 24) + '" ' + Math.round(r.width) + 'x' + Math.round(r.height)); }
  return out; }"""

with sync_playwright() as p:
    browser = p.chromium.launch()
    ctx = browser.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=1)
    ctx.route('**/*', route)
    page = ctx.new_page()
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(URL, wait_until='domcontentloaded')
    page.wait_for_selector('html[data-ready="true"]', timeout=15000)

    show = lambda b, **o: page.evaluate('([b, o]) => window.__job.show(b, o)', [b, dict({'nowMs': NOW}, **o)])
    txt = lambda sel: (page.inner_text(sel) if page.query_selector(sel) else '').strip()
    dock = lambda: page.eval_on_selector_all('#jb-dock .fx-btn', 'els => els.map(e => [e.dataset.act || null, e.textContent.trim(), e.disabled])')

    check('shell: the real job.html markup (back to Jobs, dock slot, confirm sheet)',
          page.get_attribute('#jb-back', 'href') == 'jobs.html' and page.query_selector('#jb-dock') and page.query_selector('#confirm-sheet [role="dialog"]'))

    # ── The offer, before the artisan accepts ────────────────────────────
    r = show(offer())
    body = txt('#jb-body')
    check('offer: the server countdown, the visit fee as charged, distance; Decline + Accept this job',
          r['kind'] == 'offer' and txt('[data-countdown]') == '2:00' and 'GHS 60.00' in body and 'Charged to the customer' in body
          and '2.4 km away' in body and dock() == [['decline', 'Decline', False], ['accept', 'Accept this job', False]], (r, dock()))
    check('offer: no name, address, position or map link; says the address comes after accepting',
          not any(s in page.inner_text('body') for s in ['Ama', 'Ring Road', '5.61', '-0.19']) and page.query_selector('a[href*="google.com/maps"]') is None
          and 'Exact address shared once you accept.' in body)
    check('offer: never calls the visit fee "your earnings" (decision 07 not approved)', not any(w in body.lower() for w in ['earn', 'you receive', 'your payment']), body[:300])
    check('offer: the customer\'s photo is shown', page.query_selector('#jb-body img.fx-job__photo') is not None)
    page.evaluate(f'() => window.__job.tick({NOW + 120_000})')
    check('offer: at expiresAtMs the countdown reads 0s, done', txt('[data-countdown]') == '0s' and page.get_attribute('.fx-countdown', 'data-urgency') == 'done')
    show(offer(expiresAtMs=NOW - 1))
    check('offer expired: says so; both answers disabled; Accept reads Expired',
          'This request has expired' in txt('#jb-body') and dock() == [[None, 'Decline', True], [None, 'Expired', True]], dock())
    show(offer(), offerGone=True)
    check('offer refused by the server: "no longer open to you", lapsed', 'no longer open to you' in txt('#jb-body') and dock()[1] == [None, 'Expired', True])
    show(offer(scheduledForMs=NOW + DAY, scheduleWindowMins=180, expiresAtMs=NOW + 1_200_000))
    check('scheduled offer: the commitment, and "Accept this slot"', 'Accepting commits you to arriving Tomorrow' in txt('#jb-body') and dock()[1][1] == 'Accept this slot')
    show(offer(prematched=True, expiresAtMs=None))
    check('customer-chosen offer: no countdown invented', page.query_selector('.fx-countdown') is None and 'No countdown' in txt('#jb-body'))
    show(offer(), busy='accept')
    check('accept in flight: "Accepting…", both disabled', dock() == [['decline', 'Decline', True], ['accept', 'Accepting…', True]], dock())

    # ── Every booking state ──────────────────────────────────────────────
    for name, (b, primary, secondary, x) in JOBS.items():
        r = show(b)
        acts = [a for a, _, _ in dock()]
        exp = secondary + ([primary] if primary else [])
        ok = r['primary'] == primary and r['secondary'] == secondary and acts == exp
        detail = (r, dock())
        body = txt('#jb-body')
        if x.get('quote'): ok = ok and page.query_selector('#jb-quote-mount') is not None and r['mountQuote']
        else: ok = ok and page.query_selector('#jb-quote-mount') is None
        if x.get('note'): ok = ok and x['note'] in body
        if x.get('chip'): ok = ok and txt('#jb-body .fx-chip') == x['chip']
        if x.get('money'): ok = ok and x['money'] in body
        if 'contact' in x:
            has_msg = page.query_selector('a[href="messages.html?bookingId=HHB-1"]') is not None
            ok = ok and has_msg == x['contact'] and (("unlocks once the visit is funded" in body) == (not x['contact']))
        if x.get('phone'): ok = ok and page.get_attribute('a[href^="tel:"]', 'href') == f'tel:{PHONE}'
        if x.get('name'): ok = ok and 'Kofi' in body
        if x.get('closed'):
            ok = ok and page.query_selector('a[href^="messages.html"], a[href^="tel:"], a[href*="google.com/maps"]') is None
        if x.get('removed'): ok = ok and 'removed 14 days after the job ended' in body and '4 Oxford' not in body
        check(f'{name}: step {primary or "—"}; way out {"/".join(secondary)}' + (' (+composer)' if x.get('quote') else ''), ok, detail)

    # The rules accept nothing a dock offers: each step is resolveJourney's op
    # (artisan-actions-consistency proves the rules accept those).
    r = show(JOBS['insp-enroute'][0])
    check('navigation: an external Maps link to the customer\'s booking point, never an embedded map',
          (page.get_attribute('a[href^="https://www.google.com/maps/dir/"]', 'href') or '').endswith('destination=5.556,-0.182')
          and page.get_attribute('a[href^="https://www.google.com/maps/dir/"]', 'target') == '_blank' and page.query_selector('iframe') is None)
    show(dict(JOBS['work-onsite'][0], description='<img src=x onerror="window.__xss=1">Leak'))
    check('booking text is escaped, never markup', page.evaluate('() => window.__xss') is None and page.query_selector('#jb-body img:not(.fx-job__photo)') is None)
    page.evaluate("() => window.__job.message('Job not found', 'This job no longer exists, or it is not yours.')")
    check('a missing job is said in words, with the way back', txt('#jb-title') == 'Job not found' and page.get_attribute('#jb-body a.fx-btn', 'href') == 'jobs.html'
          and page.eval_on_selector('#jb-dock', 'd => d.hidden'))

    # ── Layout ───────────────────────────────────────────────────────────
    LAYOUT = {'offer': offer(), 'offer-sched': offer(scheduledForMs=NOW + DAY, expiresAtMs=NOW + 1_200_000), **{k: v[0] for k, v in JOBS.items()}}
    for w in (360, 390, 768):
        page.set_viewport_size({'width': w, 'height': 800})
        over, small = [], []
        for name, b in LAYOUT.items():
            show(b)
            o = page.evaluate(OVERFLOW_JS)
            if o['scroll'] or o['bad']: over.append((name, o['bad']))
            t = page.evaluate(TARGETS_JS)
            if t: small.append((name, t[:3]))
            if SHOTS and w == 360:
                pathlib.Path(SHOTS).mkdir(parents=True, exist_ok=True)
                page.screenshot(path=str(pathlib.Path(SHOTS) / f'job-{name}-{w}.png'), full_page=True)
        check(f'{w}px: no horizontal overflow at any state', not over, over)
        check(f'{w}px: every control is at least 44×44', not small, small)
    page.set_viewport_size({'width': 360, 'height': 800})
    page.add_style_tag(content='html { font-size: 200% !important; }')
    over = []
    for name in ['offer', 'insp-enroute', 'work-onsite', 'disputed']:
        show(LAYOUT[name])
        o = page.evaluate(OVERFLOW_JS)
        if o['scroll'] or o['bad']: over.append((name, o['bad']))
        if SHOTS: page.screenshot(path=str(pathlib.Path(SHOTS) / f'job-{name}-360-200pct.png'), full_page=True)
    check('360px at 200% text: no horizontal overflow (offer, en route, on site, dispute)', not over, over)

    check('no script errors', not errors, errors)
    browser.close()
    _done = True
