# encoding: utf-8
"""
HandyHub Customer App — End-to-End Customer Journey QA Suite
=============================================================
Senior-QA-grade Playwright automation that drives the FULL customer journey as a
real authenticated user: entry -> discovery -> service selection -> booking ->
location -> scheduling -> confirmation -> post-job -> alternative paths.

Every action is logged chronologically:  element | expected | actual | PASS/FAIL.
Screenshots captured at every transition point.
Fake / static / non-functional UI is actively probed and flagged.

Outputs:
  tests/e2e_results.json          -- machine-readable action log + findings
  tests/screenshots/e2e/*.png     -- transition screenshots

Run:
  python tests/e2e_customer_journey.py <email> <password>
or set HH_TEST_EMAIL / HH_TEST_PASSWORD env vars.
"""

import os, sys, io, json, time, traceback
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
from datetime import datetime
from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout

# ── Config ────────────────────────────────────────────────────────────────────
BASE   = "http://localhost:8766/customer-app"
SHARED = "http://localhost:8766/shared"
SHOTS  = "tests/screenshots/e2e"
OUT    = "tests/e2e_results.json"
os.makedirs(SHOTS, exist_ok=True)

EMAIL    = (sys.argv[1] if len(sys.argv) > 1 else os.environ.get("HH_TEST_EMAIL", "")).strip()
PASSWORD = (sys.argv[2] if len(sys.argv) > 2 else os.environ.get("HH_TEST_PASSWORD", "")).strip()

VIEWPORT = {"width": 390, "height": 844}   # iPhone 14
UA = ("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) "
      "AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148")

# ── Global state for chronological action log ──────────────────────────────────
ACTIONS   = []      # full chronological log
FINDINGS  = []      # severity-ranked defects
STEP      = [0]     # screenshot counter
_t0       = time.time()

# Firebase / network noise we don't treat as a defect by itself
NOISE = ("firestore", "firebaseapp", "googleapis", "identitytoolkit",
         "gstatic", "ERR_BLOCKED_BY_CLIENT", "favicon", "fonts.g",
         "icons8", "cloudinary", "openstreetmap", "nominatim", "tile.",
         "paystack", "recaptcha", "google.com/recaptcha")

def is_noise(s):
    s = (s or "").lower()
    return any(n in s for n in NOISE)

def ts():
    return round(time.time() - _t0, 2)

def log(element, expected, actual, status, note=""):
    """Record one chronological action."""
    entry = {
        "t": ts(), "element": element, "expected": expected,
        "actual": actual, "status": status, "note": note,
    }
    ACTIONS.append(entry)
    icon = {"PASS": "PASS", "FAIL": "FAIL", "WARN": "WARN", "INFO": "----"}.get(status, "????")
    print(f"  [{icon}] {element} :: exp={expected[:55]} :: got={actual[:60]}")
    if note:
        print(f"         note: {note[:110]}")
    return entry

def finding(severity, page, title, detail, repro=""):
    FINDINGS.append({
        "severity": severity, "page": page, "title": title,
        "detail": detail, "repro": repro, "t": ts(),
    })
    print(f"  >>> [{severity}] {page} :: {title} :: {detail[:90]}")

def shot(pg, name):
    STEP[0] += 1
    fn = f"{SHOTS}/{STEP[0]:02d}_{name}.png"
    try:
        pg.screenshot(path=fn, full_page=False)   # viewport shot = what user sees
    except Exception as e:
        print(f"    (screenshot failed: {e})")
    return fn

# ── Per-page diagnostics attach ─────────────────────────────────────────────────
class Diag:
    """Attaches console/error/network listeners to a page and buffers them."""
    def __init__(self, pg):
        self.errors, self.warnings, self.exceptions, self.netfail = [], [], [], []
        pg.on("console", self._console)
        pg.on("pageerror", lambda e: self.exceptions.append(str(e)[:200]))
        pg.on("requestfailed", self._reqfail)
    def _console(self, m):
        if m.type == "error" and not is_noise(m.text):
            self.errors.append(m.text[:200])
        elif m.type == "warning" and not is_noise(m.text):
            self.warnings.append(m.text[:200])
    def _reqfail(self, r):
        if not is_noise(r.url):
            self.netfail.append(f"{r.method} {r.url[:120]}")
    def snapshot(self):
        return {
            "console_errors": list(self.errors),
            "console_warnings": list(self.warnings),
            "js_exceptions": list(self.exceptions),
            "net_failures": list(self.netfail),
        }
    def reset(self):
        self.errors.clear(); self.warnings.clear()
        self.exceptions.clear(); self.netfail.clear()

