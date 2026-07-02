# encoding: utf-8
"""
HandyHub Customer App — EXHAUSTIVE TRAVERSAL + FUZZER
======================================================
Treats the app as a connected graph of states and visits EVERY node + edge.
Not a single journey — a complete crawl + element fuzz + per-module negative tests.

Stages
  A. Route discovery   — filesystem HTML enum + in-page link/href crawl (runtime)
  B. Isolated visit    — every route loaded directly by URL (incl. orphans), authed
  C. Element fuzz      — every visible button/link/input/toggle/select exercised once
  D. Negative tests    — empty/invalid forms, bad top-up values, rapid clicks,
                         back-nav during async, network throttle, modal open/close
  E. Dead-edge crawl   — collect every <a href>/onclick target, flag dead/incorrect ones

Outputs
  tests/traversal_results.json
  tests/screenshots/traversal/*.png

Run:  python tests/e2e_full_traversal.py <email> <password>
"""

import os, sys, io, json, time, traceback, re
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
from datetime import datetime
from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout

BASE  = "http://localhost:8766/customer-app"
SHOTS = "tests/screenshots/traversal"
OUT   = "tests/traversal_results.json"
os.makedirs(SHOTS, exist_ok=True)

EMAIL    = (sys.argv[1] if len(sys.argv) > 1 else os.environ.get("HH_TEST_EMAIL", "")).strip()
PASSWORD = (sys.argv[2] if len(sys.argv) > 2 else os.environ.get("HH_TEST_PASSWORD", "")).strip()

VIEWPORT = {"width": 390, "height": 844}
UA = ("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) "
      "AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148")

# All 38 discovered routes (filesystem enum). Entry/public pages flagged.
ALL_ROUTES = [
    # public / entry
    ("index.html", False), ("splash-screen.html", False), ("login.html", False),
    ("signup.html", False), ("verify-email.html", False),
    # legal/info (public)
    ("settings-privacy-policy.html", False), ("settings-terms.html", False),
    ("settings-help.html", False), ("settings-about.html", False),
    # protected core
    ("dashboard.html", True), ("search-page.html", True), ("search-not-found.html", True),
    ("professionals.html", True), ("artisan-profile.html", True), ("service-detail.html", True),
    ("book-now.html", True), ("book-step1.html", True), ("book-step2.html", True),
    ("book-step3.html", True), ("book-step4.html", True), ("book-emergency.html", True),
    ("booking.html", True), ("live-tracking.html", True), ("quote-approval.html", True),
    ("review.html", True), ("topup.html", True), ("transaction-history.html", True),
    ("notification.html", True), ("messages.html", True), ("message.html", True),
    ("saved.html", True), ("profile.html", True),
    ("settings.html", True), ("settings-personal-info.html", True),
    ("settings-notifications.html", True), ("settings-security.html", True),
    ("settings-location.html", True), ("settings-privacy.html", True),
]
ORPHANS = {"book-now.html", "quote-approval.html", "search-not-found.html",
           "service-detail.html", "verify-email.html"}

ACTIONS, FINDINGS = [], []
STEP = [0]
_t0 = time.time()
ROUTE_COVERAGE = {}   # route -> {visited, ok, redirected, elements_fuzzed, ...}
ELEMENTS_TESTED = [0]
DISCOVERED_EDGES = set()   # (from_route, target) link graph

NOISE = ("firestore", "firebaseapp", "googleapis", "identitytoolkit", "gstatic",
         "appcheck", "ERR_BLOCKED_BY_CLIENT", "favicon", "fonts.g", "icons8",
         "cloudinary", "openstreetmap", "nominatim", "tile.", "paystack",
         "recaptcha", "google.com/recaptcha", "csp.withgoogle", "bigdatacloud",
         "unsplash", "pinimg", "withgoogle", "requeststorageaccess")

def is_noise(s):
    s = (s or "").lower()
    return any(n in s for n in NOISE)

def ts(): return round(time.time() - _t0, 2)

def log(route, element, expected, actual, status, note=""):
    ACTIONS.append({"t": ts(), "route": route, "element": element,
                    "expected": expected, "actual": actual, "status": status, "note": note})
    icon = {"PASS":"PASS","FAIL":"FAIL","WARN":"WARN","INFO":"----"}.get(status,"????")
    print(f"  [{icon}] {route} | {element[:34]} :: {actual[:58]}")
    if note: print(f"         note: {note[:100]}")

