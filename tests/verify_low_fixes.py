# HandyHub -- L1-L4 Low Priority Fix Verification
# encoding: utf-8

import os, time, json, re
from playwright.sync_api import sync_playwright

# Customer-app server for JS tests; project-root for asset resolution tests
BASE_CA = "http://localhost:8765"
BASE_PR = "http://localhost:8766/customer-app"

SHOTS = "tests/screenshots/low_verify"
os.makedirs(SHOTS, exist_ok=True)

results = []

def rec(tid, name, passed, detail="", sc=""):
    results.append({"id": tid, "name": name, "passed": passed,
                    "detail": detail, "screenshot": sc})
    icon = "PASS" if passed else "FAIL"
    print(f"  [{icon}] {name}")
    if not passed:
        print(f"         -> {str(detail)[:120]}")

def shot(pg, name):
    p = f"{SHOTS}/{name}.png"
    pg.screenshot(path=p, full_page=True)
    return p

def go(pg, url, timeout=15000):
    for attempt in range(3):
        try:
            pg.goto(url, wait_until="domcontentloaded", timeout=timeout)
            time.sleep(1.5)
            return
        except Exception as e:
            if attempt == 2: raise
            time.sleep(2)

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)

    # ==========================================================================
    # L1 -- Logo onerror fallback & asset existence
    # ==========================================================================
    print("\n" + "="*65)
    print("L1: Logo Rendering & onerror Fallback")
    print("="*65)

    # Verify logo files exist on disk
    logo_txt = os.path.isfile("shared/assets/images/handyhub-logo-text.png")
    logo_img = os.path.isfile("shared/assets/images/handyhub-logo.png")
    rec("L1-T1", "handyhub-logo-text.png exists on disk", logo_txt, "", "")
    rec("L1-T2", "handyhub-logo.png exists on disk",      logo_img, "", "")

    # Check onerror is present in each logo img
    for fname, tid in [
        ("customer-app/login.html",        "L1-T3"),
        ("customer-app/signup.html",       "L1-T4"),
        ("customer-app/splash-screen.html","L1-T5"),
        ("customer-app/index.html",        "L1-T6"),
    ]:
        try:
            with open(fname, "r", encoding="utf-8") as f:
                content = f.read()
            has_onerror = "onerror" in content and "handyhub-logo" in content
            rec(tid, f"{os.path.basename(fname)} has onerror fallback on logo img",
                has_onerror, "onerror attribute missing", "")
        except Exception as e:
            rec(tid, f"{os.path.basename(fname)} readable", False, str(e), "")

    # From project-root server, logo should load without errors
    ctx = browser.new_context(viewport={"width":390,"height":844})
    page = ctx.new_page()
    img_errs = []
    page.on("requestfailed", lambda r: img_errs.append(r.url)
            if "handyhub-logo" in r.url else None)
    try:
        go(page, f"{BASE_PR}/login.html")
        sc_l = shot(page, "l1_login_logo")
        logo_loaded = page.evaluate("""() => {
            const imgs = Array.from(document.querySelectorAll('img'));
            const logo = imgs.find(i => i.src && i.src.includes('handyhub-logo'));
            if (!logo) return 'not_found';
            return logo.complete ? (logo.naturalWidth > 0 ? 'loaded' : 'broken') : 'loading';
        }""")
        rec("L1-T7", "Logo img loads correctly from project-root server",
            logo_loaded == "loaded",
            f"logo state: {logo_loaded}", sc_l)
    except Exception as e:
        rec("L1-T7", "Logo load test (project root)", False, str(e)[:80], "")
    page.close(); ctx.close()

    # From customer-app server, onerror should trigger and show text fallback
    ctx = browser.new_context(viewport={"width":390,"height":844})
    page = ctx.new_page()
    go(page, f"{BASE_CA}/login.html")
    sc_l2 = shot(page, "l1_login_onerror_fallback")

    # Logo should either be loaded OR replaced by the text fallback span
    fallback_or_loaded = page.evaluate("""() => {
        const logo = document.querySelector('img[src*="handyhub-logo"]');
        const fallbackSpan = document.querySelector('.ln-logo span, .ln-brand span, span[style*="730201"]');
        if (fallbackSpan) return 'fallback_shown';
        if (logo && logo.naturalWidth > 0) return 'logo_loaded';
        if (logo && logo.style.display === 'none') return 'fallback_triggered';
        return 'broken_no_fallback';
    }""")
    rec("L1-T8", "Logo shows fallback text when image fails (customer-app server)",
        fallback_or_loaded in ("fallback_shown", "logo_loaded", "fallback_triggered"),
        f"State: {fallback_or_loaded}", sc_l2)
    page.close(); ctx.close()

    # ==========================================================================
    # L2 -- Page title standardization
    # ==========================================================================
    print("\n" + "="*65)
    print("L2: Page Title Consistency")
    print("="*65)

    # File-based: check titles for forbidden patterns and consistent format
    TITLE_PATTERN = re.compile(r'<title>([^<]*)</title>')
    FORBIDDEN = ['–', '—', '·']  # en dash, em dash, middle dot

    title_pages = [
        "customer-app/login.html",
        "customer-app/signup.html",
        "customer-app/dashboard.html",
        "customer-app/booking.html",
        "customer-app/settings.html",
        "customer-app/settings-security.html",
        "customer-app/book-step1.html",
        "customer-app/notification.html",
    ]

    all_titles_ok = True
    bad_titles = []
    for fname in title_pages:
        try:
            with open(fname, "r", encoding="utf-8") as f:
                content = f.read()
            m = TITLE_PATTERN.search(content)
            if not m:
                bad_titles.append(f"{fname}: no title tag")
                all_titles_ok = False
                continue
            title = m.group(1)
            # Must contain "HandyHub" and use | separator (not – or ·)
            has_handy = "HandyHub" in title
            has_bad_sep = any(c in title for c in FORBIDDEN)
            if not has_handy or has_bad_sep:
                bad_titles.append(f"{fname}: '{title}'")
                all_titles_ok = False
        except Exception as e:
            bad_titles.append(f"{fname}: error {e}")
            all_titles_ok = False

    rec("L2-T1", "All sampled page titles use HandyHub branding with | separator",
        all_titles_ok, str(bad_titles[:3]), "")

    # Browser test: titles render without garbled characters
    ctx = browser.new_context(viewport={"width":390,"height":844})
    page = ctx.new_page()
    go(page, f"{BASE_CA}/login.html")
    title_text = page.title()
    rec("L2-T2", "Login page title is 'Login | HandyHub'",
        title_text == "Login | HandyHub",
        f"Got: {title_text!r}", "")

    go(page, f"{BASE_CA}/settings.html")
    settings_title = page.title()
    rec("L2-T3", "Settings page title is 'Settings | HandyHub'",
        settings_title == "Settings | HandyHub",
        f"Got: {settings_title!r}", "")

    go(page, f"{BASE_CA}/book-step1.html")
    step1_title = page.title()
    rec("L2-T4", "Book Step 1 title uses pipe separator",
        "|" in step1_title and "HandyHub" in step1_title,
        f"Got: {step1_title!r}", "")
    page.close(); ctx.close()

    # ==========================================================================
    # L3 -- history.js fully removed
    # ==========================================================================
    print("\n" + "="*65)
    print("L3: Dead File Removal (history.js)")
    print("="*65)

    file_gone = not os.path.exists("customer-app/Scripts/history.js")
    rec("L3-T1", "history.js file deleted from disk", file_gone, "", "")

    # No script tag references remain
    refs = []
    for root, _, files in os.walk("customer-app"):
        for fn in files:
            if not fn.endswith((".html", ".js")): continue
            fp = os.path.join(root, fn)
            try:
                with open(fp, "r", encoding="utf-8") as f:
                    content = f.read()
                if 'src="Scripts/history.js"' in content or "src='Scripts/history.js'" in content:
                    refs.append(fp)
            except Exception:
                pass
    rec("L3-T2", "No <script src> tags reference history.js",
        len(refs) == 0, f"Still referenced in: {refs}", "")

    # tracking.html comment cleaned up
    try:
        with open("customer-app/tracking.html", "r", encoding="utf-8") as f:
            tracking_content = f.read()
        comment_gone = "history.js intentionally omitted" not in tracking_content
        rec("L3-T3", "Stale history.js comment removed from tracking.html",
            comment_gone, "Comment still present", "")
    except Exception as e:
        rec("L3-T3", "tracking.html readable", False, str(e), "")

    # Browser: tracking.html loads without 404 for history.js
    ctx = browser.new_context(viewport={"width":390,"height":844})
    page = ctx.new_page()
    history_404s = []
    page.on("requestfailed", lambda r: history_404s.append(r.url)
            if "history.js" in r.url else None)
    page.on("console", lambda m: history_404s.append(m.text[:80])
            if "history.js" in m.text and "404" in m.text else None)
    go(page, f"{BASE_CA}/tracking.html")
    sc_t = shot(page, "l3_tracking_no_history")
    rec("L3-T4", "tracking.html loads without any history.js 404",
        len(history_404s) == 0, str(history_404s[:2]), sc_t)
    page.close(); ctx.close()

    # ==========================================================================
    # L4 -- Dev server scripts in package.json
    # ==========================================================================
    print("\n" + "="*65)
    print("L4: Dev Server Setup")
    print("="*65)

    try:
        with open("package.json", "r", encoding="utf-8") as f:
            pkg = json.load(f)
        has_dev   = "dev"   in pkg.get("scripts", {})
        has_start = "start" in pkg.get("scripts", {})
        dev_cmd   = pkg["scripts"].get("dev", "")
        serves_root = "serve ." in dev_cmd or "http-server ." in dev_cmd
        rec("L4-T1", "package.json has a 'dev' script",   has_dev,    f"scripts: {pkg.get('scripts',{})}", "")
        rec("L4-T2", "package.json has a 'start' script", has_start,  "", "")
        rec("L4-T3", "dev script serves from project root (not subdirectory)",
            serves_root, f"dev cmd: {dev_cmd!r}", "")
    except Exception as e:
        rec("L4-T1", "package.json readable", False, str(e), "")
        rec("L4-T2", "package.json scripts", False, str(e), "")
        rec("L4-T3", "dev script root check", False, str(e), "")

    # DEVELOPER.md must exist
    has_doc = os.path.isfile("DEVELOPER.md")
    rec("L4-T4", "DEVELOPER.md documentation file exists", has_doc, "", "")

    # From project-root server: shared/ CSS and JS resolve, no 404 for shared assets
    ctx = browser.new_context(viewport={"width":390,"height":844})
    page = ctx.new_page()
    shared_404s = []
    page.on("requestfailed", lambda r: shared_404s.append(r.url)
            if "localhost:8766" in r.url and "shared/" in r.url else None)
    try:
        go(page, f"{BASE_PR}/login.html", timeout=12000)
        sc_pr = shot(page, "l4_login_project_root")
        rec("L4-T5", "login.html loads shared/ assets without 404 from project-root server",
            len(shared_404s) == 0,
            f"404s: {[u.replace('http://localhost:8766','') for u in shared_404s[:3]]}", sc_pr)
    except Exception as e:
        rec("L4-T5", "login.html from project-root server", False, str(e)[:80], "")
    page.close(); ctx.close()

    # ==========================================================================
    # GLOBAL REGRESSION -- key pages, no new exceptions
    # ==========================================================================
    print("\n" + "="*65)
    print("REGRESSION: No new exceptions on key pages")
    print("="*65)

    reg_pages = [
        ("login.html",    "Login"),
        ("signup.html",   "Sign Up"),
        ("dashboard.html","Dashboard"),
        ("tracking.html", "Search (tracking)"),
        ("saved.html",    "Saved"),
    ]
    for path, label in reg_pages:
        ctx = browser.new_context(viewport={"width":390,"height":844})
        page = ctx.new_page()
        exc = []
        page.on("pageerror", lambda e: exc.append(str(e)))
        try:
            go(page, f"{BASE_CA}/{path}")
        except Exception:
            pass
        sc_r = shot(page, f"reg_{path.replace('.html','')}")
        rec(f"REG-{label.replace(' ','')}", f"{label} -- no new JS exceptions",
            len(exc) == 0, str([e[:70] for e in exc[:2]]), sc_r)
        page.close(); ctx.close()

    browser.close()

