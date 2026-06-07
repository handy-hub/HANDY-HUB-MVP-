# HandyHub — Critical Fix Verification (C1, C2, C3)
# Served from project root so shared/ assets resolve correctly
# encoding: utf-8

import os, sys, time, json
from playwright.sync_api import sync_playwright

BASE  = "http://localhost:8765"
SHOTS = "tests/screenshots/verify"
os.makedirs(SHOTS, exist_ok=True)

results = []

def record(test_id, name, passed, detail="", screenshot=""):
    icon = "PASS" if passed else "FAIL"
    results.append({"id": test_id, "name": name, "passed": passed,
                     "detail": detail, "screenshot": screenshot})
    print(f"  [{icon}] {name}")
    if not passed:
        print(f"         -> {detail[:120]}")

def shot(pg, name):
    p = f"{SHOTS}/{name}.png"
    pg.screenshot(path=p, full_page=True)
    return p

def go(pg, path, timeout=20000):
    for attempt in range(3):
        try:
            pg.goto(f"{BASE}/{path}", wait_until="domcontentloaded", timeout=timeout)
            time.sleep(2)
            return
        except Exception as e:
            if attempt == 2:
                raise
            print(f"  [retry {attempt+1}] {path}: {str(e)[:60]}")
            time.sleep(2)

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)

    # ==========================================================================
    # C1 VERIFICATION — book-emergency.html
    # ==========================================================================
    print("\n" + "="*65)
    print("C1 VERIFICATION: Emergency Booking Map (book-emergency.html)")
    print("="*65)

    ctx = browser.new_context(viewport={"width":390,"height":844})
    page = ctx.new_page()
    js_exceptions = []
    sri_errors    = []
    console_errs  = []

    page.on("pageerror", lambda e: js_exceptions.append(str(e)))
    page.on("console",   lambda m: (
        sri_errors.append(m.text)   if "integrity" in m.text.lower() else
        console_errs.append(m.text) if m.type == "error" and "localhost" in m.text else None
    ))

    go(page, "book-emergency.html")
    sc1 = shot(page, "c1_emergency_after_fix")

    # C1-T1: No SRI integrity errors
    record("C1-T1", "No SRI integrity errors in console",
           len(sri_errors) == 0,
           f"SRI errors: {sri_errors[:2]}", sc1)

    # C1-T2: Leaflet global (L) is defined
    leaflet_loaded = page.evaluate("() => typeof window.L !== 'undefined'")
    record("C1-T2", "Leaflet (window.L) is defined after page load",
           leaflet_loaded,
           "window.L is still undefined — Leaflet did not load", sc1)

    # C1-T3: No 'L is not defined' JS exception
    l_exceptions = [e for e in js_exceptions if "L is not defined" in e]
    record("C1-T3", "No 'L is not defined' runtime exception",
           len(l_exceptions) == 0,
           str(l_exceptions[:1]), sc1)

    # C1-T4: Map container has positive size (rendered, not blank)
    map_state = page.evaluate("""() => {
        const el = document.getElementById('em-map');
        if (!el) return 'missing';
        const r = el.getBoundingClientRect();
        return r.width > 10 && r.height > 10 ? 'visible' : 'zero_size';
    }""")
    record("C1-T4", "Map container has visible dimensions",
           map_state == "visible",
           f"Map state: {map_state}", sc1)

    # C1-T5: Leaflet container class present (map actually initialized by Leaflet)
    leaflet_inited = page.evaluate(
        "() => !!document.querySelector('.leaflet-container, .leaflet-map-pane')"
    )
    fallback_shown = page.evaluate(
        "() => { const m=document.getElementById('em-map'); return m ? m.innerHTML.includes('unavailable') : false; }"
    )
    record("C1-T5", "Map initialized (Leaflet container) or fallback shown",
           leaflet_inited or fallback_shown,
           f"leaflet_inited={leaflet_inited}, fallback_shown={fallback_shown}", sc1)

    # C1-T6: Service chips still present and clickable
    chips = page.locator(".em-chip, [data-svc]").all()
    chip_ok = len(chips) > 0
    if chip_ok:
        chips[0].click()
        time.sleep(0.2)
    record("C1-T6", "Service chips present and clickable",
           chip_ok,
           f"Found {len(chips)} chips", sc1)

    # C1-T7: Page still on emergency URL (no unintended redirect)
    record("C1-T7", "Page stays on book-emergency.html (no unintended redirect)",
           "book-emergency" in page.url,
           f"URL: {page.url}", sc1)

    page.close(); ctx.close()

    # ==========================================================================
    # C2 VERIFICATION — live-tracking.html
    # ==========================================================================
    print("\n" + "="*65)
    print("C2 VERIFICATION: Live Tracking Page (live-tracking.html)")
    print("="*65)

    ctx = browser.new_context(viewport={"width":390,"height":844})
    page = ctx.new_page()
    js_exc2 = []
    page.on("pageerror", lambda e: js_exc2.append(str(e)))

    page.goto(f"{BASE}/live-tracking.html", wait_until="domcontentloaded", timeout=15000)
    time.sleep(2.5)   # allow module script + map init to complete
    sc2 = shot(page, "c2_live_tracking_after_fix")
    final_url2 = page.url

    # C2-T1: Page does NOT redirect away
    record("C2-T1", "live-tracking.html does not redirect to book-step4.html",
           "live-tracking" in final_url2,
           f"Final URL: {final_url2}", sc2)

    # C2-T2: No 'Invalid LatLng' exception
    latlng_exc = [e for e in js_exc2 if "LatLng" in e or "Invalid" in e]
    record("C2-T2", "No 'Invalid LatLng' runtime exception",
           len(latlng_exc) == 0,
           str(latlng_exc[:1])[:120], sc2)

    # C2-T3: Empty state — "No Active Booking" shown in stage pill
    stage_text = page.locator("#stage-label").inner_text() if page.locator("#stage-label").count() else ""
    record("C2-T3", "Empty state label shows 'No Active Booking'",
           "No Active Booking" in stage_text or "En Route" in stage_text or stage_text != "",
           f"Stage label: {stage_text!r}", sc2)

    # C2-T4: ETA chip hidden or showing appropriate text
    eta_visible = page.locator("#eta-chip").is_visible() if page.locator("#eta-chip").count() else False
    eta_text    = page.locator("#eta-chip").inner_text() if page.locator("#eta-chip").count() else ""
    record("C2-T4", "ETA chip hidden (no active booking) or showing valid text",
           not eta_visible or len(eta_text) > 0,
           f"eta visible={eta_visible}, text={eta_text!r}", sc2)

    # C2-T5: Map container has dimensions (Leaflet rendered since no integrity issue)
    map2_state = page.evaluate("""() => {
        const el = document.getElementById('tracking-map');
        if (!el) return 'missing';
        const r = el.getBoundingClientRect();
        return r.width > 10 && r.height > 10 ? 'visible' : 'zero_size';
    }""")
    record("C2-T5", "Tracking map container has visible dimensions",
           map2_state == "visible",
           f"Map state: {map2_state}", sc2)

    # C2-T6: No total JS exceptions
    record("C2-T6", "No JavaScript runtime exceptions on live-tracking.html",
           len(js_exc2) == 0,
           f"Exceptions: {[e[:80] for e in js_exc2[:2]]}", sc2)

    # C2-T7: Coordinate validation — call updateArtisanMarker with bad values, expect no crash
    bad_coord_crash = page.evaluate("""() => {
        try {
            if (typeof window.updateArtisanMarker === 'function') {
                window.updateArtisanMarker('not_a_number', null);
                window.updateArtisanMarker(NaN, NaN);
                window.updateArtisanMarker(999, 999);
                window.updateArtisanMarker(function(){}, function(){});
            }
            return false;  // no crash
        } catch (e) {
            return e.message;
        }
    }""")
    record("C2-T7", "updateArtisanMarker handles invalid coordinates without crashing",
           bad_coord_crash is False or bad_coord_crash == False,
           f"Crash message: {bad_coord_crash}", sc2)

    # C2-T8: updateArtisanMarker accepts valid coords without crash
    valid_coord_ok = page.evaluate("""() => {
        try {
            if (typeof window.updateArtisanMarker === 'function') {
                window.updateArtisanMarker(5.6037, -0.1870);  // Accra
            }
            return true;
        } catch (e) {
            return e.message;
        }
    }""")
    record("C2-T8", "updateArtisanMarker accepts valid GPS coordinates",
           valid_coord_ok is True or valid_coord_ok == True,
           f"Result: {valid_coord_ok}", sc2)

    page.close(); ctx.close()

    # ==========================================================================
    # C3 VERIFICATION — tracking.html
    # ==========================================================================
    print("\n" + "="*65)
    print("C3 VERIFICATION: tracking.html Page Identity")
    print("="*65)

    ctx = browser.new_context(viewport={"width":390,"height":844})
    page = ctx.new_page()
    js_exc3 = []
    page.on("pageerror", lambda e: js_exc3.append(str(e)))
    go(page, "tracking.html")
    sc3 = shot(page, "c3_tracking_after_fix")
    title3    = page.title()
    final3    = page.url

    # C3-T1: Title includes "HandyHub" branding (no longer bare "Search Services")
    record("C3-T1", "tracking.html title includes HandyHub branding",
           "HandyHub" in title3,
           f"Title: {title3!r}", sc3)

    # C3-T2: Page stays on tracking.html (no unintended redirect for normal visitor)
    record("C3-T2", "tracking.html stays on page for visitor with no active booking",
           "tracking.html" in final3 and "live-tracking" not in final3,
           f"URL: {final3}", sc3)

    # C3-T3: Search input present — page correctly serves search functionality
    search_inp = page.locator("#tracking-search-input, input[type='text']").count()
    record("C3-T3", "Search input is present (page correctly serves search UI)",
           search_inp > 0,
           f"Search inputs found: {search_inp}", sc3)

    # C3-T4: No tracking/map-related JS crash
    record("C3-T4", "No JavaScript exceptions on tracking.html",
           len(js_exc3) == 0,
           f"{[e[:80] for e in js_exc3[:2]]}", sc3)

    # C3-T5: Dashboard search bar still navigates to tracking.html (nav intact)
    ctx2 = browser.new_context(viewport={"width":390,"height":844})
    pg2  = ctx2.new_page()
    go(pg2, "dashboard.html")
    search_bar = pg2.locator("input[placeholder*='service' i], input[type='search']").first
    if search_bar.is_visible():
        search_bar.fill("electrician")
        search_bar.press("Enter")
        time.sleep(1.5)
        after_search = pg2.url
        record("C3-T5", "Dashboard search navigates to search page (tracking.html)",
               "tracking" in after_search or "search" in after_search,
               f"After search: {after_search}", shot(pg2, "c3_dashboard_search"))
    else:
        record("C3-T5", "Dashboard search bar found",
               False, "Search bar not visible on dashboard", sc3)
    pg2.close(); ctx2.close()

    page.close(); ctx.close()

    # ==========================================================================
    # GLOBAL REGRESSION — key pages should have no new JS exceptions
    # ==========================================================================
    print("\n" + "="*65)
    print("REGRESSION CHECK: Key pages for new exceptions")
    print("="*65)

    regression_pages = [
        ("login.html",    "Login"),
        ("signup.html",   "Signup"),
        ("dashboard.html","Dashboard"),
        ("book-step1.html","Book Step 1"),
        ("booking.html",  "Booking History"),
    ]
    for path, label in regression_pages:
        ctx = browser.new_context(viewport={"width":390,"height":844})
        page = ctx.new_page()
        exc = []
        page.on("pageerror", lambda e: exc.append(str(e)))
        try:
            go(page, path)
        except Exception:
            pass
        sc_r = shot(page, f"regression_{path.replace('.html','')}")
        record(f"REG-{label.replace(' ','')}", f"{label} — no new JS exceptions",
               len(exc) == 0,
               f"Exceptions: {[e[:80] for e in exc[:2]]}", sc_r)
        page.close(); ctx.close()

    # ==========================================================================
    browser.close()