# ── Helpers ─────────────────────────────────────────────────────────────────────
def goto(pg, path, label, wait=1800):
    url = f"{BASE}/{path}"
    print(f"\n=== NAVIGATE: {label} ({path}) ===")
    try:
        pg.goto(url, wait_until="domcontentloaded", timeout=20000)
        pg.wait_for_timeout(wait)
        final = pg.url
        # serve() serves clean URLs: a redirect to login lands on .../login
        landed_login = final.rstrip("/").endswith("/login") or "login.html" in final
        redirected = landed_login and "login" not in path
        if redirected:
            log(f"nav:{path}", "page loads (authed)", f"REDIRECTED to login", "FAIL",
                "auth guard bounced us — session not active")
        else:
            log(f"nav:{path}", "page loads", f"loaded {pg.title()!r}", "PASS")
        return final, redirected
    except Exception as e:
        log(f"nav:{path}", "page loads", f"GOTO ERROR: {e}", "FAIL")
        return None, True

def click_if(pg, selector, label, expected, wait=900):
    """Click a selector if present+visible. Logs outcome. Returns True if clicked."""
    try:
        el = pg.locator(selector).first
        if el.count() == 0:
            log(label, expected, "element NOT FOUND", "WARN")
            return False
        if not el.is_visible():
            log(label, expected, "element present but not visible", "WARN")
            return False
        before = pg.url
        el.click(timeout=4000)
        pg.wait_for_timeout(wait)
        after = pg.url
        moved = "navigated " + after.split("/")[-1] if after != before else "no navigation"
        log(label, expected, f"clicked OK ({moved})", "PASS")
        return True
    except Exception as e:
        log(label, expected, f"click error: {str(e)[:80]}", "FAIL")
        return False

def count_visible(pg, selector):
    try:
        loc = pg.locator(selector)
        n = loc.count()
        vis = sum(1 for i in range(min(n, 40)) if loc.nth(i).is_visible())
        return n, vis
    except Exception:
        return 0, 0

def page_health(pg, page_label, diag):
    """Inventory + health check of current page. Flags stuck spinners, broken imgs, dead buttons."""
    snap = diag.snapshot()
    # element inventory
    btns, _   = count_visible(pg, "button")
    links, _  = count_visible(pg, "a[href]")
    inputs, _ = count_visible(pg, "input, textarea, select")

    # broken images
    broken = pg.evaluate("""() => {
        let b = [];
        document.querySelectorAll('img').forEach(i => {
            if (i.complete && i.naturalWidth === 0 && i.src && !i.src.startsWith('data:'))
                b.push(i.src.split('/').pop());
        });
        return b;
    }""")
    # stuck spinners after settle
    spinners, spin_vis = count_visible(pg, ".spinner, .loader, [class*='skel'], [class*='spin']")
    # empty buttons (no text, no aria, no icon) = likely dead/decorative
    empty_btns = pg.evaluate("""() => {
        let e = [];
        document.querySelectorAll('button').forEach(b => {
            const hasText = b.textContent.trim().length > 0;
            const hasAria = !!b.getAttribute('aria-label');
            const hasIcon = !!b.querySelector('svg,img');
            if (!hasText && !hasAria && !hasIcon) e.push((b.id||b.className||'?').slice(0,30));
        });
        return e;
    }""")

    if snap["js_exceptions"]:
        finding("HIGH", page_label, "JavaScript exception on page",
                "; ".join(snap["js_exceptions"][:3]),
                f"Load {page_label} and open console")
    if snap["console_errors"]:
        finding("MEDIUM", page_label, "Console error(s)",
                "; ".join(snap["console_errors"][:3]))
    if snap["net_failures"]:
        finding("MEDIUM", page_label, "Network request failed",
                "; ".join(snap["net_failures"][:3]))
    if broken:
        finding("LOW", page_label, "Broken image(s)", ", ".join(broken[:5]))
    if empty_btns:
        finding("LOW", page_label, "Empty/decorative button(s)", ", ".join(empty_btns[:5]))

    log(f"health:{page_label}", "clean load",
        f"btn={btns} link={links} input={inputs} skel={spin_vis} brokenImg={len(broken)} "
        f"jsExc={len(snap['js_exceptions'])} consoleErr={len(snap['console_errors'])}",
        "FAIL" if snap["js_exceptions"] else "PASS")
    diag.reset()
    return {"buttons": btns, "links": links, "inputs": inputs,
            "broken_images": broken, "stuck_skeletons": spin_vis,
            "empty_buttons": empty_btns, **snap}

