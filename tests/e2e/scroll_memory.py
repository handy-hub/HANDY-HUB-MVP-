"""A screen should return to where the customer left it.

HandyHub is a multi-page app: every navigation is a full document load, so the
scroll position dies with the document. Scroll down the bookings list, open one,
press back — and you were at the top again. This drives the real screen with a
real signed-in customer and asserts the position comes back.
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
    pg.fill("#user-id", CUST[0]); pg.fill("#password", CUST[1]); pg.click("#login-btn")
    try:
        pg.wait_for_url("**/dashboard.html*", timeout=25000)
        check("customer signs in", True)
    except Exception:
        check("customer signs in", False, pg.url.split('/')[-1][:40])

    # ── the bookings list: long enough to scroll, and wired ──────────────────
    pg.goto(f"{BASE}/booking.html", wait_until="domcontentloaded")
    pg.wait_for_timeout(5000)

    # booking.html is an app shell (body{overflow:hidden;height:100dvh}), so the
    # WINDOW never scrolls — an inner pane does. Open the Completed tab, which
    # holds 12 bookings and actually overflows.
    try:
        pg.get_by_text("Completed", exact=False).first.click()
        pg.wait_for_timeout(2500)
    except Exception:
        pass

    SCROLLER = """() => {
        const cands = [...document.querySelectorAll('div, main, section, ul')]
          .filter(c => /auto|scroll/.test(getComputedStyle(c).overflowY)
                    && c.scrollHeight - c.clientHeight > 40);
        return cands.length ? cands.sort((a,b)=>(b.scrollHeight-b.clientHeight)-(a.scrollHeight-a.clientHeight))[0] : null;
    }"""
    height = pg.evaluate("(f) => { const e = eval('('+f+')')(); return e ? e.scrollHeight : document.documentElement.scrollHeight; }", SCROLLER)
    pg.evaluate("(f) => { const e = eval('('+f+')')(); if (e) e.scrollTop = 600; else window.scrollTo(0,600); }", SCROLLER)
    pg.wait_for_timeout(1200)
    before = pg.evaluate("(f) => { const e = eval('('+f+')')(); return Math.round(e ? e.scrollTop : window.scrollY); }", SCROLLER)
    check("scrolled down the bookings list", before > 100,
          f"scrollY={before} (page height {height})")

    stored = pg.evaluate("() => sessionStorage.getItem('hh_scroll_booking.html')")
    check("position recorded while scrolling", stored is not None, f"stored={stored}")

    # ── leave and come back, the way a customer does ─────────────────────────
    pg.goto(f"{BASE}/dashboard.html", wait_until="domcontentloaded")
    pg.wait_for_timeout(3000)
    pg.go_back(wait_until="domcontentloaded")
    pg.wait_for_timeout(5000)

    after = pg.evaluate("(f) => { const e = eval('('+f+')')(); return Math.round(e ? e.scrollTop : window.scrollY); }", SCROLLER)
    close_enough = abs(after - before) <= 120        # list may reflow slightly
    check("returns to roughly where it was left", close_enough,
          f"left at {before}, returned to {after}")

    # ── a fresh entry must NOT jump ──────────────────────────────────────────
    pg.evaluate("() => sessionStorage.removeItem('hh_scroll_professionals.html')")
    pg.goto(f"{BASE}/professionals.html", wait_until="domcontentloaded")
    pg.wait_for_timeout(4000)
    fresh = pg.evaluate("(f) => { const e = eval('('+f+')')(); return Math.round(e ? e.scrollTop : window.scrollY); }", SCROLLER)
    check("a first visit still starts at the top", fresh <= 20, f"scrollY={fresh}")

    ig = ("app-check","appcheck","installations","err_blocked","403","messaging","permission","404")
    real = [e for e in errs if not any(t in e.lower() for t in ig)]
    check("no unexpected JS errors", not real, real[0][:100] if real else "")

    ctx.close(); b.close()

bad = [r for r in results if not r[1]]
print(f"\n{len(results)-len(bad)}/{len(results)} checks passed")
sys.exit(1 if bad else 0)