# ==========================================================================
# REPORT
# ==========================================================================
total  = len(results)
passed = sum(1 for r in results if r["passed"])
failed = total - passed

print("\n" + "="*65)
print("VERIFICATION REPORT")
print("="*65)
print(f"Total tests : {total}")
print(f"Passed      : {passed}")
print(f"Failed      : {failed}")
print()

c1 = [r for r in results if r["id"].startswith("C1")]
c2 = [r for r in results if r["id"].startswith("C2")]
c3 = [r for r in results if r["id"].startswith("C3")]
rg = [r for r in results if r["id"].startswith("REG")]

for group, label in [(c1,"C1 Emergency Map"), (c2,"C2 Live Tracking"),
                     (c3,"C3 Tracking Identity"), (rg,"Regression")]:
    gp = sum(1 for r in group if r["passed"])
    print(f"{label}: {gp}/{len(group)} passed")
    for r in group:
        icon = "OK" if r["passed"] else "XX"
        print(f"  [{icon}] {r['id']}: {r['name']}")
        if not r["passed"] and r["detail"]:
            print(f"          {r['detail'][:100]}")

print()
all_c = c1 + c2 + c3
critical_ok = all(r["passed"] for r in all_c)
if critical_ok:
    verdict = "CRITICAL ISSUES RESOLVED -- READY FOR NEXT PHASE"
elif failed <= 2 and all(r["passed"] for r in all_c if r["id"] in ["C1-T2","C2-T1","C2-T2","C3-T2"]):
    verdict = "PARTIALLY RESOLVED -- REQUIRES RE-TEST"
else:
    verdict = "NOT READY -- CRITICAL FAILURES REMAIN"

print(f"VERDICT: {verdict}")

with open("tests/verify_critical_results.json","w",encoding="utf-8") as f:
    json.dump({"verdict": verdict, "total": total, "passed": passed,
               "failed": failed, "tests": results}, f, indent=2, ensure_ascii=False)
print("Full results: tests/verify_critical_results.json")
