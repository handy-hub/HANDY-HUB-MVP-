"""Phase 5 browser checks: the professional app's entry screens and account states.

Runs the REAL artisan-app/login.html, signup.html, verify-email.html,
index.html and offline.html, and the REAL auth guard's account screens (through
tests/e2e/guard_harness.html), in Chromium. The pages' own modules are real:
js/entry.js, js/utils/artisanRoutes.js, the shared trade list, the fx
components. Firebase, the auth service, the artisanAccount callable and the
Cloud Functions client are in-page fakes that play the server's answers.

  · branding: the Fidus X wordmark; no HandyHub name or image, no logo image,
    no gradient, no third-party image host
  · sign in: field errors, credential errors in words, routing by the server's
    record, a customer account sent to the customer app, an outage keeping the
    session, the reset view (the same answer for any email), arrival notices
  · sign up: every field's error, "Other", the payload the server receives
    (phone normalised), one request for two taps, an existing email, the
    already-signed-in visitor
  · the guard's screens: suspended, pending, rejected, offline, set-up, entered
  · layout at 360 / 390 / 768 px and 200% text; 44 px targets; no page errors

Network: NONE (Playwright routing to the fake origin http://fx.test).

    python -I tests/e2e/artisan_entry.py
    FX_SHOTS=<dir> python -I tests/e2e/artisan_entry.py
"""
import os, sys, re, json, pathlib, mimetypes, atexit
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
    print(f"artisan-entry browser: {ok} passed, {len(results) - ok} failed" + ('' if _done else '  (aborted early)'))
    sys.stdout.flush(); sys.stderr.flush()
    if ok != len(results) or not _done:
        os._exit(1)
atexit.register(_report)

INIT = r"""
(() => {
  const S = __SCENARIO__;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const err = (code, message) => Object.assign(new Error(message || `Firebase: Error (${code}).`), { code });
  const fx = window.__fx = { calls: [], authCb: [], user: S.user || null, docs: S.docs || {}, ...S };
  // The calls survive a navigation in this tab: the page that was left is read from the next one.
  try { fx.prevCalls = JSON.parse(sessionStorage.getItem('__fx_calls') || '[]'); } catch (e) { fx.prevCalls = []; }
  const push = fx.calls.push.bind(fx.calls);
  fx.calls.push = (...a) => { const r = push(...a); try { sessionStorage.setItem('__fx_calls', JSON.stringify(fx.calls)); } catch (e) {} return r; };
  window.HH_State = { currentUid: () => (fx.user && fx.user.uid) || null };
  const any = () => new Proxy(function () {}, { get: (t, k) => (k === 'then' ? undefined : k === Symbol.toPrimitive ? () => '' : any()), apply: () => any() });
  fx.any = any;
  const signedIn = (u) => { fx.user = u; fx.authCb.forEach((cb) => cb(u)); };
  fx.auth = {
    async signInWithEmail(email) { fx.calls.push(['signIn', email]); if (fx.delay) await sleep(fx.delay); if (fx.signInError) throw err(fx.signInError); signedIn({ uid: 'A1', email }); return { user: fx.user }; },
    async signInWithSocial(p) { fx.calls.push(['social', p]); if (fx.socialError) throw err(fx.socialError); signedIn({ uid: 'A1', email: 'g@x.test' }); return { user: fx.user }; },
    async sendPasswordResetEmail(email) { fx.calls.push(['reset', email]); if (fx.resetError) throw err(fx.resetError); },
    subscribeToAuthState(cb) { fx.authCb.push(cb); setTimeout(() => cb(fx.user), 0); return () => {}; },
    async signOut() { fx.calls.push(['signOut']); fx.user = null; },
    async sendEmailVerification(url) { fx.calls.push(['verify', url]); },
    async waitForUser() { return fx.user; },
    getCurrentUser() { return fx.user; },
  };
  fx.db = {
    async getDocument(c, id) { fx.calls.push(['get', `${c}/${id}`]); if (fx.docFail) throw err('unavailable', 'unavailable'); const d = fx.docs[`${c}/${id}`]; return d ? { exists: true, id, data: d } : { exists: false, id, data: null }; },
    subscribeToDocument() { return () => {}; },
  };
  fx.callable = async (name, data) => {
    fx.calls.push(['callable', name, data]);
    if (fx.callDelay) await sleep(fx.callDelay);
    const r = (fx.callables || {})[name];
    if (r && r.error) throw err(`functions/${r.error.code}`, r.error.message);
    return { data: (r && r.data) || {} };
  };
})();
"""
SPECIFIC = {
    '/shared/js/app/container.js':
        "export function getAppContainer(){ const fx = window.__fx; return { services: new Proxy({ authService: fx.auth, databaseService: fx.db },"
        " { get:(t,k)=> k in t ? t[k] : fx.any() }) }; }",
    '/artisan-app/js/utils/artisanAccount.js':
        "export async function ensureArtisanAccount(){ window.__fx.calls.push(['ensure']); return window.__fx.ensure || { ok: false }; }\n"
        "export { nextArtisanPage } from './artisanRoutes.js';\n"
        "export const ARTISAN_TRADES = []; export function claimsLocked(){ return false; }\n"
        "export async function requestProfileChange(){} export async function cancelProfileChange(){}\n",
}
STUB_PAGES = {'/artisan-app/dashboard.html', '/artisan-app/onboarding.html', '/customer-app/login.html', '/customer-app/index.html'}
EMPTY = {'/shared/js/utils/global-app.js', '/shared/js/utils/themeManager.js', '/artisan-app/js/pwa.js', '/artisan-app/js/artisanFloatingNav.js'}
CATCH_ALL = re.compile(r'^/shared/(vendor/firebase/(?!firebase-functions)|js/backend/)|^/shared/js/services/(pushNotificationService|callable)\.js$')

