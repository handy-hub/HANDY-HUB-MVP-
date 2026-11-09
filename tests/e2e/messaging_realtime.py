"""Two real accounts, one thread, messages crossing live in both directions.

Before this, chatRepository, the participant-based Firestore rules and the
onSnapshot listeners all existed — but only the customer app had a screen. A
customer could write into a thread no artisan could read. This drives BOTH sides
in two browser contexts simultaneously and proves the loop closes.

Realtime is asserted the only honest way: send from one context and wait for it
to appear in the OTHER without any reload or navigation.
"""
import sys
from playwright.sync_api import sync_playwright

BASE      = "http://localhost:8791"
CUSTOMER  = ("customer@e2e.test", "Passw0rd!23")
ARTISAN   = ("artisan@e2e.test",  "Passw0rd!23")
BOOKING   = "HHB-E2E-PLUMB-A"          # plumbing, customer e2e_customer_1 <-> artisan e2e_artisan_1

results = []
def check(name, ok, detail=""):
    results.append((name, ok))
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f"   {detail}" if detail else ""))

def bubbles(page):
    """Message text currently rendered, whichever app is showing."""
    return page.evaluate("""() => Array.from(
        document.querySelectorAll('.ms-bubble, .ms-message, [class*=bubble]')
    ).map(e => e.textContent.trim()).filter(Boolean)""")

def wait_for_text(page, needle, timeout_ms=20000):
    """Poll the DOM for text arriving via a live listener — never reload."""
    waited = 0
    while waited < timeout_ms:
        try:
            if any(needle in b for b in bubbles(page)):
                return True
        except Exception:
            pass
        page.wait_for_timeout(500)
        waited += 500
    return False

STAMP = __import__("time").strftime("%H%M%S")
MSG_FROM_CUSTOMER = f"Customer says hello {STAMP}"
MSG_FROM_ARTISAN  = f"Artisan replies here {STAMP}"

with sync_playwright() as p:
    b = p.chromium.launch()

    # Two independent browser contexts = two genuinely separate signed-in users.
    cust_ctx = b.new_context(viewport={"width": 390, "height": 844})
    art_ctx  = b.new_context(viewport={"width": 390, "height": 844})
    cust = cust_ctx.new_page()
    art  = art_ctx.new_page()

    cerr, aerr = [], []
    cust.on("pageerror", lambda e: cerr.append(str(e)))
    art.on("pageerror",  lambda e: aerr.append(str(e)))

    # ── sign in both sides ───────────────────────────────────────────────────
    cust.goto(f"{BASE}/customer-app/login.html?emulator=1", wait_until="domcontentloaded")
    cust.wait_for_timeout(2200)
    cust.fill("#user-id", CUSTOMER[0]); cust.fill("#password", CUSTOMER[1]); cust.click("#login-btn")
    try:
        cust.wait_for_url("**/dashboard.html*", timeout=25000)
        check("customer signs in", True)
    except Exception:
        check("customer signs in", False, cust.url.split('/')[-1][:40])

    art.goto(f"{BASE}/artisan-app/login.html?emulator=1", wait_until="domcontentloaded")
    art.wait_for_timeout(2200)
    art.fill("#si-email", ARTISAN[0]); art.fill("#si-password", ARTISAN[1]); art.click("#si-submit")
    try:
        art.wait_for_url("**/dashboard.html*", timeout=25000)
        check("artisan signs in", True)
    except Exception:
        check("artisan signs in", False, art.url.split('/')[-1][:40])

    # ── the artisan screen exists at all ─────────────────────────────────────
    art.goto(f"{BASE}/artisan-app/messages.html?bookingId={BOOKING}", wait_until="domcontentloaded")
    art.wait_for_timeout(6000)
    art_state = art.evaluate("""() => ({
        url: location.href,
        hasCompose: !!document.getElementById('ms-input'),
        chatOpen: !!document.querySelector('.ms-chat.open'),
        jobChip: document.getElementById('ms-job-chip') && !document.getElementById('ms-job-chip').hidden
                 ? document.getElementById('ms-job-chip').textContent.trim() : null,
    })""")
    check("artisan messages screen loads (did not exist before)",
          "messages.html" in art_state["url"] and art_state["hasCompose"],
          f"compose={art_state['hasCompose']}")
    check("opening from a booking lands IN the conversation",
          art_state["chatOpen"], f"chatOpen={art_state['chatOpen']}")
    check("artisan sees which job it is about",
          bool(art_state["jobChip"]), f"chip={art_state['jobChip']!r}")

    # ── customer opens the same thread ───────────────────────────────────────
    cust.goto(f"{BASE}/customer-app/messages.html?bookingId={BOOKING}", wait_until="domcontentloaded")
    cust.wait_for_timeout(6000)

    # ── customer -> artisan, live ────────────────────────────────────────────
    sent = False
    try:
        cust.fill("#ms-msg-input", MSG_FROM_CUSTOMER)
        cust.wait_for_timeout(300)
        cust.evaluate("() => window.sendMessage && window.sendMessage()")
        sent = True
    except Exception as e:
        check("customer can send", False, str(e)[:90])
    if sent:
        check("customer can send", True)
        check("REALTIME: artisan receives it with NO reload",
              wait_for_text(art, MSG_FROM_CUSTOMER),
              f"looking for {MSG_FROM_CUSTOMER!r}")

    # ── artisan -> customer, live ────────────────────────────────────────────
    replied = False
    try:
        art.fill("#ms-input", MSG_FROM_ARTISAN)
        art.wait_for_timeout(300)
        art.click("#ms-send")
        replied = True
    except Exception as e:
        check("artisan can reply", False, str(e)[:90])
    if replied:
        check("artisan can reply", True)
        check("REALTIME: customer receives the reply with NO reload",
              wait_for_text(cust, MSG_FROM_ARTISAN),
              f"looking for {MSG_FROM_ARTISAN!r}")

    # ── one shared thread, not two ───────────────────────────────────────────
    both = bubbles(art)
    check("both messages live in ONE thread (no duplicate conversation)",
          any(MSG_FROM_CUSTOMER in x for x in both) and any(MSG_FROM_ARTISAN in x for x in both),
          f"{len(both)} messages in the artisan's view")

    ig = ("app-check","appcheck","installations","err_blocked","403","messaging","permission","404")
    creal = [e for e in cerr if not any(t in e.lower() for t in ig)]
    areal = [e for e in aerr if not any(t in e.lower() for t in ig)]
    check("no unexpected JS errors (customer)", not creal, creal[0][:100] if creal else "")
    check("no unexpected JS errors (artisan)",  not areal, areal[0][:100] if areal else "")

    cust_ctx.close(); art_ctx.close(); b.close()

bad = [r for r in results if not r[1]]
print(f"\n{len(results)-len(bad)}/{len(results)} checks passed")
sys.exit(1 if bad else 0)
