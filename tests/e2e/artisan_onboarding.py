"""Phase 5 browser checks: the professional's application (artisan-app/onboarding.html).

Runs the REAL page in Chromium with its real modules: js/onboarding.js (what
each step needs, resuming, what is saved and sent), js/entry.js, the shared
trade list and service catalogue, PLATFORM_CONFIG, the fx components. The
auth guard, the container's auth / database / storage services, the profile
photo service and Cloudinary URLs are in-page fakes that play the server.

  · a new account from the first field to "Application sent": every step's
    errors in words at the field, focus on the first, files through real
    buttons (keyboard too), the work pin, drafts saved per step, the review
    (masked numbers, Change), the agreement, ONE batch for two taps, the
    batch's contents (no status, pending_review, offline)
  · resuming: prefill from the records, documents on file not asked again,
    the first incomplete step
  · rejected / more information: the reviewer's words on every step
  · under review, approved, a failed read: no form
  · an unverified email: identity held, sending waits for verification
  · failures keep the answers: an upload, a draft save, the submission
  · browser Back walks the steps; layout at 360 / 390 / 768 px and 200% text;
    44 px targets; no page errors; no HandyHub

Network: NONE (Playwright routing; the origin http://localhost:4799 is never reached).

    python -I tests/e2e/artisan_onboarding.py
    FX_SHOTS=<dir> python -I tests/e2e/artisan_onboarding.py
"""
import os, sys, re, json, base64, pathlib, mimetypes, atexit
from playwright.sync_api import sync_playwright
sys.stdout.reconfigure(encoding='utf-8')

ROOT = pathlib.Path(__file__).resolve().parents[2]
ORIGIN = 'http://localhost:4799'   # localhost is a secure context: geolocation works; every request is still intercepted
SHOTS = os.environ.get('FX_SHOTS')

results = []
def check(name, cond, detail=''):
    results.append((name, bool(cond), detail))
_done = False
def _report():
    ok = sum(1 for _, c, _ in results if c)
    for n, c, d in results:
        print(f"  {'PASS' if c else 'FAIL'}  {n}" + ('' if c else f"   [{str(d)[:400]}]"))
    print(f"artisan-onboarding browser: {ok} passed, {len(results) - ok} failed" + ('' if _done else '  (aborted early)'))
    sys.stdout.flush(); sys.stderr.flush()
    if ok != len(results) or not _done:
        os._exit(1)
atexit.register(_report)

INIT = r"""
(() => {
  const S = __SCENARIO__;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const err = (code, message) => Object.assign(new Error(message || `Firebase: Error (${code}).`), { code });
  const fx = window.__fx = { ...S, calls: [], docs: S.docs || {}, stored: new Set(S.stored || []) };
  fx.user = { uid: 'A1', email: 'kofi@example.com', emailVerified: S.verified !== false };
  const rec = (...a) => fx.calls.push(a);
  fx.auth = {
    getCurrentUser() { return fx.user; },
    async refreshUser() { rec('refresh'); if (fx.verifyOnRefresh) fx.user.emailVerified = true; return { emailVerified: fx.user.emailVerified }; },
    async sendEmailVerification(url) { rec('verifyLink', url); },
    subscribeToAuthState(cb) { setTimeout(() => cb(fx.user), 0); return () => {}; },
    async waitForUser() { return fx.user; },
  };
  fx.db = {
    async getDocument(c, id) { rec('get', `${c}/${id}`); if (fx.readFail) throw err('unavailable', 'client is offline'); const d = fx.docs[`${c}/${id}`]; return d ? { exists: true, id, data: d } : { exists: false, id, data: null }; },
    async setDocument(c, id, data, opts) { rec('set', `${c}/${id}`, data, opts || null); if (fx.saveFail) throw err(fx.saveFail); },
    async commitBatch(writes) { rec('batch', writes); if (fx.batchDelay) await sleep(fx.batchDelay); if (fx.batchFail) throw err(fx.batchFail); },
    subscribeToDocument() { return () => {}; },
  };
  fx.storage = {
    async uploadFile(path, file, meta) { rec('upload', path, meta && meta.contentType); if ((fx.uploadFail || []).some((k) => path.endsWith('/' + k))) throw err('storage/unknown', 'boom'); fx.stored.add(path); return { fullPath: path }; },
    async getDownloadUrl(path) { if (!fx.stored.has(path)) throw err('storage/object-not-found'); return `https://files.test/${path}`; },
  };
})();
"""
PIXEL = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=')
GIF = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'
SPECIFIC = {
    '/shared/js/app/container.js':
        "export function getAppContainer(){ const fx = window.__fx; return { services: { authService: fx.auth, databaseService: fx.db, storageService: fx.storage } }; }",
    '/artisan-app/js/utils/artisanAuthGuard.js':
        "export async function requireArtisanAuth(o){ const fx = window.__fx; fx.calls.push(['guard', o]); if (fx.guardHold) return new Promise(() => {}); return { user: fx.user, artisan: fx.docs['artisans/A1'] || null }; }\n"
        "export function subscribeToArtisanAuthState(cb){ setTimeout(() => cb(window.__fx.user), 0); return () => {}; }",
    '/shared/js/services/profilePhotoService.js':
        "export async function replaceProfilePhoto(file, type){ const fx = window.__fx; fx.calls.push(['photo', type, file.name]);"
        " if (fx.photoFail) throw Object.assign(new Error('x'), { code: 'functions/unavailable' }); return { publicId: 'artisans/A1/p1', version: 7 }; }",
    '/shared/js/services/cloudinaryService.js':
        f"export const TRANSFORMS = {{ avatarLg: '' }}; export function avatarUrl(id){{ window.__fx.calls.push(['avatar', id]); return '{GIF}'; }}",
}
EMPTY = {'/shared/js/utils/global-app.js', '/shared/js/utils/themeManager.js', '/artisan-app/js/pwa.js'}
STUB_PAGES = {'/artisan-app/dashboard.html', '/artisan-app/support.html', '/artisan-app/index.html', '/artisan-app/login.html'}