def import_names(src, tail):
    names = set()
    for m in re.finditer(r'import\s*\{([^}]*)\}\s*from\s*[\'"]([^\'"]+)[\'"]', src):
        if m.group(2).endswith(tail):
            for part in m.group(1).split(','):
                part = part.strip()
                if part: names.add(part.split(' as ')[0].strip())
    return names
ALL_SRC = '\n'.join(p.read_text(encoding='utf-8', errors='ignore')
                    for p in list((ROOT / 'artisan-app').glob('*.html')) + list((ROOT / 'shared' / 'js').rglob('*.js')) + list((ROOT / 'artisan-app' / 'js').rglob('*.js')))

def route(r):
    url = r.request.url
    if not url.startswith(ORIGIN): return r.abort()
    p = url[len(ORIGIN):].split('?')[0].split('#')[0]
    js = lambda body: r.fulfill(status=200, content_type='text/javascript', body=body)
    if p in SPECIFIC: return js(SPECIFIC[p])
    if p in EMPTY: return js('')
    if p in STUB_PAGES: return r.fulfill(status=200, content_type='text/html', body='<!doctype html><title>arrived</title><p id="arrived">arrived</p>')
    if p == '/shared/vendor/firebase/firebase-functions.js':
        others = import_names(ALL_SRC, 'firebase-functions.js') - {'httpsCallable'}
        return js(''.join(f'export const {n} = window.__fx.any();\n' for n in sorted(others) if n.isidentifier())
                  + 'export function httpsCallable(_f, name) { return (data) => window.__fx.callable(name, data); }\n')
    if CATCH_ALL.search(p):
        names = import_names(ALL_SRC, p.split('/')[-1])
        return js(''.join(f'export const {n} = window.__fx.any();\n' for n in sorted(names) if n.isidentifier()) + 'export default window.__fx.any();')
    f = ROOT / p.lstrip('/')
    if not f.is_file(): return r.fulfill(status=404, body='')
    ctype = 'text/javascript' if f.suffix in ('.js', '.mjs') else (mimetypes.guess_type(str(f))[0] or 'application/octet-stream')
    return r.fulfill(status=200, content_type=ctype, body=f.read_bytes())