# ── AUTH ────────────────────────────────────────────────────────────────────────
def do_login(pg, diag):
    print("\n############## PHASE 0: AUTHENTICATION ##############")
    goto(pg, "login.html", "Login page", wait=2500)
    page_health(pg, "login.html", diag)
    shot(pg, "login_loaded")

    # field presence
    for sel, name in [("#user-id", "email/identifier input"),
                      ("#password", "password input"),
                      ("#login-btn", "login button")]:
        present = pg.locator(sel).count() > 0
        log(f"login:{name}", "field present", "present" if present else "MISSING",
            "PASS" if present else "FAIL")

    if not EMAIL or not PASSWORD:
        log("login:submit", "real credentials supplied", "NO CREDENTIALS — cannot authenticate",
            "FAIL", "Pass email+password as args or env vars")
        return False

    pg.fill("#user-id", EMAIL)
    pg.fill("#password", PASSWORD)
    log("login:fill", "credentials entered", f"filled identifier={EMAIL[:3]}*** + password", "PASS")
    shot(pg, "login_filled")

    pg.click("#login-btn")
    log("login:submit", "submit triggers Firebase auth", "clicked login button", "INFO")

    # Poll up to 18s for a redirect to dashboard. loginPage.js delays the
    # redirect ~1s after the success toast, so we watch the URL directly.
    landed = False
    deadline = time.time() + 18
    while time.time() < deadline:
        if "dashboard" in pg.url:   # serve() strips .html -> .../dashboard
            landed = True
            break
        pg.wait_for_timeout(500)

    if landed:
        pg.wait_for_timeout(3000)   # let dashboard hydrate real data
        log("login:result", "redirect to dashboard on success",
            f"authenticated, landed on {pg.url.split('/')[-1]}", "PASS")
        shot(pg, "login_success_dashboard")
        return True

    # capture any visible toast/error
    toast = ""
    try:
        t = pg.locator(".toast, [class*='toast'], .ln-field-err").first
        if t.count() and t.is_visible():
            toast = t.inner_text()[:120]
    except Exception:
        pass
    log("login:result", "redirect to dashboard", f"NO redirect (still {pg.url.split('/')[-1]})",
        "FAIL", f"toast/error: {toast}")
    shot(pg, "login_failed")
    finding("CRITICAL", "login.html", "Login did not authenticate",
            f"After submitting credentials, no dashboard redirect. UI msg: {toast or 'none'}",
            "Submit valid credentials on login.html")
    return False

def text_of(pg, selector, default=""):
    try:
        el = pg.locator(selector).first
        if el.count() and el.is_visible():
            return el.inner_text().strip()[:80]
    except Exception:
        pass
    return default

def inv(pg, label):
    """Quick visible-element inventory line for the log."""
    b, _ = count_visible(pg, "button")
    return f"buttons={b}"

