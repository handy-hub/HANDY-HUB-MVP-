"""Phase 3, against the emulators: Jobs, the job screen and the cancellation policy,
with a real artisan sign-in and the real firestore.rules.

    npm run emulators          # Firestore 8080 + Auth 9099 are enough (functions not needed)
    npm run seed:e2e
    python -m http.server 8791 # from the repo root
    python -I tests/e2e/jobs_lifecycle.py

It writes five bookings of its own (JC-*) to the Firestore EMULATOR through its
REST API with the admin bypass ("Bearer owner"), 127.0.0.1 only — never
production — and then:
  * Jobs lists them where they belong, each with its step; History says who
    ended each booking and why, never a machine label or an admin's address;
  * approved work offers "Get help", never Cancel (decision Q5);
  * an unapproved job is cancelled for real — the rules accept it, the record
    names the artisan, and Jobs moves it to History as "Cancelled by you";
  * the view survives opening a job and coming Back;
  * and it reports (as an OBSERVATION, not a check) whether firestore.rules
    still accept a raw cancel of approved standard work — the gap awaiting a
    decision in the Phase 3 report.
"""
import json, sys, time, urllib.request
from playwright.sync_api import sync_playwright
sys.stdout.reconfigure(encoding='utf-8')

BASE = 'http://localhost:8791/artisan-app'
PROJECT = 'lamax-4fd82'
DB_ID = 'ai-studio-5589039d-72c4-40d8-ae39-f35c6c321eb6'
DOCS = f'http://127.0.0.1:8080/v1/projects/{PROJECT}/databases/{DB_ID}/documents'
ART = ('artisan@e2e.test', 'Passw0rd!23', 'e2e_artisan_1')

results = []
def check(name, ok, detail=''):
    results.append((name, bool(ok)))
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + ('' if ok else f'   [{str(detail)[:240]}]'))

def _value(v):
    if isinstance(v, bool): return {'booleanValue': v}
    if isinstance(v, int): return {'integerValue': str(v)}
    if isinstance(v, float): return {'doubleValue': v}
    return {'stringValue': str(v)}

def put(path, fields):
    body = json.dumps({'fields': {k: _value(v) for k, v in fields.items()}}).encode()
    req = urllib.request.Request(f'{DOCS}/{path}', data=body, method='PATCH',
                                 headers={'Authorization': 'Bearer owner', 'Content-Type': 'application/json'})
    urllib.request.urlopen(req, timeout=10).read()

def get(path):
    req = urllib.request.Request(f'{DOCS}/{path}', headers={'Authorization': 'Bearer owner'})
    with urllib.request.urlopen(req, timeout=10) as r:
        f = json.load(r).get('fields', {})
    return {k: list(v.values())[0] for k, v in f.items()}

now = time.time()
iso = lambda dt_s: time.strftime('%Y-%m-%dT%H:%M:%S.000Z', time.gmtime(dt_s))
BASEB = {'artisanId': ART[2], 'customerId': 'e2e_customer_1', 'customerFirstName': 'Ama', 'calloutFee': 60}
SEED = {
    'JC-S1': dict(BASEB, status='accepted', track='standard', serviceType='painting', quoteApproved=False, updatedAt=iso(now - 3600)),
    'JC-S2': dict(BASEB, status='accepted', track='standard', serviceType='tiling', quoteApproved=True, jobQuote=300, updatedAt=iso(now - 3000)),
    'JC-H1': dict(BASEB, status='completed', track='standard', serviceType='roofing', quoteApproved=True, completedAt=iso(now - 2 * 86400), updatedAt=iso(now - 2 * 86400)),
    'JC-H2': dict(BASEB, status='cancelled', track='inspection', serviceType='welding', cancelledBy='system', cancellationReason='callout_unpaid', updatedAt=iso(now - 3 * 86400)),
    'JC-H3': dict(BASEB, status='cancelled', track='standard', serviceType='glazing', cancelledBy='admin:ops@fidusx.example', updatedAt=iso(now - 4 * 86400)),
}
for bid, f in SEED.items():
    put(f'bookings/{bid}', dict(f, id=bid, bookingId=bid))

