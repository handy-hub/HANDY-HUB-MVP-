"""Phase 5 browser checks: the Account tab (artisan-app/settings.html).

Runs the REAL page in Chromium with its real modules: js/account.js (what
each control shows and writes), js/entry.js, js/onboarding.js (the radius
list), the fx components (sheet, toast, tab bar) and js/artisanFloatingNav.js
(the heartbeat). The guard, the container's services, the push service, the
presence service, Cloudinary URLs and the Cloud Functions client are in-page
fakes that play the server.

  · the tab: title, no HandyHub, the tab bar with Account current, the
    heartbeat on a live approved-and-available profile, no Dark mode
  · each control does something real: radius (writes workRadius; a failure
    keeps the saved value), push (the saved preference vs this device),
    phone (private/contact, normalised; refused when not a Ghana number),
    payout (masked, read-only), password (re-authentication first; errors
    in words; reset through the auth service; Google accounts get no
    password row), sign out (asks; logs out), close account (the server's
    reasons; CLOSE + password; re-authentication then the request; no raw
    error text)
  · verification in words for each status; links only when there is
    something to do
  · sheets are modals: Escape closes, focus returns
  · layout at 360 / 390 / 768 px and 200% text; 44 px targets; no page errors

Network: NONE (Playwright routing; the origin is never reached).

    python -I tests/e2e/artisan_account.py
    FX_SHOTS=<dir> python -I tests/e2e/artisan_account.py
"""
import os, sys, re, json, pathlib, mimetypes, atexit
from playwright.sync_api import sync_playwright
sys.stdout.reconfigure(encoding='utf-8')

ROOT = pathlib.Path(__file__).resolve().parents[2]
ORIGIN = 'http://localhost:4798'
SHOTS = os.environ.get('FX_SHOTS')

results = []
def check(name, cond, detail=''):
    results.append((name, bool(cond), detail))
_done = False
def _report():
    ok = sum(1 for _, c, _ in results if c)
    for n, c, d in results:
        print(f"  {'PASS' if c else 'FAIL'}  {n}" + ('' if c else f"   [{str(d)[:400]}]"))
    print(f"artisan-account browser: {ok} passed, {len(results) - ok} failed" + ('' if _done else '  (aborted early)'))
    sys.stdout.flush(); sys.stderr.flush()
    if ok != len(results) or not _done:
        os._exit(1)
atexit.register(_report)