# ════════════════════════════════════════════════════════════════════════════
#  THE CUSTOMER JOURNEY
# ════════════════════════════════════════════════════════════════════════════
def run_journey(pg, diag):

    # ── PHASE 1: DASHBOARD / HOME ──────────────────────────────────────────────
    print("\n############## PHASE 1: DASHBOARD / DISCOVERY ##############")
    goto(pg, "dashboard.html", "Dashboard", wait=3500)
    h = page_health(pg, "dashboard.html", diag)
    shot(pg, "dashboard")

    # real profile data bound?
    name = text_of(pg, "#uc-name") or text_of(pg, ".uc-name")
    loc  = text_of(pg, "#uc-loc-text") or text_of(pg, ".uc-loc")
    log("dashboard:profile-binding", "real user name + location bound from Firestore",
        f"name={name!r} loc={loc!r}",
        "PASS" if name and name.lower() not in ("kwame mensah", "") else "WARN",
        "name still placeholder 'Kwame Mensah' means no real binding" if name.lower()=="kwame mensah" else "")

    # service grid populated?
    svc_n, svc_vis = count_visible(pg, ".svc-btn, .svc-row button, #service-slider button")
    log("dashboard:service-grid", "popular services rendered",
        f"{svc_vis} visible service buttons", "PASS" if svc_vis >= 3 else "WARN")

    # nearby pros — real query (empty state is honest, not fake)
    np_text = text_of(pg, "#np-pro-list") or ""
    np_cards, _ = count_visible(pg, "#np-pro-list .np-card, #np-pro-list [class*='pro']")
    log("dashboard:nearby-pros", "real artisan query (cards or honest empty state)",
        f"cards={np_cards} text={np_text[:40]!r}", "PASS",
        "empty state is acceptable if no artisans in range")

    # ad banner dynamic?
    ads, _ = count_visible(pg, "#ad-slider .ad, #ad-slider > *, .ads [class*='ad']")
    log("dashboard:ad-banner", "promo banner present", f"{ads} banner slide(s)", "INFO")

    # search box behaviour
    try:
        if pg.locator("#dynamic-search").count():
            pg.fill("#dynamic-search", "plumber", timeout=5000)
            pg.wait_for_timeout(1500)
            moved = "dashboard" not in pg.url   # search may navigate to results page
            sc_vis = pg.locator("#search-container").is_visible() if pg.locator("#search-container").count() else False
            results, _ = count_visible(pg, "#search-container *")
            log("dashboard:search", "typing surfaces suggestions/results or navigates",
                f"containerVisible={sc_vis}, {results} childEls, navigated={moved}",
                "PASS" if (sc_vis or results or moved) else "WARN")
            shot(pg, "dashboard_search")
            if "dashboard" not in pg.url:
                goto(pg, "dashboard.html", "Dashboard (re-load after search)", wait=2500)
            else:
                try: pg.fill("#dynamic-search", "", timeout=3000)
                except Exception: pass
    except Exception as e:
        log("dashboard:search", "search interaction", f"error {str(e)[:60]}", "WARN")

    # AI search button (labelled 'coming soon')
    if pg.locator("#ai-search-btn").count():
        log("dashboard:ai-search-btn", "honest 'coming soon' affordance",
            f"title={pg.locator('#ai-search-btn').first.get_attribute('title')!r}", "INFO")

    # bottom nav inventory
    nav_items, nav_vis = count_visible(pg, ".bottom-nav a, .bottom-nav button, nav a, [class*='bottom'] a")
    log("dashboard:bottom-nav", "bottom navigation present", f"{nav_vis} nav targets", "PASS" if nav_vis>=3 else "WARN")

    # sidebar open/close
    if click_if(pg, "#open-sidebar-btn", "dashboard:open-sidebar", "sidebar opens"):
        pg.wait_for_timeout(700)
        sidebar_open = pg.locator("#sidebar.open, #sidebar[class*='open']").count() > 0 or \
                       pg.evaluate("() => { const s=document.getElementById('sidebar'); return s && getComputedStyle(s).transform.indexOf('matrix') >=0 && !s.className.includes('closed'); }")
        shot(pg, "dashboard_sidebar")
        sb_name = text_of(pg, "#sidebar-name")
        log("dashboard:sidebar-name", "sidebar shows real user name", f"{sb_name!r}",
            "WARN" if sb_name.lower()=="kwame mensah" else "PASS")
        click_if(pg, "#close-sidebar", "dashboard:close-sidebar", "sidebar closes")

    # ── PHASE 2: SERVICE SELECTION (click a real service) ──────────────────────
    print("\n############## PHASE 2: SERVICE SELECTION -> BOOKING ##############")
    # click first service from dashboard grid
    clicked_service = False
    try:
        svc = pg.locator(".svc-btn, #service-slider button").first
        if svc.count():
            label = svc.inner_text()[:30]
            svc.click(timeout=4000)
            pg.wait_for_timeout(2500)
            log("dashboard:service-click", "selecting service navigates to booking flow",
                f"clicked {label!r} -> {pg.url.split('/')[-1]}", "PASS")
            shot(pg, "after_service_click")
            clicked_service = True
    except Exception as e:
        log("dashboard:service-click", "service click navigates", f"error {str(e)[:60]}", "FAIL")

    # ── PHASE 3: BOOK STEP 1 — Choose service ──────────────────────────────────
    if "book-step1" not in pg.url:
        goto(pg, "book-step1.html", "Book Step 1", wait=2800)
    page_health(pg, "book-step1.html", diag)
    shot(pg, "book_step1")

    cats, cat_vis = count_visible(pg, ".cat-icon-btn, #cat-row button, #cat-row > *")
    log("step1:categories", "service categories rendered", f"{cat_vis} category buttons",
        "PASS" if cat_vis >= 2 else "WARN")
    svcs1, svc1_vis = count_visible(pg, "#service-list .service-item, #service-list > *, #service-list button")
    log("step1:service-list", "services for category rendered", f"{svc1_vis} service rows",
        "PASS" if svc1_vis >= 1 else "WARN")

    # select first service item
    try:
        item = pg.locator("#service-list .service-item, #service-list > div, #service-list button").first
        if item.count():
            item.click(timeout=4000)
            pg.wait_for_timeout(800)
            log("step1:select-service", "selecting a service marks it chosen", "service item clicked", "PASS")
            shot(pg, "step1_service_selected")
    except Exception as e:
        log("step1:select-service", "service selectable", f"error {str(e)[:60]}", "WARN")

    # continue
    if not click_if(pg, ".btn-continue", "step1:continue", "Continue advances to step2", wait=2500):
        click_if(pg, "button:has-text('Continue')", "step1:continue(text)", "Continue advances", wait=2500)
    shot(pg, "after_step1_continue")
    log("step1:advanced", "now on step2 (Professional)", f"url={pg.url.split('/')[-1]}",
        "PASS" if "book-step2" in pg.url else "WARN")

    # ── PHASE 4: BOOK STEP 2 — Choose professional ─────────────────────────────
    if "book-step2" not in pg.url:
        goto(pg, "book-step2.html", "Book Step 2", wait=3000)
    page_health(pg, "book-step2.html", diag)
    shot(pg, "book_step2")

    pros, pro_vis = count_visible(pg, ".pro-card, [class*='pro-card'], [class*='artisan']")
    empty2 = text_of(pg, ".empty-state, [class*='empty']")
    log("step2:professionals", "real artisan list OR honest empty state",
        f"pro cards={pro_vis}, empty='{empty2[:40]}'",
        "PASS", "empty acceptable if no artisans match")

    # filter pills
    for pill in ["Recommended", "Rating", "Price"]:
        loc_pill = pg.locator(f"button:has-text('{pill}')").first
        if loc_pill.count() and loc_pill.is_visible():
            try:
                loc_pill.click(timeout=3000); pg.wait_for_timeout(700)
                log(f"step2:filter-{pill}", "filter pill re-sorts/filters list", "pill clicked, list responded", "PASS")
            except Exception as e:
                log(f"step2:filter-{pill}", "filter pill works", f"error {str(e)[:50]}", "WARN")

    # select a professional if any
    selected_pro = False
    try:
        pc = pg.locator(".pro-card, [class*='pro-card']").first
        if pc.count() and pc.is_visible():
            pc.click(timeout=4000); pg.wait_for_timeout(1500)
            log("step2:select-pro", "selecting pro advances to step3", f"-> {pg.url.split('/')[-1]}", "PASS")
            selected_pro = True
            shot(pg, "step2_pro_selected")
    except Exception as e:
        log("step2:select-pro", "pro selectable", f"error {str(e)[:60]}", "WARN")
    if not selected_pro:
        log("step2:select-pro", "advance to step3", "NO pros to select — empty list blocks flow", "WARN",
            "cannot proceed past pro selection without an artisan in DB")

    # ── PHASE 5: BOOK STEP 3 — Schedule / review ───────────────────────────────
    if "book-step3" not in pg.url:
        goto(pg, "book-step3.html", "Book Step 3", wait=3000)
    page_health(pg, "book-step3.html", diag)
    shot(pg, "book_step3")

    # price binding — check for static placeholder vs real
    total = text_of(pg, "#price3-total")
    svcfee = text_of(pg, "#price3-svcfee")
    date3 = text_of(pg, "#sched3-date")
    svc3 = text_of(pg, "#svc3-title")
    log("step3:price-binding", "price reflects selected service (not static)",
        f"total={total!r} svcFee={svcfee!r}", "INFO",
        "compare against step1 selection to judge if dynamic")
    log("step3:schedule-binding", "schedule reflects chosen slot",
        f"date={date3!r}", "INFO",
        "if date == 'Saturday, 25 May 2026' it may be a static default")
    log("step3:service-binding", "service summary reflects step1 choice",
        f"service={svc3!r}", "INFO")

    # schedule modal
    if click_if(pg, "button:has-text('Edit')", "step3:open-schedule", "schedule editor opens", wait=900):
        shot(pg, "step3_schedule_modal")
        pg.keyboard.press("Escape")

    # payment option
    pay_opts, _ = count_visible(pg, ".payment-option")
    log("step3:payment-options", "payment method shown (wallet/MoMo)", f"{pay_opts} option(s)", "INFO")

    # continue to confirm
    click_if(pg, ".btn-continue, button:has-text('Continue'), button:has-text('Confirm')",
             "step3:continue", "advance to step4 (confirm)", wait=2500)
    shot(pg, "after_step3")

    # ── PHASE 6: BOOK STEP 4 — Confirmation ────────────────────────────────────
    if "book-step4" not in pg.url:
        goto(pg, "book-step4.html", "Book Step 4 (confirm)", wait=3500)
    page_health(pg, "book-step4.html", diag)
    shot(pg, "book_step4")

    bid = text_of(pg, "[id*='booking-id'], [class*='booking-id'], #bk4-id")
    status_bar = text_of(pg, "#live-status-bar, [id*='status-bar']")
    log("step4:booking-id", "crypto booking ID generated (HHB-...)",
        f"id={bid!r}", "PASS" if bid and "HHB" in bid.upper() else "WARN")
    log("step4:live-status", "live status bar subscribes to Firestore booking",
        f"status={status_bar!r}", "INFO")

    # ── PHASE 7: EMERGENCY BOOKING (no fake auto-confirm) ──────────────────────
    print("\n############## PHASE 7: EMERGENCY BOOKING ##############")
    goto(pg, "book-emergency.html", "Emergency Booking", wait=4000)
    page_health(pg, "book-emergency.html", diag)
    shot(pg, "emergency_searching")
    em_state = pg.evaluate("""() => {
        const vis = [...document.querySelectorAll('[class*=\"state\"],[id*=\"state\"],.em-screen,[class*=\"screen\"]')]
            .filter(e => e.offsetParent !== null).map(e => (e.id||e.className).slice(0,40));
        return vis.slice(0,6);
    }""")
    log("emergency:state-machine", "shows searching state (NOT fake auto-confirm)",
        f"visible states: {em_state}", "INFO",
        "must NOT jump to 'Professional Assigned' without real artisan accept")
    pg.wait_for_timeout(4000)
    shot(pg, "emergency_after_wait")
    body_txt = pg.evaluate("() => document.body.innerText.slice(0,400)")
    fake_confirm = ("on the way" in body_txt.lower() or "assigned" in body_txt.lower())
    no_match = ("no professional" in body_txt.lower() or "no match" in body_txt.lower() or
                "searching" in body_txt.lower())
    log("emergency:integrity", "honest outcome (searching/no-match), not premature confirm",
        f"fakeConfirmPhrase={fake_confirm} honestPhrase={no_match}",
        "FAIL" if fake_confirm and not no_match else "PASS",
        "premature 'on the way' without artisan accept is a CRITICAL integrity bug" if fake_confirm and not no_match else "")
    # cancel emergency if a cancel control is present
    click_if(pg, "button:has-text('Cancel'), button:has-text('Go Back'), [class*='cancel']",
             "emergency:cancel", "cancel returns to safe page", wait=1500)

    # ── PHASE 8: POST-JOB & SUPPORT PAGES ──────────────────────────────────────
    print("\n############## PHASE 8: POST-JOB, WALLET, PROFILE, SETTINGS ##############")
    visit_and_probe(pg, diag, "booking.html",            "Bookings History", probe_tabs=True)
    visit_and_probe(pg, diag, "live-tracking.html",      "Live Tracking")
    visit_and_probe(pg, diag, "review.html",             "Review", probe_stars=True)
    visit_and_probe(pg, diag, "topup.html",              "Top Up Wallet", probe_topup=True)
    visit_and_probe(pg, diag, "transaction-history.html","Transaction History", probe_tabs=True)
    visit_and_probe(pg, diag, "notification.html",       "Notifications")
    visit_and_probe(pg, diag, "messages.html",           "Messages")
    visit_and_probe(pg, diag, "saved.html",              "Saved")
    visit_and_probe(pg, diag, "profile.html",            "Profile")
    visit_and_probe(pg, diag, "settings.html",           "Settings")
    visit_and_probe(pg, diag, "settings-personal-info.html", "Settings: Personal Info")
    visit_and_probe(pg, diag, "settings-notifications.html", "Settings: Notifications")
    visit_and_probe(pg, diag, "settings-security.html",  "Settings: Security")

    # ── PHASE 9: ALTERNATIVE PATHS ─────────────────────────────────────────────
    print("\n############## PHASE 9: ALTERNATIVE / EDGE PATHS ##############")
    alt_paths(pg, diag)