with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={'width': 390, 'height': 844})
    pg = ctx.new_page()
    errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    row = lambda bid: pg.locator(f'#jobs-list a[data-row="{bid}"]')
    text = lambda sel: (pg.locator(sel).first.inner_text(timeout=3000).strip() if pg.locator(sel).count() else '')

    pg.goto(f'{BASE}/login.html?emulator=1', wait_until='domcontentloaded'); pg.wait_for_timeout(1500)
    pg.fill('#si-email', ART[0]); pg.fill('#si-password', ART[1]); pg.click('#si-submit')
    pg.wait_for_url('**/dashboard.html*', timeout=25000); pg.wait_for_timeout(2500)
    check('real artisan sign-in (Auth emulator)', 'dashboard.html' in pg.url)

    # ── Jobs, from the real queries and rules ───────────────────────────
    pg.click('#tabbar a[href="jobs.html"]')
    pg.wait_for_selector('#jobs-list a[data-row="JC-S1"]', timeout=15000)
    check('Jobs: approved work and an unpriced job both need the artisan, each with its next step',
          'Next: Submit quote' in row('JC-S1').inner_text() and 'Next: Mark en route' in row('JC-S2').inner_text(),
          [row('JC-S1').inner_text(), row('JC-S2').inner_text()])
    # The first paint is the list Today cached, which never holds a customer's name
    # (artisanLists.js stripFields); the name arrives with the live list. Wait for it.
    try:
        pg.wait_for_function("() => /Ama/.test(document.querySelector('#jobs-list a[data-row=\"JC-S1\"]')?.innerText || '')", timeout=10000)
    except Exception:
        pass
    check('Jobs: the disclosed name is shown on an accepted job (from the live list)', 'Ama' in row('JC-S1').inner_text(), row('JC-S1').inner_text())
    pg.click('#jobs-views [data-view="history"]')
    pg.wait_for_selector('#jobs-list a[data-row="JC-H1"]', timeout=15000)
    hist = text('#jobs-list')
    check('History (status in + updatedAt desc, against the rules): completed, closed automatically, cancelled by support',
          all(s in hist for s in ['Completed', 'Closed automatically', 'did not pay the visit fee', 'Cancelled by Fidus X support']), hist[:300])
    check('History shows no machine label and no administrator address', 'callout_unpaid' not in hist and 'ops@' not in hist)

    # ── Back from a job keeps the view ──────────────────────────────────
    row('JC-H1').click()
    pg.wait_for_url('**/job.html?id=JC-H1', timeout=10000)
    pg.wait_for_selector('#jb-title', timeout=10000)
    check('a closed job opens with how it ended', 'Completed' in text('#jb-body'), text('#jb-body')[:120])
    pg.go_back(); pg.wait_for_selector('#jobs-list a[data-row="JC-H1"]', timeout=10000)
    check('Back returns to History (the view was in the URL)', 'view=history' in pg.url and
          pg.get_attribute('#jobs-views [data-view="history"]', 'aria-pressed') == 'true', pg.url)

    # ── Q5: approved work goes to Support ────────────────────────────────
    pg.goto(f'{BASE}/job.html?id=JC-S2', wait_until='domcontentloaded')
    pg.wait_for_selector('#jb-dock [data-act]', timeout=15000)
    acts = pg.eval_on_selector_all('#jb-dock [data-act]', 'els => els.map(e => e.dataset.act)')
    check('approved work: "Get help with this job", no Cancel (decision Q5)', 'help' in acts and 'cancel' not in acts, acts)
    # The rules today — an observation for the report, not a check.
    probe = pg.evaluate("""async () => {
        const { getAppContainer } = await import('/shared/js/app/container.js');
        try {
            await getAppContainer().services.databaseService.updateDocument('bookings', 'JC-S2',
                { status: 'cancelled', updatedAt: new Date().toISOString(), cancelledBy: 'artisan', cancellationReason: 'rules probe' });
            return 'ACCEPTED';
        } catch (e) { return 'REFUSED: ' + (e.code || e.message); }
    }""")
    print(f'  OBSERVATION  firestore.rules on a raw artisan cancel of APPROVED standard work: {probe}')
    put('bookings/JC-S2', dict(SEED['JC-S2'], id='JC-S2', bookingId='JC-S2'))   # put it back

    # ── Q4: an unapproved job is cancelled, for real ─────────────────────
    pg.goto(f'{BASE}/job.html?id=JC-S1', wait_until='domcontentloaded')
    pg.wait_for_selector('#jb-dock [data-act="cancel"]', timeout=15000)
    pg.click('#jb-dock [data-act="cancel"]')
    pg.wait_for_selector('#confirm-sheet:not([hidden]) [data-confirm]', timeout=5000)
    terms = pg.eval_on_selector_all('#confirm-list li', 'els => els.map(e => e.textContent.trim())')
    check('the confirmation says what cancelling does', terms[:1] == ['The customer is told, and the booking ends. It is not passed to anyone else.']
          and terms[-1] == 'It counts against the completion rate on your Performance screen.', terms)
    pg.click('#confirm-sheet [data-confirm]')
    ok = False
    for _ in range(20):
        rec = get('bookings/JC-S1')
        if rec.get('status') == 'cancelled': ok = True; break
        time.sleep(0.5)
    rec = get('bookings/JC-S1')
    check('the rules accept it: the booking is cancelled, by the artisan (AR-12), through performBookingAction',
          ok and rec.get('cancelledBy') == 'artisan', rec)

    pg.goto(f'{BASE}/jobs.html?view=history', wait_until='domcontentloaded')
    pg.wait_for_selector('#jobs-list a[data-row="JC-S1"]', timeout=15000)
    check('Jobs moves it to History as "Cancelled by you"', 'Cancelled by you' in row('JC-S1').inner_text(), row('JC-S1').inner_text())
    pg.click('#jobs-views [data-view="current"]'); pg.wait_for_timeout(500)
    check('and it is no longer in Current', row('JC-S1').count() == 0)
    pg.goto(f'{BASE}/dashboard.html', wait_until='domcontentloaded'); pg.wait_for_timeout(3000)
    check('Today agrees: the cancelled job is not on Today', 'painting' not in pg.inner_text('#today-state').lower() + pg.inner_text('#today-lists').lower())

    check('no uncaught page errors', not errs, errs[:3])
    b.close()

failed = [n for n, ok in results if not ok]
print(f"\njobs-lifecycle (emulator): {len(results) - len(failed)} passed, {len(failed)} failed")
sys.exit(1 if failed else 0)
