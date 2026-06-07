# Phase 3: Targeted checks from project-root server (shared/ assets resolve correctly)
# encoding: utf-8

import os, time, json
from playwright.sync_api import sync_playwright

BASE  = "http://localhost:8766/customer-app"
SHOTS = "tests/screenshots/audit"
os.makedirs(SHOTS, exist_ok=True)

findings = []

def defect(sev, page, issue, detail, fix):
    findings.append({"severity": sev, "page": page, "issue": issue,
                      "detail": detail, "fix": fix})
    icons = {"CRITICAL":"[CRIT]","HIGH":"[HIGH]","MEDIUM":"[MED]","LOW":"[LOW]"}
    print(f"  {icons.get(sev,'[?]')} {issue}")
    print(f"        {detail[:120]}")

def shot(pg, name):
    p = f"{SHOTS}/{name}.png"
    pg.screenshot(path=p, full_page=True)
    return p

def go(pg, path, wait="domcontentloaded"):
    pg.goto(f"{BASE}/{path}", wait_until=wait, timeout=15000)
    time.sleep(1.5)

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)

    # ── TEST A: Verify shared assets resolve from project root ────────────────
    print("\n" + "="*70)
    print("TEST A: Shared asset resolution (served from project root)")
    print("="*70)

    ctx = browser.new_context(viewport={"width":390,"height":844})
    page = ctx.new_page()
    local_404s = []
    page.on("requestfailed", lambda r: local_404s.append(r.url) if "localhost:8766" in r.url else None)
    page.on("console", lambda m: local_404s.append(m.text[:120])
            if m.type == "error" and "localhost:8766" in m.text else None)
    go(page, "dashboard.html")
    shot(page, "dashboard_from_root")
    imgs = page.locator("img").all()
    broken = sum(1 for img in imgs if (lambda h: h)
                 (page.evaluate("el=>el.naturalWidth", img.element_handle())) == 0)
    print(f"  Broken images from project root: {broken}")
    print(f"  Local 404 count: {len(local_404s)}")
    if broken > 0:
        defect("HIGH", "dashboard.html",
               f"{broken} broken images even from project root",
               "Icon files referenced in dashboard do not exist on disk",
               "Check shared/assets/icons/ directory; add missing icon files")
    else:
        print("  [PASS] All images load correctly from project root")
    if local_404s:
        for r in local_404s[:5]:
            print(f"  404: {r[:100]}")
    page.close(); ctx.close()

    # ── TEST B: Check shared/assets/icons directory exists ────────────────────
    print("\n" + "="*70)
    print("TEST B: Icon file existence on disk")
    print("="*70)
    icons_dir = "shared/assets/icons"
    expected_icons = [
        "plummer.png","electricals.png","carpenter.png","cooling.png",
        "welder.png","painter.png","more.png","cleaner.png","chat.png"
    ]
    if os.path.isdir(icons_dir):
        existing = os.listdir(icons_dir)
        print(f"  Icons directory exists with {len(existing)} files")
        for icon in expected_icons:
            if icon not in existing:
                defect("HIGH","dashboard.html",
                       f"Missing icon file: {icon}",
                       f"shared/assets/icons/{icon} does not exist on disk",
                       f"Add the missing icon file or update the reference in dashboard.html")
            else:
                print(f"  [PASS] {icon} exists")
    else:
        defect("HIGH","dashboard.html",
               "shared/assets/icons/ directory missing entirely",
               "The icons directory does not exist — all service category icons will be broken",
               "Create shared/assets/icons/ and add all required icon files")

    # ── TEST C: Dashboard from root - full interaction audit ──────────────────
    print("\n" + "="*70)
    print("TEST C: Dashboard interactions (from project root)")
    print("="*70)
    ctx = browser.new_context(viewport={"width":390,"height":844})
    page = ctx.new_page()
    js_errs = []
    page.on("pageerror", lambda e: js_errs.append(str(e)))
    go(page, "dashboard.html")

    # Bottom nav tabs
    bottom_nav = page.locator("nav, .bottom-nav, [class*='bottom'], [class*='tab-bar']").first
    if bottom_nav.is_visible():
        print("  [PASS] Bottom navigation bar visible")
    else:
        defect("HIGH","dashboard.html","Bottom navigation bar not visible",
               "Nav bar not found — users cannot navigate between main sections",
               "Ensure bottom nav renders; check CSS display and z-index")

    # Popular services - click first service icon
    svc_icons = page.locator("[class*='svc'], [class*='service-icon'], .popular-services button, [class*='popular'] button").all()
    print(f"  Popular service elements: {len(svc_icons)}")
    if svc_icons:
        svc_icons[0].click(); time.sleep(0.8)
        after = page.url
        print(f"  After service click: {after}")
        page.go_back(); time.sleep(0.5)

    # Promo banner Book Now
    book_now_btn = page.locator("button:has-text('Book Now'), a:has-text('Book Now')").first
    if book_now_btn.is_visible():
        book_now_btn.click(); time.sleep(0.8)
        shot(page, "dashboard_book_now_click")
        print(f"  After Book Now: {page.url}")
        page.go_back(); time.sleep(0.5)

    shot(page, "dashboard_root_full")
    if js_errs:
        for e in js_errs:
            defect("HIGH","dashboard.html","JS exception on dashboard",e[:200],"Fix JS error")
    page.close(); ctx.close()

    # ── TEST D: Login form submit-button guard ────────────────────────────────
    print("\n" + "="*70)
    print("TEST D: Login - Submit button guard on empty form")
    print("="*70)
    ctx = browser.new_context(viewport={"width":390,"height":844})
    page = ctx.new_page()
    go(page, "login.html")
    login_btn = page.locator("button:has-text('Login')").first
    disabled = login_btn.is_disabled()
    print(f"  Login button disabled on empty form: {disabled}")
    if not disabled:
        defect("MEDIUM","login.html",
               "Login button not disabled on empty form",
               "User can click Login with no credentials, triggering a Firebase auth error in production",
               "Disable the Login button until both email and password fields have content; "
               "enable via JS input listeners on both fields")
    page.close(); ctx.close()

    # ── TEST E: book-emergency.html - Leaflet SRI hash ───────────────────────
    print("\n" + "="*70)
    print("TEST E: Emergency Booking - Leaflet SRI integrity failure")
    print("="*70)
    ctx = browser.new_context(viewport={"width":390,"height":844})
    page = ctx.new_page()
    js_errs_e = []
    sri_failures = []
    page.on("pageerror", lambda e: js_errs_e.append(str(e)))
    page.on("console",   lambda m: sri_failures.append(m.text[:200])
            if "integrity" in m.text.lower() or "sri" in m.text.lower() else None)
    go(page, "book-emergency.html")
    shot(page, "emergency_root")

    # Map rendered?
    map_rendered = page.evaluate("""() => {
        const el = document.querySelector('#map, .leaflet-container, .em-map');
        if (!el) return 'no_element';
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 ? 'visible' : 'zero_size';
    }""")
    print(f"  Map container state: {map_rendered}")

    leaflet_loaded = page.evaluate("() => typeof window.L !== 'undefined'")
    print(f"  Leaflet (L) loaded: {leaflet_loaded}")

    if not leaflet_loaded:
        defect("CRITICAL","book-emergency.html",
               "Leaflet map library fails to load - SRI integrity mismatch",
               "The <script> tag for leaflet.js has an integrity= hash that does not match the "
               "file served by unpkg.com. Browser blocks it. window.L is undefined. "
               "Map container shows blank white space. Emergency booking is non-functional.",
               "Remove the integrity= attribute from the Leaflet <script> tag, OR "
               "update the hash to match the current unpkg.com file, OR "
               "self-host leaflet.js in shared/js/vendor/leaflet.js")

    if js_errs_e:
        for e in js_errs_e:
            defect("CRITICAL" if "L is not defined" in e else "HIGH",
                   "book-emergency.html","JS exception on emergency page",e[:200],"Fix JS error")

    page.close(); ctx.close()

    # ── TEST F: live-tracking.html redirect audit ─────────────────────────────
    print("\n" + "="*70)
    print("TEST F: Live Tracking - Redirect investigation")
    print("="*70)
    ctx = browser.new_context(viewport={"width":390,"height":844})
    page = ctx.new_page()
    js_errs_f = []
    page.on("pageerror", lambda e: js_errs_f.append(str(e)))
    page.goto(f"{BASE}/live-tracking.html", wait_until="domcontentloaded", timeout=15000)
    time.sleep(2.5)
    final_f = page.url
    shot(page, "live_tracking_root")
    print(f"  Final URL: {final_f}")
    if "live-tracking" not in final_f:
        defect("CRITICAL","live-tracking.html",
               "live-tracking.html unconditionally redirects to book-step4.html",
               f"Customer navigating to /live-tracking.html lands on '{final_f}'. "
               "The booking confirmation page is shown instead of the live map. "
               "Customers cannot track their artisan in real time.",
               "In live-tracking.html: check the redirect guard condition. "
               "Only redirect if localStorage has NO booking state. "
               "If booking state exists (even without artisan coords yet) show the tracking screen "
               "with a 'Waiting for artisan...' state instead of bouncing to book-step4.html")
    for e in js_errs_f:
        if "LatLng" in e:
            defect("CRITICAL","live-tracking.html",
                   "Invalid LatLng crashes map initialization",
                   e[:200],
                   "Wrap subscribeArtisanLocation() in a guard: "
                   "only call L.marker([lat,lng]) when lat and lng are valid finite numbers")
        else:
            defect("HIGH","live-tracking.html","JS exception",e[:200],"Fix JS error")
    page.close(); ctx.close()

    # ── TEST G: tracking.html identity audit ─────────────────────────────────
    print("\n" + "="*70)
    print("TEST G: tracking.html - page identity mismatch")
    print("="*70)
    ctx = browser.new_context(viewport={"width":390,"height":844})
    page = ctx.new_page()
    go(page, "tracking.html")
    title_g = page.title()
    h1_text = page.locator("h1, h2, .page-title").first.inner_text() if page.locator("h1, h2, .page-title").count() > 0 else ""
    print(f"  Title: {title_g!r}")
    print(f"  H1/heading: {h1_text!r}")
    shot(page, "tracking_root")
    if "search" in title_g.lower() or "search" in h1_text.lower():
        defect("HIGH","tracking.html",
               "tracking.html renders search/discovery UI instead of a tracking page",
               f"Title='{title_g}', heading='{h1_text}'. This file appears to be a copy "
               "of the search page or has incorrect content wired in.",
               "Audit what content belongs in tracking.html. If it should show a map-based "
               "tracking view, wire it to the correct JS logic. If it is intentionally a "
               "search page, rename it appropriately and update all links to it.")
    page.close(); ctx.close()

    # ── TEST H: saved.html - Illegal return source location ──────────────────
    print("\n" + "="*70)
    print("TEST H: saved.html - Illegal return statement root cause")
    print("="*70)
    ctx = browser.new_context(viewport={"width":390,"height":844})
    page = ctx.new_page()
    js_errs_h = []
    page.on("pageerror", lambda e: js_errs_h.append(str(e)))
    go(page, "saved.html")
    shot(page, "saved_root")
    for e in js_errs_h:
        defect("HIGH","saved.html",
               "Illegal return statement crashes saved.html on load",
               e[:300],
               "Search saved.html and its imported JS files for a bare 'return' statement "
               "outside any function body. This is a syntax error that prevents "
               "the page's JS from executing at all — saved professionals will not load.")
    if not js_errs_h:
        print("  [PASS] No JS exceptions from project root")
    page.close(); ctx.close()

    # ── TEST I: book-step1 Continue navigates correctly ──────────────────────
    print("\n" + "="*70)
    print("TEST I: Booking flow step 1 -> 2 navigation")
    print("="*70)
    ctx = browser.new_context(viewport={"width":390,"height":844})
    page = ctx.new_page()
    go(page, "book-step1.html")
    svc = page.locator(".service-item").first
    if svc.is_visible():
        svc.click(); time.sleep(0.3)
        cont = page.locator("#bk-continue-btn, button:has-text('Continue')").first
        if cont.is_visible() and not cont.is_disabled():
            cont.click(); time.sleep(1.5)
            after = page.url
            shot(page, "book_step1_to_step2")
            if "step2" in after:
                print("  [PASS] Step 1 -> Step 2 navigation works")
            else:
                defect("HIGH","book-step1.html","Continue does not navigate to step 2",
                       f"URL after continue: {after}","Fix saveAndContinue() navigation")
    page.close(); ctx.close()

    # ── TEST J: Booking step 2 - artisan list state ───────────────────────────
    print("\n" + "="*70)
    print("TEST J: Book Step 2 - Artisan list & empty state")
    print("="*70)
    ctx = browser.new_context(viewport={"width":390,"height":844})
    page = ctx.new_page()
    go(page, "book-step2.html")
    shot(page, "book_step2_root")
    artisan_cards = page.locator("[class*='artisan'], [class*='pro-card'], .professional-card").count()
    skeleton      = page.locator("[class*='skeleton'], [class*='loading'], .shimmer").count()
    empty_state   = page.locator("[class*='empty'], [class*='no-pro']").count()
    print(f"  Artisan cards: {artisan_cards}, Skeletons: {skeleton}, Empty states: {empty_state}")
    if artisan_cards == 0 and skeleton == 0 and empty_state == 0:
        defect("MEDIUM","book-step2.html",
               "No artisan cards, skeletons, or empty state visible without auth",
               "Step 2 shows a blank screen — unclear if loading or error state",
               "Show skeleton loaders while fetching, then an empty state if no artisans found")
    page.close(); ctx.close()

    browser.close()

# Save
with open("tests/audit_phase3_findings.json","w",encoding="utf-8") as f:
    json.dump(findings, f, indent=2, ensure_ascii=False)

print("\n\nPhase 3 complete.")
print(f"Total additional defects: {len(findings)}")
by_sev = {}
for fi in findings:
    by_sev.setdefault(fi["severity"],[]).append(fi)
for sev in ["CRITICAL","HIGH","MEDIUM","LOW"]:
    lst = by_sev.get(sev,[])
    if lst:
        print(f"  {sev}: {len(lst)}")
