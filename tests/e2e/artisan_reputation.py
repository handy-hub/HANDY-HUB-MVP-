"""Phase 4 browser checks: the artisan Reputation screen (reputation.html), for real.

Runs the REAL artisan-app/reputation.html in Chromium with the REAL
artisanReputation domain (the same rules dispatch uses: performanceMetrics
weights and thresholds, artisanIndex liveness), reputationScreen, instantView
and fx components. Firebase, auth and presence are in-page fakes that play the
server's records.

  · each figure on both sides of its real threshold (2 / 3 reviews, 4 / 5
    requests, the 15-minute online window), and completion said to be unused
  · how matching works, in dispatch's own weights — and no promised advantage
  · reviews: first name only, escaped, the trade, the job, paged; the rating
    on file checked against the reviews read, only when every one was read
  · performance.html and reviews.html forward (reviews to the Reviews section)
  · a cached paint, no data at all, the heartbeat, and the layout at 360 / 390 /
    768 px and 200% text

Network: NONE (Playwright routing to the fake origin http://fx.test).

    python -I tests/e2e/artisan_reputation.py
    FX_SHOTS=<dir> python -I tests/e2e/artisan_reputation.py
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
    print(f"artisan-reputation browser: {ok} passed, {len(results) - ok} failed" + ('' if _done else '  (aborted early)'))
    sys.stdout.flush(); sys.stderr.flush()
    if ok != len(results) or not _done:
        os._exit(1)
atexit.register(_report)
exec(pathlib.Path(__file__).with_name('fx_theme_hook.py').read_text(encoding='utf-8'))   # FX_THEME=dark + the contrast audit

NOW = 1_794_045_600_000            # 2026-11-07 10:00 UTC
MIN = 60_000
DAY = 86_400_000
import datetime as _dt
iso = lambda ms: _dt.datetime.fromtimestamp(ms / 1000, _dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z')

INIT = r"""
(() => {
  // A fixed start that keeps moving, across page loads too (a clock that went
  // back between visits would make the cache look written in the future).
  const real = Date.now;
  let t0 = Number(localStorage.getItem('__fx_t0'));
  if (!t0) { t0 = real(); localStorage.setItem('__fx_t0', String(t0)); }
  const offset = __NOW__ - t0;
  Date.now = () => real() + offset;
  const fx = window.__fx = { data: __DATA__, queries: [], reads: [], ensure: [] };
  window.HH_State = { currentUid: () => 'A1' };
  const any = () => new Proxy(function () {}, { get: (t, k) => (k === 'then' ? undefined : k === Symbol.toPrimitive ? () => '' : any()), apply: () => any() });
  fx.any = any;
  const wait = () => new Promise((res, rej) => setTimeout(() => (fx.data && fx.data.fail ? rej(new Error('unavailable')) : res()), fx.data && fx.data.delay || 0));
  fx.db = {
    async getDocument(name, id) { fx.reads.push(`${name}/${id}`); await wait(); return name === 'artisans' ? { exists: true, id, data: fx.data.artisan } : { exists: false, id, data: null }; },
    async queryWithOptions(name, cond, opts) { fx.queries.push([name, cond, opts]); await wait(); return (fx.data.bookings || []).map((d) => ({ id: d.id, data: d })); },
    subscribeToDocument(name, id, onChange) { if (name === 'artisans' && fx.data) setTimeout(() => onChange({ id, exists: true, data: fx.data.artisan, fromCache: false }), 0); return () => {}; },
    subscribeToCollection() { return () => {}; }, subscribeToSubCollection() { return () => {}; },
  };
})();
"""
SPECIFIC = {
    '/shared/js/app/container.js':
        "export function getAppContainer(){ const fx = window.__fx; return { services: new Proxy({ databaseService: fx.db,"
        " authService: { waitForUser: async () => ({ uid: 'A1' }) } }, { get:(t,k)=> k in t ? t[k] : fx.any() }) }; }",
    '/artisan-app/js/utils/artisanAuthGuard.js': """