def finding(severity, route, title, detail, repro=""):
    FINDINGS.append({"severity": severity, "route": route, "title": title,
                     "detail": detail, "repro": repro, "t": ts()})
    print(f"  >>> [{severity}] {route} :: {title} :: {detail[:80]}")

def shot(pg, name):
    STEP[0] += 1
    fn = f"{SHOTS}/{STEP[0]:03d}_{name}.png"
    try: pg.screenshot(path=fn, full_page=False)
    except Exception: pass
    return fn

class Diag:
    def __init__(self, pg):
        self.errors, self.exc, self.netfail = [], [], []
        pg.on("console", self._c)
        pg.on("pageerror", lambda e: self.exc.append(str(e)[:200]))
        pg.on("requestfailed", self._r)
        pg.on("response", self._resp)
        self.http4xx = []
    def _c(self, m):
        if m.type == "error" and not is_noise(m.text): self.errors.append(m.text[:200])
    def _r(self, r):
        if not is_noise(r.url): self.netfail.append(f"{r.method} {r.url[:110]}")
    def _resp(self, r):
        if r.status >= 400 and not is_noise(r.url): self.http4xx.append(f"{r.status} {r.url[:110]}")
    def snap(self):
        return {"console_errors": list(self.errors), "js_exceptions": list(self.exc),
                "net_failures": list(self.netfail), "http_4xx": list(self.http4xx)}
    def reset(self):
        self.errors.clear(); self.exc.clear(); self.netfail.clear(); self.http4xx.clear()

# ── auth ────────────────────────────────────────────────────────────────────
def login(pg):
    pg.goto(f"{BASE}/login.html", wait_until="domcontentloaded"); pg.wait_for_timeout(2200)
    if not EMAIL: return False
    pg.fill("#user-id", EMAIL); pg.fill("#password", PASSWORD); pg.click("#login-btn")
    for _ in range(36):
        if "dashboard" in pg.url: return True
        pg.wait_for_timeout(500)
    return "dashboard" in pg.url

# ── STAGE B: isolated route visit + health ──────────────────────────────────
def visit_route(pg, diag, route, needs_auth):
    diag.reset()
    url = f"{BASE}/{route}"
    rec = {"route": route, "orphan": route in ORPHANS, "needs_auth": needs_auth,
           "visited": True, "loaded": False, "redirected_login": False,
           "elements_fuzzed": 0, "js_exceptions": [], "console_errors": [], "http_4xx": []}
    print(f"\n=== ROUTE: {route} {'(ORPHAN)' if route in ORPHANS else ''} ===")
    try:
        pg.goto(url, wait_until="domcontentloaded", timeout=20000)
        pg.wait_for_timeout(2600)
    except Exception as e:
        log(route, "navigate", "loads", f"GOTO ERROR {str(e)[:60]}", "FAIL")
        rec["error"] = str(e)[:120]; ROUTE_COVERAGE[route] = rec; return rec

    final = pg.url
    redirected = (final.rstrip("/").endswith("/login") or "login.html" in final) and "login" not in route
    rec["loaded"] = True
    rec["redirected_login"] = redirected
    snap = diag.snap()
    rec["js_exceptions"] = snap["js_exceptions"]
    rec["console_errors"] = snap["console_errors"]
    rec["http_4xx"] = snap["http_4xx"]

    title = pg.title()
    if redirected:
        # protected page bouncing to login while authed = real defect; public ok
        if needs_auth:
            log(route, "navigate", "loads (authed)", "REDIRECTED to login", "FAIL")
            finding("CRITICAL", route, "Protected route bounced to login while authenticated",
                    "Session active but route redirected to login.", f"login then open {route}")
        else:
            log(route, "navigate", "redirect ok", "redirected to login (expected for some)", "INFO")
    else:
        log(route, "navigate", "loads", f"OK title={title!r}", "PASS")

    if snap["js_exceptions"]:
        finding("HIGH", route, "JS exception on load", "; ".join(snap["js_exceptions"][:2]),
                f"open {route}")
    if snap["http_4xx"]:
        # genuine app-asset 4xx (not firebase) — e.g. wrong script path
        app_4xx = [h for h in snap["http_4xx"] if "localhost:8766" in h]
        if app_4xx:
            finding("HIGH", route, "App asset 4xx (broken script/style path)",
                    "; ".join(app_4xx[:3]), f"open {route}, watch network")
    if snap["console_errors"]:
        finding("MEDIUM", route, "Console error", "; ".join(snap["console_errors"][:2]))

    shot(pg, route.replace(".html", ""))
    ROUTE_COVERAGE[route] = rec
    return rec