def open_page(b, path, scenario=None, width=390, height=900, session=None):
    ctx = b.new_context(viewport={'width': width, 'height': height})
    ctx.add_init_script(INIT.replace('__SCENARIO__', json.dumps(scenario or {})))
    if session:
        ctx.add_init_script(f"try {{ for (const [k, v] of Object.entries({json.dumps(session)})) sessionStorage.setItem(k, v); }} catch (e) {{}}")
    pg = ctx.new_page()
    errors = []
    pg.on('pageerror', lambda e: errors.append(str(e)))
    pg.route('**/*', route)
    pg.set_default_timeout(5000)
    pg.goto(f'{ORIGIN}{path}', wait_until='domcontentloaded')
    pg.wait_for_timeout(250)
    return pg, errors

squash = lambda s: re.sub(r'\s+', ' ', s or '').strip()
txt = lambda pg, sel: squash(pg.text_content(sel) or '')
calls = lambda pg: pg.evaluate('window.__fx.calls')
def notice(pg, view):
    return squash(pg.evaluate(f"() => {{ const n = document.querySelector('#{view}-notices .fx-notice'); return n ? n.className + ' | ' + n.textContent : ''; }}"))

BRAND_JS = """() => {
  const html = document.documentElement.outerHTML;
  const grads = [...document.querySelectorAll('*')].filter((e) => /gradient/.test(getComputedStyle(e).backgroundImage)).map((e) => e.tagName + '.' + e.className);
  return { handy: /handy\\s*hub/i.test(document.body.innerText) || /handyhub-logo|handy-hub-logo/i.test(html),
           imgs: document.querySelectorAll('img').length, icons8: /icons8/.test(html), grads,
           word: (document.querySelector('.fx-wordmark, .ag-word, .word') || {}).textContent || '' };
}"""
OVERFLOW_JS = """() => { const w = document.documentElement.clientWidth; const bad = [];
  for (const el of document.querySelectorAll('body *')) { if (el.closest('[hidden]')) continue;
    const r = el.getBoundingClientRect(); if (r.width && (r.right > w + 0.5 || r.left < -0.5)) bad.push(el.tagName + '.' + [...el.classList].join('.')); }
  return { scroll: document.documentElement.scrollWidth > w, bad: bad.slice(0, 5) }; }"""
TARGETS_JS = """() => { const out = [];
  for (const el of document.querySelectorAll('button, a[href], input, select')) {
    if (el.closest('[hidden], .fx-skip') || el.classList.contains('fx-link') || el.classList.contains('fx-btn--s') || el.type === 'checkbox') continue;
    const r = el.getBoundingClientRect(); if (!r.width) continue;
    if (r.width < 43.5 || r.height < 43.5) out.push(el.tagName + '#' + el.id + ' ' + Math.round(r.width) + 'x' + Math.round(r.height)); }
  return out; }"""

def layout_checks(pg, name):
    for w in (360, 390, 768):
        pg.set_viewport_size({'width': w, 'height': 800}); pg.wait_for_timeout(80)
        o = pg.evaluate(OVERFLOW_JS)
        check(f'{name} {w}px: no horizontal overflow', not o['scroll'] and not o['bad'], o)
        t = pg.evaluate(TARGETS_JS)
        check(f'{name} {w}px: every control is at least 44 px', not t, t)
    pg.set_viewport_size({'width': 360, 'height': 800})
    pg.add_style_tag(content='html { font-size: 200% !important; }'); pg.wait_for_timeout(120)
    o = pg.evaluate(OVERFLOW_JS)
    check(f'{name} 360px at 200% text: no horizontal overflow', not o['scroll'] and not o['bad'], o)

def shot(pg, name):
    if SHOTS:
        pathlib.Path(SHOTS).mkdir(parents=True, exist_ok=True)
        pg.screenshot(path=str(pathlib.Path(SHOTS) / f'entry-{name}.png'), full_page=True)

APPROVED = {'artisans/A1': {'userType': 'artisan', 'status': 'active', 'verificationStatus': 'approved'}}
DRAFT    = {'artisans/A1': {'userType': 'artisan', 'status': 'pending', 'verificationStatus': 'draft'}}