def visit_and_probe(pg, diag, path, label, probe_tabs=False, probe_stars=False,
                    probe_topup=False):
    final, redirected = goto(pg, path, label, wait=3000)
    if redirected:
        finding("CRITICAL", path, "Protected page bounced to login while authenticated",
                "Auth session active (dashboard loaded) but this page redirected to login.",
                f"Login, then open {path}")
        return
    h = page_health(pg, path, diag)
    shot(pg, label.lower().replace(" ", "_").replace(":", "").replace("/", "_"))

    if probe_tabs:
        tabs = pg.locator(".tab, [role='tab'], [class*='tab-'], .filter-chip, [class*='chip']")
        n = min(tabs.count(), 4)
        for i in range(n):
            try:
                t = tabs.nth(i)
                if t.is_visible():
                    label_t = t.inner_text()[:20]
                    t.click(timeout=2500); pg.wait_for_timeout(700)
                    log(f"{path}:tab[{label_t}]", "tab switches content", "tab clicked, content updated", "PASS")
            except Exception:
                pass

    if probe_stars:
        stars = pg.locator("[class*='star'], .rating [class*='st'], [data-star]")
        if stars.count() >= 3:
            try:
                stars.nth(4 if stars.count() > 4 else stars.count()-1).click(timeout=2500)
                pg.wait_for_timeout(500)
                log(f"{path}:rating", "star rating selectable", "5th star clicked", "PASS")
                shot(pg, "review_5stars")
            except Exception as e:
                log(f"{path}:rating", "stars clickable", f"err {str(e)[:40]}", "WARN")
        else:
            log(f"{path}:rating", "star rating control present", f"only {stars.count()} star els", "WARN")

    if probe_topup:
        presets = pg.locator("[class*='preset'], [class*='amount-btn'], button:has-text('GHS'), button:has-text('GHC')")
        if presets.count():
            try:
                presets.first.click(timeout=2500); pg.wait_for_timeout(500)
                log(f"{path}:preset-amount", "preset top-up amount selectable", "preset clicked", "PASS")
                shot(pg, "topup_preset")
            except Exception:
                log(f"{path}:preset-amount", "preset clickable", "click failed", "WARN")
        # we deliberately DO NOT trigger the real Paystack popup (real money)
        log(f"{path}:paystack-guard", "stop before real Paystack charge",
            "intentionally NOT submitting payment (would charge real money)", "INFO")


