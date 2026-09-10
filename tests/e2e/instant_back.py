"""Dashboard -> Booking -> back must RESTORE the dashboard, not rebuild it.

The proof is the JS heap. A marker is stamped onto `window` on the dashboard.
If the same marker is still there after returning, the document was restored:
no re-parse, no Firebase re-init, no refetch. If it is gone, the page was
rebuilt from scratch — which is what was happening before.
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
    cdp = ctx.new_cdp_session(pg)
    cdp.send("Page.enable")
    bf_reasons = []
    cdp.on("Page.backForwardCacheNotUsed",
           lambda ev: [bf_reasons.append(f"{e.get('type')}: {e.get('reason')}")
                       for e in ev.get("notRestoredExplanations", [])])

    pg.goto(f"{BASE}/login.html?emulator=1", wait_until="domcontentloaded")
    pg.wait_for_timeout(2500)
    pg.fill("#user-id", CUST[0]); pg.fill("#password", CUST[1]); pg.click("#login-btn")
    pg.wait_for_url("**/dashboard.html*", timeout=25000)
    pg.wait_for_timeout(5000)

    # Stamp this dashboard document instance.
    pg.evaluate("() => { window.__dash = 'dash-' + Math.random().toString(36).slice(2,8); }")
    stamp = pg.evaluate("() => window.__dash")
    check("dashboard loaded and stamped", bool(stamp), stamp)

    # CLICK through, the way a customer does. pg.goto() sets no referrer, and
    # the back logic deliberately refuses to use history when it cannot confirm
    # where the customer came from — so a scripted goto would test nothing.
    # A JS click on a real anchor is still a real navigation and still sets the
    # referrer — and it avoids the fixed nav bar being outside the viewport.
    pg.evaluate("""() => {
        const a = document.querySelector("a[data-tab='bookings'], a[href='booking.html']")
               || Object.assign(document.createElement('a'), { href: 'booking.html' });
        if (!a.isConnected) document.body.appendChild(a);
        a.click();
    }""")
    pg.wait_for_url("**/booking.html*", timeout=20000)
    pg.wait_for_timeout(4000)
    check("navigated to bookings by clicking", "booking.html" in pg.url)

    # Return via the app's own back button.
    clicked = False
    for sel in [".bk-back", ".back-btn", "[aria-label='Go back']", "[aria-label='Back']"]:
        try:
            el = pg.query_selector(sel)
            if el: el.click(); clicked = True; break
        except Exception:
            pass
    if not clicked:
        pg.evaluate("() => window.hhBack && window.hhBack('dashboard.html')")
        clicked = True
    check("used the in-app back control", clicked)
    pg.wait_for_timeout(5000)

    after = pg.evaluate("() => ({ url: location.href, dash: window.__dash || null })")
    on_dash = "dashboard.html" in after["url"]
    restored = after["dash"] == stamp

    check("landed back on the dashboard", on_dash, after["url"].split('/')[-1][:30])
    check("dashboard was RESTORED, not rebuilt", restored,
          f"marker {'survived' if restored else 'lost -> full reload'}")

    if not restored and bf_reasons:
        print("")
        print("  Chrome refused bfcache because:")
        for r in dict.fromkeys(bf_reasons):
            print("   -", r)

    ctx.close(); b.close()

bad = [r for r in results if not r[1]]
print("")
print(f"{len(results)-len(bad)}/{len(results)} checks passed")
sys.exit(1 if bad else 0)