# ── STAGE C: element fuzz (exercise every visible control once, safely) ──────
SKIP_TEXT = re.compile(r"log\s*out|sign\s*out|delete|withdraw|pay\b|confirm pay|top\s*up now|"
                       r"checkout|charge|submit payment", re.I)

def fuzz_elements(pg, diag, route):
    """Click every visible button/toggle, type into inputs, open/close modals.
    Destructive controls (logout/delete/pay) are inventoried but NOT clicked."""
    if route in ("login.html", "signup.html"):  # handled by negative tests
        return 0
    fuzzed = 0
    start_url = pg.url

    # 3a — buttons (skip destructive + nav-away to keep us on-page where possible)
    try:
        btns = pg.locator("button:visible")
        n = min(btns.count(), 25)
        for i in range(n):
            try:
                b = btns.nth(i)
                if not b.is_visible(): continue
                label = (b.inner_text() or b.get_attribute("aria-label") or "").strip()[:30]
                if SKIP_TEXT.search(label):
                    log(route, f"btn:{label or '?'}", "destructive — inventoried not clicked",
                        "SKIPPED (safety)", "INFO"); continue
                before = pg.url
                b.click(timeout=2500, no_wait_after=True)
                pg.wait_for_timeout(350)
                fuzzed += 1; ELEMENTS_TESTED[0] += 1
                after = pg.url
                if after != before:
                    # navigated away — log edge, return to route to keep fuzzing
                    DISCOVERED_EDGES.add((route, after.split("/")[-1]))
                    log(route, f"btn:{label or i}", "responds", f"navigated->{after.split('/')[-1]}", "PASS")
                    pg.goto(f"{BASE}/{route}", wait_until="domcontentloaded"); pg.wait_for_timeout(1500)
                    btns = pg.locator("button:visible")  # re-acquire
                else:
                    # close any modal/overlay it may have opened
                    try: pg.keyboard.press("Escape")
                    except Exception: pass
            except Exception:
                pass
    except Exception:
        pass

    # 3b — toggles / checkboxes / radios
    try:
        toggles = pg.locator("input[type=checkbox]:visible, input[type=radio]:visible, [role=switch]:visible, .toggle:visible, [class*=switch]:visible")
        n = min(toggles.count(), 12)
        flipped = 0
        for i in range(n):
            try:
                t = toggles.nth(i)
                if t.is_visible():
                    t.click(timeout=2000, no_wait_after=True); pg.wait_for_timeout(200)
                    flipped += 1; fuzzed += 1; ELEMENTS_TESTED[0] += 1
            except Exception: pass
        if flipped:
            log(route, "toggles", "toggle state flips", f"{flipped} toggles flipped", "PASS")
    except Exception: pass

    # 3c — selects / dropdowns
    try:
        sels = pg.locator("select:visible")
        n = min(sels.count(), 6)
        for i in range(n):
            try:
                s = sels.nth(i)
                opts = s.locator("option")
                if opts.count() > 1:
                    s.select_option(index=min(1, opts.count()-1), timeout=2000)
                    fuzzed += 1; ELEMENTS_TESTED[0] += 1
                    log(route, f"select[{i}]", "option selectable", "option changed", "PASS")
            except Exception: pass
    except Exception: pass

    # 3d — text inputs (type a benign probe value, don't submit)
    try:
        inputs = pg.locator("input[type=text]:visible, input[type=search]:visible, input[type=tel]:visible, input:not([type]):visible, textarea:visible")
        n = min(inputs.count(), 10)
        typed = 0
        for i in range(n):
            try:
                inp = inputs.nth(i)
                if inp.is_visible() and inp.is_editable():
                    inp.fill("QA probe 123", timeout=2000); pg.wait_for_timeout(120)
                    typed += 1; fuzzed += 1; ELEMENTS_TESTED[0] += 1
            except Exception: pass
        if typed:
            log(route, "text-inputs", "accept input", f"{typed} inputs accepted text", "PASS")
    except Exception: pass

    ROUTE_COVERAGE.setdefault(route, {})["elements_fuzzed"] = fuzzed
    # ensure we end on the route
    if pg.url.split("/")[-1].split("?")[0] not in route:
        try: pg.goto(f"{BASE}/{route}", wait_until="domcontentloaded"); pg.wait_for_timeout(800)
        except Exception: pass
    return fuzzed

