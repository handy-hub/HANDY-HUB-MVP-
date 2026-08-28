"""Signing up must drop you INTO the app — never back at a login form.

Signing up already signs you in. The bug was the destination: signup sent people
to index.html, a static landing page with no auth handling at all, so a freshly
authenticated customer saw a "Log In" button and logged in again.

The second, nastier half was a race. createUserWithEmailAndPassword resolves as
soon as the credential exists, but Firebase persists the session afterwards. A
timed redirect could therefore reach a guarded page before the session was
durable, and requireAuth() would bounce to login — intermittently, which is the
worst kind. Hence the reload assertion below: it proves the session SURVIVED,
not merely that one navigation happened to win the race.
"""
import sys, time
from playwright.sync_api import sync_playwright

BASE = "http://localhost:8791/customer-app"
UNIQUE = str(int(time.time()))
EMAIL = f"autologin{UNIQUE}@e2e.test"
PASSWORD = "Passw0rd!23"

results = []
def check(name, ok, detail=""):
    results.append((name, ok))
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f"   {detail}" if detail else ""))

with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={"width": 390, "height": 844})
    pg = ctx.new_page()
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))

    pg.goto(f"{BASE}/signup.html?emulator=1", wait_until="domcontentloaded")
    pg.wait_for_timeout(3000)

    # Fill whatever the form actually asks for, tolerating optional fields.
    def fill(sel, val):
        try:
            if pg.locator(sel).count():
                pg.fill(sel, val); return True
        except Exception:
            pass
        return False

    # Real ids from customer-app/signup.html: pass/confirm/tel-no, not the
    # generic names guessed first.
    fill("#full-name", "Auto Login Test")
    fill("#email", EMAIL)
    fill("#tel-no", "0201234567")
    fill("#location", "Accra")
    fill("#pass", PASSWORD)
    fill("#confirm", PASSWORD)

    # Any terms checkbox must be ticked or the submit stays disabled.
    # NOT gated on is_visible(): the checkbox is custom-styled and therefore
    # reports invisible, so skipping it left the form invalid and the submit
    # button disabled — which looked exactly like "signup is broken".
    try:
        for i in range(pg.locator("input[type=checkbox]").count()):
            cb = pg.locator("input[type=checkbox]").nth(i)
            try:
                if not cb.is_checked():
                    cb.check(force=True)
            except Exception:
                pass
    except Exception:
        pass

    pg.wait_for_timeout(600)
    # The submit button starts disabled and enables only once the form validates.
    try:
        pg.wait_for_function(
            "() => { const b=document.getElementById('submit-btn'); return b && !b.disabled; }",
            timeout=15000)
    except Exception:
        pass
    pg.click("#submit-btn", timeout=15000, force=True)

    # Give the account creation + profile write + redirect time to complete.
    landed = None
    for _ in range(40):
        pg.wait_for_timeout(700)
        u = pg.url
        if "signup.html" not in u:
            landed = u
            break

    check("signup completed and navigated away", landed is not None,
          f"url={(landed or pg.url).split('/')[-1][:44]}")

    if landed:
        page = landed.split("/")[-1].split("?")[0]
        check("did NOT land on login.html", page != "login.html", f"landed on {page}")
        check("did NOT land on the static index.html", page != "index.html", f"landed on {page}")
        check("landed in the app (dashboard)", page == "dashboard.html", f"landed on {page}")

    # The real proof the session is durable, not a race we happened to win:
    # reload a guarded page and confirm the guard does not bounce us to login.
    pg.goto(f"{BASE}/dashboard.html", wait_until="domcontentloaded")
    pg.wait_for_timeout(5000)
    after = pg.url.split("/")[-1].split("?")[0]
    check("session SURVIVES a fresh load of a guarded page",
          after == "dashboard.html", f"dashboard reload -> {after}")

    signed_in = pg.evaluate("""async () => {
        try {
            const m = await import('/shared/js/backend/providers/firebase/firebaseConfig.js');
            if (m.firebaseAuth.authStateReady) await m.firebaseAuth.authStateReady();
            return !!m.firebaseAuth.currentUser;
        } catch (e) { return 'ERR ' + String(e).slice(0, 80); }
    }""")
    check("Firebase reports a signed-in user", signed_in is True, f"currentUser present={signed_in}")

    real = [e for e in errs if not any(t in e.lower() for t in
            ("app-check", "appcheck", "installations", "err_blocked", "403", "messaging", "permission"))]
    check("no unexpected JS errors", not real, real[0][:110] if real else "")

    ctx.close(); b.close()

bad = [r for r in results if not r[1]]
print(f"\n{len(results)-len(bad)}/{len(results)} checks passed")
sys.exit(1 if bad else 0)
