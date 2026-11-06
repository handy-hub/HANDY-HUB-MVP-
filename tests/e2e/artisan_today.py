"""Phase 2 browser checks: the artisan Today screen, rendered.

The REAL artisan-app/dashboard.html markup and stylesheets, drawn by the REAL
artisan-app/js/today.js from shared/js/domain/artisanToday.js states (via
tests/e2e/today_harness.html), with a fixed clock. No Firebase: the data
wiring is the emulator suite's job (tests/e2e/offer_refusal.py and friends).

Every Today state, offer type, job step and list; what each one offers and
withholds; what an unaccepted offer never shows; the countdown; and the
layout at 360 / 390 / 768 px and at 200% text.

Network: NONE. Files come from this checkout via Playwright routing to the
fake origin http://fx.test; every other host is aborted.

    python -I tests/e2e/artisan_today.py
    FX_SHOTS=<dir> python -I tests/e2e/artisan_today.py   # also save screenshots
"""
import os, sys, json, pathlib, mimetypes, atexit
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright
sys.stdout.reconfigure(encoding='utf-8')

ROOT = pathlib.Path(__file__).resolve().parents[2]
ORIGIN = 'http://fx.test'
URL = f'{ORIGIN}/tests/e2e/today_harness.html'
SHOTS = os.environ.get('FX_SHOTS')

results = []
def check(name, cond, detail=''):
    results.append((name, bool(cond), detail))
_done = False
def _report():
    ok = sum(1 for _, c, _ in results if c)
    for n, c, d in results:
        print(f"  {'PASS' if c else 'FAIL'}  {n}" + ('' if c else f"   [{str(d)[:300]}]"))
    print(f"artisan-today browser: {ok} passed, {len(results) - ok} failed" + ('' if _done else '  (aborted early)'))
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

# ── Fixtures (the shapes functions/jobOffers.js and the booking flow write) ──
NOW = 1_794_045_600_000            # 2026-11-07 10:00 Accra (UTC+0)
DAY = 86_400_000
ART = {'userType': 'artisan', 'status': 'active', 'verificationStatus': 'approved', 'isAvailable': True}
OFF = dict(ART, isAvailable=False)

def offer(**o):
    d = {'id': 'bk_1', 'bookingId': 'bk_1', 'artisanId': 'art_1', 'offerStatus': 'open', 'status': 'pending',
         'serviceType': 'plumbing', 'description': 'Kitchen tap leaking under the sink', 'photos': [],
         'track': 'inspection', 'calloutFee': 50, 'customerFirstName': 'Ama', 'lat': 5.6123, 'lng': -0.1871,
         'address': '12 Ring Road', 'locationApproximate': True, 'distanceKm': 2.34, 'prematched': False,
         'offeredAt': NOW - 60_000, 'expiresAtMs': NOW + 120_000}
    d.update(o); return d

def bk(id, status, **o):
    d = {'id': id, 'artisanId': 'art_1', 'serviceType': 'electrical', 'track': 'inspection', 'calloutFee': 50,
         'calloutPaid': True, 'status': status, 'address': '4 Oxford Street', 'customerName': 'Kofi Mensah'}
    d.update(o); return d