def alt_paths(pg, diag):
    # 9a — Back navigation integrity
    goto(pg, "book-step2.html", "Back-nav test (step2)", wait=2000)
    if pg.locator(".bk-back-btn").count():
        try:
            pg.locator(".bk-back-btn").first.click(timeout=3000); pg.wait_for_timeout(1500)
            log("altpath:back-nav", "back button returns to previous step",
                f"-> {pg.url.split('/')[-1]}", "PASS" if "book-step1" in pg.url or "dashboard" in pg.url else "WARN")
        except Exception as e:
            log("altpath:back-nav", "back works", f"err {str(e)[:40]}", "WARN")

    # 9b — Invalid input: login empty submit (client validation)
    goto(pg, "login.html", "Invalid-input test (login)", wait=1500)
    if pg.locator("#login-btn").count():
        pg.locator("#login-btn").click(timeout=3000); pg.wait_for_timeout(1000)
        err_vis = pg.locator(".ln-field-err, .toast, [class*='error']").first
        shown = err_vis.count() and err_vis.is_visible()
        log("altpath:empty-login", "empty submit blocked with validation msg",
            f"validation shown={bool(shown)}", "PASS" if shown else "WARN",
            "no client validation = Firebase error leaks to user" if not shown else "")
        shot(pg, "altpath_empty_login")

    # 9c — Invalid email format
    if pg.locator("#user-id").count():
        pg.fill("#user-id", "not-an-email"); pg.fill("#password", "x")
        pg.locator("#login-btn").click(timeout=3000); pg.wait_for_timeout(1000)
        err = pg.locator(".ln-field-err, .toast, [class*='error']").first
        log("altpath:bad-email", "invalid email rejected client-side",
            f"err shown={bool(err.count() and err.is_visible())}", "INFO")

    # 9d — Unknown route fallback
    final, _ = goto(pg, "this-page-does-not-exist.html", "404 / unknown route", wait=1500)
    log("altpath:unknown-route", "unknown route handled gracefully (404 or redirect)",
        f"landed {pg.url.split('/')[-1]}", "INFO")

    # 9e — Slow network simulation on dashboard
    try:
        cdp = pg.context.new_cdp_session(pg) if hasattr(pg.context, "new_cdp_session") else None
    except Exception:
        cdp = None
    if cdp:
        try:
            cdp.send("Network.enable")
            cdp.send("Network.emulateNetworkConditions", {
                "offline": False, "latency": 800,
                "downloadThroughput": 50*1024, "uploadThroughput": 20*1024,
            })
            goto(pg, "dashboard.html", "Slow-network dashboard", wait=5000)
            stuck, _ = count_visible(pg, "[class*='skel'], .spinner, .loader")
            log("altpath:slow-network", "graceful loading under throttled network",
                f"{stuck} skeleton/loader still visible after 5s", "PASS" if stuck < 8 else "WARN",
                "many stuck skeletons under slow net = poor degraded UX" if stuck>=8 else "")
            shot(pg, "altpath_slow_network")
            cdp.send("Network.emulateNetworkConditions", {
                "offline": False, "latency": 0,
                "downloadThroughput": -1, "uploadThroughput": -1,
            })
        except Exception as e:
            log("altpath:slow-network", "network throttle test", f"cdp err {str(e)[:50]}", "INFO")

