"""THE test the whole redesign exists to pass — section 9 of the brief.

One customer, two live bookings, same artisan. Booking B (electrical) has the
NEWEST updatedAt, so any surviving "most recently updated booking" fallback
picks the wrong one and this test says so.

This runs against the Firestore + Auth emulators with a real sign-in through
the real login page. No stubs.
"""
import sys
from playwright.sync_api import sync_playwright

BASE = "http://localhost:8791"
CUST = ("customer@e2e.test", "Passw0rd!23")
A = ("HHB-E2E-PLUMB-A", "Plumbing")
B = ("HHB-E2E-ELEC-B",  "Electrical")

results = []
def check(name, ok, detail=""):
    results.append((name, ok, detail))
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f"   {detail}" if detail else ""))

def tracked_service(pg):
    """What service is the tracking screen actually showing?"""
    return pg.evaluate("""() => {
        const el = document.getElementById('trk-service');
        const nm = document.getElementById('trk-name');
        return { service: el?.textContent?.trim() || '', name: nm?.textContent?.trim() || '',
                 url: location.href };
    }""")

with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={"width": 390, "height": 844})
    pg = ctx.new_page()
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))

    # ── real sign-in, emulator mode armed by the query flag ──────────────────
    pg.goto(f"{BASE}/customer-app/login.html?emulator=1", wait_until="domcontentloaded")
    pg.wait_for_timeout(2500)
    emu = pg.evaluate("() => { try { return localStorage.getItem('hh_use_emulator'); } catch { return null; } }")
    check("emulator mode armed", emu == "1", f"hh_use_emulator={emu!r}")

    pg.fill("#user-id", CUST[0])
    pg.fill("#password", CUST[1])
    pg.click("#login-btn")
    try:
        pg.wait_for_url("**/dashboard.html*", timeout=25000)
        check("real sign-in against Auth emulator", True, pg.url.split("/")[-1][:40])
    except Exception:
        check("real sign-in against Auth emulator", False, f"stuck at {pg.url.split('/')[-1][:60]}")
        body = pg.evaluate("() => document.body.innerText.slice(0,240)")
        print("      page said:", body.replace("\n", " | ")[:200])

    # ── 9.1 open A -> must be plumbing ──────────────────────────────────────
    pg.goto(f"{BASE}/customer-app/live-tracking.html?bookingId={A[0]}", wait_until="domcontentloaded")
    pg.wait_for_timeout(3500)
    s = tracked_service(pg)
    check("booking A opens PLUMBING", A[1].lower() in s["service"].lower(), f"showed {s['service']!r}")

    # ── 9.2 open B -> must be electrical ────────────────────────────────────
    pg.goto(f"{BASE}/customer-app/live-tracking.html?bookingId={B[0]}", wait_until="domcontentloaded")
    pg.wait_for_timeout(3500)
    s = tracked_service(pg)
    check("booking B opens ELECTRICAL", B[1].lower() in s["service"].lower(), f"showed {s['service']!r}")

    # ── 9.3 refresh A -> still plumbing (B is newer; the old code would flip) ─
    pg.goto(f"{BASE}/customer-app/live-tracking.html?bookingId={A[0]}", wait_until="domcontentloaded")
    pg.wait_for_timeout(3000)
    pg.reload(wait_until="domcontentloaded")
    pg.wait_for_timeout(3500)
    s = tracked_service(pg)
    check("A survives REFRESH as plumbing", A[1].lower() in s["service"].lower(), f"showed {s['service']!r}")

    # ── 9.4 back/forward must not cross the streams ─────────────────────────
    pg.goto(f"{BASE}/customer-app/live-tracking.html?bookingId={B[0]}", wait_until="domcontentloaded")
    pg.wait_for_timeout(2500)
    pg.go_back(wait_until="domcontentloaded")
    pg.wait_for_timeout(3000)
    s = tracked_service(pg)
    check("BACK returns to plumbing", A[1].lower() in s["service"].lower(), f"showed {s['service']!r}")
    pg.go_forward(wait_until="domcontentloaded")
    pg.wait_for_timeout(3000)
    s = tracked_service(pg)
    check("FORWARD returns to electrical", B[1].lower() in s["service"].lower(), f"showed {s['service']!r}")

    # ── 9.5 the router sends a pre-quote booking to the console, WITH its id ─
    pg.goto(f"{BASE}/customer-app/live-tracking.html?bookingId=HHB-E2E-CARP-C", wait_until="domcontentloaded")
    pg.wait_for_timeout(4000)
    u = pg.url
    check("pre-quote booking C routed to its OWN console url",
          "book-request.html" in u and "HHB-E2E-CARP-C" in u, u.split("/")[-1][:60])

    # ── 9.6 the old failure mode, documented: no id at all ──────────────────
    pg.goto(f"{BASE}/customer-app/live-tracking.html", wait_until="domcontentloaded")
    pg.wait_for_timeout(3500)
    s = tracked_service(pg)
    print(f"  INFO  bare live-tracking.html (no id) fell back to {s['service']!r}"
          f"  <- this is the documented fallback, and it picks the NEWEST booking")

    # ── 10 review deep link survives refresh ────────────────────────────────
    pg.goto(f"{BASE}/customer-app/review.html?bookingId={A[0]}", wait_until="domcontentloaded")
    pg.wait_for_timeout(3000)
    r1 = pg.evaluate("() => document.getElementById('rv-booking-id')?.textContent?.trim() || document.body.innerText.slice(0,120)")
    pg.reload(wait_until="domcontentloaded")
    pg.wait_for_timeout(3000)
    r2 = pg.evaluate("() => document.getElementById('rv-booking-id')?.textContent?.trim() || document.body.innerText.slice(0,120)")
    check("review deep link survives refresh", A[0] in str(r2), f"after reload: {str(r2)[:60]!r}")

    real = [e for e in errs if not any(t in e.lower() for t in
            ("app-check", "appcheck", "installations", "err_blocked", "403", "messaging"))]
    check("no unexpected JS errors", not real, real[0][:110] if real else "")

    ctx.close(); b.close()

bad = [r for r in results if not r[1]]
print(f"\n{len(results)-len(bad)}/{len(results)} checks passed")
sys.exit(1 if bad else 0)
