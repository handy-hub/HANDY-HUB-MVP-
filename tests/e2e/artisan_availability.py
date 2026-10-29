"""Audit FLOW-001 / FLOW-002 / FLOW-008 / FLOW-004 — in a real browser.

An artisan's availability is their choice. Browsing the app, reloading, losing
the connection or reopening the dashboard must never change it; the dashboard
card and the nav toggle must always agree; and a Firestore outage must never
send an approved artisan into onboarding.

Runs against the emulators with the seeded artisan (npm run seed:e2e) and a
real sign-in through the artisan login page:

    npm run emulators                    # Firestore 8080, Auth 9099, Functions 5001
    npm run seed:e2e
    python -m http.server 8791           # from the repo root
    npm run test:availability-e2e

The database is read through the Firestore emulator's REST API with the
emulator's admin bypass ("Bearer owner") — never production.
"""
import json
import os
import sys
import time
import urllib.request

from playwright.sync_api import sync_playwright

BASE = os.environ.get("E2E_BASE", "http://localhost:8791")   # E2E_BASE: serve another tree
PROJECT = "lamax-4fd82"
DB_ID = "ai-studio-5589039d-72c4-40d8-ae39-f35c6c321eb6"
ART = ("artisan@e2e.test", "Passw0rd!23", "e2e_artisan_1")
DOCS = f"http://127.0.0.1:8080/v1/projects/{PROJECT}/databases/{DB_ID}/documents"

results = []


def check(name, ok, detail=""):
    results.append((name, ok, detail))
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f"   {detail}" if detail else ""))


def field(doc, name):
    v = (doc.get("fields") or {}).get(name)
    if not v:
        return None
    return v.get("booleanValue", v.get("stringValue"))


def read_doc(path):
    req = urllib.request.Request(f"{DOCS}/{path}", headers={"Authorization": "Bearer owner"})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.load(r)
    except Exception:
        return {}


def availability():
    d = read_doc(f"artisans/{ART[2]}")
    return field(d, "isAvailable"), field(d, "isOnline")


def write_available(value):
    """Reset the stored choice through the emulator (admin), between scenarios."""
    body = json.dumps({"fields": {"isAvailable": {"booleanValue": value}, "isOnline": {"booleanValue": value}}}).encode()
    url = f"{DOCS}/artisans/{ART[2]}?updateMask.fieldPaths=isAvailable&updateMask.fieldPaths=isOnline"
    req = urllib.request.Request(url, data=body, method="PATCH",
                                 headers={"Authorization": "Bearer owner", "Content-Type": "application/json"})
    urllib.request.urlopen(req, timeout=10).read()


def wait_for(pred, timeout_s=25):
    """Poll until pred() is true. Returns (ok, seconds). A write made just after
    the connection comes back is acknowledged only once Firestore reconnects."""
    t0 = time.time()
    while time.time() - t0 < timeout_s:
        if pred():
            return True, round(time.time() - t0, 1)
        time.sleep(0.5)
    return False, round(time.time() - t0, 1)


def text(pg, sel):
    try:
        return pg.locator(sel).first.inner_text(timeout=2000).strip()
    except Exception:
        return ""


