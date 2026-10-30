"""MSG-UI-001 — with a conversation open, its header is the one on top.

The inbox header (.ms-top, sticky, z-index 10) painted over the open thread
(.ms-chat, position:fixed, no z-index), so the thread's name and "Back to
messages" were hidden and a tap on the visible Back hit #ms-back, which leaves
Messages for the dashboard.

No emulator or sign-in needed: this renders artisan-app/messages.html's own
stylesheet and markup (scripts removed), opens the thread the way the page does
(.ms-chat.open) and asks the browser what a tap at the thread header's Back
button and name actually hits.

    python tests/e2e/messages_thread_stacking.py [repo root]
"""
import pathlib
import re
import sys

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else pathlib.Path(__file__).resolve().parents[2])
page_src = (ROOT / "artisan-app" / "messages.html").read_text(encoding="utf-8")
css = "\n".join(re.findall(r"<style[^>]*>([\s\S]*?)</style>", page_src))
ds = (ROOT / "artisan-app" / "css" / "design-system.css").read_text(encoding="utf-8")
body = re.search(r"<body[^>]*>([\s\S]*)</body>", page_src).group(1)
body = re.sub(r"<script[\s\S]*?</script>", "", body)

HTML = f"""<!doctype html><html><head><meta name="viewport" content="width=device-width">
<style>{ds}</style><style>{css}</style></head><body>{body}</body></html>"""

PROBE = """() => {
  document.getElementById('ms-chat').classList.add('open');
  document.getElementById('ms-chat-name').textContent = 'Ama';
  const at = (el) => { const r = el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; };
  const hit = (el) => { const [x, y] = at(el); const h = document.elementFromPoint(x, y); return h ? (h.closest('[id]') || h).id || h.className : null; };
  return { back: hit(document.getElementById('ms-chat-back')), name: hit(document.getElementById('ms-chat-name')) };
}"""

results = []
def check(name, ok, detail=""):
    results.append(ok)
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f"   {detail}" if detail else ""))

with sync_playwright() as p:
    b = p.chromium.launch()
    for w in (360, 414):
        pg = b.new_page(viewport={"width": w, "height": 780})
        pg.set_content(HTML)
        r = pg.evaluate(PROBE)
        check(f"{w}px: a tap on the thread's Back hits #ms-chat-back", r["back"] == "ms-chat-back", f"hit {r['back']!r}")
        check(f"{w}px: the customer's name is visible, not covered", r["name"] == "ms-chat-name", f"hit {r['name']!r}")
        pg.close()
    b.close()

failed = results.count(False)
print(f"\nmessages-thread-stacking: {len(results) - failed} passed, {failed} failed")
sys.exit(1 if failed else 0)