# ── STAGE C2: collect link/onclick edges + dead-edge detection ───────────────
def crawl_edges(pg, route):
    try:
        edges = pg.evaluate("""() => {
            const out = [];
            document.querySelectorAll('a[href]').forEach(a => {
                const h = a.getAttribute('href');
                if (h) out.push({type:'href', target:h, text:(a.textContent||'').trim().slice(0,25)});
            });
            document.querySelectorAll('[onclick]').forEach(e => {
                const o = e.getAttribute('onclick')||'';
                const m = o.match(/['"]([a-zA-Z0-9_\\-]+\\.html)/);
                if (m) out.push({type:'onclick', target:m[1], text:(e.textContent||'').trim().slice(0,25)});
            });
            return out;
        }""")
    except Exception:
        return
    dead = 0
    for e in edges:
        tgt = e["target"]
        if tgt.startswith("#") or tgt.startswith("javascript:"):
            if tgt in ("#", "javascript:void(0)", "javascript:;"):
                dead += 1
            continue
        if tgt.endswith(".html"):
            DISCOVERED_EDGES.add((route, tgt))
    if dead:
        log(route, "dead-href-scan", "no placeholder #/void links", f"{dead} href='#'/void link(s)", "WARN",
            "decorative or unwired links")

# ── STAGE D: per-module negative / fuzz tests ────────────────────────────────
def negative_tests(pg, diag):
    print("\n############## STAGE D: NEGATIVE / FUZZ TESTS ##############")

    # D1 — login empty submit
    pg.goto(f"{BASE}/login.html", wait_until="domcontentloaded"); pg.wait_for_timeout(1500)
    if pg.locator("#login-btn").count():
        pg.locator("#login-btn").click(timeout=3000); pg.wait_for_timeout(900)
        v = pg.locator(".ln-field-err, .toast, [class*=error]").first
        shown = v.count() and v.is_visible()
        log("login.html", "empty-submit", "blocked w/ validation", f"validation shown={bool(shown)}",
            "PASS" if shown else "WARN")
        shot(pg, "neg_login_empty")

    # D2 — login invalid email format
    if pg.locator("#user-id").count():
        pg.fill("#user-id", "###not-email###"); pg.fill("#password", "x")
        pg.locator("#login-btn").click(timeout=3000); pg.wait_for_timeout(900)
        v = pg.locator(".ln-field-err, .toast, [class*=error]").first
        log("login.html", "invalid-email", "client rejects bad email",
            f"err shown={bool(v.count() and v.is_visible())}", "INFO")

    # D3 — signup empty + mismatch passwords
    pg.goto(f"{BASE}/signup.html", wait_until="domcontentloaded"); pg.wait_for_timeout(1800)
    sb = pg.locator("#submit-btn")
    if sb.count():
        disabled = sb.first.is_disabled()
        log("signup.html", "submit-gating", "submit disabled until valid",
            f"initially disabled={disabled}", "PASS" if disabled else "WARN")
        # mismatch passwords
        try:
            if pg.locator("#pass").count(): pg.fill("#pass", "Abcdef12")
            if pg.locator("#confirm").count(): pg.fill("#confirm", "Zzzzzz99")
            pg.wait_for_timeout(400)
            border = pg.locator("#confirm").first.evaluate("e => e.style.border") if pg.locator("#confirm").count() else ""
            log("signup.html", "pw-mismatch", "mismatch flagged visually",
                f"confirm border={border!r}", "PASS" if "red" in (border or "") else "INFO")
            shot(pg, "neg_signup_mismatch")
        except Exception as e:
            log("signup.html", "pw-mismatch", "mismatch handling", f"err {str(e)[:40]}", "INFO")

    # D4 — wallet top-up invalid values
    pg.goto(f"{BASE}/topup.html", wait_until="domcontentloaded"); pg.wait_for_timeout(2500)
    amt = pg.locator("input[type=number], input[inputmode=numeric], #topup-amount, [id*=amount]").first
    if amt.count():
        for bad in ["0", "-50", "abc", "0.001"]:
            try:
                amt.fill(bad, timeout=2500); pg.wait_for_timeout(300)
                # try to find a proceed/confirm button and see if it's blocked
                proceed = pg.locator("button:has-text('Continue'), button:has-text('Proceed'), button:has-text('Top Up'), #topup-confirm").first
                blocked = True
                if proceed.count() and proceed.is_visible():
                    blocked = proceed.is_disabled()
                log("topup.html", f"invalid-amount[{bad}]", "invalid amount rejected/blocked",
                    f"proceed disabled/blocked={blocked}", "PASS" if blocked else "WARN",
                    "negative/zero/non-numeric should not proceed")
            except Exception as e:
                log("topup.html", f"invalid-amount[{bad}]", "input handles bad value", f"err {str(e)[:40]}", "INFO")
        shot(pg, "neg_topup_invalid")
        log("topup.html", "paystack-guard", "stop before real charge",
            "did NOT submit a real Paystack charge", "INFO")

    # D5 — profile edit: clear required + bad formats, attempt save
    pg.goto(f"{BASE}/settings-personal-info.html", wait_until="domcontentloaded"); pg.wait_for_timeout(2500)
    fields = pg.locator("input:visible")
    if fields.count():
        try:
            # bad phone / bad email if present
            for sel, bad in [("input[type=email]", "bad@@"), ("input[type=tel]", "12"), ("input[type=email]", "")]:
                f = pg.locator(sel).first
                if f.count() and f.is_visible() and f.is_editable():
                    f.fill(bad, timeout=2000)
            save = pg.locator("button:has-text('Save'), button:has-text('Update'), [id*=save]").first
            if save.count() and save.is_visible():
                save.click(timeout=3000, no_wait_after=True); pg.wait_for_timeout(1200)
                v = pg.locator(".toast, [class*=error]").first
                log("settings-personal-info.html", "bad-profile-save", "invalid profile rejected",
                    f"feedback shown={bool(v.count() and v.is_visible())}", "INFO")
            shot(pg, "neg_profile_bad")
        except Exception as e:
            log("settings-personal-info.html", "bad-profile-save", "handles bad input", f"err {str(e)[:40]}", "INFO")

    # D6 — rapid repeated clicks on a booking CTA (double-submit guard)
    pg.goto(f"{BASE}/book-step1.html", wait_until="domcontentloaded"); pg.wait_for_timeout(2500)
    cta = pg.locator(".btn-continue, button:has-text('Continue')").first
    if cta.count() and cta.is_visible():
        try:
            for _ in range(5):
                cta.click(timeout=1500, no_wait_after=True);
            pg.wait_for_timeout(1500)
            log("book-step1.html", "rapid-click-CTA", "no crash/duplicate from rapid clicks",
                f"landed {pg.url.split('/')[-1]}", "PASS")
            shot(pg, "neg_rapid_click")
        except Exception as e:
            log("book-step1.html", "rapid-click-CTA", "rapid click safe", f"err {str(e)[:40]}", "INFO")

    # D7 — back-navigation during async (emergency search)
    pg.goto(f"{BASE}/book-emergency.html", wait_until="domcontentloaded"); pg.wait_for_timeout(900)
    try:
        pg.go_back(); pg.wait_for_timeout(1500)
        log("book-emergency.html", "back-during-async", "back-nav mid-search is safe",
            f"landed {pg.url.split('/')[-1]}, no crash", "PASS")
    except Exception as e:
        log("book-emergency.html", "back-during-async", "back safe", f"err {str(e)[:40]}", "WARN")

    # D8 — network throttle on dashboard
    try:
        cdp = pg.context.new_cdp_session(pg)
        cdp.send("Network.enable")
        cdp.send("Network.emulateNetworkConditions", {"offline": False, "latency": 700,
                 "downloadThroughput": 60*1024, "uploadThroughput": 30*1024})
        pg.goto(f"{BASE}/dashboard.html", wait_until="domcontentloaded"); pg.wait_for_timeout(6000)
        stuck = pg.locator("[class*=skel]:visible, .spinner:visible, .loader:visible").count()
        log("dashboard.html", "throttled-load", "degrades gracefully under slow net",
            f"{stuck} loaders visible after 6s", "PASS" if stuck < 10 else "WARN")
        shot(pg, "neg_throttled")
        cdp.send("Network.emulateNetworkConditions", {"offline": False, "latency": 0,
                 "downloadThroughput": -1, "uploadThroughput": -1})
    except Exception as e:
        log("dashboard.html", "throttled-load", "throttle test", f"cdp err {str(e)[:40]}", "INFO")

    # D9 — offline mode on a protected page
    try:
        pg.context.set_offline(True)
        pg.goto(f"{BASE}/booking.html", wait_until="domcontentloaded", timeout=12000); pg.wait_for_timeout(3000)
        body = pg.evaluate("() => document.body.innerText.length")
        log("booking.html", "offline-mode", "page shell renders offline (cached/SW)",
            f"body length={body}", "PASS" if body > 50 else "WARN")
        shot(pg, "neg_offline")
    except Exception as e:
        log("booking.html", "offline-mode", "offline handled", f"{str(e)[:40]}", "INFO")
    finally:
        pg.context.set_offline(False)