def route(r):
    url = r.request.url
    if not url.startswith(ORIGIN): return r.abort()
    p = url[len(ORIGIN):].split('?')[0].split('#')[0]
    js = lambda body: r.fulfill(status=200, content_type='text/javascript', body=body)
    if p in SPECIFIC: return js(SPECIFIC[p])
    if p in EMPTY: return js('')
    if p in STUB_PAGES: return r.fulfill(status=200, content_type='text/html', body='<!doctype html><title>arrived</title><p id="arrived">arrived</p>')
    if p.startswith('/shared/vendor/firebase/') or p.startswith('/shared/js/backend/'):
        return js('export default {};')   # nothing real may load: every service is the fake above
    f = ROOT / p.lstrip('/')
    if not f.is_file(): return r.fulfill(status=404, body='')
    ctype = 'text/javascript' if f.suffix in ('.js', '.mjs') else (mimetypes.guess_type(str(f))[0] or 'application/octet-stream')
    return r.fulfill(status=200, content_type=ctype, body=f.read_bytes())

def open_page(b, scenario=None, width=390, height=900):
    ctx = b.new_context(viewport={'width': width, 'height': height},
                        geolocation={'latitude': 5.603716, 'longitude': -0.186964, 'accuracy': 18}, permissions=['geolocation'])
    ctx.add_init_script(INIT.replace('__SCENARIO__', json.dumps(scenario or {})))
    pg = ctx.new_page()
    errors = []
    pg.on('pageerror', lambda e: errors.append(str(e)))
    pg.route('**/*', route)
    pg.set_default_timeout(6000)
    pg.goto(f'{ORIGIN}/artisan-app/onboarding.html', wait_until='domcontentloaded')
    pg.wait_for_timeout(300)
    return pg, errors

squash = lambda s: re.sub(r'\s+', ' ', s or '').strip()
txt = lambda pg, sel: squash(pg.text_content(sel) or '')
calls = lambda pg, kind=None: [c for c in pg.evaluate('window.__fx.calls') if kind is None or c[0] == kind]
visible_step = lambda pg: pg.evaluate("() => (document.querySelector('.fx-onb__step:not([hidden])') || {}).dataset?.step || null")
def err_of(pg, id_):
    return txt(pg, f'#{id_}-err') if not pg.is_hidden(f'#{id_}-err') else ''
def pick(pg, which, name='card.png', mime='image/png', data=PIXEL, keyboard=False):
    with pg.expect_file_chooser() as fc:
        if keyboard:
            pg.focus(f'#ob-{which}-btn'); pg.keyboard.press('Enter')
        else:
            pg.click(f'#ob-{which}-btn')
    fc.value.set_files({'name': name, 'mimeType': mime, 'buffer': data})
def cont(pg, wait=250):
    pg.click('#ob-next'); pg.wait_for_timeout(wait)

OVERFLOW_JS = """() => { const w = document.documentElement.clientWidth; const bad = [];
  for (const el of document.querySelectorAll('body *')) { if (el.closest('[hidden]')) continue;
    const r = el.getBoundingClientRect(); if (r.width && (r.right > w + 0.5 || r.left < -0.5)) bad.push(el.tagName + '#' + el.id + '.' + [...el.classList].join('.')); }
  return { scroll: document.documentElement.scrollWidth > w, bad: bad.slice(0, 5) }; }"""