INIT = r"""
(() => {
  const S = __SCENARIO__;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const err = (code, message, details) => Object.assign(new Error(message || `Firebase: Error (${code}).`), { code, details });
  const fx = window.__fx = { ...S, calls: [], docCbs: {}, device: S.device || 'on' };
  // The calls survive a navigation in this tab (sign out and closing leave the page).
  try { fx.prevCalls = JSON.parse(sessionStorage.getItem('__fx_calls') || '[]'); } catch (e) { fx.prevCalls = []; }
  const push = fx.calls.push.bind(fx.calls);
  fx.calls.push = (...a) => { const r = push(...a); try { sessionStorage.setItem('__fx_calls', JSON.stringify(fx.calls)); } catch (e) {} return r; };
  fx.profile = Object.assign({ id: 'A1', userType: 'artisan', status: 'active', verificationStatus: 'approved', name: 'Kofi Boateng',
    workRadius: 10, isAvailable: true }, S.profile || {});
  fx.user = { uid: 'A1', email: 'kofi@example.com', emailVerified: true };
  const rec = (...a) => fx.calls.push(a);
  const docs = Object.assign({ 'artisans/A1/private/contact': { artisanId: 'A1', phone: '0241234567' },
    'artisans/A1/private/kyc': { artisanId: 'A1', payoutAccount: { provider: 'mtn', phone: '0241111111', accountName: 'Kofi' } } }, S.docs || {});
  fx.auth = {
    getCurrentUser() { return fx.user; },
    signInProviders() { return fx.providers || ['password']; },
    async reauthenticate(pw) { rec('reauth', pw === undefined ? null : pw); if (fx.reauthFail) throw err(fx.reauthFail); },
    async changePassword(pw) { rec('changePassword', pw); },
    async sendPasswordResetEmail(email) { rec('reset', email); },
    async signOut() { rec('signOut'); },
    async waitForUser() { return fx.user; },
    subscribeToAuthState(cb) { setTimeout(() => cb(fx.user), 0); return () => {}; },
  };
  fx.db = {
    async getDocument(c, id) { rec('get', `${c}/${id}`); const d = docs[`${c}/${id}`]; return d ? { exists: true, id, data: d } : { exists: false, id, data: null }; },
    async updateDocument(c, id, data) { rec('update', `${c}/${id}`, data); if (fx.saveFail) throw err('unavailable'); },
    async setDocument(c, id, data, opts) { rec('set', `${c}/${id}`, data, opts || null); if (fx.saveFail) throw err('unavailable'); },
    subscribeToDocument(c, id, cb) { (fx.docCbs[`${c}/${id}`] = fx.docCbs[`${c}/${id}`] || []).push(cb); return () => {}; },
  };
  fx.session = { async logout() { rec('logout'); } };
  fx.callable = async (name, data) => {
    if (data && data.action) rec('callable', name, data); else rec('callable', name);
    const r = (fx.callables || {})[`${name}:${data && data.action}`] || (fx.callables || {})[name];
    if (r && r.error) throw err(`functions/${r.error.code}`, r.error.message, r.error.details);
    return { data: (r && r.data) || {} };
  };
})();
"""
SPECIFIC = {
    '/shared/js/app/container.js':
        "export function getAppContainer(){ const fx = window.__fx; return { services: { authService: fx.auth, databaseService: fx.db, sessionService: fx.session } }; }",
    '/artisan-app/js/utils/artisanAuthGuard.js':
        "export async function requireArtisanAuth(o){ const fx = window.__fx; fx.calls.push(['guard', o]); return { user: fx.user, artisan: { ...fx.profile } }; }\n"
        "export function patchArtisanSession(p){ window.__fx.calls.push(['patchSession', p]); }",
    '/shared/js/services/pushNotificationService.js':
        "export function getPushState(){ return window.__fx.device; }\n"
        "export async function enablePushNotifications(uid, type){ window.__fx.calls.push(['enablePush', uid, type]); }\n"
        "export async function initializePushNotifications(){}",
    '/shared/js/services/presenceService.js':
        "export function ensurePresence(uid, db, available){ window.__fx.calls.push(['presence', uid, available]); }",
    '/shared/js/services/cloudinaryService.js':
        "export const TRANSFORMS = { avatarLg: '' }; export function avatarUrl(id){ return 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'; }",
    '/shared/vendor/firebase/firebase-functions.js':
        "export function httpsCallable(_f, name){ return (data) => window.__fx.callable(name, data); }",
    '/shared/js/backend/providers/firebase/firebaseConfig.js': "export const firebaseFunctions = {};",
    '/shared/js/services/profilePhotoService.js':
        "export async function replaceProfilePhoto(file, type){ window.__fx.calls.push(['photo', type, file.name]); return { publicId: 'artisans/A1/p2', version: 9 }; }",
}
EMPTY = {'/shared/js/utils/global-app.js', '/shared/js/utils/themeManager.js', '/artisan-app/js/pwa.js'}
STUB_PAGES = {'/artisan-app/login.html', '/artisan-app/onboarding.html', '/artisan-app/dashboard.html', '/artisan-app/reputation.html'}

def route(r):
    url = r.request.url
    if not url.startswith(ORIGIN): return r.abort()
    p = url[len(ORIGIN):].split('?')[0].split('#')[0]
    js = lambda body: r.fulfill(status=200, content_type='text/javascript', body=body)
    if p in SPECIFIC: return js(SPECIFIC[p])
    if p in EMPTY: return js('')
    if p in STUB_PAGES: return r.fulfill(status=200, content_type='text/html', body='<!doctype html><title>arrived</title><p id="arrived">arrived</p>')
    if p.startswith('/shared/vendor/firebase/') or p.startswith('/shared/js/backend/'): return js('export default {};')
    f = ROOT / p.lstrip('/')
    if not f.is_file(): return r.fulfill(status=404, body='')
    ctype = 'text/javascript' if f.suffix in ('.js', '.mjs') else (mimetypes.guess_type(str(f))[0] or 'application/octet-stream')
    return r.fulfill(status=200, content_type=ctype, body=f.read_bytes())

def open_page(b, scenario=None, width=390, height=900, path='/artisan-app/settings.html'):
    ctx = b.new_context(viewport={'width': width, 'height': height})
    ctx.add_init_script(INIT.replace('__SCENARIO__', json.dumps(scenario or {})))
    pg = ctx.new_page()
    errors = []
    pg.on('pageerror', lambda e: errors.append(str(e)))
    pg.route('**/*', route)
    pg.set_default_timeout(6000)
    pg.goto(f'{ORIGIN}{path}', wait_until='domcontentloaded')
    pg.wait_for_timeout(350)
    return pg, errors

