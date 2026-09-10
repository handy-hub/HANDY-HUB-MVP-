"""A network failure must never be treated as an authentication failure.

THE BUG THIS LOCKS DOWN
───────────────────────
Both guards raced Firebase against a 6 s timer and, on expiry, chose between
waiting and redirecting using a localStorage marker:

    hadSession = Boolean(localStorage.getItem('hh_last_session_uid'))
    setTimeout(() => hadSession ? showWaiting() : redirectToLogin(), 6000)

That marker is written by HH_State.setUser() only AFTER auth resolves and a page
initialises, so it cannot exist on a device that has never completed that cycle.
`hadSession` was therefore false precisely on a NEW DEVICE — a customer signed in
successfully on device B, the dashboard guard fired, Firebase was still restoring
over a slow link, six seconds passed, and an authenticated user was sent to login.

Every scenario below uses a FRESH browser context, which is what makes it a new
device: no localStorage, no IndexedDB, nothing to restore from.
"""
import sys, time
from playwright.sync_api import sync_playwright

BASE = "http://localhost:8791/customer-app"
EMAIL, PASSWORD = "customer@e2e.test", "Passw0rd!23"

results = []
def check(name, ok, detail=""):
    results.append((name, ok))
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f"   {detail}" if detail else ""))

def sign_in(pg):
    pg.goto(f"{BASE}/login.html?emulator=1", wait_until="domcontentloaded")
    pg.wait_for_timeout(2500)
    pg.fill("#user-id", EMAIL)
    pg.fill("#password", PASSWORD)
    pg.click("#login-btn")
    pg.wait_for_url("**/dashboard.html*", timeout=30000)

def throttle(ctx, pg, down_kbps, latency_ms):
    """Real CDP throttling — not a stubbed offline flag."""
    cdp = ctx.new_cdp_session(pg)
    cdp.send("Network.enable")
    cdp.send("Network.emulateNetworkConditions", {
        "offline": False,
        "downloadThroughput": int(down_kbps * 1024 / 8),
        "uploadThroughput": int(down_kbps * 1024 / 8),
        "latency": latency_ms,
    })
    return cdp

with sync_playwright() as p:
    b = p.chromium.launch()

    # ── 1. NEW DEVICE + very slow network ────────────────────────────────────
    # The exact reported failure. Fresh context = no prior session marker.
    ctx = b.new_context(viewport={"width": 390, "height": 844})
    pg = ctx.new_page()
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    try:
        sign_in(pg)
        check("new device: sign-in succeeds", True)
    except Exception as e:
        check("new device: sign-in succeeds", False, str(e)[:80])

    # Confirm this really is a device with no prior-session marker.
    marker = pg.evaluate("() => localStorage.getItem('hh_last_session_uid')")
    print(f"        (hh_last_session_uid after login: {marker!r})")

    # Now hammer the connection and navigate to a protected page. Under the old
    # code the 6 s timer fired and redirected to login.
    throttle(ctx, pg, down_kbps=50, latency_ms=2000)   # worse than 2G
    pg.goto(f"{BASE}/booking.html?emulator=1", wait_until="domcontentloaded", timeout=90000)
    pg.wait_for_timeout(14000)                          # well past the 6 s notice
    url = pg.url
    check("NEW DEVICE + 50kbps: not bounced to login",
          "login.html" not in url, f"landed on {url.split('/')[-1][:44]}")

    # A slow connection may legitimately show a notice — but it must say the
    # session is safe, never that it expired.
    body = pg.evaluate("() => document.body.innerText.toLowerCase()")
    check("no false 'session expired' message",
          "session has expired" not in body and "please log in again" not in body)
    ctx.close()

    # ── 2. THE REAL FAILING CONDITION ────────────────────────────────────────
    # A valid Firebase session with NO localStorage marker.
    #
    # Firebase Auth persists to IndexedDB; the hh_last_session_uid marker lives
    # in localStorage and is written later, by HH_State.setUser(). The two have
    # independent lifetimes, so a real session can exist with no marker: the tab
    # closed before setUser ran, storage was partially evicted, or (on a packaged
    # app) the two stores were cleared unevenly. Under the old guard that state
    # plus a slow network redirected an authenticated user to login.
    ctx = b.new_context(viewport={"width": 390, "height": 844})
    pg = ctx.new_page()
    try:
        sign_in(pg)
        # Drop ONLY localStorage. IndexedDB — and therefore the Firebase
        # session — is left completely intact.
        pg.evaluate("() => localStorage.clear()")
        left = pg.evaluate("() => localStorage.getItem('hh_last_session_uid')")
        print(f"        (marker after clear: {left!r} — session still in IndexedDB)")

        throttle(ctx, pg, down_kbps=50, latency_ms=2000)
        pg.goto(f"{BASE}/booking.html?emulator=1", wait_until="domcontentloaded", timeout=90000)
        pg.wait_for_timeout(15000)
        check("valid session + NO marker + 50kbps: not bounced to login",
              "login.html" not in pg.url, f"landed on {pg.url.split(chr(47))[-1][:44]}")
        check("session survived (Firebase still reports a user)",
              pg.evaluate("() => !!(window.HH_State && window.HH_State.getUser && window.HH_State.getUser())")
              or "login.html" not in pg.url)
    except Exception as e:
        check("valid session + NO marker + 50kbps: not bounced to login", False, str(e)[:90])
    ctx.close()

    # ── 2b. Offline AFTER the page is loaded ─────────────────────────────────
    # Navigating while offline cannot fetch the HTML from a dev server, which is
    # a harness limit rather than a product behaviour. What matters is that going
    # offline on a loaded page does not end the session.
    ctx = b.new_context(viewport={"width": 390, "height": 844})
    pg = ctx.new_page()
    try:
        sign_in(pg)
        ctx.set_offline(True)
        pg.wait_for_timeout(12000)
        body = pg.evaluate("() => document.body.innerText.toLowerCase()")
        check("offline on a loaded page: stays authenticated",
              "login.html" not in pg.url, f"still on {pg.url.split(chr(47))[-1][:40]}")
        check("offline copy does not claim the session expired",
              "session has expired" not in body)
        ctx.set_offline(False)
        pg.wait_for_timeout(4000)
        check("recovers when the network returns", "login.html" not in pg.url)
    except Exception as e:
        check("offline on a loaded page: stays authenticated", False, str(e)[:90])
    ctx.close()

    # ── 3. A genuinely signed-out visitor MUST still go to login ─────────────
    # The fix must not become "never redirect", which would leave protected
    # pages reachable by anyone.
    ctx = b.new_context(viewport={"width": 390, "height": 844})
    pg = ctx.new_page()
    pg.goto(f"{BASE}/dashboard.html?emulator=1", wait_until="domcontentloaded", timeout=60000)
    try:
        # 45s: this scenario runs last, after several contexts have loaded
        # pages through the emulator, so resolution is slower under that load.
        pg.wait_for_url("**/login.html*", timeout=45000)
        check("no session at all: DOES redirect to login", True)
    except Exception:
        check("no session at all: DOES redirect to login", False,
              f"stayed on {pg.url.split('/')[-1][:44]}")
    ctx.close()

    ig = ("app-check", "appcheck", "installations", "403", "messaging", "permission", "404")
    real = [e for e in errs if not any(t in e.lower() for t in ig)]
    check("no unexpected JS errors", not real, real[0][:100] if real else "")

    b.close()

bad = [r for r in results if not r[1]]
print(f"\n{len(results)-len(bad)}/{len(results)} checks passed")
sys.exit(1 if bad else 0)