TARGETS_JS = """() => { const out = [];
  for (const el of document.querySelectorAll('button, a[href], select, input:not([type=checkbox]):not([type=radio]):not([type=file]), .fx-onb__opt, .fx-onb__choice')) {
    if (el.closest('[hidden], .fx-skip') || el.classList.contains('fx-link') || el.classList.contains('fx-btn--s')) continue;
    const r = el.getBoundingClientRect(); if (!r.width) continue;
    if (r.height < 43.5 || (r.width < 43.5)) out.push(el.tagName + '#' + el.id + '.' + el.className + ' ' + Math.round(r.width) + 'x' + Math.round(r.height)); }
  return out; }"""
def layout(pg, name):
    for w in (360, 390, 768):
        pg.set_viewport_size({'width': w, 'height': 800}); pg.wait_for_timeout(60)
        o = pg.evaluate(OVERFLOW_JS)
        check(f'{name} {w}px: no horizontal overflow', not o['scroll'] and not o['bad'], o)
        t = pg.evaluate(TARGETS_JS)
        check(f'{name} {w}px: every control is at least 44 px', not t, t)
    pg.set_viewport_size({'width': 390, 'height': 900})
def big_text(pg, name):
    pg.set_viewport_size({'width': 360, 'height': 800})
    pg.add_style_tag(content='html { font-size: 200% !important; }'); pg.wait_for_timeout(120)
    o = pg.evaluate(OVERFLOW_JS)
    check(f'{name} 360px at 200% text: no horizontal overflow', not o['scroll'] and not o['bad'], o)
def shot(pg, name):
    if SHOTS:
        pathlib.Path(SHOTS).mkdir(parents=True, exist_ok=True)
        pg.screenshot(path=str(pathlib.Path(SHOTS) / f'onboarding-{name}.png'), full_page=True)

NEW = {'artisans/A1': {'id': 'A1', 'userType': 'artisan', 'status': 'pending', 'verificationStatus': 'draft', 'name': 'Kofi Boateng', 'category': 'Plumbing'}}
FULL_PROFILE = {'id': 'A1', 'userType': 'artisan', 'status': 'pending', 'name': 'Kofi Boateng', 'category': 'Plumbing', 'gender': 'male',
    'bio': 'Plumber in Accra for twelve years: leaks, toilets and water heaters.', 'yearsExperience': 12, 'workRadius': 20,
    'skills': ['Fix Leaking Pipe'], 'availability': ['Mon'], 'profileImageId': 'artisans/A1/p0', 'profileImageVersion': 3}
FULL_KYC = {'artisanId': 'A1', 'dob': '1990-04-12', 'address': '12 Example Street', 'ghanaCardNumber': 'GHA-123456789-0',
    'payoutAccount': {'provider': 'mtn', 'phone': '0241111111', 'accountName': 'Kofi Boateng'}}
CARD_FILES = ['artisans/A1/documents/idFront', 'artisans/A1/documents/idBack']
FULL_DOCS = lambda status, request=None: {
    'artisans/A1': dict(FULL_PROFILE, verificationStatus=status),
    'artisans/A1/private/kyc': FULL_KYC,
    'artisans/A1/private/contact': {'artisanId': 'A1', 'phone': '0241234567'},
    'artisans/A1/private/location': {'lat': 5.6037, 'lng': -0.1869, 'accuracy': 12, 'updatedAt': '2026-11-01T00:00:00Z'},
    **({'verification_requests/A1': request} if request else {}),
}

