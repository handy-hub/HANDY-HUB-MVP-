"""Phase 3 browser checks: the artisan Jobs screen, rendered.

The REAL artisan-app/jobs.html markup and stylesheets, drawn by the REAL
artisan-app/js/jobsScreen.js from shared/js/domain/artisanJobs.js (via
tests/e2e/jobs_harness.html), with a fixed clock. No Firebase: the page's own
wiring (views in the URL, paging, the outage notice, redirects) is driven in
tests/e2e/offer_refusal.py.

Every view and section, what each row says and withholds, closures in words,
paging controls, empty and loading states, and the layout at 360 / 390 / 768 px
and at 200% text.

Network: NONE (Playwright routing to the fake origin http://fx.test).

    python -I tests/e2e/artisan_jobs.py
    FX_SHOTS=<dir> python -I tests/e2e/artisan_jobs.py
"""
import os, sys, pathlib, mimetypes, atexit
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright
sys.stdout.reconfigure(encoding='utf-8')

ROOT = pathlib.Path(__file__).resolve().parents[2]
ORIGIN = 'http://fx.test'
URL = f'{ORIGIN}/tests/e2e/jobs_harness.html'
SHOTS = os.environ.get('FX_SHOTS')

results = []
def check(name, cond, detail=''):
    results.append((name, bool(cond), detail))
_done = False
def _report():
    ok = sum(1 for _, c, _ in results if c)
    for n, c, d in results:
        print(f"  {'PASS' if c else 'FAIL'}  {n}" + ('' if c else f"   [{str(d)[:300]}]"))
    print(f"artisan-jobs browser: {ok} passed, {len(results) - ok} failed" + ('' if _done else '  (aborted early)'))
    sys.stdout.flush(); sys.stderr.flush()
    if ok != len(results) or not _done:
        os._exit(1)