with sync_playwright() as p:
    b = p.chromium.launch()

    # ═══ Sign in ═════════════════════════════════════════════════════════════
    pg, errs = open_page(b, '/artisan-app/login.html', {'docs': APPROVED})
    br = pg.evaluate(BRAND_JS)
    check('sign in: the Fidus X wordmark; no HandyHub name or logo, no image, no gradient, no icons8',
          br['word'].split() == ['Fidus', 'X', 'for', 'professionals'] and not br['handy'] and br['imgs'] == 0 and not br['icons8'] and not br['grads'], br)
    check('sign in: one heading says what the screen is for', pg.eval_on_selector_all('h1', 'els => els.filter(e => !e.closest("[hidden]")).map(e => e.textContent.trim())') == ['Sign in'])
    shot(pg, 'signin-390')
    pg.click('#si-submit')
    check('empty: both fields say what is missing, are marked invalid, focus goes to the first; nothing is sent',
          not pg.is_hidden('#si-email-err') and not pg.is_hidden('#si-pw-err') and txt(pg, '#si-pw-err') == 'Enter your password.'
          and pg.get_attribute('#si-email', 'aria-invalid') == 'true' and pg.evaluate('document.activeElement.id') == 'si-email'
          and not any(c[0] == 'signIn' for c in calls(pg)), calls(pg))
    pg.fill('#si-email', 'kofi@example.test'); pg.fill('#si-password', 'secret123')
    pg.click('[data-reveal="si-password"]')
    check('Show reveals the password and says Hide; pressed state for screen readers',
          pg.get_attribute('#si-password', 'type') == 'text' and txt(pg, '[data-reveal="si-password"]') == 'Hide' and pg.get_attribute('[data-reveal="si-password"]', 'aria-pressed') == 'true')
    pg.close()

    pg, errs = open_page(b, '/artisan-app/login.html', {'docs': APPROVED, 'signInError': 'auth/invalid-credential'})
    pg.fill('#si-email', 'kofi@example.test'); pg.fill('#si-password', 'wrong-one'); pg.click('#si-submit'); pg.wait_for_timeout(150)
    check('a wrong password: said in words (never Firebase text), the button usable again',
          'That email and password do not match a Fidus X account' in notice(pg, 'signin') and 'fx-notice--bad' in notice(pg, 'signin')
          and 'auth/' not in notice(pg, 'signin') and not pg.is_disabled('#si-submit') and txt(pg, '#si-submit') == 'Sign in', notice(pg, 'signin'))
    pg.close()

    pg, errs = open_page(b, '/artisan-app/login.html', {'docs': APPROVED})
    pg.fill('#si-email', 'kofi@example.test'); pg.fill('#si-password', 'right-one'); pg.click('#si-submit')
    pg.wait_for_url('**/artisan-app/dashboard.html', timeout=4000)
    check('an approved artisan who signs in goes to Today, by the server\'s record', pg.url.endswith('/artisan-app/dashboard.html'), pg.url)
    pg.close()

    pg, errs = open_page(b, '/artisan-app/login.html', {'docs': DRAFT, 'user': {'uid': 'A1'}})
    pg.wait_for_url('**/artisan-app/onboarding.html', timeout=4000)
    check('already signed in with an unfinished application: sent on to onboarding', pg.url.endswith('/artisan-app/onboarding.html'), pg.url)
    pg.close()

    pg, errs = open_page(b, '/artisan-app/login.html', {'user': {'uid': 'C1'}, 'ensure': {'ok': False, 'reason': 'customer_account', 'message': 'customer'}})
    pg.wait_for_timeout(400)
    cust = notice(pg, 'signin')
    check('a customer account: signed out here, told, then taken to the customer app',
          ['signOut'] in calls(pg) and 'This is a customer account' in cust, [cust, calls(pg)])
    pg.wait_for_url('**/customer-app/login.html', timeout=4000)
    check('…the customer app\'s sign-in', pg.url.endswith('/customer-app/login.html'), pg.url)
    pg.close()

    pg, errs = open_page(b, '/artisan-app/login.html', {'user': {'uid': 'A1'}, 'docFail': True, 'ensure': {'ok': False}})
    pg.wait_for_timeout(400)
    off = notice(pg, 'signin')
    check('the server unreachable: the session is kept, said plainly, with Try again (LOGIN-001)',
          ['signOut'] not in calls(pg) and "Can't reach the server. You're still signed in" in off and 'fx-notice--warn' in off
          and pg.query_selector('#signin-notices button') is not None, [off, calls(pg)])
    pg.close()

    pg, errs = open_page(b, '/artisan-app/login.html?closed=1', {})
    check('arriving after closing the account says so', 'Your Fidus X account has been closed.' in notice(pg, 'signin'), notice(pg, 'signin'))
    pg.close()
    pg, errs = open_page(b, '/artisan-app/login.html', {}, session={'hh_artisan_return_url': f'{ORIGIN}/artisan-app/wallet.html'})
    check('sent here by the guard from a page in use: "your session has ended"', 'Your session has ended. Sign in to carry on where you were.' in notice(pg, 'signin'), notice(pg, 'signin'))
    pg.close()

    # Reset (AUTH-002)
    pg, errs = open_page(b, '/artisan-app/login.html', {'resetError': 'auth/user-not-found'})
    pg.fill('#si-email', 'nobody@example.test'); pg.click('#si-forgot'); pg.wait_for_timeout(100)
    check('Forgot your password? opens the reset view with the email carried over, and a linkable address',
          pg.is_hidden('#view-signin') and not pg.is_hidden('#view-reset') and pg.input_value('#rs-email') == 'nobody@example.test' and 'view=reset' in pg.url, pg.url)
    pg.click('#rs-submit'); pg.wait_for_timeout(150)
    unknown = notice(pg, 'reset')
    pg.close()
    pg, errs = open_page(b, '/artisan-app/login.html?view=reset', {})
    check('the reset view opens directly from its address', not pg.is_hidden('#view-reset'))
    pg.fill('#rs-email', 'nobody@example.test'); pg.click('#rs-submit'); pg.wait_for_timeout(150)
    known = notice(pg, 'reset')
    check('reset: exactly the same answer for an unknown email as for a known one (AUTH-002)',
          known == unknown and 'If a Fidus X professional account uses nobody@example.test, a reset link is on its way.' in known and 'fx-notice--ok' in known, [known, unknown])
    shot(pg, 'reset-390')
    pg.click('#rs-back'); pg.wait_for_timeout(100)
    check('Back to sign in returns to the sign-in view', not pg.is_hidden('#view-signin') and 'view=reset' not in pg.url)
    pg.close()

    # Google
    pg, errs = open_page(b, '/artisan-app/login.html', {'socialError': 'auth/popup-closed-by-user'})
    pg.click('#si-google'); pg.wait_for_timeout(150)
    check('closing the Google window says nothing and leaves the button ready', notice(pg, 'signin') == '' and not pg.is_disabled('#si-google'))
    pg.close()
    pg, errs = open_page(b, '/artisan-app/login.html', {'socialError': 'auth/popup-blocked'})
    pg.click('#si-google'); pg.wait_for_timeout(150)
    check('a blocked Google window is explained, with the email way in', 'Your browser blocked the Google window' in notice(pg, 'signin'), notice(pg, 'signin'))
    check('the Google button keeps its mark after an error', pg.query_selector('#si-google svg') is not None and txt(pg, '#si-google-label') == 'Continue with Google')
    pg.close()

    pg, errs = open_page(b, '/artisan-app/login.html', {})
    layout_checks(pg, 'sign in')
    check('sign in: no page errors', not errs, errs)
    pg.close()

    # ═══ Sign up ═════════════════════════════════════════════════════════════
    pg, errs = open_page(b, '/artisan-app/signup.html', {})
    br = pg.evaluate(BRAND_JS)
    check('sign up: the wordmark; no HandyHub logo, no image (the Google mark is drawn, not loaded from icons8)',
          br['word'].split() == ['Fidus', 'X', 'for', 'professionals'] and not br['handy'] and br['imgs'] == 0 and not br['icons8'] and not br['grads'], br)
    trades = pg.eval_on_selector_all('#su-trade option', 'els => els.map(e => e.value)')
    check('the trades are the 8 customers can book, plus Other', trades == ['', 'Electrical', 'Plumbing', 'Carpentry', 'AC Repair', 'Welding', 'Cleaning', 'Painting', 'Gardening', 'Other'], trades)
    check('the closest-trade list has only the bookable trades', pg.eval_on_selector_all('#su-other-bucket option', 'els => els.length') == 9)
    check('an untouched form says nothing', all(pg.is_hidden(f'#{i}-err') for i in ['su-name', 'su-email', 'su-phone', 'su-trade', 'su-password', 'su-terms']))
    pg.fill('#su-email', 'kofi'); pg.click('#su-name')
    check('a field left wrong says why, at once', txt(pg, '#su-email-err') == 'Enter a valid email address.' and pg.get_attribute('#su-email', 'aria-invalid') == 'true')
    pg.click('#su-submit'); pg.wait_for_timeout(100)
    errs_shown = {i: txt(pg, f'#{i}-err') for i in ['su-name', 'su-email', 'su-trade', 'su-password', 'su-terms']}
    check('sending an incomplete form marks every problem, focuses the first, and sends nothing',
          all(errs_shown.values()) and pg.evaluate('document.activeElement.id') == 'su-name' and not any(c[0] == 'callable' for c in calls(pg)), errs_shown)
    pg.select_option('#su-trade', 'Other'); pg.wait_for_timeout(50)
    check('"Other" opens the description and closest-trade questions', not pg.is_hidden('#su-other'))
    pg.click('#su-submit'); pg.wait_for_timeout(80)
    check('…which are required', txt(pg, '#su-other-desc-err') == 'Describe your trade.' and txt(pg, '#su-other-bucket-err') == 'Choose the listed trade closest to yours.')
    shot(pg, 'signup-errors-390')
    pg.close()

    good = {'callables': {'signUpArtisanDirect': {'data': {'ok': True}}}, 'callDelay': 400}
    pg, errs = open_page(b, '/artisan-app/signup.html', good)
    pg.fill('#su-name', 'Kofi  Mensah'); pg.fill('#su-email', 'kofi@example.test'); pg.fill('#su-phone', '+233 24 123 4567')
    pg.select_option('#su-trade', 'AC Repair'); pg.fill('#su-password', 'longenough1'); pg.check('#su-terms')
    pg.click('#su-submit')
    pg.evaluate("() => document.getElementById('signup-form').requestSubmit()")
    busy = txt(pg, '#su-submit')
    pg.wait_for_url('**/artisan-app/onboarding.html', timeout=5000)
    check('a complete form: the button says it is working, and goes on to onboarding', busy == 'Creating your account…' and pg.url.endswith('/artisan-app/onboarding.html'), busy)
    done = [c[0] if c[0] != 'callable' else f'callable:{c[1]}' for c in pg.evaluate('window.__fx.prevCalls')]
    verify = [c for c in pg.evaluate('window.__fx.prevCalls') if c[0] == 'verify']
    check('…after the server created the account: signed in here, and the verification link sent (back to onboarding)',
          done == ['callable:signUpArtisanDirect', 'signIn', 'verify'] and verify and verify[0][1].endswith('/artisan-app/onboarding.html'), [done, verify])
    pg.close()

    pg, errs = open_page(b, '/artisan-app/signup.html', {'callables': {'signUpArtisanDirect': {'data': {}}}, 'callDelay': 400})
    pg.fill('#su-name', 'Kofi  Mensah'); pg.fill('#su-email', 'kofi@example.test'); pg.fill('#su-phone', '+233 24 123 4567')
    pg.select_option('#su-trade', 'AC Repair'); pg.fill('#su-password', 'longenough1'); pg.check('#su-terms')
    pg.evaluate("() => { const f = document.getElementById('signup-form'); f.requestSubmit(); f.requestSubmit(); }")
    pg.wait_for_timeout(150)
    sent = [c for c in calls(pg) if c[0] == 'callable']
    check('two quick submissions send one request', len(sent) == 1, sent)
    check('the server gets the checked values: name tidied, phone as it stores it, the trade\'s label',
          sent and sent[0][1] == 'signUpArtisanDirect' and sent[0][2]['payload'] == {'name': 'Kofi Mensah', 'email': 'kofi@example.test', 'password': 'longenough1',
                                                                                    'phone': '233241234567', 'category': 'AC Repair', 'otherBucket': None, 'otherDesc': None}, sent)
    pg.wait_for_url('**/artisan-app/onboarding.html', timeout=5000)
    pg.close()

    pg, errs = open_page(b, '/artisan-app/signup.html', {'callables': {'signUpArtisanDirect': {'error': {'code': 'already-exists', 'message': 'An account with this email already exists. Please sign in instead.'}}}})
    pg.fill('#su-name', 'Kofi Mensah'); pg.fill('#su-email', 'kofi@example.test')
    pg.select_option('#su-trade', 'Plumbing'); pg.fill('#su-password', 'longenough1'); pg.check('#su-terms')
    pg.click('#su-submit'); pg.wait_for_timeout(200)
    check('an email that already has an account: said, with the way in; the form usable again',
          'This email already has a Fidus X account. Sign in instead' in notice(pg, 'signup') and not pg.is_disabled('#su-submit') and txt(pg, '#su-submit') == 'Create account', notice(pg, 'signup'))
    pg.close()

    pg, errs = open_page(b, '/artisan-app/signup.html', {'user': {'uid': 'A1'}})
    pg.wait_for_url('**/artisan-app/login.html', timeout=4000)
    check('already signed in: sent to sign-in, which routes every account (IA-005)', pg.url.endswith('/artisan-app/login.html'), pg.url)
    pg.close()

    pg, errs = open_page(b, '/artisan-app/signup.html', {})
    layout_checks(pg, 'sign up')
    check('sign up: no page errors', not errs, errs)
    pg.close()

    # ═══ Verify email (the emailed-code step, off for now) ═══════════════════
    pg, errs = open_page(b, '/artisan-app/verify-email.html', {}, session={'hh_otp_session': json.dumps({'sessionId': 's1', 'email': 'kofi@example.test'})})
    br = pg.evaluate(BRAND_JS)
    check('verify email: the wordmark, six code boxes, no HandyHub logo',
          br['word'].split() == ['Fidus', 'X', 'for', 'professionals'] and not br['handy'] and br['imgs'] == 0 and len(pg.query_selector_all('[data-otp-input]')) == 6, br)
    layout_checks(pg, 'verify email')
    pg.close()

    # ═══ Offline and the front door ══════════════════════════════════════════
    pg, errs = open_page(b, '/artisan-app/offline.html', {})
    br = pg.evaluate(BRAND_JS)
    body = squash(pg.inner_text('body'))
    check('offline: the wordmark, and no promise that a job request waits (they expire)',
          not br['handy'] and 'may expire before you can answer it' in body and 'wait in your inbox' not in body, body)
    check('offline: Try again is ink on orange (decision 01), at least 48 px',
          pg.evaluate("() => { const b = document.querySelector('button'); const s = getComputedStyle(b); return s.color === 'rgb(17, 19, 22)' && b.getBoundingClientRect().height >= 48; }"))
    pg.close()

    pg, errs = open_page(b, '/artisan-app/index.html', {'user': {'uid': 'A1'}, 'docs': DRAFT})
    pg.wait_for_url('**/artisan-app/onboarding.html', timeout=5000)
    check('the front door sends an unfinished application to onboarding', pg.url.endswith('/artisan-app/onboarding.html'), pg.url)
    pg.close()
    pg, errs = open_page(b, '/artisan-app/index.html', {'user': {'uid': 'A1'}, 'docFail': True})
    pg.wait_for_url('**/artisan-app/dashboard.html', timeout=5000)
    check('the front door, profile unreadable: to Today (whose guard retries), never to sign-in', pg.url.endswith('/artisan-app/dashboard.html'), pg.url)
    pg.close()

    # ═══ The guard's account screens ═════════════════════════════════════════
    def guard(doc=None, fail=False, approved=True, tokens=False):
        docs = {'artisans/A1': doc} if doc else {}
        path = f"/tests/e2e/guard_harness.html?approved={'1' if approved else '0'}{'&tokens=1' if tokens else ''}"
        pg, errs = open_page(b, path, {'user': {'uid': 'A1'}, 'docs': docs, 'docFail': fail})
        pg.wait_for_timeout(500)
        return pg, errs
    def overlay(pg):
        return pg.evaluate("""() => { const o = document.getElementById('artisan-auth-overlay'); if (!o || o.classList.contains('ag-fade')) return null;
          return { title: (o.querySelector('.ag-title') || {}).textContent || '', text: o.innerText.replace(/\\s+/g, ' '),
                   buttons: [...o.querySelectorAll('.ag-btn')].map(b => b.textContent.trim()),
                   primary: (() => { const p = o.querySelector('.ag-btn-primary'); if (!p) return null; const s = getComputedStyle(p); return [s.color, s.backgroundColor, Math.round(p.getBoundingClientRect().height)]; })(),
                   dialog: !!o.querySelector('[role="dialog"][aria-modal="true"]') }; }""")

    cases = [
        ('suspended', {'userType': 'artisan', 'status': 'suspended', 'verificationStatus': 'approved'}, False,
         'Your account is suspended', ['Email support', 'Sign out']),
        ('pending', {'userType': 'artisan', 'status': 'pending', 'verificationStatus': 'pending_review'}, False,
         'Your application is being reviewed', ['Go to Today', 'Sign out']),
        ('rejected', {'userType': 'artisan', 'status': 'pending', 'verificationStatus': 'rejected'}, False,
         'Your application needs changes', ['Review and resubmit', 'Sign out']),
        ('offline', None, True, "Can't reach the server", ['Try again']),
        ('setup', None, False, 'Finish setting up your account', ['Create my profile', 'Sign out']),
    ]
    for name, doc, fail, title, buttons in cases:
        pg, errs = guard(doc, fail)
        o = overlay(pg)
        check(f'guard · {name}: "{title}", with exactly what can be done', o and o['title'] == title and o['buttons'] == buttons and o['dialog'], o)
        if o and o['primary']:
            check(f'guard · {name}: the main action is ink on orange (decision 01), 48 px', o['primary'] == ['rgb(17, 19, 22)', 'rgb(249, 115, 22)', 48], o['primary'])
        check(f'guard · {name}: the wordmark, no review-time promise', o and o['text'].startswith('Fidus X for professionals') and 'business day' not in o['text'], o and o['text'][:120])
        if name == 'offline':
            check('guard · offline keeps the session: "You\'re still signed in", no Sign out', o and "You're still signed in" in o['text'] and 'Sign out' not in o['buttons'])
        if name == 'rejected':
            check('guard · rejected: Review and resubmit opens the application', pg.get_attribute('#artisan-auth-overlay a.ag-btn-primary', 'href') == 'onboarding.html')
        shot(pg, f'guard-{name}')
        check(f'guard · {name}: no page errors', not errs, errs)
        pg.close()

    pg, errs = guard({'userType': 'artisan', 'status': 'active', 'verificationStatus': 'approved'})
    check('guard · an approved, active artisan enters the page', pg.evaluate('window.__guard') == 'entered' and overlay(pg) is None)
    pg.close()

    pg, errs = guard({'userType': 'artisan', 'status': 'suspended'}, tokens=True)
    with_tokens = overlay(pg)
    pg.close()
    pg, errs = guard({'userType': 'artisan', 'status': 'suspended'}, tokens=False)
    without = overlay(pg)
    pg.close()
    check('guard screens look the same with or without the design tokens on the page',
          with_tokens and without and with_tokens['primary'] == without['primary'], [with_tokens and with_tokens['primary'], without and without['primary']])

    b.close()
    _done = True
