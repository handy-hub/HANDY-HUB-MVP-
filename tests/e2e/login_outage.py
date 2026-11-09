"""LOGIN-001 browser check: an outage does not sign a signed-in artisan out.

Runs the REAL artisan-app/login.html, js/entry.js and js/utils/artisanAccount.js
in Chromium (Phase 5: the page reads auth and the profile through the shared
container, and decides with entry.js routeEnsured). Only the container's
auth and database services, the Cloud Functions SDK module and the
Firebase config are in-page fakes, each set to answer as the case requires:

  outage        Firestore read rejects 'unavailable'; the artisanAccount
                callable rejects as the SDK does when the request never
                completes ('internal' / 'deadline-exceeded' / 'unavailable')
                -> NOT signed out; "Can't reach the server … still signed in"
                   with Try again (which reloads)
  customer      the server answers details.reason 'customer_account'
                -> signed out, sent to the Customer app (role isolation)
  admin         details.reason 'admin_account' -> signed out, message shown
  artisan       profile readable, approved -> dashboard, not signed out
  half outage   Firestore down, callable answers 'existing' -> dashboard

Served from the fake origin http://fx.test by Playwright routing; every other
host is aborted - no server, port, emulator or network.

    python -I tests/e2e/login_outage.py            # this checkout
    python -I tests/e2e/login_outage.py <root>     # e.g. a checkout of 213c932
"""
import sys, json, pathlib, mimetypes, atexit
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
        print(f"  {'PASS' if c else 'FAIL'}  {n}" + ('' if c else f"   [{str(d)[:180]}]"))
    print(f"login-outage browser ({ROOT.name}): {ok} passed, {len(results) - ok} failed" + ('' if _done else '  (aborted early)'))
atexit.register(_report)

INIT = """
(() => {
  let c = {};
  try { c = JSON.parse(sessionStorage.getItem('fx_case') || '{}'); } catch (e) {}
  window.__fx = { case: c, signedOut: 0, calls: 0 };
})();
"""
STUBS = {
    '/shared/js/backend/providers/firebase/firebaseConfig.js': "export const firebaseFunctions = {}; export const firebaseAuth = {}; export const firebaseDb = {};",
    '/shared/js/utils/global-app.js': '', '/shared/js/utils/themeManager.js': '', '/artisan-app/js/pwa.js': '',
    '/shared/js/app/container.js': """
const fx = window.__fx;
const authService = {
  subscribeToAuthState(cb) {
    // No case yet (the throwaway load that stores it): report nobody, route nowhere.
    if (!fx.case.firestore) return () => {};
    setTimeout(() => cb({ uid: 'U1', email: 'u1@example.com' }), 0); return () => {};
  },
  async signOut() { fx.signedOut++; },
  async signInWithEmail() { throw Object.assign(new Error('x'), { code: 'auth/network-request-failed' }); },
  async signInWithSocial() {}, async sendPasswordResetEmail() {},
};
const databaseService = {
  async getDocument(c, id) {
    const f = fx.case.firestore;
    if (f === 'down') throw Object.assign(new Error('Failed to get document because the client is offline.'), { code: 'unavailable' });
    if (f === 'missing') return { exists: false, id, data: null };
    return { exists: true, id, data: fx.case.profile || {} };
  },
};
export function getAppContainer() { return { services: { authService, databaseService } }; }
""",
    '/shared/vendor/firebase/firebase-functions.js': """
const fx = window.__fx;
export function httpsCallable(fns, name) {
  return async (payload) => {
    fx.calls++;
    const r = fx.case.callable;
    if (r && r.throw) throw Object.assign(new Error(r.throw.message), { code: r.throw.code, details: r.throw.details });
    return { data: r && r.data };
  };
}
""",
}
LANDING = '<!doctype html><title>landed</title><p id="landed">landed</p>'

def route(r):
    url = r.request.url
    if not url.startswith(ORIGIN): return r.abort()
    p = url[len(ORIGIN):].split('?')[0]
    if p in STUBS: return r.fulfill(status=200, content_type='text/javascript', body=STUBS[p])
    if p in ('/artisan-app/dashboard.html', '/artisan-app/onboarding.html', '/customer-app/login.html'):
        return r.fulfill(status=200, content_type='text/html', body=LANDING)
    f = ROOT / p.lstrip('/')
    if not f.is_file(): return r.fulfill(status=404, body='')
    ctype = 'text/javascript' if f.suffix in ('.js', '.mjs') else (mimetypes.guess_type(str(f))[0] or 'application/octet-stream')
    return r.fulfill(status=200, content_type=ctype, body=f.read_bytes())