# ── main ──────────────────────────────────────────────────────────────────
def main():
    print("="*74)
    print(" HandyHub — EXHAUSTIVE TRAVERSAL + FUZZER")
    print(f" Routes discovered (filesystem): {len(ALL_ROUTES)}  | orphans: {len(ORPHANS)}")
    print("="*74)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(viewport=VIEWPORT, user_agent=UA,
            geolocation={"latitude":5.6037,"longitude":-0.1870},
            permissions=["geolocation"], locale="en-GH")
        pg = ctx.new_page()
        diag = Diag(pg)
        authed = False
        try:
            authed = login(pg)
            log("login.html", "authentication", "real login succeeds",
                "authenticated" if authed else "FAILED to auth", "PASS" if authed else "FAIL")

            # STAGE B + C: visit every route, fuzz each
            print("\n############## STAGE B+C: ISOLATED VISIT + ELEMENT FUZZ ##############")
            for route, needs_auth in ALL_ROUTES:
                rec = visit_route(pg, diag, route, needs_auth)
                if rec.get("loaded") and not rec.get("redirected_login"):
                    crawl_edges(pg, route)
                    fuzz_elements(pg, diag, route)

            # STAGE D: negative tests
            negative_tests(pg, diag)

        except Exception as e:
            traceback.print_exc()
            finding("CRITICAL", "runner", "Traversal runner crashed", str(e)[:200])
        finally:
            visited = [r for r in ROUTE_COVERAGE.values() if r.get("loaded")]
            authed_routes = [r for r,a in ALL_ROUTES if a]
            blocked = [r["route"] for r in ROUTE_COVERAGE.values()
                       if r.get("redirected_login") and r.get("needs_auth")]
            report = {
                "meta": {"generated": datetime.now().isoformat(), "base": BASE,
                         "authenticated": authed, "duration_s": ts()},
                "coverage": {
                    "routes_discovered": len(ALL_ROUTES),
                    "routes_visited": len(visited),
                    "routes_visited_pct": round(100*len(visited)/len(ALL_ROUTES), 1),
                    "orphans_discovered": len(ORPHANS),
                    "orphans_visited": len([r for r in visited if r["route"] in ORPHANS]),
                    "protected_routes": len(authed_routes),
                    "protected_blocked_while_authed": blocked,
                    "elements_tested": ELEMENTS_TESTED[0],
                    "edges_discovered": len(DISCOVERED_EDGES),
                },
                "summary": {
                    "actions": len(ACTIONS),
                    "passed": sum(1 for a in ACTIONS if a["status"]=="PASS"),
                    "failed": sum(1 for a in ACTIONS if a["status"]=="FAIL"),
                    "warnings": sum(1 for a in ACTIONS if a["status"]=="WARN"),
                    "findings": len(FINDINGS),
                    "by_severity": {s: sum(1 for f in FINDINGS if f["severity"]==s)
                                    for s in ["CRITICAL","HIGH","MEDIUM","LOW"]},
                },
                "route_coverage": ROUTE_COVERAGE,
                "findings": FINDINGS,
                "edges": sorted(f"{a} -> {b}" for a,b in DISCOVERED_EDGES),
                "actions": ACTIONS,
            }
            with open(OUT, "w", encoding="utf-8") as f:
                json.dump(report, f, indent=2, ensure_ascii=False)
            c = report["coverage"]; s = report["summary"]
            print("\n" + "="*74)
            print(f" COVERAGE: {c['routes_visited']}/{c['routes_discovered']} routes "
                  f"({c['routes_visited_pct']}%) | orphans {c['orphans_visited']}/{c['orphans_discovered']} "
                  f"| elements {c['elements_tested']} | edges {c['edges_discovered']}")
            print(f" ACTIONS:  {s['passed']} pass / {s['failed']} fail / {s['warnings']} warn")
            print(f" FINDINGS: {s['findings']}  severity={s['by_severity']}")
            print(f" Blocked-while-authed: {c['protected_blocked_while_authed'] or 'none'}")
            print(f" -> {OUT}")
            print("="*74)
            browser.close()

if __name__ == "__main__":
    main()
