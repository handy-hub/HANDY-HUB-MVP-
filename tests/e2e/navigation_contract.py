"""Back goes backward. Forward goes to a destination. One nav per gesture.

HH_Nav (js/navContext.js) owns every back decision. These assert the CONTRACT
holds at runtime, not that a particular mechanism fired.
"""
import sys
from playwright.sync_api import sync_playwright

BASE = "http://localhost:8791/customer-app"
CUST = ("customer@e2e.test", "Passw0rd!23")

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

    pg.goto(f"{BASE}/login.html?emulator=1", wait_until="domcontentloaded")
    pg.wait_for_timeout(2500)

    loaded = pg.evaluate("() => ({ nav: typeof window.HH_Nav, back: typeof (window.HH_Nav||{}).back })")
    check("HH_Nav contract is loaded", loaded["nav"] == "object" and loaded["back"] == "function",
          f"HH_Nav={loaded['nav']} back={loaded['back']}")

    pg.fill("#user-id", CUST[0]); pg.fill("#password", CUST[1]); pg.click("#login-btn")
    pg.wait_for_url("**/dashboard.html*", timeout=25000); pg.wait_for_timeout(4000)

    # ── Dashboard -> Bookings -> Back ────────────────────────────────────────
    pg.evaluate("""() => {
        const a = document.querySelector("a[href='booking.html'], a[data-tab='bookings']")
               || Object.assign(document.createElement('a'), { href:'booking.html' });
        if (!a.isConnected) document.body.appendChild(a);
        a.click();
    }""")
    pg.wait_for_url("**/booking.html*", timeout=20000); pg.wait_for_timeout(3500)
    check("forward navigation reached bookings", "booking.html" in pg.url)

    depth_before = pg.evaluate("() => history.length")
    pg.evaluate("() => window.HH_Nav.back()")
    pg.wait_for_timeout(4000)
    check("back returned to the dashboard", "dashboard.html" in pg.url,
          pg.url.split('/')[-1][:28])

    nav_type = pg.evaluate("() => (performance.getEntriesByType('navigation')[0]||{}).type")
    check("back used a HISTORY navigation, not a fresh load",
          nav_type == "back_forward", f"navigation.type={nav_type}")

    # ── Bottom nav must NOT be hijacked to history ───────────────────────────
    pg.evaluate("""() => {
        const a = document.querySelector("a[href='saved.html'], a[data-tab='saved']")
               || Object.assign(document.createElement('a'), { href:'saved.html' });
        if (!a.isConnected) document.body.appendChild(a);
        a.click();
    }""")
    pg.wait_for_url("**/saved.html*", timeout=20000); pg.wait_for_timeout(3000)
    fwd_type = pg.evaluate("() => (performance.getEntriesByType('navigation')[0]||{}).type")
    check("a tab tap is a FORWARD navigation (not history.back)",
          fwd_type == "navigate", f"navigation.type={fwd_type}")

    # ── Rapid double tap must produce ONE history entry ──────────────────────
    before = pg.evaluate("() => history.length")
    pg.evaluate("""() => {
        const a = Object.assign(document.createElement('a'), { href:'notification.html' });
        document.body.appendChild(a);
        a.click(); a.click(); a.click();      // three taps, one intent
    }""")
    pg.wait_for_url("**/notification.html*", timeout=20000); pg.wait_for_timeout(3000)
    after = pg.evaluate("() => history.length")
    check("three rapid taps created ONE history entry", after - before <= 1,
          f"history grew by {after - before}")

    # ── Deep link with no history still resolves somewhere safe ──────────────
    fresh = ctx.new_page()
    fresh.goto(f"{BASE}/review.html", wait_until="domcontentloaded")
    fresh.wait_for_timeout(3500)
    fresh.evaluate("() => window.HH_Nav && window.HH_Nav.back()")
    fresh.wait_for_timeout(3500)
    check("back from a deep link lands on a safe route, never off-app",
          "lamax" in fresh.url or "localhost" in fresh.url,
          fresh.url.split('/')[-1][:30])
    fresh.close()

    ig = ("app-check","appcheck","installations","err_blocked","403","messaging","permission","404")
    real = [e for e in errs if not any(t in e.lower() for t in ig)]
    check("no unexpected JS errors", not real, real[0][:100] if real else "")

    ctx.close(); b.close()

bad = [r for r in results if not r[1]]
print("")
print(f"{len(results)-len(bad)}/{len(results)} checks passed")
sys.exit(1 if bad else 0)
