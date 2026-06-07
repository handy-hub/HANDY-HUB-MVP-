# HandyHub Customer App - Phase 1: Full Page Scan
# Visits every page, captures console errors, network failures, screenshots, element inventory
# encoding: utf-8

import sys
import os
import json
import time
from playwright.sync_api import sync_playwright

BASE = "http://localhost:8765"
SHOTS = "tests/screenshots/audit"
os.makedirs(SHOTS, exist_ok=True)

PAGES = [
    ("splash-screen.html",         "Splash Screen",           False),
    ("index.html",                 "Index / Entry",           False),
    ("login.html",                 "Login",                   False),
    ("signup.html",                "Signup",                  False),
    ("dashboard.html",             "Dashboard",               True),
    ("search-not-found.html",      "Search Not Found",        False),
    ("book-step1.html",            "Book Step 1",             True),
    ("book-step2.html",            "Book Step 2",             True),
    ("book-step3.html",            "Book Step 3",             True),
    ("book-step4.html",            "Book Step 4",             True),
    ("book-now.html",              "Book Now",                True),
    ("book-emergency.html",        "Book Emergency",          True),
    ("booking.html",               "Booking History",         True),
    ("live-tracking.html",         "Live Tracking",           True),
    ("tracking.html",              "Tracking",                True),
    ("notification.html",          "Notifications",           True),
    ("messages.html",              "Messages",                True),
    ("message.html",               "Message Thread",          True),
    ("saved.html",                 "Saved",                   True),
    ("profile.html",               "Profile",                 True),
    ("personal-Info.html",         "Personal Info",           True),
    ("topup.html",                 "Top Up",                  True),
    ("transaction-history.html",   "Transaction History",     True),
    ("review.html",                "Review",                  True),
    ("settings.html",              "Settings",                True),
    ("settings-personal-info.html","Settings Personal Info",  True),
    ("settings-security.html",     "Settings Security",       True),
    ("settings-notifications.html","Settings Notifications",  True),
    ("settings-location.html",     "Settings Location",       True),
    ("settings-privacy.html",      "Settings Privacy",        True),
    ("settings-privacy-policy.html","Privacy Policy",         False),
    ("settings-terms.html",        "Terms of Service",        False),
    ("settings-help.html",         "Help",                    False),
    ("settings-about.html",        "About",                   False),
]

FIREBASE_PATTERNS = [
    "firestore", "firebase", "auth/", "googleapis", "firebaseapp",
    "identitytoolkit", "ERR_BLOCKED_BY_CLIENT", "net::ERR_NAME_NOT_RESOLVED",
]

def is_firebase_noise(msg):
    m = msg.lower()
    return any(p in m for p in FIREBASE_PATTERNS)

results = []

def run_audit():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(
            viewport={"width": 390, "height": 844},  # iPhone 14 viewport
            user_agent="Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15"
        )

        for path, label, needs_auth in PAGES:
            url = f"{BASE}/{path}"
            print(f"\n[SCAN] {label} -> {path}")

            page = context.new_page()
            console_errors   = []
            console_warnings = []
            js_exceptions    = []
            net_failures     = []
            net_requests     = []

            # Capture console
            def on_console(msg, label=label):
                text = msg.text
                if msg.type == "error":
                    if not is_firebase_noise(text):
                        console_errors.append(text)
                    # Always record firebase errors separately
                elif msg.type == "warning":
                    if not is_firebase_noise(text):
                        console_warnings.append(text)

            page.on("console", on_console)

            # Capture JS exceptions
            page.on("pageerror", lambda exc: js_exceptions.append(str(exc)))

            # Capture network failures
            def on_fail(req):
                url_str = req.url
                if not is_firebase_noise(url_str):
                    net_failures.append(f"{req.method} {url_str}")
            page.on("requestfailed", on_fail)

            # Track all requests
            page.on("request", lambda req: net_requests.append(req.url))

            try:
                response = page.goto(url, wait_until="domcontentloaded", timeout=15000)
                status = response.status if response else 0
                time.sleep(1.5)  # allow JS to execute

                final_url = page.url
                title     = page.title()

                # Count elements
                buttons   = page.locator("button").count()
                links     = page.locator("a[href]").count()
                inputs    = page.locator("input, textarea, select").count()
                forms     = page.locator("form").count()
                images    = page.locator("img").count()
                broken_imgs = 0

                # Check for broken images
                for img in page.locator("img").all():
                    try:
                        nat_w = page.evaluate("el => el.naturalWidth", img.element_handle())
                        if nat_w == 0:
                            broken_imgs += 1
                    except Exception:
                        pass

                # Detect spinners / loaders stuck on screen
                spinners = page.locator(
                    ".spinner, .loading, .loader, [class*='spin'], [class*='load']"
                ).count()

                # Detect error states visible on page
                error_els = page.locator(
                    ".error, .error-state, [class*='error'], .toast.error, .alert-error"
                ).count()

                # Check redirect
                redirected  = final_url != url
                redirect_to = final_url if redirected else None

                # Screenshot
                shot_name = path.replace("/", "_").replace(".html", "")
                shot_path = f"{SHOTS}/{shot_name}.png"
                page.screenshot(path=shot_path, full_page=True)

                result = {
                    "page":          path,
                    "label":         label,
                    "needs_auth":    needs_auth,
                    "http_status":   status,
                    "title":         title,
                    "final_url":     final_url,
                    "redirected":    redirected,
                    "redirect_to":   redirect_to,
                    "console_errors":   console_errors,
                    "console_warnings": console_warnings,
                    "js_exceptions":    js_exceptions,
                    "net_failures":     [f for f in net_failures if f],
                    "broken_imgs":   broken_imgs,
                    "spinners":      spinners,
                    "error_els":     error_els,
                    "buttons":       buttons,
                    "links":         links,
                    "inputs":        inputs,
                    "forms":         forms,
                    "images":        images,
                    "screenshot":    shot_path,
                }
                results.append(result)

                # Print summary
                status_icon = "OK" if status == 200 else f"HTTP {status}"
                redir_str   = f" -> REDIR:{final_url}" if redirected else ""
                err_str     = f" CONSOLE_ERRS:{len(console_errors)}" if console_errors else ""
                exc_str     = f" JS_EXC:{len(js_exceptions)}" if js_exceptions else ""
                net_str     = f" NET_FAIL:{len(net_failures)}" if net_failures else ""
                bi_str      = f" BROKEN_IMG:{broken_imgs}" if broken_imgs else ""
                print(f"  [{status_icon}]{redir_str}{err_str}{exc_str}{net_str}{bi_str}")
                print(f"  Title: {title!r} | btn:{buttons} link:{links} input:{inputs} form:{forms}")

                if console_errors:
                    for e in console_errors[:3]:
                        print(f"  ERROR: {e[:120]}")
                if js_exceptions:
                    for e in js_exceptions[:2]:
                        print(f"  JS_EXC: {str(e)[:120]}")

            except Exception as ex:
                print(f"  [CRASH] {ex}")
                results.append({
                    "page": path, "label": label, "needs_auth": needs_auth,
                    "crash": str(ex), "console_errors": [], "js_exceptions": [],
                    "net_failures": [], "buttons": 0, "links": 0,
                })
            finally:
                page.close()

        browser.close()

    # Save raw results
    with open("tests/audit_phase1_results.json", "w", encoding="utf-8") as f:
        json.dump(results, f, indent=2, ensure_ascii=False)
    print("\n\nRaw results saved to tests/audit_phase1_results.json")
    return results

if __name__ == "__main__":
    run_audit()