atexit.register(_report)
exec(pathlib.Path(__file__).with_name('fx_theme_hook.py').read_text(encoding='utf-8'))   # FX_THEME=dark + the contrast audit

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
import datetime as _dt
iso = lambda ms: _dt.datetime.fromtimestamp(ms / 1000, _dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z')

def bk(id, status, **o):
    d = {'id': id, 'artisanId': 'A1', 'serviceType': 'electrical', 'track': 'inspection', 'calloutFee': 60, 'calloutPaid': True,
         'customerFirstName': 'Kofi', 'address': '4 Oxford Street, Osu', 'status': status, 'updatedAt': iso(NOW - 60_000)}
    d.update(o); return d

def offer(id, **o):
    d = {'id': id, 'bookingId': id, 'artisanId': 'A1', 'offerStatus': 'open', 'status': 'pending', 'serviceType': 'plumbing',
         'track': 'inspection', 'calloutFee': 60, 'customerFirstName': 'Ama', 'distanceKm': 2.4, 'locationApproximate': True,
         'offeredAt': NOW - 60_000, 'expiresAtMs': NOW + 120_000}
    d.update(o); return d

ACTIVE = [
    bk('ip', 'in_progress', quoteApproved=True, jobQuote=300, updatedAt=iso(NOW - 900_000)),
    bk('er', 'en_route'),
    bk('q', 'quoted', jobQuote=300),
    bk('dp', 'disputed', quoteApproved=True),
    bk('up1', 'inspection_scheduled', scheduledForMs=NOW + 2 * DAY),
    bk('up2', 'inspection_scheduled', scheduledForMs=NOW + 4 * DAY),
]
HISTORY = [
    bk('done', 'completed', quoteApproved=True, completedAt=iso(NOW - 2 * DAY), updatedAt=iso(NOW - 2 * DAY)),
    bk('mine', 'cancelled', cancelledBy='artisan', cancellationReason='Van broke down', updatedAt=iso(NOW - DAY)),
    bk('auto', 'cancelled', cancelledBy='system', cancellationReason='callout_unpaid', updatedAt=iso(NOW - 3 * DAY)),
    bk('adm', 'cancelled', cancelledBy='admin:ops@fidusx.example', updatedAt=iso(NOW - 4 * DAY)),
]

with sync_playwright() as p:
    browser = p.chromium.launch()
    ctx = browser.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=1)
    ctx.route('**/*', route)
    page = ctx.new_page()
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(URL, wait_until='domcontentloaded')
    page.wait_for_selector('html[data-ready="true"]', timeout=15000)

    def show(**spec):
        spec.setdefault('nowMs', NOW)
        return page.evaluate('(s) => window.__jobs.show(s)', spec)
    txt = lambda sel: (page.inner_text(sel) if page.query_selector(sel) else '').strip()
    rows = lambda: page.eval_on_selector_all('#jobs-list a.fx-row', 'els => els.map(e => e.getAttribute("href"))')
    heads = lambda: page.eval_on_selector_all('#jobs-list .fx-sect__title', 'els => els.map(e => e.textContent.trim())')

    check('shell: the real Jobs markup (app bar, three views, filter, tab bar with Jobs current)',
          txt('.fx-appbar__title') == 'Jobs' and page.query_selector('#jobs-views [data-view="history"]') is not None
          and txt('#tabbar [aria-current="page"]') == 'Jobs')

    # ── Loading and empty ────────────────────────────────────────────────
    show(view='current', ready={'active': False, 'history': False})
    check('loading (nothing cached): a skeleton, never "nothing here"', page.query_selector('#jobs-list [data-skeleton]') is not None
          and page.query_selector('#jobs-list [data-empty]') is None)
    show(view='current')
    check('current, empty: says nothing needs you and where requests appear', 'Nothing needs you right now' in txt('#jobs-list'))
    show(view='upcoming')
    check('upcoming, empty', 'No upcoming bookings' in txt('#jobs-list'))
    show(view='history', filter='cancelled')
    check('history, empty for its filter', 'No cancelled bookings' in txt('#jobs-list'))

    # ── Current ──────────────────────────────────────────────────────────
    show(view='current', active=ACTIVE, offers=[offer('o1')])
    check('current: requests, needs you, waiting, on hold — in that order',
          heads() == ['Requests for you (1)', 'Needs you (2)', 'Waiting on the customer (1)', 'On hold (1)'], heads())
    check('current: the jobs that need you first (on site, then travelling), each opening its job screen',
          rows() == ['job.html?id=o1', 'job.html?id=ip', 'job.html?id=er', 'job.html?id=q', 'job.html?id=dp'], rows())
    check('views show their counts (current 5 incl. the request, upcoming 2); the app bar says how many need you',
          txt('#jobs-views [data-view="current"]') == 'Current 5' and txt('#jobs-views [data-view="upcoming"]') == 'Upcoming 2'
          and txt('#jobs-sub') == '2 jobs need you', [txt('#jobs-views'), txt('#jobs-sub')])
    er = txt('#jobs-list a[data-row="er"]')
    check('a row: service, status and the next step, the disclosed name and address',
          all(s in er for s in ['Electrical', 'On your way', 'Next: Mark arrived', 'Kofi · 4 Oxford Street, Osu']), er)
    check('waiting / on hold rows offer no step', 'Next:' not in txt('#jobs-list a[data-row="q"]') and 'Next:' not in txt('#jobs-list a[data-row="dp"]'))
    check('the request row: countdown from the server deadline, no name, no address',
          '2:00 left' in txt('#jobs-list a[data-offer="o1"]') and 'Ama' not in txt('#jobs-list') and 'Ring' not in txt('#jobs-list'))
    check('no Accept, Decline or step buttons in the list: actions live on the job screen',
          page.query_selector('#jobs-list button') is None)
    lapsed = page.evaluate(f'() => window.__jobs.tick({NOW + 120_000})')
    check('the request countdown reaches zero and is reported lapsed', lapsed == ['o1'] and '0s left' in txt('#jobs-list a[data-offer="o1"]'), lapsed)
    show(view='current', active=ACTIVE, offers=[offer('o1', expiresAtMs=NOW - 1)])
    check('an expired request is not listed', page.query_selector('#jobs-list a[data-offer]') is None)

    # ── Upcoming ─────────────────────────────────────────────────────────
    show(view='upcoming', active=ACTIVE)
    check('upcoming: booked slots, soonest first, with the appointment', rows() == ['job.html?id=up1', 'job.html?id=up2']
          and ('Mon' in txt('#jobs-list') or 'Sun' in txt('#jobs-list') or 'Tue' in txt('#jobs-list')), txt('#jobs-list')[:200])
    check('upcoming rows offer no step (the slot has not opened)', 'Next:' not in txt('#jobs-list'))

    # ── History ──────────────────────────────────────────────────────────
    show(view='history', filter='all', history=HISTORY)
    hist = txt('#jobs-list')
    check('history: most recent first', rows() == ['job.html?id=mine', 'job.html?id=done', 'job.html?id=auto', 'job.html?id=adm'], rows())
    check('history says who ended each booking and why, in words',
          all(s in hist for s in ['Cancelled by you', 'Your reason: Van broke down', 'Completed', 'Closed automatically',
                                  'did not pay the visit fee', 'Cancelled by Fidus X support']), hist[:400])
    check('history never shows a machine label, an admin address or a job address',
          not any(s in hist for s in ['callout_unpaid', 'ops@', 'Oxford Street']), hist[:300])
    check('the filter is shown only on History', not page.eval_on_selector('#jobs-filters', 'e => e.hidden'))
    show(view='history', filter='completed', history=HISTORY)
    check('filter Completed', rows() == ['job.html?id=done'])
    show(view='history', filter='cancelled', history=HISTORY)
    check('filter Cancelled: by you, automatically, by support', rows() == ['job.html?id=mine', 'job.html?id=auto', 'job.html?id=adm'])
    show(view='history', filter='all', history=HISTORY, more={'can': True, 'busy': False})
    check('more history: a Show more button', txt('#jobs-list [data-act="more"]') == 'Show more')
    show(view='history', filter='all', history=HISTORY, more={'can': True, 'busy': True})
    check('loading more: disabled, busy (no second request)', page.eval_on_selector('#jobs-list [data-act="more"]', 'b => [b.disabled, b.getAttribute("aria-busy")]') == [True, 'true'])
    show(view='history', filter='all', history=HISTORY, more={'can': True, 'busy': False, 'failed': True})
    check('a failed page: the list stays, a notice, and Try again', len(rows()) == 4 and 'Could not load more' in txt('#jobs-list')
          and txt('#jobs-list [data-act="more"]') == 'Try again')

    # ── Escaping and incomplete data ─────────────────────────────────────
    show(view='current', active=[bk('x', 'en_route', serviceType='<img src=x onerror="window.__xss=1">', customerFirstName='<b>K</b>')])
    check('booking text is escaped, never markup', page.evaluate('() => window.__xss') is None and page.query_selector('#jobs-list img, #jobs-list b') is None)
    show(view='current', active=[{'id': 'bare', 'status': 'accepted', 'track': 'standard'}])
    check('a booking with nothing optional still reads ("Job", its status, its step)', 'Job' in txt('#jobs-list a[data-row="bare"]')
          and 'Next: Submit quote' in txt('#jobs-list a[data-row="bare"]'), txt('#jobs-list'))

    # ── Layout ───────────────────────────────────────────────────────────
    SPECS = {
        'current': dict(view='current', active=ACTIVE, offers=[offer('o1')]),
        'upcoming': dict(view='upcoming', active=ACTIVE),
        'history': dict(view='history', filter='all', history=HISTORY, more={'can': True}),
        'empty': dict(view='history', filter='cancelled'),
    }
    OVERFLOW_JS = """() => { const w = document.documentElement.clientWidth; const bad = [];
      for (const el of document.querySelectorAll('body *')) { if (el.closest('[hidden]')) continue;
        const r = el.getBoundingClientRect(); if (r.width && (r.right > w + 0.5 || r.left < -0.5)) bad.push(el.tagName + '.' + [...el.classList].join('.')); }
      return { scroll: document.documentElement.scrollWidth > w, bad: bad.slice(0, 5) }; }"""
    TARGETS_JS = """() => { const out = [];
      for (const el of document.querySelectorAll('button, a[href]')) {
        if (el.closest('[hidden], .fx-skip')) continue;
        const r = el.getBoundingClientRect(); if (!r.width) continue;
        if (r.width < 43.5 || r.height < 43.5) out.push(el.tagName + ' "' + el.textContent.trim().slice(0, 20) + '" ' + Math.round(r.width) + 'x' + Math.round(r.height)); }
      return out; }"""
    for w in (360, 390, 768):
        page.set_viewport_size({'width': w, 'height': 800})
        over, small = [], []
        for name, spec in SPECS.items():
            show(**spec)
            o = page.evaluate(OVERFLOW_JS)
            if o['scroll'] or o['bad']: over.append((name, o['bad']))
            t = page.evaluate(TARGETS_JS)
            if t: small.append((name, t[:3]))
            if SHOTS and w == 360:
                pathlib.Path(SHOTS).mkdir(parents=True, exist_ok=True)
                page.screenshot(path=str(pathlib.Path(SHOTS) / f'jobs-{name}-{w}.png'), full_page=True)
        check(f'{w}px: no horizontal overflow in any view', not over, over)
        check(f'{w}px: every control is at least 44×44', not small, small)
    page.set_viewport_size({'width': 360, 'height': 800})
    page.add_style_tag(content='html { font-size: 200% !important; }')
    over = []
    for name in ('current', 'history'):
        show(**SPECS[name])
        o = page.evaluate(OVERFLOW_JS)
        if o['scroll'] or o['bad']: over.append((name, o['bad']))
        if SHOTS: page.screenshot(path=str(pathlib.Path(SHOTS) / f'jobs-{name}-360-200pct.png'), full_page=True)
    check('360px at 200% text: no horizontal overflow', not over, over)

    check('no script errors', not errors, errors)
    browser.close()
    _done = True
