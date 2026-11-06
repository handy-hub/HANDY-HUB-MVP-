"""A quote must attach to the job the artisan is looking at — and no other.

Two bookings sit at `inspection_done` (the quoting phase) for the SAME artisan.
Before the composer was extracted, pricing either one meant leaving job.html for
jobs.html, where the sheet read a module-scoped `_quoteBookingId` set by whichever
card was tapped last. This test opens each job directly and proves the composer
mounted inside it is bound to that booking.
"""
import json
import sys
import urllib.request
from playwright.sync_api import sync_playwright

BASE = "http://localhost:8791/artisan-app"
A = ("HHB-QUOTE-A", "Plumbing")
B = ("HHB-QUOTE-B", "Electrical")

ARTISAN = ("artisan@e2e.test", "Passw0rd!23")

# The two quoting-phase bookings this test needs. npm run seed:e2e never created
# them, so the test opened two missing jobs; it now writes them itself, through
# the Firestore EMULATOR's REST API with its admin bypass ("Bearer owner") —
# 127.0.0.1 only, never production.
PROJECT = "lamax-4fd82"
DB_ID = "ai-studio-5589039d-72c4-40d8-ae39-f35c6c321eb6"
DOCS = f"http://127.0.0.1:8080/v1/projects/{PROJECT}/databases/{DB_ID}/documents"


def _value(v):
    if isinstance(v, bool): return {"booleanValue": v}
    if isinstance(v, (int, float)): return {"integerValue": str(v)} if isinstance(v, int) else {"doubleValue": v}
    return {"stringValue": str(v)}


def seed_quote_booking(bid, service):
    fields = {"id": bid, "bookingId": bid, "artisanId": "e2e_artisan_1", "customerId": "e2e_customer_1",
              "status": "inspection_done", "track": "inspection", "calloutPaid": True, "calloutFee": 60,
              "serviceType": service.lower(), "description": f"{service} problem to price",
              "createdAt": "2026-11-06T09:00:00.000Z", "updatedAt": "2026-11-06T09:30:00.000Z"}
    body = json.dumps({"fields": {k: _value(v) for k, v in fields.items()}}).encode()
    req = urllib.request.Request(f"{DOCS}/bookings/{bid}", data=body, method="PATCH",
                                 headers={"Authorization": "Bearer owner", "Content-Type": "application/json"})
    urllib.request.urlopen(req, timeout=10).read()


for _bid, _svc in (("HHB-QUOTE-A", "Plumbing"), ("HHB-QUOTE-B", "Electrical")):
    seed_quote_booking(_bid, _svc)

results = []
def check(name, ok, detail=""):
    results.append((name, ok))
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f"   {detail}" if detail else ""))

STATE = """() => {
    const root = document.querySelector('.qc');
    const sub  = document.getElementById('qc-submit');
    return {
        mounted:   !!root,
        boundTo:   root ? root.getAttribute('data-booking') : null,
        forText:   document.querySelector('.qc-for') ? document.querySelector('.qc-for').textContent.trim() : null,
        submitOff: sub ? sub.disabled : null,
        total:     document.getElementById('qc-s-tot') ? document.getElementById('qc-s-tot').textContent : null,
        url:       location.href,
    };
}"""

with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={"width": 390, "height": 844})
    pg = ctx.new_page()
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))

    # A REAL artisan sign-in. Stubbing only the auth *guard* leaves Firebase Auth
    # with no user, so every Firestore read is unauthenticated and denied by
    # rules — the screen then sits on its skeleton forever. The guard is not the
    # thing that authorises reads; the signed-in user is.
    pg.goto(f"{BASE}/login.html?emulator=1", wait_until="domcontentloaded")
    pg.wait_for_timeout(2500)
    pg.fill("#login-email", ARTISAN[0])
    pg.fill("#login-password", ARTISAN[1])
    pg.click("#login-btn")
    try:
        pg.wait_for_url("**/dashboard.html*", timeout=25000)
        check("real artisan sign-in", True, pg.url.split("/")[-1][:36])
    except Exception:
        check("real artisan sign-in", False, f"stuck at {pg.url.split('/')[-1][:50]}")
    pg.wait_for_timeout(1200)

    def open_job(bid):
        pg.goto(f"{BASE}/job.html?id={bid}", wait_until="domcontentloaded")
        pg.wait_for_timeout(4500)
        return pg.evaluate(STATE)

    # ── A ────────────────────────────────────────────────────────────────────
    s = open_job(A[0])
    check("composer mounts INSIDE job A (no navigation away)",
          s["mounted"] and "job.html" in s["url"], f"url={s['url'].split('/')[-1][:40]}")
    check("composer is bound to booking A", s["boundTo"] == A[0], f"bound to {s['boundTo']!r}")
    check("composer names A's service", s["forText"] and A[1].lower() in s["forText"].lower(),
          f"{(s['forText'] or '')[:48]!r}")
    check("submit is disabled until a price is entered", s["submitOff"] is True)

    # typing a price enables it, and the total is computed not invented
    pg.fill("#qc-labour", "250")
    pg.wait_for_timeout(400)
    s2 = pg.evaluate(STATE)
    check("entering labour enables submit and totals correctly",
          s2["submitOff"] is False and s2["total"] == "250.00", f"total={s2['total']} disabled={s2['submitOff']}")

    # ── B ────────────────────────────────────────────────────────────────────
    s = open_job(B[0])
    check("composer is bound to booking B", s["boundTo"] == B[0], f"bound to {s['boundTo']!r}")
    check("composer names B's service", s["forText"] and B[1].lower() in s["forText"].lower(),
          f"{(s['forText'] or '')[:48]!r}")
    # An empty form's total is "—", not "0.00", since 307b37c (2026-10-20): no
    # amount is shown until the quote is valid. A value carried over would be "250.00".
    check("B's form starts clean — no value carried over from A",
          s["total"] == "—" and s["submitOff"] is True, f"total={s['total']}")

    # ── refresh keeps the binding ────────────────────────────────────────────
    pg.reload(wait_until="domcontentloaded")
    pg.wait_for_timeout(4500)
    s = pg.evaluate(STATE)
    check("refresh keeps the composer bound to B", s["boundTo"] == B[0], f"bound to {s['boundTo']!r}")

    # ── back returns to A, still bound to A ──────────────────────────────────
    pg.go_back(wait_until="domcontentloaded")
    pg.wait_for_timeout(4500)
    s = pg.evaluate(STATE)
    check("browser BACK returns a composer bound to A", s["boundTo"] == A[0], f"bound to {s['boundTo']!r}")

    real = [e for e in errs if not any(t in e.lower() for t in
            ("app-check", "appcheck", "installations", "err_blocked", "403", "messaging", "permission"))]
    check("no unexpected JS errors", not real, real[0][:110] if real else "")

    ctx.close(); b.close()

bad = [r for r in results if not r[1]]
print(f"\n{len(results)-len(bad)}/{len(results)} checks passed")
sys.exit(1 if bad else 0)