squash = lambda s: re.sub(r'\s+', ' ', s or '').strip()
txt = lambda pg, sel: squash(pg.text_content(sel) or '')
calls = lambda pg, kind=None: [c for c in pg.evaluate('window.__fx.calls') if kind is None or c[0] == kind]
prev_calls = lambda pg, kind=None: [c for c in pg.evaluate('window.__fx.prevCalls') if kind is None or c[0] == kind]
open_sheet = lambda pg: pg.evaluate("() => { const o = [...document.querySelectorAll('.fx-overlay')].find(o => !o.hidden); return o ? o.id : null; }")
def live(pg, data):
    pg.evaluate("(d) => (window.__fx.docCbs['artisans/A1'] || []).forEach(cb => cb({ id: 'A1', exists: true, data: d, fromCache: false }))", data)
    pg.wait_for_timeout(150)

OVERFLOW_JS = """() => { const w = document.documentElement.clientWidth; const bad = [];
  for (const el of document.querySelectorAll('body *')) { if (el.closest('[hidden]')) continue;
    const r = el.getBoundingClientRect(); if (r.width && (r.right > w + 0.5 || r.left < -0.5)) bad.push(el.tagName + '#' + el.id + '.' + [...el.classList].join('.')); }
  return { scroll: document.documentElement.scrollWidth > w, bad: bad.slice(0, 5) }; }"""
TARGETS_JS = """() => { const out = [];
  for (const el of document.querySelectorAll('button, a[href], input:not([type=radio]), .fx-acct__choice')) {
    if (el.closest('[hidden], .fx-skip, [inert]') || el.classList.contains('fx-btn--s') || el.classList.contains('fx-scrim')) continue;
    const r = el.getBoundingClientRect(); if (!r.width) continue;
    const hit = el.classList.contains('fx-acct__switch') ? Math.max(r.height, 44) : r.height;
    if (hit < 43.5 || r.width < 43.5) out.push(el.tagName + '#' + el.id + '.' + el.className + ' ' + Math.round(r.width) + 'x' + Math.round(r.height)); }
  return out; }"""
def layout(pg, name):
    for w in (360, 390, 768):
        pg.set_viewport_size({'width': w, 'height': 800}); pg.wait_for_timeout(60)
        o = pg.evaluate(OVERFLOW_JS)
        check(f'{name} {w}px: no horizontal overflow', not o['scroll'] and not o['bad'], o)
        t = pg.evaluate(TARGETS_JS)
        check(f'{name} {w}px: every control is at least 44 px', not t, t)
    pg.set_viewport_size({'width': 390, 'height': 900})
def shot(pg, name):
    if SHOTS:
        pathlib.Path(SHOTS).mkdir(parents=True, exist_ok=True)
        pg.screenshot(path=str(pathlib.Path(SHOTS) / f'account-{name}.png'), full_page=True)

