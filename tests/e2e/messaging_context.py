"""Booking context must not leak between two conversations with the SAME artisan.

This is the hardest case in the product: `directChatId(a, b)` is deterministic,
so a customer and artisan share ONE thread no matter how many jobs they have.
The thread cannot tell you which job is being discussed — only the URL can.

Booking A (Plumbing) and Booking B (Electrical) share a customer AND an artisan
here deliberately. If context came from the chat document, both would show
whichever job was messaged about first.
"""
import sys
from playwright.sync_api import sync_playwright

BASE = "http://localhost:8791"
CUST = ("customer@e2e.test", "Passw0rd!23")
A = ("HHB-E2E-PLUMB-A", "Plumbing")
B = ("HHB-E2E-ELEC-B",  "Electrical")

results = []
def check(name, ok, detail=""):
    results.append((name, ok))
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f"   {detail}" if detail else ""))

CHIP = """() => {
    const el = document.getElementById('chat-booking-chip');
    return { hidden: el ? el.hidden : null, text: el ? el.textContent.trim() : null,
             url: location.href };
}"""

with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={"width": 390, "height": 844})
    pg = ctx.new_page()
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))

    pg.goto(f"{BASE}/customer-app/login.html?emulator=1", wait_until="domcontentloaded")
    pg.wait_for_timeout(2000)
    pg.fill("#user-id", CUST[0]); pg.fill("#password", CUST[1]); pg.click("#login-btn")
    pg.wait_for_url("**/dashboard.html*", timeout=25000)
    pg.wait_for_timeout(1200)

    def open_messages(bid):
        pg.goto(f"{BASE}/customer-app/messages.html?bookingId={bid}", wait_until="domcontentloaded")
        pg.wait_for_timeout(4000)
        return pg.evaluate(CHIP)

    # ── A ────────────────────────────────────────────────────────────────────
    c = open_messages(A[0])
    check("message from booking A shows PLUMBING context",
          c["text"] is not None and A[1].lower() in c["text"].lower(), f"chip={c['text']!r}")

    # ── B (same artisan, same thread) ────────────────────────────────────────
    c = open_messages(B[0])
    check("message from booking B shows ELECTRICAL context",
          c["text"] is not None and B[1].lower() in c["text"].lower(), f"chip={c['text']!r}")

    # ── refresh B ────────────────────────────────────────────────────────────
    pg.reload(wait_until="domcontentloaded"); pg.wait_for_timeout(4000)
    c = pg.evaluate(CHIP)
    check("B survives a REFRESH as electrical",
          c["text"] is not None and B[1].lower() in c["text"].lower(), f"chip={c['text']!r}")

    # ── back to A: the earlier context must not have stuck ───────────────────
    c = open_messages(A[0])
    check("returning to A shows PLUMBING again, not the last-used booking",
          c["text"] is not None and A[1].lower() in c["text"].lower(), f"chip={c['text']!r}")

    # ── browser back/forward ─────────────────────────────────────────────────
    pg.go_back(wait_until="domcontentloaded"); pg.wait_for_timeout(3500)
    c = pg.evaluate(CHIP)
    check("browser BACK restores the electrical context",
          c["text"] is not None and B[1].lower() in c["text"].lower(), f"chip={c['text']!r}")

    # ── no booking id at all: no chip, and no invented one ───────────────────
    pg.goto(f"{BASE}/customer-app/messages.html", wait_until="domcontentloaded")
    pg.wait_for_timeout(3000)
    c = pg.evaluate(CHIP)
    check("plain messages.html invents NO booking context",
          c["hidden"] is True or not c["text"], f"chip hidden={c['hidden']} text={c['text']!r}")

    # ── a booking that is not this customer's: nothing shown, no crash ───────
    pg.goto(f"{BASE}/customer-app/messages.html?bookingId=AUTHZ-BOOKING-1", wait_until="domcontentloaded")
    pg.wait_for_timeout(3500)
    c = pg.evaluate(CHIP)
    check("a booking the customer cannot read shows NO chip (no leak, no crash)",
          c["hidden"] is True or not c["text"], f"chip hidden={c['hidden']} text={c['text']!r}")

    real = [e for e in errs if not any(t in e.lower() for t in
            ("app-check", "appcheck", "installations", "err_blocked", "403", "messaging", "permission"))]
    check("no unexpected JS errors", not real, real[0][:110] if real else "")

    ctx.close(); b.close()

bad = [r for r in results if not r[1]]
print(f"\n{len(results)-len(bad)}/{len(results)} checks passed")
sys.exit(1 if bad else 0)
