# HandyHub Customer App - Phase 2: Deep 404 Analysis + Interactive Testing
# Tests form validation, navigation, buttons, booking flow, modals, settings
# encoding: utf-8

import sys, os, json, time
from playwright.sync_api import sync_playwright, expect

BASE  = "http://localhost:8765"
SHOTS = "tests/screenshots/audit"
os.makedirs(SHOTS, exist_ok=True)

findings = []  # {severity, page, issue, detail, fix}

def defect(severity, page, issue, detail, fix):
    findings.append({"severity": severity, "page": page, "issue": issue,
                      "detail": detail, "fix": fix})
    icon = {"CRITICAL":"[CRIT]","HIGH":"[HIGH]","MEDIUM":"[MED]","LOW":"[LOW]"}.get(severity,"[?]")
    print(f"  {icon} {issue}: {detail[:100]}")

def shot(page_obj, name):
    path = f"{SHOTS}/{name}.png"
    page_obj.screenshot(path=path, full_page=True)
    return path

def nav(page_obj, path, wait="networkidle", timeout=12000):
    url = f"{BASE}/{path}"
    page_obj.goto(url, wait_until="domcontentloaded", timeout=timeout)
    time.sleep(1.2)
    return page_obj

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)

    # =========================================================================
    # TEST 1: Detailed 404 resource scan on key pages
    # =========================================================================
    print("\n" + "="*70)
    print("TEST 1: Detailed 404 Resource Analysis")
    print("="*70)

    for page_path, label in [
        ("splash-screen.html", "Splash"),
        ("dashboard.html",     "Dashboard"),
        ("login.html",         "Login"),
        ("book-emergency.html","Emergency"),
        ("tracking.html",      "Tracking"),
    ]:
        ctx = browser.new_context(viewport={"width":390,"height":844})
        page = ctx.new_page()
        missing = []
        page.on("requestfailed", lambda r: missing.append(r.url) if "localhost:8765" in r.url else None)

        def on_console_404(msg, m=missing, path=page_path):
            if "404" in msg.text or "Failed to load" in msg.text:
                m.append(msg.text[:200])

        page.on("console", on_console_404)
        page.goto(f"{BASE}/{page_path}", wait_until="domcontentloaded", timeout=12000)
        time.sleep(1)

        local_404s = [u for u in missing if "localhost:8765" in str(u)]
        if local_404s:
            for u in local_404s[:5]:
                resource = u.replace(f"http://localhost:8765/","")
                defect("HIGH", page_path, "Missing local resource (404)",
                       resource,
                       f"Ensure file exists at customer-app/{resource}")
            print(f"  {label}: {len(local_404s)} local 404s found")
        else:
            print(f"  {label}: No local 404s")
        page.close()
        ctx.close()

    # =========================================================================
    # TEST 2: Login page - form validation & UI interactions
    # =========================================================================
    print("\n" + "="*70)
    print("TEST 2: Login Page - Form Validation & Interactions")
    print("="*70)

    ctx = browser.new_context(viewport={"width":390,"height":844})
    page = ctx.new_page()
    js_errs = []
    page.on("pageerror", lambda e: js_errs.append(str(e)))
    nav(page, "login.html")

    # 2a: Submit button state with empty form
    submit_btns = page.locator("button[type='submit'], button:has-text('Login'), button:has-text('Sign In')").all()
    print(f"  Found {len(submit_btns)} submit-style buttons")
    if submit_btns:
        btn = submit_btns[0]
        is_disabled = btn.get_attribute("disabled") is not None or btn.is_disabled()
        if not is_disabled:
            defect("MEDIUM", "login.html", "Submit button not disabled on empty form",
                   "Login button is clickable with no credentials entered",
                   "Disable submit until email+password are filled and valid")
        else:
            print("  [PASS] Login button correctly disabled on empty form")

    # 2b: Fill invalid email
    email_inp = page.locator("input[type='email'], input[placeholder*='email' i], input[placeholder*='phone' i]").first
    pw_inp    = page.locator("input[type='password']").first

    if email_inp.is_visible():
        email_inp.fill("notanemail")
        pw_inp.fill("short")
        time.sleep(0.5)
        shot(page, "login_invalid_input")
        print("  [INFO] Filled invalid email + short password")

    # 2c: Fill valid-format credentials and attempt submit
    email_inp.fill("test@example.com")
    pw_inp.fill("password123")
    time.sleep(0.3)
    shot(page, "login_filled")

    btns = page.locator("button:has-text('Login'), button[type='submit']").all()
    if btns and not btns[0].is_disabled():
        btns[0].click()
        time.sleep(2)
        final = page.url
        shot(page, "login_after_submit")
        print(f"  [INFO] After submit: URL={final}")
        if "dashboard" in final:
            print("  [PASS] Login navigated to dashboard (would need real creds in prod)")
        else:
            print("  [INFO] Login stayed on login page (expected with test creds)")

    # 2d: Check Google/Social login buttons
    google_btn = page.locator("button:has-text('Google'), [class*='google']").count()
    fb_btn     = page.locator("button:has-text('Facebook'), [class*='facebook']").count()
    apple_btn  = page.locator("button:has-text('Apple'), [class*='apple']").count()
    print(f"  Social buttons - Google:{google_btn} Facebook:{fb_btn} Apple:{apple_btn}")

    # 2e: Forgot password link
    forgot = page.locator("a:has-text('Forgot'), button:has-text('Forgot')").count()
    if forgot == 0:
        defect("MEDIUM", "login.html", "No Forgot Password link found",
               "Users with forgotten passwords have no recovery path visible",
               "Add a Forgot Password link/button to login page")
    else:
        print(f"  [PASS] Forgot Password element present ({forgot} found)")

    # 2f: Sign up link
    signup_link = page.locator("a:has-text('Sign up'), a:has-text('Register'), a[href*='signup']").count()
    if signup_link == 0:
        defect("MEDIUM", "login.html", "No Sign Up link from login page",
               "New users cannot find the registration path from login",
               "Add a Sign Up link on the login page")
    else:
        print(f"  [PASS] Sign Up link present")

    if js_errs:
        for e in js_errs:
            defect("HIGH", "login.html", "JavaScript exception on login page", e,
                   "Fix the JS error to prevent silent login failures")

    page.close(); ctx.close()

    # =========================================================================
    # TEST 3: Signup page - form validation
    # =========================================================================
    print("\n" + "="*70)
    print("TEST 3: Signup Page - Form Validation")
    print("="*70)

    ctx = browser.new_context(viewport={"width":390,"height":844})
    page = ctx.new_page()
    nav(page, "signup.html")
    shot(page, "signup_initial")

    # Count all inputs
    inputs = page.locator("input").all()
    print(f"  Found {len(inputs)} input fields")

    # Terms checkbox
    terms = page.locator("input[type='checkbox']").count()
    print(f"  Terms checkbox present: {terms > 0}")

    # Submit button with empty form
    sub = page.locator("button[type='submit'], button:has-text('Create'), button:has-text('Sign Up')").first
    if sub.count() > 0:
        disabled = sub.is_disabled()
        print(f"  Submit disabled on empty form: {disabled}")
        if not disabled:
            defect("MEDIUM", "signup.html", "Signup button active on empty form",
                   "Submit is not disabled before filling required fields",
                   "Add validation to disable submit until all required fields are completed")

    # Fill form
    name_inp = page.locator("input[placeholder*='name' i], input[placeholder*='Name']").first
    if name_inp.is_visible():
        name_inp.fill("Test Customer")
    email_inp2 = page.locator("input[type='email']").first
    if email_inp2.is_visible():
        email_inp2.fill("testcustomer@example.com")
    pw_inps = page.locator("input[type='password']").all()
    for pw in pw_inps:
        if pw.is_visible():
            pw.fill("TestPass123!")
    time.sleep(0.3)
    shot(page, "signup_filled")
    print("  [INFO] Signup form filled with test data")

    page.close(); ctx.close()

    # =========================================================================
    # TEST 4: Dashboard - button interactions, navigation, search
    # =========================================================================
    print("\n" + "="*70)
    print("TEST 4: Dashboard - Interactions & Navigation")
    print("="*70)

    ctx = browser.new_context(viewport={"width":390,"height":844})
    page = ctx.new_page()
    js_errs4 = []
    page.on("pageerror", lambda e: js_errs4.append(str(e)))
    nav(page, "dashboard.html")
    shot(page, "dashboard_initial")

    # Search bar
    search = page.locator("input[type='search'], input[placeholder*='search' i], input[placeholder*='service' i]").first
    if search.is_visible():
        search.fill("plumber")
        time.sleep(0.5)
        shot(page, "dashboard_search_plumber")
        print("  [PASS] Search bar accepts input")
        search.fill("")
    else:
        defect("HIGH", "dashboard.html", "Search bar not found or not visible",
               "Primary search input is missing from dashboard",
               "Ensure search input renders on page load")

    # Test Popular Service cards (should navigate to booking)
    service_cards = page.locator("[class*='service'], [class*='Service'], .svc-card, .service-card").all()
    print(f"  Found {len(service_cards)} service card elements")

    # Test nav bar links
    nav_links = page.locator("nav a, .bottom-nav a, .tab-bar a, [class*='nav'] a").all()
    print(f"  Found {len(nav_links)} nav links")
    for i, link in enumerate(nav_links[:5]):
        href = link.get_attribute("href") or ""
        txt  = link.inner_text().strip()
        print(f"    Nav[{i}]: '{txt}' -> {href}")

    # Test notification bell
    bell = page.locator("[class*='bell'], [class*='notif'], button[aria-label*='notif' i]").first
    if bell.is_visible():
        bell.click()
        time.sleep(0.8)
        shot(page, "dashboard_bell_click")
        print("  [INFO] Bell clicked")
        page.go_back()
        time.sleep(0.5)
    else:
        defect("LOW", "dashboard.html", "Notification bell not detectable",
               "Could not find or click notification bell button",
               "Ensure bell button has a recognizable class or aria-label")

    # Check for broken images
    imgs = page.locator("img").all()
    broken = 0
    for img in imgs:
        try:
            w = page.evaluate("el => el.naturalWidth", img.element_handle())
            if w == 0:
                src = img.get_attribute("src") or "no-src"
                broken += 1
                defect("MEDIUM", "dashboard.html", f"Broken image on dashboard",
                       f"Image src: {src[:80]}",
                       "Fix image path or provide fallback/placeholder")
        except Exception:
            pass
    print(f"  Broken images: {broken}")

    if js_errs4:
        for e in js_errs4:
            defect("HIGH", "dashboard.html", "JS exception on dashboard", str(e)[:200],
                   "Fix JS error — may break dashboard functionality silently")

    page.close(); ctx.close()

    # =========================================================================
    # TEST 5: Book Step 1 - category selection, service selection, continue
    # =========================================================================
    print("\n" + "="*70)
    print("TEST 5: Book Step 1 - Service Selection Flow")
    print("="*70)

    ctx = browser.new_context(viewport={"width":390,"height":844})
    page = ctx.new_page()
    nav(page, "book-step1.html")
    shot(page, "book_step1_initial")

    # Category buttons
    cat_btns = page.locator("button[data-cat], .cat-icon-btn, [class*='cat-btn']").all()
    print(f"  Category buttons found: {len(cat_btns)}")
    if cat_btns:
        cat_btns[0].click()
        time.sleep(0.5)
        shot(page, "book_step1_cat_selected")
        print(f"  [PASS] Category button clickable")
    else:
        defect("HIGH", "book-step1.html", "No category buttons found",
               "Service category buttons not rendered or not selectable",
               "Check that category buttons render with correct data-cat attributes")

    # Service items
    svc_items = page.locator(".service-item, [onclick*='toggleService']").all()
    print(f"  Service items found: {len(svc_items)}")
    if svc_items:
        svc_items[0].click()
        time.sleep(0.3)
        shot(page, "book_step1_service_selected")
        print("  [PASS] Service item clickable")

        # Continue button
        continue_btn = page.locator("button:has-text('Continue'), button:has-text('Next'), #bk-continue-btn").first
        if continue_btn.is_visible() and not continue_btn.is_disabled():
            continue_btn.click()
            time.sleep(1.5)
            final = page.url
            shot(page, "book_step1_after_continue")
            if "step2" in final or "book-step2" in final:
                print("  [PASS] Continue navigates to Step 2")
            else:
                defect("HIGH", "book-step1.html", "Continue button does not advance to Step 2",
                       f"URL after continue: {final}",
                       "Fix saveAndContinue() navigation to book-step2.html")
        else:
            defect("HIGH", "book-step1.html", "Continue button not clickable after service selected",
                   "Continue button is disabled or hidden after selecting a service",
                   "Ensure Continue button becomes enabled once a service is selected")
    else:
        defect("CRITICAL", "book-step1.html", "No service items rendered",
               "SVC_CATALOG is not rendering service items in the list",
               "Check renderServices() function and SVC_CATALOG data")

    page.close(); ctx.close()

    # =========================================================================
    # TEST 6: Book Step 3 - date/time picker
    # =========================================================================
    print("\n" + "="*70)
    print("TEST 6: Book Step 3 - Date & Time Picker")
    print("="*70)

    ctx = browser.new_context(viewport={"width":390,"height":844})
    page = ctx.new_page()
    nav(page, "book-step3.html")
    shot(page, "book_step3_initial")

    date_inp = page.locator("input[type='date'], .date-picker, [class*='date']").first
    time_inp = page.locator("input[type='time'], .time-picker, [class*='time']").first
    notes_inp= page.locator("textarea, input[placeholder*='note' i]").first

    if date_inp.is_visible():
        date_inp.fill("2026-07-01")
        print("  [PASS] Date input accepts value")
    else:
        defect("MEDIUM", "book-step3.html", "Date input not visible",
               "Date picker not rendering on step 3",
               "Ensure date input renders correctly")

    if time_inp.is_visible():
        time_inp.fill("10:00")
        print("  [PASS] Time input accepts value")

    if notes_inp.is_visible():
        notes_inp.fill("Please bring your own tools")
        print("  [PASS] Notes textarea accepts input")

    shot(page, "book_step3_filled")
    page.close(); ctx.close()

    # =========================================================================
    # TEST 7: Emergency booking - Leaflet JS exception
    # =========================================================================
    print("\n" + "="*70)
    print("TEST 7: Emergency Booking - Leaflet & Map Issues")
    print("="*70)

    ctx = browser.new_context(viewport={"width":390,"height":844})
    page = ctx.new_page()
    js_errs7 = []
    console_errs7 = []
    page.on("pageerror",  lambda e: js_errs7.append(str(e)))
    page.on("console",    lambda m: console_errs7.append(m.text) if m.type=="error" else None)
    nav(page, "book-emergency.html")
    shot(page, "emergency_initial")

    if js_errs7:
        for e in js_errs7:
            if "L is not defined" in e or "Leaflet" in e:
                defect("CRITICAL", "book-emergency.html",
                       "Leaflet map library not loading (SRI integrity failure)",
                       "Subresource Integrity check fails for leaflet.js from unpkg.com — " +
                       "L global is undefined, map cannot initialize",
                       "Remove or update the integrity= hash on the Leaflet <script> tag, or self-host Leaflet")
            else:
                defect("HIGH", "book-emergency.html", "JS exception on emergency page",
                       e[:200], "Fix JS error before launch")

    # Check service chips
    chips = page.locator(".em-chip, [data-svc]").all()
    print(f"  Service chips found: {len(chips)}")
    if chips:
        chips[0].click()
        time.sleep(0.3)
        shot(page, "emergency_chip_selected")
        print(f"  [PASS] Service chip clickable")
    else:
        defect("HIGH", "book-emergency.html", "No service chips found",
               "Emergency service selection chips not rendering",
               "Check em-chip elements render on page load")

    # Map container
    map_el = page.locator("#map, [class*='leaflet'], .em-map").first
    if map_el.is_visible():
        print("  [INFO] Map container is visible")
    else:
        defect("CRITICAL", "book-emergency.html", "Map container not visible",
               "The map area is not rendering on the emergency booking screen",
               "Fix Leaflet initialization after resolving the integrity check failure")

    page.close(); ctx.close()

    # =========================================================================
    # TEST 8: live-tracking.html - unexpected redirect
    # =========================================================================
    print("\n" + "="*70)
    print("TEST 8: Live Tracking - Redirect & LatLng Exception")
    print("="*70)

    ctx = browser.new_context(viewport={"width":390,"height":844})
    page = ctx.new_page()
    js_errs8 = []
    page.on("pageerror", lambda e: js_errs8.append(str(e)))
    page.goto(f"{BASE}/live-tracking.html", wait_until="domcontentloaded", timeout=12000)
    time.sleep(2)
    final8 = page.url
    shot(page, "live_tracking_landing")

    if "live-tracking" not in final8:
        defect("CRITICAL", "live-tracking.html",
               "Live tracking page redirects away unexpectedly",
               f"Redirected to: {final8} — customer loses their tracking screen",
               "Audit the redirect logic; only redirect if booking state is missing, " +
               "and show a clear 'No active booking' state instead of silently redirecting")

    for e in js_errs8:
        if "LatLng" in e or "Invalid" in e:
            defect("CRITICAL", "live-tracking.html",
                   "Invalid LatLng — map crashes on load",
                   e[:200],
                   "Guard the subscribeArtisanLocation() call: only init map when " +
                   "artisan lat/lng are valid numbers, not functions or null values")
        else:
            defect("HIGH", "live-tracking.html", "JS exception on live tracking", e[:200], "Fix JS error")

    page.close(); ctx.close()

    # =========================================================================
    # TEST 9: tracking.html - wrong page title
    # =========================================================================
    print("\n" + "="*70)
    print("TEST 9: tracking.html - Title & Content Audit")
    print("="*70)

    ctx = browser.new_context(viewport={"width":390,"height":844})
    page = ctx.new_page()
    nav(page, "tracking.html")
    title9 = page.title()
    shot(page, "tracking_page")
    print(f"  Page title: {title9!r}")
    if "search" in title9.lower() or "Search" in title9:
        defect("MEDIUM", "tracking.html",
               "Wrong page title on tracking.html",
               f"Title is '{title9}' — should be something like 'Track Your Booking'",
               "Update the <title> tag in tracking.html to the correct title")
    page.close(); ctx.close()

    # =========================================================================
    # TEST 10: saved.html - Illegal return statement exception
    # =========================================================================
    print("\n" + "="*70)
    print("TEST 10: saved.html - JS Exception Audit")
    print("="*70)

    ctx = browser.new_context(viewport={"width":390,"height":844})
    page = ctx.new_page()
    js_errs10 = []
    page.on("pageerror", lambda e: js_errs10.append(str(e)))
    nav(page, "saved.html")
    shot(page, "saved_page")
    for e in js_errs10:
        if "return" in e.lower() or "Illegal" in e:
            defect("HIGH", "saved.html",
                   "Illegal return statement JS exception",
                   e[:200],
                   "Find and remove a bare 'return' statement outside a function in saved.html scripts")
        else:
            defect("HIGH", "saved.html", "JS exception on saved page", e[:200], "Fix JS error")
    if not js_errs10:
        print("  [PASS] No JS exceptions on saved.html")
    page.close(); ctx.close()

    # =========================================================================
    # TEST 11: Review page - star rating interaction
    # =========================================================================
    print("\n" + "="*70)
    print("TEST 11: Review Page - Star Rating Interaction")
    print("="*70)

    ctx = browser.new_context(viewport={"width":390,"height":844})
    page = ctx.new_page()
    nav(page, "review.html")
    shot(page, "review_initial")

    stars = page.locator(".star, [class*='star'], [data-rating], [class*='rating'] button").all()
    print(f"  Star elements found: {len(stars)}")
    if stars:
        stars[-1].click()  # Click 5th star
        time.sleep(0.3)
        shot(page, "review_5stars")
        print("  [PASS] Star rating clickable")
    else:
        defect("HIGH", "review.html", "Star rating elements not found or not clickable",
               "No clickable star elements detected on review page",
               "Ensure star rating buttons have identifiable classes/data attributes")

    # Submit review
    submit_review = page.locator("button:has-text('Submit'), button:has-text('Rate')").first
    if submit_review.is_visible():
        print("  [PASS] Review submit button visible")
    else:
        defect("MEDIUM", "review.html", "Review submit button not visible",
               "Submit/Rate button not found on review page",
               "Ensure submit button is rendered and visible")

    page.close(); ctx.close()

    # =========================================================================
    # TEST 12: Settings hub - all navigation links
    # =========================================================================
    print("\n" + "="*70)
    print("TEST 12: Settings Hub - Navigation Links")
    print("="*70)

    ctx = browser.new_context(viewport={"width":390,"height":844})
    page = ctx.new_page()
    nav(page, "settings.html")
    shot(page, "settings_hub")

    btns = page.locator("button, a[href]").all()
    print(f"  Settings items found: {len(btns)}")
    for btn in btns:
        try:
            href = btn.get_attribute("href") or ""
            txt  = (btn.inner_text() or "").strip()
            if href and href not in ["#", "javascript:void(0)", ""]:
                # Try to navigate to each settings link
                target = href.replace("./","").replace("../","")
                if target.endswith(".html"):
                    resp = browser.new_page()
                    resp.goto(f"{BASE}/{target}", wait_until="domcontentloaded", timeout=8000)
                    st = resp.title()
                    if not st or st.lower() in ["", "undefined"]:
                        defect("MEDIUM", "settings.html",
                               f"Settings link '{txt}' leads to page with no title",
                               f"href={href}",
                               f"Add a proper <title> to {target}")
                    resp.close()
        except Exception:
            pass

    # Dark mode toggle
    dark_toggle = page.locator("[class*='theme'], [class*='dark'], input[type='checkbox']").first
    if dark_toggle.is_visible():
        dark_toggle.click()
        time.sleep(0.3)
        shot(page, "settings_dark_mode")
        print("  [PASS] Dark mode toggle interactable")

    page.close(); ctx.close()

    # =========================================================================
    # TEST 13: Topup page - amount input & button states
    # =========================================================================
    print("\n" + "="*70)
    print("TEST 13: Topup Page - Amount Inputs & Buttons")
    print("="*70)

    ctx = browser.new_context(viewport={"width":390,"height":844})
    page = ctx.new_page()
    nav(page, "topup.html")
    shot(page, "topup_initial")

    # Preset amount buttons
    presets = page.locator("button:has-text('50'), button:has-text('100'), button:has-text('200'), [class*='preset'], [class*='amount-btn']").all()
    print(f"  Preset amount buttons: {len(presets)}")
    if presets:
        presets[0].click()
        time.sleep(0.3)
        shot(page, "topup_preset_selected")
        print("  [PASS] Preset amount button clickable")

    # Custom amount input
    amount_inp = page.locator("input[type='number'], input[placeholder*='amount' i], input[placeholder*='GH' i]").first
    if amount_inp.is_visible():
        amount_inp.fill("150")
        time.sleep(0.2)
        shot(page, "topup_custom_amount")
        print("  [PASS] Custom amount input works")
    else:
        defect("MEDIUM", "topup.html", "Amount input not found or visible",
               "Custom amount input not detectable on top-up page",
               "Ensure amount input has visible state and correct type")

    # Proceed button
    proceed_btn = page.locator("button:has-text('Top Up'), button:has-text('Proceed'), button:has-text('Pay')").first
    if proceed_btn.is_visible():
        print("  [PASS] Proceed/Pay button visible")
    else:
        defect("HIGH", "topup.html", "Proceed button not visible",
               "Payment initiation button not found on top-up page",
               "Ensure Proceed button renders and is visible to user")

    page.close(); ctx.close()

    # =========================================================================
    # TEST 14: Messages page - search & compose
    # =========================================================================
    print("\n" + "="*70)
    print("TEST 14: Messages Page - Search & UI")
    print("="*70)

    ctx = browser.new_context(viewport={"width":390,"height":844})
    page = ctx.new_page()
    nav(page, "messages.html")
    shot(page, "messages_initial")

    msg_search = page.locator("input[type='search'], input[placeholder*='search' i], input[placeholder*='message' i]").first
    if msg_search.is_visible():
        msg_search.fill("John")
        time.sleep(0.3)
        shot(page, "messages_search")
        print("  [PASS] Message search input works")
    else:
        defect("LOW", "messages.html", "Message search input not visible",
               "Search for conversations input not rendering",
               "Ensure search input is rendered in messages list header")

    empty_state = page.locator("[class*='empty'], [class*='no-message'], [class*='no-chat']").count()
    print(f"  Empty state elements: {empty_state}")
    page.close(); ctx.close()

    # =========================================================================
    # TEST 15: Transaction history - filter tabs
    # =========================================================================
    print("\n" + "="*70)
    print("TEST 15: Transaction History - Filter Tabs")
    print("="*70)

    ctx = browser.new_context(viewport={"width":390,"height":844})
    page = ctx.new_page()
    nav(page, "transaction-history.html")
    shot(page, "txn_history_initial")

    tabs = page.locator(".tab, [class*='filter-tab'], [class*='tab-btn'], button:has-text('All'), button:has-text('Credit'), button:has-text('Debit')").all()
    print(f"  Filter tabs found: {len(tabs)}")
    for i, tab in enumerate(tabs[:4]):
        try:
            tab.click()
            time.sleep(0.3)
            txt = tab.inner_text().strip()
            print(f"  [PASS] Tab '{txt}' clickable")
        except Exception as ex:
            defect("MEDIUM", "transaction-history.html", f"Filter tab {i} not clickable",
                   str(ex)[:100], "Fix tab click handler")

    shot(page, "txn_history_tabs")
    page.close(); ctx.close()

    # =========================================================================
    # TEST 16: Profile page - edit button & avatar
    # =========================================================================
    print("\n" + "="*70)
    print("TEST 16: Profile Page - Edit & Avatar")
    print("="*70)

    ctx = browser.new_context(viewport={"width":390,"height":844})
    page = ctx.new_page()
    nav(page, "profile.html")
    shot(page, "profile_initial")

    edit_btn = page.locator("button:has-text('Edit'), a[href*='personal'], [class*='edit']").first
    if edit_btn.is_visible():
        edit_btn.click()
        time.sleep(1)
        shot(page, "profile_edit_clicked")
        final_p = page.url
        print(f"  [INFO] After edit click: {final_p}")
        if "personal" in final_p or "edit" in final_p:
            print("  [PASS] Edit navigates to personal info page")
    else:
        defect("MEDIUM", "profile.html", "Edit profile button not found",
               "Cannot find Edit button on profile page",
               "Ensure Edit button is visible and has recognizable text/class")

    page.close(); ctx.close()

    # =========================================================================
    # TEST 17: Booking history - tabs & empty state
    # =========================================================================
    print("\n" + "="*70)
    print("TEST 17: Booking History - Tabs & States")
    print("="*70)

    ctx = browser.new_context(viewport={"width":390,"height":844})
    page = ctx.new_page()
    nav(page, "booking.html")
    shot(page, "booking_history_initial")

    tabs = page.locator(".tab, [class*='tab'], button:has-text('Active'), button:has-text('Past'), button:has-text('All')").all()
    print(f"  Booking tabs found: {len(tabs)}")
    for tab in tabs[:3]:
        try:
            tab.click(); time.sleep(0.3)
            txt = tab.inner_text().strip()
            print(f"  [PASS] Booking tab '{txt}' clickable")
        except Exception: pass
    shot(page, "booking_history_tabs")
    page.close(); ctx.close()

    # =========================================================================
    # TEST 18: Search not found - back & retry buttons
    # =========================================================================
    print("\n" + "="*70)
    print("TEST 18: Search Not Found - Recovery Actions")
    print("="*70)

    ctx = browser.new_context(viewport={"width":390,"height":844})
    page = ctx.new_page()
    nav(page, "search-not-found.html")
    shot(page, "search_not_found")

    back_btn  = page.locator("button:has-text('Back'), a:has-text('Back'), button:has-text('Go Back')").count()
    retry_btn = page.locator("button:has-text('Try'), button:has-text('Search'), button:has-text('Home')").count()
    print(f"  Back buttons: {back_btn}, Retry/Search buttons: {retry_btn}")
    if back_btn + retry_btn == 0:
        defect("HIGH", "search-not-found.html", "No recovery action on empty search",
               "User is stuck on 'No Results' page with no back or retry button",
               "Add a Back or Try Again button on the search-not-found page")
    else:
        print("  [PASS] Recovery actions present on empty search page")

    page.close(); ctx.close()

    # =========================================================================
    # TEST 19: Notification page - mark-all-read & clear
    # =========================================================================
    print("\n" + "="*70)
    print("TEST 19: Notifications - Actions")
    print("="*70)

    ctx = browser.new_context(viewport={"width":390,"height":844})
    page = ctx.new_page()
    nav(page, "notification.html")
    shot(page, "notifications_initial")

    mark_read = page.locator("button:has-text('Mark'), button:has-text('Read All'), [class*='mark-read']").count()
    clear_all  = page.locator("button:has-text('Clear'), button:has-text('Delete All')").count()
    print(f"  Mark-read buttons: {mark_read}, Clear buttons: {clear_all}")
    empty_notif = page.locator("[class*='empty'], [class*='no-notif']").count()
    print(f"  Empty notification state: {empty_notif > 0}")
    page.close(); ctx.close()

    # =========================================================================
    # TEST 20: Offline / network simulation
    # =========================================================================
    print("\n" + "="*70)
    print("TEST 20: Offline Simulation - Dashboard & Login")
    print("="*70)

    ctx = browser.new_context(viewport={"width":390,"height":844})
    page = ctx.new_page()

    # Load page first, then go offline
    nav(page, "dashboard.html")
    page.context.set_offline(True)
    time.sleep(0.5)
    page.reload(wait_until="domcontentloaded")
    time.sleep(1.5)
    shot(page, "dashboard_offline")
    offline_msg = page.locator("[class*='offline'], [class*='no-connection'], .toast").count()
    if offline_msg == 0:
        defect("MEDIUM", "dashboard.html",
               "No offline state feedback to user",
               "When network is disconnected, dashboard shows no user-facing message",
               "Add an offline banner or toast notification when Firebase/network is unavailable")
    else:
        print("  [PASS] Offline state feedback present")
    page.context.set_offline(False)
    page.close(); ctx.close()

    # =========================================================================
    browser.close()

    # =========================================================================
    # SAVE FINDINGS
    # =========================================================================
    with open("tests/audit_phase2_findings.json","w",encoding="utf-8") as f:
        json.dump(findings, f, indent=2, ensure_ascii=False)

    print("\n\nPhase 2 complete. Findings saved to tests/audit_phase2_findings.json")
    print(f"Total defects found: {len(findings)}")

    by_sev = {}
    for fi in findings:
        by_sev.setdefault(fi["severity"], []).append(fi)
    for sev in ["CRITICAL","HIGH","MEDIUM","LOW"]:
        lst = by_sev.get(sev, [])
        if lst:
            print(f"  {sev}: {len(lst)}")