with sync_playwright() as p:
    b = p.chromium.launch()

    # ═══ The tab ═══════════════════════════════════════════════════════════════
    pg, errs = open_page(b)
    check('tab: "Account | Fidus X for professionals"; nothing says HandyHub', pg.title() == 'Account | Fidus X for professionals'
          and not re.search(r'handy\s*hub', pg.inner_text('body'), re.I) and txt(pg, 'h1') == 'Account')
    check('tab: the four tabs, Account current', pg.eval_on_selector_all('#tabbar .fx-tab', 'els => els.map(e => [e.textContent.trim(), e.getAttribute("href")])')
          == [['Today', 'dashboard.html'], ['Jobs', 'jobs.html'], ['Earnings', 'wallet.html'], ['Account', 'settings.html']]
          and txt(pg, '#tabbar [aria-current="page"]') == 'Account' and pg.query_selector('#fx-tabbar, .fx-bottom--fixed') is None)
    check('tab: the guard admits every account that is not blocked (allowPending)', calls(pg, 'guard') == [['guard', {'allowPending': True}]])
    check('who: name, sign-in email, initials; the row opens the profile',
          txt(pg, '#me-name') == 'Kofi Boateng' and txt(pg, '#me-email') == 'kofi@example.com' and txt(pg, '#me-initials') == 'KB'
          and pg.get_attribute('#me-row', 'href') == 'profile.html')
    check('no Dark mode switch (decision 04)', 'Dark mode' not in pg.inner_text('body') and pg.query_selector('#toggle-theme') is None)
    live(pg, {'userType': 'artisan', 'status': 'active', 'verificationStatus': 'approved', 'isAvailable': True, 'name': 'Kofi Boateng'})
    check('heartbeat: a live approved and available profile keeps presence (as on every artisan page)',
          ['presence', 'A1', True] in calls(pg, 'presence'), calls(pg, 'presence'))
    check('verification, approved: "Verified" in words, nothing to tap', txt(pg, '#kyc-value') == 'Verified' and 'fx-chip--ok' in pg.get_attribute('#kyc-value', 'class')
          and pg.get_attribute('#kyc-row', 'href') is None and pg.is_hidden('#kyc-chev'))
    check('radius, payout, phone: what applies, masked, private', txt(pg, '#radius-value') == '10 km' and txt(pg, '#payout-value') == 'MTN •••1111'
          and txt(pg, '#phone-value') == '0241234567')
    check('push: preference on, device on → on, "On for this device."', pg.is_checked('#toggle-notif') and txt(pg, '#notif-sub') == 'On for this device.')
    shot(pg, '390')
    layout(pg, 'account')

    # Radius
    pg.click('#radius-row'); pg.wait_for_timeout(250)
    check('radius sheet: a modal with the five distances, the saved one chosen, focus inside',
          open_sheet(pg) == 'radius-sheet' and pg.eval_on_selector_all('#radius-opts input', 'is => is.map(i => i.value)') == ['5', '10', '15', '20', '25']
          and pg.is_checked('#radius-opts input[value="10"]') and pg.evaluate("document.activeElement.closest('#radius-sheet') !== null"))
    layout(pg, 'radius sheet')
    pg.keyboard.press('Escape'); pg.wait_for_timeout(300)
    check('Escape closes it and focus returns to the row', open_sheet(pg) is None and pg.evaluate('document.activeElement.id') == 'radius-row')
    pg.click('#radius-row'); pg.wait_for_timeout(250)
    pg.check('#radius-opts input[value="15"]'); pg.wait_for_timeout(400)
    up = [c for c in calls(pg, 'update') if 'workRadius' in c[2]]
    check('choosing 15 km writes workRadius 15 to the profile, closes, says so',
          len(up) == 1 and up[0][1] == 'artisans/A1' and up[0][2]['workRadius'] == 15 and set(up[0][2]) == {'workRadius', 'updatedAt'}
          and open_sheet(pg) is None and txt(pg, '#radius-value') == '15 km' and "within 15 km" in txt(pg, '.fx-toasts'), up)
    pg.evaluate('window.__fx.saveFail = true')
    pg.click('#radius-row'); pg.wait_for_timeout(250)
    pg.click('#radius-opts input[value="5"]'); pg.wait_for_timeout(300)   # click, not check: the page puts the SAVED value back
    check('a failed save: the sheet stays, says so in words, and shows what is SAVED', open_sheet(pg) == 'radius-sheet'
          and txt(pg, '#radius-msg') == 'Could not save. Check your connection and try again.' and pg.is_checked('#radius-opts input[value="15"]'))
    check('… and the focus is still in the sheet (Escape and the focus trap still work)',
          pg.evaluate("document.activeElement.closest('#radius-sheet') !== null"), pg.evaluate('document.activeElement.outerHTML.slice(0, 80)'))
    pg.evaluate('window.__fx.saveFail = false'); pg.keyboard.press('Escape'); pg.wait_for_timeout(250)

    # Push
    pg.click('#toggle-notif'); pg.wait_for_timeout(300)
    pu = [c for c in calls(pg, 'update') if 'notificationPreferences' in c[2]]
    check('push off: the preference saved on the profile; the words say what still arrives',
          pu and pu[-1][2]['notificationPreferences']['push'] is False and not pg.is_checked('#toggle-notif')
          and txt(pg, '#notif-sub').startswith('Off. New job requests show only while the app is open.'), pu)
    pg.click('#toggle-notif'); pg.wait_for_timeout(300)
    check('push on: saved, and this device is asked through the push service', calls(pg, 'enablePush') == [['enablePush', 'A1', 'artisan']]
          and pg.is_checked('#toggle-notif'))

    # Phone
    pg.click('#phone-row'); pg.wait_for_timeout(250)
    check('phone sheet: the current number, focus in the field', open_sheet(pg) == 'phone-sheet' and pg.input_value('#phone-input') == '0241234567'
          and pg.evaluate('document.activeElement.id') == 'phone-input')
    pg.fill('#phone-input', '+44 20 7946 0000'); pg.click('#phone-save'); pg.wait_for_timeout(150)
    check('a non-Ghana number is refused in words; nothing is saved', txt(pg, '#phone-msg') == 'Enter a Ghana mobile number, like 024 123 4567.'
          and pg.get_attribute('#phone-input', 'aria-invalid') == 'true' and not calls(pg, 'set'))
    pg.fill('#phone-input', '+233 20 123 4567'); pg.click('#phone-save'); pg.wait_for_timeout(350)
    st = calls(pg, 'set')
    check('saved to private/contact only, normalised; never the profile', len(st) == 1 and st[0][1] == 'artisans/A1/private/contact'
          and st[0][2]['phone'] == '233201234567' and st[0][2]['artisanId'] == 'A1' and st[0][3] == {'merge': True}
          and not [c for c in calls(pg, 'update') if 'phone' in c[2]] and txt(pg, '#phone-value') == '233201234567', st)

    # A Save that disables itself drops the focus to <body>; the sheet must still hear Escape (js/fx/sheet.js).
    pg.evaluate('window.__fx.saveFail = true')
    pg.click('#phone-row'); pg.wait_for_timeout(250)
    pg.fill('#phone-input', '024 555 0000'); pg.click('#phone-save'); pg.wait_for_timeout(300)
    check('a failed save: said in words, the number not changed', txt(pg, '#phone-msg') == 'Not saved. Check your connection and try again.'
          and txt(pg, '#phone-value') == '233201234567')
    pg.keyboard.press('Escape'); pg.wait_for_timeout(300)
    check('… and Escape still closes the sheet after the Save button was disabled', open_sheet(pg) is None)
    pg.evaluate('window.__fx.saveFail = false')

    # Password
    pg.click('#password-row'); pg.wait_for_timeout(250)
    pg.click('#pw-save'); pg.wait_for_timeout(100)
    check('password: empty → "Enter your current password.", focus there', txt(pg, '#pw-msg') == 'Enter your current password.'
          and pg.evaluate('document.activeElement.id') == 'pw-current')
    pg.fill('#pw-current', 'old-pass-1'); pg.fill('#pw-new', 'new-pass-22'); pg.fill('#pw-confirm', 'new-pass-23'); pg.click('#pw-save'); pg.wait_for_timeout(100)
    check('mismatch → said, nothing sent', txt(pg, '#pw-msg') == "The new passwords don't match." and not calls(pg, 'reauth'))
    pg.evaluate("window.__fx.reauthFail = 'auth/invalid-credential'")
    pg.fill('#pw-confirm', 'new-pass-22'); pg.click('#pw-save'); pg.wait_for_timeout(250)
    check('a wrong current password: in words, the new one never set', txt(pg, '#pw-msg') == 'Your current password is not right.' and not calls(pg, 'changePassword'))
    pg.evaluate('window.__fx.reauthFail = null'); pg.click('#pw-save'); pg.wait_for_timeout(350)
    check('the current password proven, then the new one set; then "Password updated."',
          [c[0] for c in calls(pg) if c[0] in ('reauth', 'changePassword')][-2:] == ['reauth', 'changePassword']
          and calls(pg, 'changePassword')[-1][1] == 'new-pass-22' and open_sheet(pg) is None and 'Password updated.' in txt(pg, '.fx-toasts'))
    pg.click('#password-row'); pg.wait_for_timeout(200); pg.click('#pw-forgot'); pg.wait_for_timeout(200)
    check('forgot: the reset link through the auth service, to the sign-in email', calls(pg, 'reset') == [['reset', 'kofi@example.com']]
          and txt(pg, '#pw-msg') == "We've sent a reset link to kofi@example.com.")
    pg.keyboard.press('Escape'); pg.wait_for_timeout(250)

    # Sign out
    pg.click('#signout-row'); pg.wait_for_timeout(250)
    check('sign out asks first; Cancel has the focus', open_sheet(pg) == 'signout-sheet' and pg.evaluate("document.activeElement.textContent.trim()") == 'Cancel')
    pg.click('#signout-confirm'); pg.wait_for_timeout(400)
    check('sign out → the session service logs out → sign-in', prev_calls(pg, 'logout') == [['logout']] and pg.url.endswith('/artisan-app/login.html'), pg.url)
    check('the tab: no page errors', not errs, errs[:3])
    pg.context.close()

    # ═══ Verification statuses, Google sign-in ═════════════════════════════
    for status, value, tone, linked in [('rejected', 'Action needed', 'bad', True), ('pending_review', 'Under review', 'warn', True),
                                        ('draft', 'Not submitted', 'warn', True), ('re_verification_required', 'Action needed', 'bad', True)]:
        pg, errs = open_page(b, {'profile': {'verificationStatus': status, 'status': 'pending'}})
        check(f'verification, {status}: "{value}", and the row opens the application', txt(pg, '#kyc-value') == value
              and f'fx-chip--{tone}' in pg.get_attribute('#kyc-value', 'class') and pg.get_attribute('#kyc-row', 'href') == 'onboarding.html'
              and not re.search(r'business day|within', txt(pg, '#kyc-sub')), [txt(pg, '#kyc-value'), txt(pg, '#kyc-sub')])
        check(f'verification, {status}: no page errors', not errs, errs[:3])
        pg.context.close()

    pg, errs = open_page(b, {'providers': ['google.com'], 'device': 'blocked', 'profile': {'workRadius': None, 'profileImageId': 'p/1'}})
    check('Google sign-in: no password row; it says the password is managed by Google', pg.is_hidden('#password-row') and pg.is_visible('#google-row'))
    check('a browser that blocks push: the switch is off and says why; the preference is not changed',
          not pg.is_checked('#toggle-notif') and txt(pg, '#notif-sub').startswith('Blocked by this browser.') and not calls(pg, 'update'))
    check('no saved radius: the 20 km dispatch applies is what is shown', txt(pg, '#radius-value') == '20 km')
    check('a profile photo replaces the initials', pg.is_visible('#me-photo') and pg.is_hidden('#me-initials'))
    pg.context.close()

    # ═══ Closing the account ═════════════════════════════════════════════════
    blockers = {'checkAccountDeletable': {'data': {'deletable': False, 'blockers': [
        {'code': 'available_balance', 'message': 'You still have GHS 12.50 to withdraw.'}, {'code': 'active_bookings', 'message': 'A job is in progress.'}]}}}
    pg, errs = open_page(b, {'callables': blockers})
    pg.click('#close-row'); pg.wait_for_timeout(400)
    check('close, with obligations: the server\'s reasons as a list; no way to confirm',
          txt(pg, '#close-body p') == "Your account can't be closed yet:"
          and pg.eval_on_selector_all('#close-body li', 'ls => ls.map(l => l.textContent)') == ['You still have GHS 12.50 to withdraw.', 'A job is in progress.']
          and pg.is_hidden('#close-confirm') and pg.is_hidden('#close-actions'), txt(pg, '#close-body'))
    pg.context.close()

    ok_check = {'checkAccountDeletable': {'data': {'deletable': True, 'blockers': []}},
                'requestAccountDeletion': {'error': {'code': 'failed-precondition', 'message': 'Please confirm it is you — sign in again — and then close your account.',
                                                     'details': {'blockers': []}}}}
    pg, errs = open_page(b, {'callables': ok_check})
    pg.click('#close-row'); pg.wait_for_timeout(400)
    check('close, nothing outstanding: what is removed and what is kept; CLOSE and the password asked',
          'removed from your profile' in txt(pg, '#close-body') and 'Kept:' in txt(pg, '#close-body')
          and pg.is_visible('#close-confirm-text') and pg.is_visible('#close-password') and pg.is_disabled('#close-confirm'))
    pg.fill('#close-confirm-text', 'close'); pg.wait_for_timeout(50)
    check('CLOSE alone is not enough for a password account', pg.is_disabled('#close-confirm'))
    pg.fill('#close-password', 'secret-1'); pg.wait_for_timeout(50)
    pg.click('#close-confirm'); pg.wait_for_timeout(400)
    order = [c[0] if c[0] != 'callable' else c[1] for c in calls(pg) if c[0] in ('reauth', 'callable')]
    check('re-authentication comes before the request', order == ['checkAccountDeletable', 'reauth', 'requestAccountDeletion'], order)
    check('a refusal: in words, never the server\'s raw text; the button usable again',
          txt(pg, '#close-error') == 'Your account was not closed. Confirm it is you and try again.' and not pg.is_disabled('#close-confirm')
          and 'Please confirm' not in txt(pg, '#close-error'), txt(pg, '#close-error'))
    pg.evaluate("window.__fx.callables.requestAccountDeletion = { error: { code: 'failed-precondition', message: 'x', details: { blockers: [{ message: 'A job request is waiting for your answer.' }] } } }")
    pg.click('#close-confirm'); pg.wait_for_timeout(400)
    check('a refusal with reasons: the server\'s reasons', txt(pg, '#close-error') == 'Your account was not closed: A job request is waiting for your answer.')
    pg.evaluate("window.__fx.callables.requestAccountDeletion = { data: { closed: true } }")
    pg.click('#close-confirm'); pg.wait_for_timeout(500)
    check('closed: signed out, to sign-in with the closed notice', prev_calls(pg, 'signOut') and pg.url.endswith('/artisan-app/login.html?closed=1'), pg.url)
    check('closing: no page errors', not errs, errs[:3])
    pg.context.close()

    # ═══ Profile (profile.html): what customers see; verified vs editable ═══════
    PROF = '/artisan-app/profile.html'
    APPROVED = {'verificationStatus': 'approved', 'category': 'plumbing', 'specialty': 'Plumbing', 'skills': ['Fix Leaking Pipe'],
                'bio': 'Plumber in Accra for twelve years: leaks, toilets and water heaters.', 'yearsExperience': 7,
                'rating': 4.8, 'reviewCount': 5, 'jobsCompleted': 12, 'profileImageId': 'artisans/A1/p1', 'location': 'Madina, Accra', 'workRadius': 15}
    pg, errs = open_page(b, {'profile': APPROVED, 'callables': {'artisanAccount:requestProfileChange': {'data': {'requested': True}}}}, path=PROF)
    check('profile: "Profile | Fidus X for professionals", Back to Account, the tab bar with Account current',
          pg.title() == 'Profile | Fidus X for professionals' and pg.get_attribute('.fx-appbar a.fx-iconbtn', 'href') == 'settings.html'
          and pg.get_attribute('.fx-appbar a.fx-iconbtn', 'aria-label') == 'Back to Account' and txt(pg, '#tabbar [aria-current="page"]') == 'Account')
    check('approved: the name with "Verified" (the server\'s word), the trade, the area within the radius that applies',
          txt(pg, '#pf-name') == 'Kofi Boateng Verified' and pg.is_visible('#pf-tick') and txt(pg, '#pf-trade') == 'Plumbing'
          and txt(pg, '#pf-area') == 'Madina, Accra · within 15 km', [txt(pg, '#pf-name'), txt(pg, '#pf-trade'), txt(pg, '#pf-area')])
    check('the facts customers judge by: rating with its reviews (to Reputation), jobs, years',
          txt(pg, '#pf-rating') == '★ 4.8' and txt(pg, '#pf-rating-lbl') == '5 reviews' and txt(pg, '#pf-jobs') == '12' and txt(pg, '#pf-years') == '7 yrs'
          and pg.get_attribute('.fx-prof__fact[href]', 'href') == 'reputation.html#reviews')
    check('complete and approved: no notices; About and Services shown', pg.query_selector('#pf-notices .fx-notice') is None
          and txt(pg, '#pf-about').startswith('Plumber in Accra') and pg.eval_on_selector_all('#pf-chips .fx-chip', 'cs => cs.map(c => c.textContent)') == ['Plumbing', 'Fix Leaking Pipe'])
    check('no account controls on Profile (they live in Account)', not re.search(r'Sign out|Password|Phone number|Payout', pg.inner_text('main')))
    shot(pg, 'profile-390')
    layout(pg, 'profile')
    pg.click('#pf-edit'); pg.wait_for_timeout(250)
    check('edit, approved: name and trade are shown as verified, not editable, with Request a change',
          open_sheet(pg) == 'edit-sheet' and pg.is_hidden('#ed-name-field') and pg.is_hidden('#ed-specialty-field')
          and 'Your name and trade are verified.' in txt(pg, '#ed-verified') and 'Kofi Boateng · Plumbing' in txt(pg, '#ed-verified')
          and pg.is_visible('#ed-request'), txt(pg, '#ed-verified'))
    check('… and the focus is on the first thing the artisan can change (About you)', pg.evaluate('document.activeElement.id') == 'ed-bio',
          pg.evaluate('document.activeElement.id || document.activeElement.tagName'))
    layout(pg, 'profile edit sheet')
    pg.fill('#ed-years', '61'); pg.click('#ed-save'); pg.wait_for_timeout(100)
    check('years beyond 60: refused in words, nothing saved', txt(pg, '#ed-msg') == 'Years of experience must be a whole number from 0 to 60.' and not calls(pg, 'update'))
    pg.fill('#ed-years', '8'); pg.fill('#ed-location', 'Tema'); pg.click('#ed-save'); pg.wait_for_timeout(350)
    up = calls(pg, 'update')
    check('saved: bio, area and years only — never the verified name or trade',
          len(up) == 1 and set(up[0][2]) == {'bio', 'location', 'yearsExperience', 'updatedAt'} and up[0][2]['yearsExperience'] == 8
          and open_sheet(pg) is None and 'Profile saved.' in txt(pg, '.fx-toasts') and txt(pg, '#pf-area') == 'Tema · within 15 km', up)
    pg.click('#pf-edit'); pg.wait_for_timeout(250); pg.click('#ed-request'); pg.wait_for_timeout(500)
    check('Request a change opens the change sheet, the trade list the 8 bookable trades', open_sheet(pg) == 'change-sheet'
          and pg.eval_on_selector_all('#chg-category option', 'os => os.map(o => o.value)') == ['Electrical', 'Plumbing', 'Carpentry', 'AC Repair', 'Welding', 'Cleaning', 'Painting', 'Gardening'])
    pg.click('#chg-send'); pg.wait_for_timeout(100)
    check('nothing changed: said, nothing sent', txt(pg, '#chg-error') == 'Nothing has changed yet.' and not [c for c in calls(pg, 'callable') if len(c) > 2])
    pg.fill('#chg-name', 'Kofi Mensah Boateng'); pg.fill('#chg-reason', 'My middle name was missing'); pg.click('#chg-send'); pg.wait_for_timeout(350)
    sent = [c for c in calls(pg, 'callable') if len(c) > 2]
    check('a change is a request for review: only the changed field and the reason go to the server',
          sent and sent[-1][2] == {'name': 'Kofi Mensah Boateng', 'reason': 'My middle name was missing', 'action': 'requestProfileChange'}
          and open_sheet(pg) is None and 'Change sent for review.' in txt(pg, '.fx-toasts'), sent)
    pg.click('#pf-cam'); pg.wait_for_timeout(50)
    with pg.expect_file_chooser() as fc:
        pg.click('#pf-cam')
    fc.value.set_files({'name': 'me.png', 'mimeType': 'image/png', 'buffer': b'\x89PNG\r\n\x1a\n'})
    pg.wait_for_timeout(300)
    check('photo: the shared lifecycle replaces it', calls(pg, 'photo') == [['photo', 'artisan', 'me.png']] and 'Photo updated.' in txt(pg, '.fx-toasts'))
    check('profile, approved: no page errors', not errs, errs[:3])
    pg.context.close()

    pg, errs = open_page(b, {'profile': {'verificationStatus': 'approved', 'category': 'plumbing', 'pendingProfileChange': {'fields': ['name']}},
                             'callables': {'artisanAccount:cancelProfileChange': {'data': {}}}}, path=PROF)
    pg.click('#pf-edit'); pg.wait_for_timeout(250); pg.click('#ed-request'); pg.wait_for_timeout(500)
    check('a pending request: said, with Withdraw; no second request form', 'You asked to change your name.' in txt(pg, '#chg-pending-text')
          and pg.is_hidden('#change-form') and pg.is_hidden('#chg-send') and txt(pg, '#chg-cancel') == 'Close')
    pg.click('#chg-withdraw'); pg.wait_for_timeout(350)
    check('withdrawn through the server', [c[2]['action'] for c in calls(pg, 'callable') if len(c) > 2] == ['cancelProfileChange'] and 'Request withdrawn.' in txt(pg, '.fx-toasts'))
    pg.context.close()

    pg, errs = open_page(b, {'profile': {'verificationStatus': 'draft', 'status': 'pending', 'category': 'Plumbing', 'yearsExperience': 0}}, path=f'{PROF}?edit=area')
    notes = txt(pg, '#pf-notices')
    check('draft: "Finish your verification" (to the application) and what is missing — no "Verified"',
          'Finish your verification' in notes and pg.get_attribute('#pf-notices a', 'href') == 'onboarding.html'
          and 'Profile 0 of 4 complete' in notes and 'Add a profile photo and 3 more' in notes and pg.is_hidden('#pf-tick'), notes)
    check('the deep link ?edit=area opens the editor on the service area', open_sheet(pg) == 'edit-sheet' and pg.evaluate('document.activeElement.id') == 'ed-location',
          [open_sheet(pg), pg.evaluate('document.activeElement.id || document.activeElement.tagName')])
    check('draft: name and specialty are still editable (the rules allow it before sending)', pg.is_visible('#ed-name-field') and pg.is_visible('#ed-specialty-field') and pg.is_hidden('#ed-verified'))
    pg.fill('#ed-name', ''); pg.click('#ed-save'); pg.wait_for_timeout(100)
    check('an empty name is refused', txt(pg, '#ed-msg') == 'Your name is required.' and not calls(pg, 'update'))
    pg.fill('#ed-name', 'Kofi Boateng'); pg.click('#ed-save'); pg.wait_for_timeout(350)
    up = calls(pg, 'update')
    check('draft: the name and specialty are written with the rest', up and {'name', 'specialty'} <= set(up[-1][2]), up)
    check('profile, draft: no page errors', not errs, errs[:3])
    pg.context.close()

    pg, errs = open_page(b, {'profile': APPROVED}, width=360, path=PROF)
    pg.add_style_tag(content='html { font-size: 200% !important; }'); pg.wait_for_timeout(150)
    o = pg.evaluate(OVERFLOW_JS)
    check('profile 360px at 200% text: no horizontal overflow', not o['scroll'] and not o['bad'], o)
    pg.context.close()

    # ═══ 200% text ══════════════════════════════════════════════════════════
    pg, errs = open_page(b, width=360)
    pg.add_style_tag(content='html { font-size: 200% !important; }'); pg.wait_for_timeout(150)
    o = pg.evaluate(OVERFLOW_JS)
    check('account 360px at 200% text: no horizontal overflow', not o['scroll'] and not o['bad'], o)
    pg.context.close()

    b.close()

_done = True