with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={"width": 390, "height": 844},
                        geolocation={"latitude": 5.6037, "longitude": -0.1870}, permissions=["geolocation"])
    pg = ctx.new_page()
    errs = []
    logs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.on("console", lambda m: logs.append(f"{m.type}: {m.text[:200]}") if m.type in ("warning", "error") and "emulator" not in m.text else None)
    go = lambda page, wait=3500: (pg.goto(f"{BASE}/artisan-app/{page}", wait_until="domcontentloaded"), pg.wait_for_timeout(wait))

    write_available(True)
    pg.goto(f"{BASE}/artisan-app/login.html?emulator=1", wait_until="domcontentloaded")
    pg.wait_for_timeout(1500)
    pg.fill("#login-email", ART[0])
    pg.fill("#login-password", ART[1])
    pg.click("#login-btn")
    try:
        pg.wait_for_url("**/dashboard.html*", timeout=25000)
        check("real artisan sign-in against the Auth emulator", True)
    except Exception:
        check("real artisan sign-in against the Auth emulator", False, pg.url)
        print("cannot continue"); sys.exit(1)
    pg.wait_for_timeout(3500)

    # ── FLOW-001: browsing never changes availability ─────────────────────────
    print("\nFLOW-001 · an online artisan stays online while browsing")
    for page in ["wallet.html", "profile.html", "settings.html", "notifications.html", "jobs.html", "dashboard.html"]:
        go(page)
        av, on = availability()
        check(f"after opening {page:20} isAvailable stays true", av is True, f"isAvailable={av} isOnline={on}")
    pg.reload(wait_until="domcontentloaded"); pg.wait_for_timeout(3500)
    check("a dashboard reload keeps it", availability()[0] is True)
    check("the dashboard card says online", "You are online" in text(pg, "#status-title"), text(pg, "#status-title"))
    check("the nav toggle agrees (FLOW-008)", text(pg, "#hh-online-label") == "Online", text(pg, "#hh-online-label"))

    # ── FLOW-002: an explicit offline choice persists ─────────────────────────
    print("\nFLOW-002 · Go Offline stays offline")
    pg.click("#toggle-status-btn"); pg.wait_for_timeout(3000)
    check("Go Offline is saved", availability()[0] is False, str(availability()))
    check("the nav toggle follows the card live (FLOW-008)", text(pg, "#hh-online-label") == "Offline", text(pg, "#hh-online-label"))
    for page in ["wallet.html", "dashboard.html", "jobs.html", "dashboard.html"]:
        go(page)
        check(f"after opening {page:20} isAvailable stays false", availability()[0] is False, str(availability()))
    pg.reload(wait_until="domcontentloaded"); pg.wait_for_timeout(3500)
    check("a reload does not bring it back online", availability()[0] is False)
    check("the card says offline after the reload", "You are offline" in text(pg, "#status-title"), text(pg, "#status-title"))
    ctx.set_offline(True); pg.wait_for_timeout(1500)
    ctx.set_offline(False)
    # Playwright's emulated geolocation stops answering after offline emulation;
    # re-apply it (a test-harness artifact — on a device presenceService bounds
    # the GPS wait at 12 s and reports it).
    ctx.set_geolocation({"latitude": 5.6037, "longitude": -0.1870})
    pg.wait_for_timeout(3500)
    check("losing and regaining the connection does not reactivate", availability()[0] is False, str(availability()))
    pg.evaluate("document.dispatchEvent(new Event('visibilitychange'))"); pg.wait_for_timeout(1500)
    check("the tab coming back into view does not reactivate", availability()[0] is False)

    # ── Explicit reactivation, from the nav toggle ────────────────────────────
    print("\nGo Online again, from the nav")
    logs.clear()
    pg.click("#hh-online-toggle")
    ok, secs = wait_for(lambda: availability()[0] is True)
    check("Go Online from the nav is saved", ok, f"{availability()} after {secs}s")
    if not ok:
        pg.wait_for_timeout(100)   # let Playwright deliver queued console events
        print("      console:", " || ".join(logs[-5:]) or "(nothing)")
    ok, secs = wait_for(lambda: "You are online" in text(pg, "#status-title") and text(pg, "#hh-online-label") == "Online", 10)
    check("the dashboard card and the nav both show it (FLOW-008)", ok, f"card={text(pg, '#status-title')!r} nav={text(pg, '#hh-online-label')!r} after {secs}s")
    go("settings.html"); go("dashboard.html")
    check("and it survives navigation", availability()[0] is True)

    # ── Go Online from the card while a job is being tracked ──────────────────
    # The seeded artisan has en_route / in_progress jobs, so the dashboard runs a
    # watchPosition. Go Online used to start a second GPS request beside it, and
    # that request timed out (Wallet → Dashboard → card, 3/3 on 28 Oct).
    print("\nGo Online from the dashboard card, with a job being tracked (3 attempts)")
    probe = """() => new Promise((res) => navigator.geolocation.getCurrentPosition(
        () => res('answered'), (e) => res('error ' + e.code), { maximumAge: 0, timeout: 8000 }))"""
    for attempt in (1, 2, 3):
        write_available(False)
        go("wallet.html"); go("dashboard.html")
        if attempt == 1:
            # Diagnostic only: does a second, uncached request answer beside the watch?
            print(f"      raw getCurrentPosition beside the watch: {pg.evaluate(probe)}")
            go("wallet.html"); go("dashboard.html")
        logs.clear()
        pg.click("#toggle-status-btn")
        ok, secs = wait_for(lambda: availability()[0] is True, 20)
        body = pg.evaluate("() => document.body.innerText")
        check(f"attempt {attempt}: Go Online from the card is saved", ok, f"{availability()} after {secs}s")
        check(f"attempt {attempt}: no location time-out shown", "timed out" not in body.lower())
        if not ok:
            pg.wait_for_timeout(100)
            print("      console:", " || ".join(logs[-5:]) or "(nothing)")

    # ── FLOW-004: an outage is not a missing account ──────────────────────────
    print("\nFLOW-004 · Firestore unreachable (the audit's reproduction, 3 attempts)")
    navs = []
    pg.on("framenavigated", lambda f: navs.append(f.url) if f == pg.main_frame else None)
    for attempt in (1, 2, 3):
        go("wallet.html")
        navs.clear()
        pg.route("http://127.0.0.1:8080/**", lambda r: r.abort())
        pg.goto(f"{BASE}/artisan-app/dashboard.html", wait_until="domcontentloaded"); pg.wait_for_timeout(7000)
        check(f"attempt {attempt}: the dashboard does not redirect to onboarding",
              not any("onboarding" in u for u in navs), " → ".join(u.split("/")[-1] for u in navs))
        body = pg.evaluate("() => document.body.innerText")
        check(f"attempt {attempt}: it says it cannot reach the server, with Retry", "can't reach Fidus X" in body and "Retry" in body)
        check(f"attempt {attempt}: the last known profile is still painted", "Kwame" in body, body[:80].replace("\n", " | "))
        pg.unroute("http://127.0.0.1:8080/**")
    pg.reload(wait_until="domcontentloaded"); pg.wait_for_timeout(4000)
    body = pg.evaluate("() => document.body.innerText")
    check("Retry after the connection returns restores the dashboard", "dashboard" in pg.url and "can't reach" not in body)

    check("no uncaught page errors", not errs, "; ".join(errs[:3]))
    b.close()

failed = [r for r in results if not r[1]]
print(f"\nartisan-availability (browser): {len(results) - len(failed)} passed, {len(failed)} failed")
sys.exit(1 if failed else 0)
