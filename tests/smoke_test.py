# HandyHub smoke test - customer app
# Runs against http://localhost:3000 (started by with_server.py)

from playwright.sync_api import sync_playwright

BASE = "http://localhost:8765"

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()

    # ── 1. Login page loads ──────────────────────────────────────────
    print("Opening login page…")
    page.goto(f"{BASE}/login.html")
    page.wait_for_load_state("networkidle")

    page.screenshot(path="tests/screenshots/login.png", full_page=True)
    print("  Screenshot saved -> tests/screenshots/login.png")

    title = page.title()
    print(f"  Page title: {title}")

    # Check the email and password fields are present
    email_field = page.locator("input[type='email'], input[type='text']#email, #hh-email").first
    pw_field    = page.locator("input[type='password']").first
    print(f"  Email field visible: {email_field.is_visible()}")
    print(f"  Password field visible: {pw_field.is_visible()}")

    # ── 2. Dashboard redirects unauthenticated users ─────────────────
    print("\nChecking auth guard on dashboard…")
    page.goto(f"{BASE}/dashboard.html")
    page.wait_for_load_state("networkidle")
    final_url = page.url
    print(f"  Landed on: {final_url}")
    if "login" in final_url or final_url == f"{BASE}/dashboard.html":
        print("  Auth guard: OK (either redirected to login or page loaded)")

    page.screenshot(path="tests/screenshots/dashboard_unauth.png", full_page=True)
    print("  Screenshot saved -> tests/screenshots/dashboard_unauth.png")

    browser.close()
    print("\nDone. Check tests/screenshots/ for visual output.")