with sync_playwright() as p:
    b = p.chromium.launch()

    # ═══ A new account, from the first field to "Application sent" ══════════
    pg, errs = open_page(b, {'docs': NEW, 'batchDelay': 400})
    check('new: the guard admits a draft account (allowPending)', calls(pg, 'guard') == [['guard', {'allowPending': True}]], calls(pg, 'guard'))
    check('new: it reads the profile, the private records and the request — and writes nothing on arrival',
          {c[1] for c in calls(pg, 'get')} >= {'artisans/A1', 'artisans/A1/private/kyc', 'artisans/A1/private/contact', 'artisans/A1/private/location', 'verification_requests/A1'}
          and not calls(pg, 'set') and not calls(pg, 'batch'), calls(pg))
    check('new: step 1 of 5, About you; title and wordmark-free bar say Fidus X, nothing says HandyHub',
          visible_step(pg) == 'you' and txt(pg, '#ob-sub') == 'Step 1 of 5 · About you' and txt(pg, '.fx-rail__now') == 'About you'
          and pg.title() == 'Your application | Fidus X for professionals'
          and not re.search(r'handy\s*hub', pg.inner_text('body'), re.I), [visible_step(pg), txt(pg, '#ob-sub'), pg.title()])
    check('new: the name comes from the account, the email is the sign-in email and read-only',
          pg.input_value('#ob-first') == 'Kofi' and pg.input_value('#ob-last') == 'Boateng'
          and pg.input_value('#ob-email') == 'kofi@example.com' and pg.get_attribute('#ob-email', 'readonly') is not None)
    check('new: verified email → no verification notice; the dock has Continue, no Back on step 1',
          pg.query_selector('#ob-gate .fx-notice') is None and txt(pg, '#ob-next') == 'Continue' and pg.is_hidden('#ob-prev'))
    shot(pg, 'you-390')
    layout(pg, 'about you')

    cont(pg)
    check('about you, empty: each missing answer is said at its field, in words, and marked invalid',
          err_of(pg, 'ob-phone') == 'Enter your mobile number.' and err_of(pg, 'ob-dob') == 'Enter your date of birth.'
          and err_of(pg, 'ob-address') == 'Enter your home address.'
          and err_of(pg, 'ob-pin') == 'Set your work location. Job requests are offered by distance from it.'
          and err_of(pg, 'ob-selfie') == 'Add a photo of your face.'
          and pg.get_attribute('#ob-phone', 'aria-invalid') == 'true', [err_of(pg, x) for x in ('ob-phone', 'ob-dob', 'ob-pin', 'ob-selfie')])
    check('about you, empty: focus goes to the first problem; nothing is saved', pg.evaluate('document.activeElement.id') == 'ob-phone' and not calls(pg, 'set'))
    pg.fill('#ob-phone', '12345'); pg.fill('#ob-dob', '2010-01-01'); cont(pg)
    check('a wrong number and an under-18 date are explained', err_of(pg, 'ob-phone') == 'Enter a Ghana mobile number, like 024 123 4567.'
          and err_of(pg, 'ob-dob') == 'You must be 18 or older to work on Fidus X.')
    pg.fill('#ob-phone', '024 123 4567'); pg.fill('#ob-dob', '1990-04-12'); pg.fill('#ob-address', '12 Example Street, Accra')
    check('typing clears that field\'s error', err_of(pg, 'ob-phone') == '' and pg.get_attribute('#ob-phone', 'aria-invalid') == 'false')
    pg.click('#ob-pin-btn'); pg.wait_for_function("document.getElementById('ob-pin-state').dataset.state === 'set'")
    check('the work pin: "Set, accurate to about 18 m"; the button now updates it',
          txt(pg, '#ob-pin-state') == 'Set, accurate to about 18 m' and txt(pg, '#ob-pin-btn') == 'Update location')
    pick(pg, 'selfie', 'me.png')
    check('the photo: a real button opens the picker; the choice is shown with a preview',
          txt(pg, '#ob-selfie-state') == 'Selected: me.png' and pg.is_visible('#ob-selfie-thumb') and txt(pg, '#ob-selfie-btn') == 'Change photo')
    cont(pg, 400)
    check('about you → saved: the photo through the shared lifecycle, then contact, pin, profile and identity record',
          calls(pg, 'photo') == [['photo', 'artisan', 'me.png']]
          and {c[1] for c in calls(pg, 'set')} == {'artisans/A1/private/contact', 'artisans/A1/private/location', 'artisans/A1', 'artisans/A1/private/kyc'},
          calls(pg, 'set'))
    prof = next(c[2] for c in calls(pg, 'set') if c[1] == 'artisans/A1')
    check('the profile draft: the name and the area to ~1 km; no state, no phone, no private field',
          prof.get('lat') == 5.6 and prof.get('lng') == -0.19 and prof.get('name') == 'Kofi Boateng'
          and not ({'verificationStatus', 'status', 'phone', 'email', 'dob', 'address'} & set(prof)), prof)
    check('about you → step 2, Your identity; "Saved to your account."; focus on the step heading',
          visible_step(pg) == 'identity' and txt(pg, '#ob-note') == 'Saved to your account.'
          and pg.evaluate('document.activeElement.id') == 'ob-h-identity' and pg.is_visible('#ob-prev'))

    cont(pg)
    check('identity, empty: the card number and both sides of the card are asked for',
          err_of(pg, 'ob-card') == 'Enter your Ghana Card number.' and err_of(pg, 'ob-idFront') == 'Add a photo of the front of your Ghana Card.'
          and err_of(pg, 'ob-idBack') == 'Add a photo of the back of your Ghana Card.')
    pg.fill('#ob-card', 'gha 123456789 0')
    pick(pg, 'idFront', 'front.png', keyboard=True)
    pick(pg, 'idBack', 'back.pdf', 'application/pdf', b'%PDF-1.4')
    check('identity: the file buttons work from the keyboard; a PDF is accepted without a preview',
          txt(pg, '#ob-idFront-state') == 'Selected: front.png' and txt(pg, '#ob-idBack-state') == 'Selected: back.pdf' and pg.is_hidden('#ob-idBack-thumb'))
    pick(pg, 'cert', 'big.png', data=b'x' * (5 * 1024 * 1024 + 1))
    check('a file over 5 MB is refused here, with the reason', txt(pg, '#ob-note') == 'Trade certificate or licence: Choose a file under 5 MB.' and txt(pg, '#ob-cert-state').startswith('Not added'))
    shot(pg, 'identity-390')
    layout(pg, 'identity')
    cont(pg, 400)
    up = calls(pg, 'upload')
    check('identity → the card photos stored under their fixed names, with their type', up == [
        ['upload', 'artisans/A1/documents/idFront', 'image/png'], ['upload', 'artisans/A1/documents/idBack', 'application/pdf']], up)
    kyc = [c[2] for c in calls(pg, 'set') if c[1] == 'artisans/A1/private/kyc'][-1]
    check('identity → the card number saved normalised, privately', kyc.get('ghanaCardNumber') == 'GHA-123456789-0' and visible_step(pg) == 'work', kyc)

    check('work: the trade list is the 8 bookable trades + Other', pg.eval_on_selector_all('#ob-trade option:not([disabled])', 'os => os.map(o => o.value)')
          == ['Electrical', 'Plumbing', 'Carpentry', 'AC Repair', 'Welding', 'Cleaning', 'Painting', 'Gardening', 'Other'])
    check('work: the account\'s trade is preselected and its jobs come from the catalogue',
          pg.input_value('#ob-trade') == 'Plumbing' and pg.eval_on_selector_all('#ob-skills-opts input', 'is => is.map(i => i.value)')
          == ['Fix Leaking Pipe', 'Toilet Repair / Unclogging', 'Water Heater Installation', 'Tap / Faucet Replacement'])
    pg.select_option('#ob-trade', 'Other')
    check('Other: the description and the closest listed trade appear', pg.is_visible('#ob-other-desc') and pg.is_visible('#ob-other-bucket'))
    cont(pg)
    check('Other, empty: the server\'s words', err_of(pg, 'ob-other-desc') == 'Describe your trade.' and err_of(pg, 'ob-other-bucket') == 'Choose the listed trade closest to yours.')
    pg.select_option('#ob-trade', 'Plumbing')
    check('back to a listed trade: the panel closes', pg.is_hidden('#ob-other'))
    pg.check('#ob-skills-opts input[value="Fix Leaking Pipe"]')
    pg.fill('#ob-bio', 'Too short'); cont(pg)
    check('the bio counts what is there', err_of(pg, 'ob-bio') == 'Write at least 50 characters (9 so far).' and err_of(pg, 'ob-years') == 'Enter your years of experience.')
    pg.fill('#ob-bio', 'Plumber in Accra for twelve years: leaks, toilets and water heaters.')
    pg.fill('#ob-years', '12')
    check('the radius: 5–25 km as Settings offers; 10 km to start', pg.eval_on_selector_all('#ob-radius .fx-seg__btn', 'bs => bs.map(b => b.textContent)')
          == ['5 km', '10 km', '15 km', '20 km', '25 km'] and pg.get_attribute('#ob-radius [data-value="10"]', 'aria-pressed') == 'true')
    pg.click('#ob-radius [data-value="15"]'); pg.check('#ob-days input[value="Sat"]')
    shot(pg, 'work-390')
    layout(pg, 'your work')
    cont(pg, 400)
    work = [c[2] for c in calls(pg, 'set') if c[1] == 'artisans/A1'][-1]
    check('work → saved to the profile: trade, jobs, bio, years, radius, days; no state',
          [work.get(k) for k in ('category', 'specialty', 'requestedService', 'yearsExperience', 'workRadius', 'baseRate')] == ['Plumbing', 'Plumbing', None, 12, 15, None]
          and work.get('skills') == ['Fix Leaking Pipe'] and work.get('availability') == ['Sat'] and 'verificationStatus' not in work, work)

    check('payout: the providers by their names (no "VDF"); the commission from PLATFORM_CONFIG',
          visible_step(pg) == 'payout' and pg.eval_on_selector_all('#ob-pay-opts label', 'ls => ls.map(l => l.textContent.trim())') == ['MTN Mobile Money', 'Telecel Cash', 'AirtelTigo Money']
          and txt(pg, '[data-fx-commission]') == '15%' and txt(pg, '[data-fx-artisan-share]') == '85%' and 'VDF' not in pg.inner_text('body'))
    cont(pg)
    check('payout, empty: provider, number and name', err_of(pg, 'ob-pay') == 'Choose your Mobile Money provider.'
          and err_of(pg, 'ob-pay-number') == 'Enter the Mobile Money number.' and err_of(pg, 'ob-pay-name') == 'Enter the name on the Mobile Money account.')
    pg.check('#ob-pay-opts input[value="mtn"]'); pg.fill('#ob-pay-number', '024 111 1111'); pg.fill('#ob-pay-name', 'Kofi Boateng')
    layout(pg, 'getting paid')
    cont(pg, 400)
    pay = [c[2] for c in calls(pg, 'set') if c[1] == 'artisans/A1/private/kyc'][-1]
    check('payout → saved privately, the number normalised', pay.get('payoutAccount') == {'provider': 'mtn', 'phone': '0241111111', 'accountName': 'Kofi Boateng'}, pay)

    body = txt(pg, '#ob-summary')
    check('review: every step summarised; the card and payout numbers masked; documents "Ready"/"On file"',
          visible_step(pg) == 'review' and 'GHA-•••••6789-0' in body and '•••• 1111' in body and 'Kofi Boateng' in body
          and 'Up to 15 km' in body and '0241111111' not in body and 'GHA-123456789-0' not in body, body)
    check('review: the button says what it does; what happens next promises no time',
          txt(pg, '#ob-next') == 'Send application' and not re.search(r'\bdays?\b|hours?\b|hrs|\b24\b|\b48\b', txt(pg, '#ob-step-review .fx-onb__next')),
          txt(pg, '#ob-step-review .fx-onb__next'))
    shot(pg, 'review-390')
    layout(pg, 'review')
    pg.click('#ob-summary section:nth-of-type(3) button')
    check('Change on "Your work" opens that step with the answers kept', visible_step(pg) == 'work' and pg.input_value('#ob-years') == '12'
          and pg.get_attribute('#ob-radius [data-value="15"]', 'aria-pressed') == 'true')
    pg.go_back(); pg.wait_for_timeout(150)
    check('browser Back walks the steps, not away from the page', visible_step(pg) == 'review', visible_step(pg))
    pg.go_back(); pg.wait_for_timeout(150)
    check('… and again, in the order the steps were visited', visible_step(pg) == 'payout', visible_step(pg))
    pg.go_forward(); pg.wait_for_timeout(150)
    check('Forward returns to Check and send', visible_step(pg) == 'review', visible_step(pg))
    cont(pg)
    check('send without the agreement: refused, in words; nothing is sent',
          err_of(pg, 'ob-terms') == 'Agree to the Terms of Service and Privacy Policy to send your application.' and not calls(pg, 'batch'))
    pg.check('#ob-terms')
    pg.evaluate("() => { const b = document.getElementById('ob-next'); b.click(); b.disabled = false; b.click(); document.getElementById('ob-form').requestSubmit(); }")
    pg.wait_for_selector('#ob-done:not([hidden])', timeout=6000)
    batches = calls(pg, 'batch')
    check('two taps (and a forced third) send ONE application', len(batches) == 1, len(batches))
    ws = batches[0][1] if batches else []
    check('the batch: identity, pin, contact, profile, request — all merges', [f"{w['path']}/{w['id']}" for w in ws] == [
        'artisans/A1/private/kyc', 'artisans/A1/private/location', 'artisans/A1/private/contact', 'artisans/A1', 'verification_requests/A1']
        and all(w['merge'] for w in ws), [w['path'] for w in ws])
    profile = next((w['data'] for w in ws if w['path'] == 'artisans'), {})
    req = next((w['data'] for w in ws if w['path'] == 'verification_requests'), {})
    check('the profile is sent for review and offline — never its status or an approval',
          profile.get('verificationStatus') == 'pending_review' and profile.get('isAvailable') is False and 'status' not in profile
          and 'isVerified' not in profile and 'createdAt' not in profile, profile)
    check('the request: both status fields, the stored documents', req.get('status') == 'pending_review' and req.get('verificationStatus') == 'pending_review'
          and req.get('documents') == {'idFront': 'https://files.test/artisans/A1/documents/idFront', 'idBack': 'https://files.test/artisans/A1/documents/idBack'}, req)
    check('sent: "Application sent", no form, no dock; Go to Today and Contact support; focus on the heading',
          txt(pg, '#ob-done-h') == 'Application sent' and pg.is_hidden('#ob-form') and pg.is_hidden('#ob-dock')
          and pg.get_attribute('#ob-done a.fx-btn--primary', 'href') == 'dashboard.html' and pg.get_attribute('#ob-done a.fx-btn--secondary', 'href') == 'support.html'
          and pg.evaluate('document.activeElement.id') == 'ob-done-h')
    check('sent: no promise of a review time and no SMS', not re.search(r'business day|hours?\b|hrs|SMS', txt(pg, '#ob-done')), txt(pg, '#ob-done'))
    shot(pg, 'sent-390')
    layout(pg, 'sent')
    big_text(pg, 'sent')
    check('new account: no page errors', not errs, errs[:3])
    pg.context.close()

    # ═══ 200% text on a long step ═══════════════════════════════════════════
    pg, errs = open_page(b, {'docs': NEW}, width=360)
    big_text(pg, 'about you')
    pg.context.close()

    # ═══ Resuming ═══════════════════════════════════════════════════════════
    docs = FULL_DOCS('draft')
    docs['artisans/A1/private/kyc'] = {k: v for k, v in FULL_KYC.items() if k != 'payoutAccount'}
    pg, errs = open_page(b, {'docs': docs, 'stored': ['artisans/A1/documents/idFront', 'artisans/A1/documents/idBack']})
    check('resume: it opens at the first incomplete step (Getting paid)', visible_step(pg) == 'payout' and txt(pg, '#ob-sub') == 'Step 4 of 5 · Getting paid', visible_step(pg))
    pg.click('#ob-back'); pg.wait_for_timeout(100); pg.click('#ob-back'); pg.wait_for_timeout(100)
    check('resume: the documents stored on an earlier visit are on file, not asked for again',
          visible_step(pg) == 'identity' and txt(pg, '#ob-idFront-state') == 'On file' and txt(pg, '#ob-idBack-btn') == 'Replace' and pg.input_value('#ob-card') == 'GHA-123456789-0')
    pg.click('#ob-back'); pg.wait_for_timeout(100)
    check('resume: about you is filled from the records; the photo on file; the pin set',
          pg.input_value('#ob-phone') == '0241234567' and pg.input_value('#ob-dob') == '1990-04-12' and txt(pg, '#ob-selfie-state') == 'On file'
          and txt(pg, '#ob-pin-state') == 'Set, accurate to about 12 m' and pg.input_value('#ob-gender') == 'male')
    pg.click('#ob-back'); pg.wait_for_timeout(200)
    check('Back on step 1 leaves for Today', pg.url.endswith('/artisan-app/dashboard.html'), pg.url)
    check('resume: no page errors', not errs, errs[:3])
    pg.context.close()

    # ═══ Rejected: the reviewer's words, then send again ════════════════════
    req = {'artisanId': 'A1', 'status': 'rejected', 'verificationStatus': 'rejected', 'rejectionReason': 'The card photo is blurred.',
           'documents': {'idFront': 'https://files.test/old-f', 'idBack': 'https://files.test/old-b'}}
    pg, errs = open_page(b, {'docs': FULL_DOCS('rejected', req)})
    fix = txt(pg, '#ob-fix .fx-notice')
    check('rejected: "Your application needs changes" with the reviewer\'s reason, on every step',
          fix.startswith('Your application needs changes') and 'The card photo is blurred.' in fix and 'send your application again' in fix, fix)
    check('rejected: the answers are all there; it opens on Check and send', visible_step(pg) == 'review' and 'GHA-•••••6789-0' in txt(pg, '#ob-summary'))
    pg.click('#ob-summary section:nth-of-type(2) button')
    check('… and the notice stays while changing a step', visible_step(pg) == 'identity' and 'blurred' in txt(pg, '#ob-fix'))
    pick(pg, 'idFront', 'sharp.png')
    cont(pg, 400); cont(pg, 300); cont(pg, 300)
    pg.check('#ob-terms'); cont(pg, 500)
    ws = (calls(pg, 'batch') or [[None, []]])[0][1]
    req2 = next((w['data'] for w in ws if w['path'] == 'verification_requests'), {})
    check('rejected → resent with the new front and the old back on file', req2.get('documents') == {
        'idFront': 'https://files.test/artisans/A1/documents/idFront', 'idBack': 'https://files.test/old-b'} and txt(pg, '#ob-done-h') == 'Application sent', req2)
    check('rejected: no page errors', not errs, errs[:3])
    pg.context.close()

    pg, errs = open_page(b, {'docs': FULL_DOCS('re_verification_required', {'artisanId': 'A1', 'status': 're_verification_required', 'infoRequestNotes': 'Add a clearer photo of your face.'})})
    fix = txt(pg, '#ob-fix .fx-notice')
    check('more information: "Fidus X needs more information" and the reviewer\'s notes', fix.startswith('Fidus X needs more information') and 'Add a clearer photo of your face.' in fix, fix)
    pg.context.close()

    # ═══ Under review, approved, a failed read: no form ═════════════════════
    pg, errs = open_page(b, {'docs': FULL_DOCS('pending_review')})
    check('under review: the waiting screen, no form, nothing written', txt(pg, '#ob-done-h') == 'Your application is being reviewed'
          and pg.is_hidden('#ob-form') and pg.is_hidden('#ob-dock') and not calls(pg, 'set') and not calls(pg, 'batch'))
    layout(pg, 'under review')
    check('under review: no page errors', not errs, errs[:3])
    pg.context.close()

    pg, errs = open_page(b, {'docs': FULL_DOCS('approved')})
    check('approved: sent to Today, never shown the form', pg.url.endswith('/artisan-app/dashboard.html'), pg.url)
    pg.context.close()

    pg, errs = open_page(b, {'docs': NEW, 'readFail': True})
    check('a failed read: "Can\'t reach the server", Try again; no form, nothing written',
          txt(pg, '#ob-alert .fx-notice').startswith("Can't reach the server") and pg.is_visible('#ob-alert button')
          and pg.is_hidden('#ob-form') and pg.is_hidden('#ob-dock') and not calls(pg, 'set'), txt(pg, '#ob-alert'))
    check('a failed read: no page errors', not errs, errs[:3])
    pg.context.close()

    # ═══ An unverified email ═══════════════════════════════════════════════
    docs = FULL_DOCS('draft')
    pg, errs = open_page(b, {'docs': docs, 'verified': False, 'stored': CARD_FILES})
    gate = txt(pg, '#ob-gate .fx-notice')
    check('unverified: the notice explains it, with I\'ve verified and Resend link',
          gate.startswith('Verify your email') and 'kofi@example.com' in gate and pg.eval_on_selector_all('#ob-gate button', 'bs => bs.map(b => b.textContent)') == ["I've verified", 'Resend link'], gate)
    pg.click('#ob-gate button:nth-of-type(2)'); pg.wait_for_timeout(100)
    check('Resend link sends a link back to this page', [c[1].endswith('/artisan-app/onboarding.html') for c in calls(pg, 'verifyLink')] == [True]
          and txt(pg, '#ob-note') == 'Verification link sent to kofi@example.com.')
    pg.click('#ob-summary section:nth-of-type(4) button'); cont(pg, 300)
    check('unverified: the payout step saves nothing and says the details stay on this screen',
          not [c for c in calls(pg, 'set') if c[1].endswith('/kyc')] and txt(pg, '#ob-note') == 'Kept on this screen until your email is verified.')
    pg.check('#ob-terms'); cont(pg, 300)
    check('unverified: Send checks with the server, does not send, and says why',
          calls(pg, 'refresh') and not calls(pg, 'batch') and txt(pg, '#ob-note') == 'Verify your email to send your application.' and not pg.is_disabled('#ob-next'))
    pg.evaluate('window.__fx.verifyOnRefresh = true')
    cont(pg, 500)
    check('verified meanwhile: Send goes through and the notice is gone', len(calls(pg, 'batch')) == 1 and txt(pg, '#ob-done-h') == 'Application sent'
          and pg.query_selector('#ob-gate .fx-notice') is None)
    check('unverified: no page errors', not errs, errs[:3])
    pg.context.close()

    # ═══ Failures keep the answers ══════════════════════════════════════════
    pg, errs = open_page(b, {'docs': FULL_DOCS('draft'), 'uploadFail': ['idFront'], 'stored': CARD_FILES})
    pg.click('#ob-summary section:nth-of-type(2) button')
    pick(pg, 'idFront', 'again.png'); cont(pg, 400)
    check('an upload that fails: stays on the step, says which file, keeps the card number and the pick',
          visible_step(pg) == 'identity' and txt(pg, '#ob-alert').startswith('Ghana Card, front could not be uploaded.')
          and pg.input_value('#ob-card') == 'GHA-123456789-0' and txt(pg, '#ob-idFront-state') == 'Selected: again.png' and not pg.is_disabled('#ob-next'), txt(pg, '#ob-alert'))
    pg.evaluate("window.__fx.uploadFail = []"); cont(pg, 400)
    check('… and Continue again goes through', visible_step(pg) == 'work' and pg.query_selector('#ob-alert .fx-notice') is None)
    pg.evaluate("window.__fx.saveFail = 'unavailable'"); cont(pg, 400)
    check('a draft save that fails: the step still continues and says it was not saved, in words',
          visible_step(pg) == 'payout' and txt(pg, '#ob-note').startswith("Not saved to your account yet. Can't reach the server."), txt(pg, '#ob-note'))
    pg.evaluate("window.__fx.saveFail = null; window.__fx.batchFail = 'permission-denied'")
    cont(pg, 300); pg.check('#ob-terms'); cont(pg, 500)
    check('a refused submission: still on Check and send, the reason in words, the button usable, the answers kept',
          visible_step(pg) == 'review' and 'could not accept this application' in txt(pg, '#ob-alert') and not pg.is_disabled('#ob-next')
          and txt(pg, '#ob-next') == 'Send application' and pg.is_checked('#ob-terms') and 'Firebase' not in txt(pg, '#ob-alert'), txt(pg, '#ob-alert'))
    pg.evaluate("window.__fx.batchFail = null"); cont(pg, 500)
    check('… and sending again works', txt(pg, '#ob-done-h') == 'Application sent' and len(calls(pg, 'batch')) == 2)
    check('failures: no page errors', not errs, errs[:3])
    pg.context.close()

    b.close()

_done = True