STATES = {
    'unknown':     {'artisan': None},
    'offline':     {'artisan': OFF},
    'online':      {'artisan': ART},
    'cached':      {'artisan': ART, 'ui': {'cached': True}},
    'unverified':  {'artisan': dict(ART, verificationStatus='draft'), 'ui': {'onboarding': True}},
    'unverified-cached': {'artisan': dict(ART, verificationStatus='draft'), 'ui': {'onboarding': False}},
    'review':      {'artisan': dict(ART, verificationStatus='pending_review')},
    'suspended':   {'artisan': dict(ART, status='suspended')},
    'offer':       {'artisan': ART, 'offers': [offer()]},
    'offer-photos': {'artisan': ART, 'offers': [offer(photos=['https://res.example/a.jpg', 'https://res.example/b.jpg'])]},
    'offer-sched': {'artisan': ART, 'offers': [offer(scheduledForMs=NOW + DAY, scheduleWindowMins=180, expiresAtMs=NOW + 1_200_000)]},
    'offer-emerg': {'artisan': ART, 'offers': [offer(track='emergency', isEmergency=True, calloutFee=120, expiresAtMs=NOW + 65_000, offeredAt=NOW)]},
    'offer-chosen': {'artisan': ART, 'offers': [offer(prematched=True, expiresAtMs=None)]},
    'offer-onjob': {'artisan': ART, 'offers': [offer()], 'bookings': [bk('bk_er', 'en_route')]},
    'offer-busy':  {'artisan': ART, 'offers': [offer()], 'busy': {'bk_1': 'accept'}},
    'offer-many':  {'artisan': ART, 'offers': [offer(), offer(id='bk_2', bookingId='bk_2', expiresAtMs=NOW + 170_000)]},
    'offer-xss':   {'artisan': ART, 'offers': [offer(description='<img src=x onerror="window.__xss=1">Leak', serviceType='<b>bad</b>')]},
    'offer-offline': {'artisan': OFF, 'offers': [offer()]},
    'job-enroute': {'artisan': ART, 'bookings': [bk('bk_er', 'en_route')]},
    'job-quote':   {'artisan': ART, 'bookings': [bk('bk_q', 'accepted', track='standard', calloutPaid=False)]},
    'job-busy':    {'artisan': ART, 'bookings': [bk('bk_er', 'en_route')], 'busy': {'bk_er': 'job-arrived'}},
    'job-two':     {'artisan': ART, 'bookings': [bk('bk_q', 'accepted', track='standard'), bk('bk_ip', 'in_progress', quoteApproved=True)]},
    'lists':       {'artisan': ART, 'bookings': [bk('w1', 'quoted'), bk('w2', 'awaiting', quoteApproved=True),
                                                 bk('u1', 'inspection_scheduled', scheduledForMs=NOW + 3 * DAY)]},
}

def show(page, name):
    spec = dict(STATES[name]); spec['nowMs'] = NOW
    return page.evaluate('(s) => window.__today.show(s)', spec)

def text(page, sel):
    el = page.query_selector(sel)
    return (el.inner_text() if el else '').strip()

OVERFLOW_JS = """() => { const w = document.documentElement.clientWidth; const bad = [];
  for (const el of document.querySelectorAll('body *')) { if (el.closest('[hidden]')) continue;
    const r = el.getBoundingClientRect(); if (r.width && (r.right > w + 0.5 || r.left < -0.5)) bad.push(el.tagName + '.' + [...el.classList].join('.') + ' ' + Math.round(r.left) + '..' + Math.round(r.right)); }
  return { scroll: document.documentElement.scrollWidth > w, bad: bad.slice(0, 5) }; }"""