const U = { uid: 'A1', email: 'a@x.test', emailVerified: true };
export async function requireArtisanAuth(){ return { user: U, artisan: { uid: 'A1', userType: 'artisan' } }; }
export function subscribeToArtisanAuthState(cb){ setTimeout(() => cb(U), 0); return () => {}; }
""",
    '/shared/js/services/presenceService.js':
        "export function startPresence(){} export function stopPresence(){} export function syncAvailability(){}"
        " export function ensurePresence(uid, db, available){ window.__fx.ensure.push([uid, available]); }"
        " export function availabilityPending(){ return false; } export async function setAvailability(){ window.__fx.wroteAvailability = true; } export default {};",
}
EMPTY = {'/shared/js/utils/global-app.js', '/shared/js/utils/themeManager.js', '/artisan-app/js/pwa.js'}
CATCH_ALL = re.compile(r'^/shared/(vendor/firebase/|js/backend/|dev/)')

def route(r):
    url = r.request.url
    if not url.startswith(ORIGIN): return r.abort()
    p = url[len(ORIGIN):].split('?')[0].split('#')[0]
    js = lambda body: r.fulfill(status=200, content_type='text/javascript', body=body)
    if p in SPECIFIC: return js(SPECIFIC[p])
    if p in EMPTY: return js('')
    if CATCH_ALL.search(p): return js('export default window.__fx.any();')
    f = ROOT / p.lstrip('/')
    if not f.is_file(): return r.fulfill(status=404, body='')
    ctype = 'text/javascript' if f.suffix in ('.js', '.mjs') else (mimetypes.guess_type(str(f))[0] or 'application/octet-stream')
    return r.fulfill(status=200, content_type=ctype, body=f.read_bytes())

# ── The records ──────────────────────────────────────────────────────────────
def bk(id, status='completed', ago_days=1.0, **o):
    d = {'id': id, 'artisanId': 'A1', 'status': status, 'serviceType': 'plumbing', 'customerFirstName': 'Ama', 'customerName': 'Ama Owusu-Mensah',
         'price': 480, 'address': '12 Secret Street', 'customerPhone': '+233555000111',
         'completedAt': iso(NOW - ago_days * DAY), 'updatedAt': iso(NOW - ago_days * DAY)}
    d.update(o); return d

def reviewed(id, rating, ago_days, text=None, **o):
    return bk(id, rating=rating, review=text, reviewedAt=iso(NOW - ago_days * DAY), ago_days=ago_days, **o)

STRONG = {   # measured on every figure the algorithm measures
    'artisan': {'rating': 4.3, 'reviewCount': 3, 'isOnline': True, 'isAvailable': True, 'lastHeartbeat': iso(NOW - 4 * MIN),
                'workRadius': 15, 'verificationStatus': 'approved', 'status': 'active', 'jobsCompleted': 57,
                'responseStats': {'sufficient': True, 'rate': 0.85, 'responded': 17, 'missed': 3, 'counted': 20, 'windowDays': 90, 'computedAt': iso(NOW - DAY)},
                'totalEarned': 1234.5, 'phone': '0241111111', 'name': 'Kofi Boateng'},
    'bookings': [
        reviewed('r1', 5, 0.5, 'Fixed the leak <img src=x onerror=alert(1)> fast', serviceType='plumbing', customerFirstName='Ama'),
        reviewed('r2', 4, 3, None, serviceType='electrical', customerFirstName='Kojo'),
        reviewed('r3', 4, 40, 'Good work', serviceType='ac-repair', customerFirstName='Efua'),
        bk('c1', ago_days=10), bk('c2', ago_days=45),
        bk('x1', status='cancelled', cancelledBy='artisan', ago_days=5),
        bk('x2', status='cancelled', cancelledBy='customer', ago_days=6),
    ],
}
NEW = {      # below every threshold
    'artisan': {'rating': 5, 'reviewCount': 2, 'isOnline': True, 'isAvailable': True, 'lastHeartbeat': iso(NOW - 16 * MIN),
                'verificationStatus': 'approved', 'status': 'active', 'jobsCompleted': 2,
                'responseStats': {'sufficient': False, 'rate': None, 'responded': 4, 'missed': 0, 'counted': 4, 'windowDays': 90}},
    'bookings': [reviewed('n1', 5, 2, 'Great'), reviewed('n2', 5, 4, 'Great again')],
}

def new_ctx(b, data, width=390, height=900):
    ctx = b.new_context(viewport={'width': width, 'height': height})
    ctx.add_init_script(INIT.replace('__NOW__', str(NOW)).replace('__DATA__', json.dumps(data)))
    return ctx

def open_page(ctx, path='/artisan-app/reputation.html'):
    pg = ctx.new_page()
    errors = []
    pg.on('pageerror', lambda e: errors.append(str(e)))
    pg.route('**/*', route)
    pg.set_default_timeout(5000)
    pg.goto(f'{ORIGIN}{path}', wait_until='domcontentloaded')
    return pg, errors

squash = lambda s: re.sub(r'\s+', ' ', s or '').strip()
def fig(pg, key):
    return squash(pg.evaluate("(k) => { const r = document.querySelector(`[data-figure='${k}']`); return r ? r.innerText : null; }", key) or '')
def ready(pg):
    pg.wait_for_selector('[data-figure="rating"]')
    pg.wait_for_timeout(150)

OVERFLOW_JS = """() => { const w = document.documentElement.clientWidth; const bad = [];
  for (const el of document.querySelectorAll('body *')) { if (el.closest('[hidden]')) continue;
    const r = el.getBoundingClientRect(); if (r.width && (r.right > w + 0.5 || r.left < -0.5)) bad.push(el.tagName + '.' + [...el.classList].join('.')); }
  return { scroll: document.documentElement.scrollWidth > w, bad: bad.slice(0, 5) }; }"""
TARGETS_JS = """() => { const out = [];
  for (const el of document.querySelectorAll('button, a[href]')) {
    if (el.closest('[hidden], .fx-skip') || el.classList.contains('fx-link') || el.classList.contains('fx-btn--s')) continue;
    const r = el.getBoundingClientRect(); if (!r.width) continue;
    if (r.width < 43.5 || r.height < 43.5) out.push(el.tagName + ' "' + el.textContent.trim().slice(0, 20) + '" ' + Math.round(r.width) + 'x' + Math.round(r.height)); }
  return out; }"""
def shot(pg, name):
    if SHOTS:
        pathlib.Path(SHOTS).mkdir(parents=True, exist_ok=True)
        pg.screenshot(path=str(pathlib.Path(SHOTS) / f'reputation-{name}.png'), full_page=True)

with sync_playwright() as p:
    b = p.chromium.launch()

    # ═══ 1. Measured on every figure dispatch measures ═══════════════════════
    slow = copy.deepcopy(STRONG); slow['delay'] = 600
    ctx = new_ctx(b, slow); pg, errs = open_page(ctx)
    pg.wait_for_timeout(200)
    check('first visit: the skeleton, until the records answer', pg.query_selector('#rep-body [data-skeleton]') is not None)
    ready(pg)
    q = pg.evaluate('window.__fx.queries')
    check('one bounded read of the finished bookings, newest first (the Jobs history index)',
          q == [['bookings', [{'field': 'artisanId', 'op': '==', 'value': 'A1'}, {'field': 'status', 'op': 'in', 'value': ['completed', 'cancelled', 'resolved']}],
                 {'orderBy': {'field': 'updatedAt', 'direction': 'desc'}, 'limit': 200}]], q)
    check('rating: 3 reviews is the threshold — the stored rating, with stars, counts in matching',
          fig(pg, 'rating') == 'Rating 4.3 From 3 reviews. Counts in matching.'
          and pg.get_attribute('[data-figure="rating"] .fx-rep__stars', 'aria-label') == '4.3 out of 5 stars', fig(pg, 'rating'))
    check('response rate: the server\'s figure and its window',
          fig(pg, 'response') == 'Response rate 85% 17 of 20 job requests answered before they expired, in the last 90 days. Counts in matching.', fig(pg, 'response'))
    # 5 completed + 1 cancelled by the artisan = 6 finished (5 is the threshold); the customer's cancellation is not counted.
    check('completion: only the artisan\'s cancellations count, and it is said to be unused in matching',
          fig(pg, 'completion') == 'Completion rate 83% 5 completed, 1 cancelled by you. Cancellations by customers do not count. Not used in matching yet.',
          fig(pg, 'completion'))
    check('online: online and seen 4 minutes ago (inside the 15-minute window)',
          fig(pg, 'online') == 'Online Online now Last seen in the app 4 min ago. Counts in matching while you are online and seen in the last 15 minutes.', fig(pg, 'online'))
    reqs = pg.eval_on_selector_all('.fx-rep__req', 'els => els.map(e => [e.dataset.ok, e.textContent.trim()])')
    check('who can be offered a job: verified, active, available, within the work radius on file',
          reqs == [['true', 'Verified'], ['true', 'Account active'], ['true', 'Available for jobs'], ['true', 'Jobs within 15 km of where you are']], reqs)
    facs = pg.eval_on_selector_all('.fx-rep__factor', 'els => els.map(e => [e.dataset.factor, e.hasAttribute("data-unused"), e.innerText.replace(/\\s+/g, " ").trim()])')
    check('how candidates are ranked, in the algorithm\'s own weights; completion marked as not used',
          [f[0] for f in facs] == ['distance', 'online', 'rating', 'response', 'completion']
          and facs[0][2] == 'Distance to the job 1.5 points less for every km You: Depends on each job'
          and facs[1][2] == 'Online and seen in the app 20 points You: Online now'
          and facs[2][2] == 'Rating 15 points per star You: 4.3 counts' and facs[3][2] == 'Response rate Up to 15 points You: 85% counts'
          and facs[4][1] and facs[4][2] == 'Completion rate Not used yet You: Everyone is counted the same (80%) until it is measured', facs)
    body = squash(pg.inner_text('body'))
    check('no advantage the algorithm does not give: no priority, boost or unlock; levels said not to matter',
          not re.search(r'priority|boost|unlock|top of the list|guarantee', body, re.I)
          and 'This is how ranking works today. It is not a promise of a place in any list.' in body
          and 'Milestones recognise the jobs you complete. They do not change how jobs are matched.' in body)
    check('milestone from jobsCompleted (the server\'s count): Pro, 43 more to Top Pro', fig(pg, 'level') == 'Pro 57 jobs 43 more completed jobs to Top Pro.', fig(pg, 'level'))
    check('recent activity: jobs completed in the last 30 days, the last job, the last review',
          [fig(pg, 'recent-jobs'), fig(pg, 'last-job'), fig(pg, 'last-review')] == ['Jobs completed, last 30 days 3', 'Last job completed 12 h ago', 'Last review 12 h ago'],
          [fig(pg, 'recent-jobs'), fig(pg, 'last-job'), fig(pg, 'last-review')])
    revs = pg.eval_on_selector_all('.fx-rep__review', 'els => els.map(e => [e.dataset.review, e.querySelector(".fx-row__title").textContent.trim(), e.querySelector(".fx-rep__stars").getAttribute("aria-label")])')
    check('reviews, newest first: the customer\'s first name and the trade by its label',
          revs == [['r1', 'Ama · Plumbing', '5.0 out of 5 stars'], ['r2', 'Kojo · Electrical', '4.0 out of 5 stars'], ['r3', 'Efua · AC Repair', '4.0 out of 5 stars']], revs)
    html = pg.content()
    check('a review is the customer\'s words, escaped; no full name, phone, address or money on the screen',
          '&lt;img src=x onerror=alert(1)&gt;' in html and 'Owusu-Mensah' not in html and '+233555000111' not in html and '12 Secret Street' not in html
          and 'GHS' not in body and '1234' not in body and 'Kofi Boateng' not in html, '')
    check('each review opens its job', pg.query_selector('.fx-rep__review[data-review="r1"] a[href="job.html?id=r1"]') is not None)
    check('a review with no words says so', 'No written review.' in squash(pg.inner_text('.fx-rep__review[data-review="r2"]')))
    check('every review was read and they agree with the rating on file: no notice', pg.query_selector('[data-check="rating"]') is None)
    fills = pg.eval_on_selector_all('[data-figure="rating"] .fx-rep__star-fill', 'els => els.map(e => e.style.width)')
    check('the stars are filled to 4.3, not rounded', fills == ['100%', '100%', '100%', '100%', '30%'], fills)
    check('one tab bar, Account current; back goes to Account',
          len(pg.query_selector_all('nav.fx-tabbar')) == 1 and squash(pg.text_content('#tabbar [aria-current="page"]')) == 'Account'
          and pg.query_selector('.fx-appbar a[href="settings.html"][aria-label="Back to Account"]') is not None)
    check('the heartbeat keeps an available artisan in dispatch here too; availability is never written',
          ['A1', True] in pg.evaluate('window.__fx.ensure') and not pg.evaluate('!!window.__fx.wroteAvailability'), pg.evaluate('window.__fx.ensure'))
    shot(pg, 'strong-390')
    for w in (360, 390, 768):
        pg.set_viewport_size({'width': w, 'height': 800}); pg.wait_for_timeout(100)
        o = pg.evaluate(OVERFLOW_JS)
        check(f'{w}px: no horizontal overflow', not o['scroll'] and not o['bad'], o)
        t = pg.evaluate(TARGETS_JS)
        check(f'{w}px: every control is at least 44px', not t, t)
    pg.set_viewport_size({'width': 360, 'height': 800})
    pg.add_style_tag(content='html { font-size: 200% !important; }'); pg.wait_for_timeout(150)
    o = pg.evaluate(OVERFLOW_JS)
    shot(pg, 'strong-360-200pct')
    check('360px at 200% text: no horizontal overflow', not o['scroll'] and not o['bad'], o)
    check('no page errors', not errs, errs)
    pg.close()

    # The next visit paints at once from the cache, and the cache holds only the figures' inputs
    data2 = copy.deepcopy(STRONG); data2['delay'] = 1500
    ctx.add_init_script(f'window.__fx && (window.__fx.data = {json.dumps(data2)});')
    pg, errs = open_page(ctx)
    pg.wait_for_selector('[data-figure="rating"]', timeout=800)
    check('a return visit paints the figures from the cache before the read answers, and says so',
          fig(pg, 'rating').startswith('Rating 4.3') and squash(pg.text_content('#rep-sub')) == 'Showing your last figures · checking for updates', squash(pg.text_content('#rep-sub')))
    store = pg.evaluate('() => JSON.stringify(Object.fromEntries(Object.keys(localStorage).map(k => [k, localStorage.getItem(k)])))')
    check('the cache holds no money, phone, address, full name or price',
          'artisan-reputation' in store and all(x not in store for x in ('totalEarned', '1234.5', '0241111111', '+233555000111', '12 Secret Street', 'Owusu-Mensah', 'Kofi Boateng', '"price"')), store[:300])
    try:
        pg.wait_for_function("() => document.getElementById('rep-sub').textContent === ''", timeout=4000)
    except Exception:
        pass
    check('the read answers and the line goes', squash(pg.text_content('#rep-sub')) == '' and len(pg.evaluate('window.__fx.queries')) == 1,
          [pg.text_content('#rep-sub'), pg.evaluate('window.__fx.queries')])
    pg.close(); ctx.close()

    # ═══ 2. Below every threshold ═══════════════════════════════════════════
    ctx = new_ctx(b, NEW); pg, errs = open_page(ctx); ready(pg)
    check('rating: 2 reviews is below the threshold — "Not enough yet", the neutral value matching uses, never 5.0 as if it counted',
          fig(pg, 'rating') == 'Rating Not enough yet 2 of 3 reviews. Until you have 3, matching counts you as 4.0, like every new professional.', fig(pg, 'rating'))
    check('response: 4 of 5 requests — "Not enough yet", never 0% or 100%',
          fig(pg, 'response') == 'Response rate Not enough yet 4 of 5 job requests in the last 90 days. Until then matching counts you as 70%. Declining counts as an answer.', fig(pg, 'response'))
    check('online: seen 16 minutes ago is outside the window — not online, said with the time',
          fig(pg, 'online').startswith('Online Not online Last seen in the app 16 min ago.'), fig(pg, 'online'))
    facs = pg.eval_on_selector_all('.fx-rep__factor', 'els => els.map(e => e.innerText.replace(/\\s+/g, " ").trim())')
    check('the factors say how an unmeasured figure is counted',
          'Counted as 4.0 until you have 3 reviews' in facs[2] and 'Counted as 70% until you have 5 requests in 90 days' in facs[3] and 'Not online now' in facs[1], facs)
    check('the reviews are still shown, with their own average and count', squash(pg.text_content('.fx-rep__avg')) == '5.0 · 2 reviews' and len(pg.query_selector_all('.fx-rep__review')) == 2,
          squash(pg.text_content('.fx-rep__avg') or ''))
    check('milestone: New, 18 more to Rising', fig(pg, 'level') == 'New 2 jobs 18 more completed jobs to Rising.', fig(pg, 'level'))
    shot(pg, 'new')
    pg.close(); ctx.close()

    # ═══ 3. Eligibility not met, standard radius ════════════════════════════
    off = copy.deepcopy(NEW); off['artisan'].update({'isAvailable': False, 'isOnline': False, 'verificationStatus': 'pending_review', 'status': 'active'})
    ctx = new_ctx(b, off); pg, errs = open_page(ctx); ready(pg)
    reqs = pg.eval_on_selector_all('.fx-rep__req', 'els => els.map(e => [e.dataset.ok, e.textContent.trim()])')
    check('an unmet condition says how to meet it; no radius on file reads as the standard 20 km',
          reqs == [['false', 'Verified — finish verification in Account'], ['true', 'Account active'], ['false', 'Available for jobs — go online on Today'],
                   ['true', 'Jobs within 20 km (the standard radius) of where you are']], reqs)
    check('an unavailable artisan gets no heartbeat claim of availability', ['A1', False] in pg.evaluate('window.__fx.ensure'), pg.evaluate('window.__fx.ensure'))
    pg.close(); ctx.close()

    # ═══ 4. The rating on file against the reviews ══════════════════════════
    drift = copy.deepcopy(STRONG); drift['artisan']['rating'] = 4.8   # the reviews average 4.33
    ctx = new_ctx(b, drift); pg, errs = open_page(ctx); ready(pg)
    note = squash(pg.text_content('[data-check="rating"]') or '')
    check('a rating on file that the reviews do not support is said, with both figures; matching uses the one on file',
          'Your rating on file (4.8 from 3 reviews) does not match the 3 reviews found, which average 4.33. Matching uses the rating on file. Fidus X support can recount it.' in note
          and pg.query_selector('[data-check="rating"] a[href="support.html"]') is not None, note)
    pg.close(); ctx.close()

    many = copy.deepcopy(STRONG)
    many['bookings'] = [reviewed(f'm{i:03d}', 4, 1 + i / 10, f'Review {i}') for i in range(200)]
    many['artisan'].update({'rating': 3.1, 'reviewCount': 260})
    ctx = new_ctx(b, many); pg, errs = open_page(ctx); ready(pg)
    check('200 finished jobs read (the limit): no claim about all reviews, and the figures say what they cover',
          pg.query_selector('[data-check="rating"]') is None and 'From your latest 200 finished jobs.' in squash(pg.inner_text('#reviews'))
          and 'Counted from your latest 200 finished jobs.' in fig(pg, 'recent-jobs'), squash(pg.inner_text('#reviews'))[-200:])
    check('reviews are shown ten at a time', len(pg.query_selector_all('.fx-rep__review')) == 10 and 'Show more reviews (190)' in squash(pg.text_content('[data-act="more-reviews"]')))
    pg.click('[data-act="more-reviews"]'); pg.wait_for_timeout(100)
    check('…and more on request', len(pg.query_selector_all('.fx-rep__review')) == 20)
    pg.close(); ctx.close()

    # ═══ 5. The old addresses, and no data ═══════════════════════════════════
    ctx = new_ctx(b, STRONG)
    pg, errs = open_page(ctx, '/artisan-app/performance.html')
    pg.wait_for_url('**/artisan-app/reputation.html', timeout=4000); ready(pg)
    check('performance.html forwards to Reputation', pg.url.endswith('/artisan-app/reputation.html'), pg.url)
    pg.close()
    pg, errs = open_page(ctx, '/artisan-app/reviews.html')
    pg.wait_for_url('**/artisan-app/reputation.html#reviews', timeout=4000); ready(pg)
    pg.wait_for_timeout(200)
    top = pg.evaluate("() => document.getElementById('reviews').getBoundingClientRect().top")
    check('reviews.html forwards to the Reviews section', pg.url.endswith('/artisan-app/reputation.html#reviews') and -5 <= top < 200, [pg.url, top])
    pg.close(); ctx.close()

    fail = copy.deepcopy(STRONG); fail['fail'] = True
    ctx = new_ctx(b, fail); pg, errs = open_page(ctx); pg.wait_for_timeout(400)
    check('nothing cached and Fidus X unreachable: said plainly, with Retry — never zeros',
          'can\'t be shown yet' in squash(pg.text_content('#rep-notices')) and pg.query_selector('#rep-notices button') is not None
          and pg.query_selector('[data-figure]') is None, squash(pg.text_content('#rep-notices')))
    pg.close(); ctx.close()

    b.close()
    _done = True