DOWN = lambda code, msg: {'throw': {'code': code, 'message': msg}}
CASES = [
    ('outage (internal)',          {'firestore': 'down', 'callable': DOWN('functions/internal', 'internal')}, 'stay'),
    ('outage (deadline-exceeded)', {'firestore': 'down', 'callable': DOWN('functions/deadline-exceeded', 'deadline-exceeded')}, 'stay'),
    ('outage (unavailable)',       {'firestore': 'down', 'callable': DOWN('functions/unavailable', 'unavailable')}, 'stay'),
    ('no profile, callable down',  {'firestore': 'missing', 'callable': DOWN('functions/internal', 'internal')}, 'stay'),
    ('customer uid',               {'firestore': 'missing', 'callable': {'throw': {'code': 'functions/permission-denied',
        'message': 'This email is already used for a Fidus X customer account.', 'details': {'reason': 'customer_account'}}}}, 'customer'),
    ('administrator uid',          {'firestore': 'missing', 'callable': {'throw': {'code': 'functions/permission-denied',
        'message': 'Administrator accounts cannot also be artisan accounts.', 'details': {'reason': 'admin_account'}}}}, 'refused'),
    ('approved artisan',           {'firestore': 'ok', 'profile': {'status': 'active', 'verificationStatus': 'approved'}}, 'dashboard'),
    ('half outage: Firestore down, server answers', {'firestore': 'down',
        'callable': {'data': {'result': 'existing', 'verificationStatus': 'approved', 'emailVerified': True}}}, 'dashboard'),
]

with sync_playwright() as pw:
    b = pw.chromium.launch()
    for name, case, expect in CASES:
        ctx = b.new_context(); ctx.add_init_script(INIT)
        pg = ctx.new_page(); pg.set_default_timeout(5000)
        errors = []; pg.on('pageerror', lambda e: errors.append(str(e)))
        pg.route('**/*', route)
        pg.goto(f'{ORIGIN}/artisan-app/login.html', wait_until='commit')
        pg.evaluate("(c) => sessionStorage.setItem('fx_case', JSON.stringify(c))", case)
        pg.goto(f'{ORIGIN}/artisan-app/login.html', wait_until='domcontentloaded')
        pg.wait_for_timeout(2200 if expect == 'customer' else 900)   # the customer redirect waits 1.6 s
        landed = pg.url.split('?')[0]
        on_login = landed.endswith('/artisan-app/login.html')
        state = pg.evaluate("""() => window.__fx ? {
            signedOut: window.__fx.signedOut, calls: window.__fx.calls,
            offline: /Can't reach the server\\. You're still signed in/.test((document.querySelector('#signin-notices .fx-notice--warn') || {}).textContent || ''),
            retry: !!document.querySelector('#signin-notices .fx-notice--warn button'),
            error: (document.querySelector('#signin-notices .fx-notice--bad') || {}).textContent || '' } : null""")
        if expect == 'stay':
            check(f'{name}: NOT signed out', on_login and state and state['signedOut'] == 0, (landed, state))
            check(f'{name}: "can\'t reach the server" with Try again is shown', state and state['offline'] and state['retry'], state)
            if state and state['retry']:
                pg.click('#signin-notices .fx-notice--warn button'); pg.wait_for_load_state('domcontentloaded')
                check(f'{name}: Try again reloads the login page (session still kept)', pg.url.split('?')[0].endswith('/login.html'))
        elif expect == 'customer':
            check(f'{name}: signed out and sent to the Customer app (role isolation)',
                  landed.endswith('/customer-app/login.html'), (landed, state))
        elif expect == 'refused':
            check(f'{name}: signed out, refusal shown', on_login and state['signedOut'] == 1 and 'Administrator' in state['error'], state)
        elif expect == 'dashboard':
            check(f'{name}: routed to the dashboard, not signed out', landed.endswith('/artisan-app/dashboard.html'), (landed, state))
        check(f'{name}: no page errors', not errors, errors[:2])
        ctx.close()
    b.close()

_done = True
sys.exit(0 if all(c for _, c, _ in results) else 1)