TARGETS_JS = """() => { const out = [];
  for (const el of document.querySelectorAll('button, a[href]')) {
    if (el.closest('[hidden], .fx-skip, .fx-overlay')) continue;
    if (el.classList.contains('fx-link')) continue;     // inline text link (WCAG 2.5.8 inline exception)
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

    # ── The page shell ───────────────────────────────────────────────────
    check('shell: the real dashboard markup loaded (Today app bar, tab bar, dock slot)',
          text(page, '.fx-appbar__title') == 'Today' and page.query_selector('#today-dock') is not None)
    check('shell: four tabs, Today current', page.eval_on_selector_all('#tabbar .fx-tab', 'els => els.map(e => e.textContent.trim())') == ['Today', 'Jobs', 'Earnings', 'Account']
          and text(page, '#tabbar [aria-current="page"]') == 'Today')
    check('shell: no wallet, rating or stats on Today', not page.query_selector('#wallet-amount, #stat-rating, #perf-rating, .wallet-card'))
    check('shell: Performance, Reviews, Service area and Support stay one tap away',
          page.eval_on_selector_all('#more-h ~ * a, section[aria-labelledby="more-h"] a', 'els => els.map(e => e.getAttribute("href"))')
          == ['performance.html', 'reviews.html', 'profile.html?edit=area', 'support.html'])

    # ── Availability and idle states ─────────────────────────────────────
    show(page, 'unknown')
    av = page.eval_on_selector('#avail-btn', 'b => ({ t: b.textContent.trim(), busy: b.getAttribute("aria-busy"), dis: b.disabled })')
    check('unknown: skeleton only, availability "Checking…" and inert, no dock',
          page.query_selector('#today-state [data-mode="unknown"] .fx-skel') is not None and av == {'t': 'Checking…', 'busy': 'true', 'dis': True}
          and page.eval_on_selector('#today-dock', 'd => d.hidden'))

    show(page, 'offline')
    check('offline: says so, and the dock is the one action: Go online',
          text(page, '#today-h') == 'You are offline' and text(page, '#today-dock .fx-btn--primary') == 'Go online'
          and page.get_attribute('#today-dock [data-act="go-online"]', 'data-act') == 'go-online')
    check('offline: the app bar control reads Offline, not pressed',
          page.eval_on_selector('#avail-btn', 'b => [b.textContent.trim(), b.getAttribute("aria-pressed"), b.dataset.act]') == ['Offline', 'false', 'go-online'])

    show(page, 'online')
    check('online: says so; the control is pressed and stops offers; no dock',
          text(page, '#today-h') == 'You are online'
          and page.eval_on_selector('#avail-btn', 'b => [b.textContent.trim(), b.getAttribute("aria-pressed"), b.dataset.act]') == ['Online', 'true', 'stop-offers']
          and page.eval_on_selector('#today-dock', 'd => d.hidden'))

    show(page, 'cached')
    check('cached profile: shown, but the switch waits for the server (disabled)',
          page.eval_on_selector('#avail-btn', 'b => [b.textContent.trim(), b.disabled, b.dataset.act || null]') == ['Online', True, None])

    show(page, 'unverified')
    check('locked (live, needs verification): reason, and Complete verification → onboarding',
          text(page, '#today-h') == 'Verification needed' and page.get_attribute('#today-state a.fx-btn', 'href') == 'onboarding.html'
          and page.eval_on_selector('#avail-btn', 'b => [b.getAttribute("aria-disabled"), b.dataset.act]') == ['true', 'locked'])
    show(page, 'unverified-cached')
    check('locked (profile not confirmed live): no route to onboarding (FLOW-004)', page.query_selector('#today-state a.fx-btn') is None)
    show(page, 'review')
    check('locked (under review): the review copy, nothing to tap', text(page, '#today-h') == 'Under review' and page.query_selector('#today-state a.fx-btn') is None)
    show(page, 'suspended')
    check('locked (suspended): Contact support', page.get_attribute('#today-state a.fx-btn', 'href') == 'support.html')

    # ── Offers ───────────────────────────────────────────────────────────
    show(page, 'offer')
    body = text(page, '#today-state')
    check('offer: type, service, server countdown (2:00 left), when, distance, visit fee',
          text(page, '#today-state .fx-chip') == 'New job request' and text(page, '#today-h') == 'Plumbing'
          and text(page, '[data-countdown]') == '2:00' and 'As soon as possible' in body and '2.3 km away' in body
          and 'GHS 50.00' in body, body[:300])
    fill = page.eval_on_selector('.fx-countdown', 'e => [getComputedStyle(e).getPropertyValue("--fx-countdown").trim(), e.dataset.urgency]')
    check('offer: the bar is the fraction left of offeredAt → expiresAtMs (120 of 180 s)', fill[0].startswith('0.66') and fill[1] == 'normal', fill)
    page_text = page.inner_text('body')
    check('offer: no customer name, address or coordinates anywhere on screen',
          not any(s in page_text for s in ['Ama', 'Ring Road', '5.61', '-0.18']), page_text[:200])
    check('offer: says the address comes after accepting', 'The exact address is shared once you accept.' in body)
    check('offer: the dock is Decline + Accept, both live',
          page.eval_on_selector_all('#today-dock .fx-btn', 'els => els.map(e => [e.textContent.trim(), e.dataset.act, e.disabled])')
          == [['Decline', 'decline', False], ['Accept', 'accept', False]])
    check('offer: the availability control stays in the app bar', page.eval_on_selector('#avail-btn', 'b => !b.hidden && b.textContent.trim()') == 'Online')

    show(page, 'offer-photos')
    check('offer with photos: a link to see them on the request screen', page.get_attribute('#today-state a.fx-link', 'href') == 'job.html?id=bk_1'
          and text(page, '#today-state a.fx-link') == 'See 2 photos')

    show(page, 'offer-sched')
    check('scheduled offer: the slot, the commitment, "Accept this slot"',
          'Tomorrow' in text(page, '#today-state') and 'Accepting commits you to arriving' in text(page, '#today-state .fx-notice')
          and text(page, '#today-dock [data-act="accept"]') == 'Accept this slot')

    show(page, 'offer-emerg')
    check('emergency offer: emergency chip, "Now", its own 65 s window', text(page, '#today-state .fx-chip') == 'Emergency request'
          and 'Now' in text(page, '#today-state') and text(page, '[data-countdown]') == '1:05')

    show(page, 'offer-chosen')
    check('customer-chosen offer: no countdown is invented', page.query_selector('.fx-countdown') is None
          and 'No countdown' in text(page, '#today-state') and text(page, '#today-state .fx-chip') == 'A customer chose you')

    show(page, 'offer-onjob')
    check('offer while on a job (Q3): the offer leads, and says a job is under way',
          page.get_attribute('#today-state > section', 'data-mode') == 'offer' and 'You have a job under way' in text(page, '#today-state'))

    show(page, 'offer-offline')
    check('offer while offline: still answerable (the server does not require online)',
          page.get_attribute('#today-state > section', 'data-mode') == 'offer' and not page.eval_on_selector('#today-dock [data-act="accept"]', 'b => b.disabled'))

    show(page, 'offer-busy')
    btns = page.eval_on_selector_all('#today-dock .fx-btn', 'els => els.map(e => [e.textContent.trim(), e.disabled, e.getAttribute("aria-busy")])')
    check('accept in flight: "Accepting…", both answers disabled (no duplicate)', btns == [['Decline', True, None], ['Accepting…', True, 'true']], btns)

    show(page, 'offer-many')
    check('two offers: the one expiring first, and a count of the rest', page.get_attribute('#today-state > section', 'data-offer') == 'bk_1'
          and '1 more request is waiting' in text(page, '#today-state'))

    show(page, 'offer-xss')
    check('offer text is escaped, never markup', page.evaluate('() => window.__xss') is None
          and page.query_selector('#today-state img, #today-state b') is None and '<img' in text(page, '#today-state'))

    # ── The countdown ────────────────────────────────────────────────────
    show(page, 'offer')
    lapsed = page.evaluate(f'() => window.__today.tick({NOW + 60_000})')
    check('tick +60 s: "1:00", normal', text(page, '[data-countdown]') == '1:00' and page.get_attribute('.fx-countdown', 'data-urgency') == 'normal' and lapsed == [])
    page.evaluate(f'() => window.__today.tick({NOW + 100_000})')
    check('tick: 20 s left reads "20s", urgency soon', text(page, '[data-countdown]') == '20s' and page.get_attribute('.fx-countdown', 'data-urgency') == 'soon')
    lapsed = page.evaluate(f'() => window.__today.tick({NOW + 120_000})')
    check('tick at expiresAtMs: 0s, done, and the offer is reported lapsed', text(page, '[data-countdown]') == '0s'
          and page.get_attribute('.fx-countdown', 'data-urgency') == 'done' and lapsed == ['bk_1'], lapsed)

    # ── Jobs ─────────────────────────────────────────────────────────────
    show(page, 'job-enroute')
    check('job (en route): its stage, the rail, and Mark arrived in the dock with Open job',
          text(page, '#today-state .fx-chip') == 'On your way' and page.query_selector('.fx-rail__seg--current') is not None
          and page.eval_on_selector_all('#today-dock .fx-btn', 'els => els.map(e => [e.textContent.trim(), e.dataset.act || e.getAttribute("href")])')
          == [['Open job', 'job.html?id=bk_er'], ['Mark arrived', 'job-arrived']])
    check('job: the rail says it in words', 'Step' in text(page, '.fx-rail__cap'))

    show(page, 'job-quote')
    check('job (accepted, no quote): Submit quote opens the composer on THIS job, never Mark en route',
          page.get_attribute('#today-dock a.fx-btn--primary', 'href') == 'jobs.html?quote=bk_q' and 'en route' not in text(page, '#today-dock').lower())

    show(page, 'job-busy')
    check('job step in flight: "Updating…", disabled', page.eval_on_selector('#today-dock button.fx-btn--primary', 'b => [b.textContent.trim(), b.disabled]') == ['Updating…', True])

    show(page, 'job-two')
    check('two jobs: on site first; the other under "Also needs you"', page.get_attribute('#today-state > section', 'data-job') == 'bk_ip'
          and text(page, '#also-h') == 'Also needs you' and page.get_attribute('#today-state a.fx-row', 'href') == 'job.html?id=bk_q')

    show(page, 'lists')
    check('waiting and upcoming are listed, not the main state', page.get_attribute('#today-state > section', 'data-mode') == 'online'
          and text(page, '#waiting-h') == 'Waiting on the customer' and text(page, '#upcoming-h') == 'Coming up'
          and page.eval_on_selector_all('#today-lists a.fx-row', 'els => els.map(e => e.getAttribute("href"))') == ['job.html?id=w1', 'job.html?id=w2', 'job.html?id=u1'])
    check('job rows never show the address or the customer\'s name', not any(s in text(page, '#today-lists') for s in ['Oxford', 'Kofi']))

    # ── Layout: every state at every width, and at 200% text ─────────────
    LAYOUT = ['offline', 'online', 'unverified', 'offer', 'offer-sched', 'offer-onjob', 'offer-chosen', 'job-enroute', 'job-two', 'lists']
    for w in (360, 390, 768):
        page.set_viewport_size({'width': w, 'height': 800})
        over, small = [], []
        for name in LAYOUT:
            show(page, name)
            o = page.evaluate(OVERFLOW_JS)
            if o['scroll'] or o['bad']: over.append((name, o['bad']))
            t = page.evaluate(TARGETS_JS)
            if t: small.append((name, t[:3]))
            if SHOTS and w == 360:
                pathlib.Path(SHOTS).mkdir(parents=True, exist_ok=True)
                page.screenshot(path=str(pathlib.Path(SHOTS) / f'today-{name}-{w}.png'), full_page=True)
        check(f'{w}px: no horizontal overflow in any state', not over, over)
        check(f'{w}px: every control is at least 44×44', not small, small)

    page.set_viewport_size({'width': 360, 'height': 800})
    page.add_style_tag(content='html { font-size: 200% !important; }')
    over = []
    for name in ['offer', 'offer-sched', 'job-enroute', 'offline']:
        show(page, name)
        o = page.evaluate(OVERFLOW_JS)
        if o['scroll'] or o['bad']: over.append((name, o['bad']))
        if SHOTS: page.screenshot(path=str(pathlib.Path(SHOTS) / f'today-{name}-360-200pct.png'), full_page=True)
    check('360px at 200% text: no horizontal overflow (offer, slot, job, offline)', not over, over)

    check('no script errors', not errors, errors)
    browser.close()
    _done = True