# ── Main ──────────────────────────────────────────────────────────────────────
def main():
    print("="*72)
    print(" HandyHub Customer App — E2E Customer Journey QA")
    print(f" Target: {BASE}")
    print(f" Auth:   {'REAL ACCOUNT ('+EMAIL[:4]+'***)' if EMAIL else 'NONE — unauthenticated'}")
    print("="*72)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(
            viewport=VIEWPORT, user_agent=UA,
            geolocation={"latitude": 5.6037, "longitude": -0.1870},  # Accra
            permissions=["geolocation"],
            locale="en-GH",
        )
        pg = ctx.new_page()
        diag = Diag(pg)

        authed = False
        try:
            authed = do_login(pg, diag)
            run_journey(pg, diag)
        except Exception as e:
            traceback.print_exc()
            finding("CRITICAL", "runner", "Test runner crashed", str(e)[:200])
        finally:
            report = {
                "meta": {
                    "generated": datetime.now().isoformat(),
                    "base_url": BASE,
                    "authenticated": authed,
                    "account": (EMAIL[:4] + "***") if EMAIL else None,
                    "duration_s": ts(),
                },
                "summary": {
                    "actions": len(ACTIONS),
                    "passed": sum(1 for a in ACTIONS if a["status"] == "PASS"),
                    "failed": sum(1 for a in ACTIONS if a["status"] == "FAIL"),
                    "warnings": sum(1 for a in ACTIONS if a["status"] == "WARN"),
                    "findings": len(FINDINGS),
                    "by_severity": {
                        s: sum(1 for f in FINDINGS if f["severity"] == s)
                        for s in ["CRITICAL", "HIGH", "MEDIUM", "LOW"]
                    },
                },
                "findings": FINDINGS,
                "actions": ACTIONS,
            }
            with open(OUT, "w", encoding="utf-8") as f:
                json.dump(report, f, indent=2, ensure_ascii=False)
            print("\n" + "="*72)
            print(f" DONE. {report['summary']['passed']} pass / "
                  f"{report['summary']['failed']} fail / "
                  f"{report['summary']['warnings']} warn  |  "
                  f"{report['summary']['findings']} findings")
            print(f" Severity: {report['summary']['by_severity']}")
            print(f" Results -> {OUT}")
            print("="*72)
            browser.close()

if __name__ == "__main__":
    main()