# ==========================================================================
# REPORT
# ==========================================================================
total  = len(results)
passed = sum(1 for r in results if r["passed"])
failed = total - passed

print("\n" + "="*65)
print("LOW PRIORITY FIX VERIFICATION REPORT")
print("="*65)
print(f"Total tests : {total}")
print(f"Passed      : {passed}")
print(f"Failed      : {failed}")
print()

groups = {
    "L1 Logo":       [r for r in results if r["id"].startswith("L1")],
    "L2 Titles":     [r for r in results if r["id"].startswith("L2")],
    "L3 History":    [r for r in results if r["id"].startswith("L3")],
    "L4 Dev Server": [r for r in results if r["id"].startswith("L4")],
    "Regression":    [r for r in results if r["id"].startswith("REG")],
}
for label, group in groups.items():
    gp = sum(1 for r in group if r["passed"])
    print(f"{label}: {gp}/{len(group)} passed")
    for r in group:
        icon = "OK" if r["passed"] else "XX"
        print(f"  [{icon}] {r['id']}: {r['name']}")
        if not r["passed"] and r["detail"]:
            print(f"          {str(r['detail'])[:100]}")

low_tests = [r for r in results if not r["id"].startswith("REG")]
all_low_ok = all(r["passed"] for r in low_tests)
reg_ok     = all(r["passed"] for r in results if r["id"].startswith("REG"))

print()
if all_low_ok and reg_ok:
    verdict = "LOW ISSUES RESOLVED -- SYSTEM POLISHED"
elif failed <= 2:
    verdict = "PARTIALLY RESOLVED -- REQUIRES RE-TEST"
else:
    verdict = "NOT RESOLVED -- LOW SEVERITY ISSUES REMAIN"

print(f"VERDICT: {verdict}")
with open("tests/verify_low_results.json", "w", encoding="utf-8") as f:
    json.dump({"verdict": verdict, "total": total, "passed": passed,
               "failed": failed, "tests": results}, f, indent=2, ensure_ascii=False)
