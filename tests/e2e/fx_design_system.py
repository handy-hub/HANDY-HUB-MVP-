"""Phase 1 browser checks: the artisan design system, rendered (design/artisan/index.html).

What the Node test cannot see: touch targets, overflow, rendered contrast, focus
visibility on every stop, keyboard operation, the sheet's modal behaviour, toast
announcements, reduced motion, 200% text and forced colours — at 360, 390, 768
and 1280 px.

Network: NONE. Files are served from this checkout to the fake origin
http://fx.test by Playwright routing; every other host (fonts, CDNs) is aborted,
so the system is also proven to hold up on the fallback font.

    python -I tests/e2e/fx_design_system.py            # this checkout
    FX_SHOTS=<dir> python -I tests/e2e/fx_design_system.py   # also save screenshots
"""
import os, sys, json, pathlib, mimetypes, atexit
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright
sys.stdout.reconfigure(encoding='utf-8')

ROOT = pathlib.Path(__file__).resolve().parents[2]
ORIGIN = 'http://fx.test'
URL = f'{ORIGIN}/design/artisan/index.html'
SHOTS = os.environ.get('FX_SHOTS')

results = []
def check(name, cond, detail=''):
    results.append((name, bool(cond), detail))
_done = False
def _report():
    ok = sum(1 for _, c, _ in results if c)
    for n, c, d in results:
        print(f"  {'PASS' if c else 'FAIL'}  {n}" + ('' if c else f"   [{str(d)[:300]}]"))
    print(f"fx-design-system browser: {ok} passed, {len(results) - ok} failed" + ('' if _done else '  (aborted early)'))
    sys.stdout.flush(); sys.stderr.flush()
    if ok != len(results) or not _done:
        os._exit(1)
atexit.register(_report)

def route(r):
    u = urlparse(r.request.url)
    if f'{u.scheme}://{u.netloc}' != ORIGIN:
        return r.abort()
    f = (ROOT / u.path.lstrip('/')).resolve()
    if ROOT not in f.parents or not f.is_file():
        return r.fulfill(status=404, body='')
    ctype = 'text/javascript' if f.suffix in ('.js', '.mjs') else (mimetypes.guess_type(str(f))[0] or 'application/octet-stream')
    return r.fulfill(status=200, content_type=ctype, body=f.read_bytes())

INTERACTIVE = 'button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])'

TARGETS_JS = r"""(sel) => {
  const out = [];
  for (const el of document.querySelectorAll(sel)) {
    if (el.closest('.gal-toc, .fx-skip, [hidden], .fx-overlay[hidden]')) continue;   // inline doc links; the skip link shows on focus
    const r = el.getBoundingClientRect(); if (!r.width || !r.height) continue;
    let w = r.width, h = r.height;
    const a = getComputedStyle(el, '::after');
    if (a.content !== 'none' && a.position === 'absolute') {
      const n = (v) => (isNaN(parseFloat(v)) ? 0 : parseFloat(v));
      h = r.height - n(a.top) - n(a.bottom); w = r.width - n(a.left) - n(a.right);
    }
    if (w < 43.5 || h < 43.5) out.push(`${el.tagName}.${[...el.classList].join('.')} "${(el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 28)}" ${Math.round(w)}x${Math.round(h)}`);
  }
  return out;
}"""

CONTRAST_JS = r"""() => {
  const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(',').map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
  const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const bgOf = (el) => { for (let e = el; e; e = e.parentElement) { const c = parse(getComputedStyle(e).backgroundColor); if (c && c.a > 0.99) return c; } return { r: 255, g: 255, b: 255, a: 1 }; };
  const bad = [];
  let checked = 0;
  for (const el of document.querySelectorAll('body *')) {
    if (el.closest('.gal-swatches, .gal-tbl, script, style, [hidden], [aria-hidden="true"]')) continue;
    if (el.closest(':disabled, [aria-disabled="true"]')) continue;          // WCAG: inactive controls are exempt
    if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
    const s = getComputedStyle(el); if (s.visibility === 'hidden' || s.display === 'none') continue;
    const r = el.getBoundingClientRect(); if (!r.width || !r.height) continue;
    const fg = parse(s.color); const bg = bgOf(el);
    const [x, y] = [lum(fg), lum(bg)].sort((p, q) => q - p);
    const ratio = (x + 0.05) / (y + 0.05);
    const size = parseFloat(s.fontSize), weight = parseInt(s.fontWeight, 10);
    const large = size >= 24 || (size >= 18.66 && weight >= 700);
    checked++;
    if (ratio < (large ? 3 : 4.5)) bad.push(`${el.tagName}.${[...el.classList].join('.')} "${el.textContent.trim().slice(0, 24)}" ${ratio.toFixed(2)}`);
  }
  return { bad, checked };
}"""

FOCUS_JS = r"""() => {
  const a = document.activeElement; if (!a || a === document.body) return null;
  const s = getComputedStyle(a); const r = a.getBoundingClientRect();
  const outline = s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) >= 2;
  // An input's focus is its edge thickened to 2px: ink, or the error colour on an invalid field.
  const inputRing = a.classList.contains('fx-input') && s.boxShadow.includes('inset') && ['rgb(17, 19, 22)', 'rgb(194, 48, 43)'].includes(s.borderTopColor);
  return { tag: a.tagName, cls: [...a.classList].join('.'), label: (a.textContent || a.getAttribute('aria-label') || a.id || '').trim().slice(0, 28),
           visible: outline || inputRing, onscreen: r.width > 0 && r.height > 0 };
}"""

OVERFLOW_JS = r"""() => ({ doc: document.documentElement.scrollWidth, vw: window.innerWidth })"""

CLIP_JS = r"""() => {
  const out = [];
  for (const el of document.querySelectorAll('.fx-btn, .fx-chip, .fx-tab, .fx-seg__btn, .fx-avail, .fx-ledger__row, .fx-row, .fx-appbar, .fx-notice, .fx-countdown__text, .fx-rail__cap, .fx-sheet__actions, .fx-dock__actions')) {
    if (el.closest('[hidden]')) continue;
    const r = el.getBoundingClientRect(); if (!r.width) continue;
    if (el.scrollWidth > el.clientWidth + 1) out.push(`${[...el.classList][0]} "${el.textContent.trim().slice(0, 24)}" ${el.scrollWidth}>${el.clientWidth}`);
  }
  return out;
}"""

def open_gallery(ctx):
    pg = ctx.new_page()
    errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.on('console', lambda m: errs.append(m.text) if m.type == 'error' and 'Failed to load resource' not in m.text else None)
    pg.goto(URL, wait_until='domcontentloaded')
    pg.wait_for_function("document.documentElement.dataset.ready === 'true'", timeout=15000)
    return pg, errs

def shot(pg, name, full=True, el=None):
    if not SHOTS:
        return
    pathlib.Path(SHOTS).mkdir(parents=True, exist_ok=True)
    (el or pg).screenshot(path=str(pathlib.Path(SHOTS) / f'{name}.png'), **({'full_page': full} if el is None else {}))

with sync_playwright() as p:
    b = p.chromium.launch()

    # ── Widths: overflow, targets, contrast ─────────────────────────────────
    for w, h in [(360, 780), (390, 844), (768, 1024), (1280, 900)]:
        ctx = b.new_context(viewport={'width': w, 'height': h})
        ctx.route('**/*', route)
        pg, errs = open_gallery(ctx)
        o = pg.evaluate(OVERFLOW_JS)
        check(f'{w}px: no horizontal page scroll', o['doc'] <= o['vw'], o)
        small = pg.evaluate(TARGETS_JS, INTERACTIVE)
        check(f'{w}px: every control has a 44x44 hit area', not small, small)
        c = pg.evaluate(CONTRAST_JS)
        check(f'{w}px: rendered text contrast ≥ 4.5:1 ({c["checked"]} elements)', not c['bad'] and c['checked'] > 100, c['bad'])
        clip = pg.evaluate(CLIP_JS)
        check(f'{w}px: no component clips its content', not clip, clip)
        big = pg.evaluate("""() => [...document.querySelectorAll('.fx-app svg')].filter((s) => !s.closest('.fx-avatar--l'))
            .map((s) => { const r = s.getBoundingClientRect(); return [s.closest('[class]').className, Math.round(r.width), Math.round(r.height)]; })
            .filter(([, w, h]) => w > 24.5 || h > 24.5)""")
        check(f'{w}px: no icon renders larger than the icon tokens (24px)', not big, big)
        rows = pg.evaluate("""() => [...document.querySelectorAll('.fx-row')].filter((r) => r.querySelector('.fx-row__meta'))
            .filter((r) => r.querySelector('.fx-row__meta').getBoundingClientRect().top < r.querySelector('.fx-row__title').getBoundingClientRect().bottom - 1)
            .map((r) => r.textContent.trim().slice(0, 30))""")
        check(f"{w}px: a row's metadata always sits under its title", not rows, rows)
        check(f'{w}px: no script or console errors', not errs, errs)
        if w in (360, 390):
            shot(pg, f'gallery-{w}')
            shot(pg, f'shell-{w}', el=pg.locator('[data-test="phone-root"]'))
            shot(pg, f'shell-push-{w}', el=pg.locator('[data-test="phone-push"]'))
        if w == 1280:
            shot(pg, 'gallery-1280', full=False)
        ctx.close()

    # ── Keyboard: every Tab stop shows focus ───────────────────────────────
    ctx = b.new_context(viewport={'width': 390, 'height': 844})
    ctx.route('**/*', route)
    pg, _ = open_gallery(ctx)
    stops, hidden_focus, no_ring, first = [], [], [], None
    for _ in range(140):
        pg.keyboard.press('Tab')
        f = pg.evaluate(FOCUS_JS)
        if not f: continue
        if not f['visible'] and 'fx-input' in f['cls']:
            pg.wait_for_timeout(250)          # the input's 2px ink edge settles after its 180ms transition
            f = pg.evaluate(FOCUS_JS)
        key = f"{f['tag']}.{f['cls']}:{f['label']}"
        if first is None: first = f
        elif key == f"{first['tag']}.{first['cls']}:{first['label']}" and len(stops) > 5: break
        stops.append(key)
        if not f['visible']: no_ring.append(key)
        if not f['onscreen']: hidden_focus.append(key)
    check('the first Tab reaches the skip link', first and 'fx-skip' in first['cls'], first)
    check(f'every focus stop shows a 2px focus indicator ({len(stops)} stops)', len(stops) > 40 and not no_ring, no_ring[:8])
    check('focus never lands on something invisible', not hidden_focus, hidden_focus[:8])
    check('the closed sheet is not in the tab order', not any('sheet-note' in s or 'Accept' == s.split(':')[-1] for s in stops), [s for s in stops if 'sheet' in s])

    # Segmented control: Space selects, exactly one pressed, the change is applied.
    pg.locator('#seg-demo [data-value="upcoming"]').focus()
    pg.keyboard.press('Space')
    pressed = pg.evaluate("() => [...document.querySelectorAll('#seg-demo .fx-seg__btn')].map((b) => b.getAttribute('aria-pressed'))")
    check('segmented: Space on a segment selects it, and only it', pressed == ['false', 'true', 'false'], pressed)
    check('segmented: the change reaches the screen', pg.locator('#seg-out').inner_text() == 'Showing: upcoming')
    ring = pg.evaluate("() => { const s = getComputedStyle(document.activeElement); return s.outlineStyle + ' ' + s.outlineWidth; }")
    check('segmented: the selected, focused segment still shows its focus ring (Phase 0 prototype bug)', ring.startswith('solid 2'), ring)
    pg.locator('#avail-demo').focus(); pg.keyboard.press('Enter')
    check('availability: Enter toggles it and the label says the new state',
          pg.evaluate("() => { const b = document.getElementById('avail-demo'); return b.getAttribute('aria-pressed') + ' ' + b.textContent.trim(); }") == 'false Offline')

    # Sheet: modal, trapped, Escape, focus returns.
    opener = pg.locator('#open-sheet'); opener.focus(); pg.keyboard.press('Enter'); pg.wait_for_timeout(500)
    st = pg.evaluate("() => ({ open: !document.getElementById('sheet-demo').hidden, focusIn: !!document.activeElement.closest('.fx-sheet'), autofocus: document.activeElement.id, mainInert: document.getElementById('gallery').inert, lock: document.documentElement.classList.contains('fx-lock') })")
    check('sheet: opens with focus on its [data-autofocus] field', st['open'] and st['focusIn'] and st['autofocus'] == 'sheet-note', st)
    check('sheet: the page behind is inert and stops scrolling', st['mainInert'] and st['lock'], st)
    shot(pg, 'sheet-390', full=False)
    outside = 0
    for _ in range(12):
        pg.keyboard.press('Tab')
        if not pg.evaluate("() => !!document.activeElement.closest('.fx-sheet')"): outside += 1
    for _ in range(6):
        pg.keyboard.press('Shift+Tab')
        if not pg.evaluate("() => !!document.activeElement.closest('.fx-sheet')"): outside += 1
    check('sheet: Tab and Shift+Tab never leave it', outside == 0, outside)
    pg.keyboard.press('Escape'); pg.wait_for_timeout(600)
    st = pg.evaluate("() => ({ hidden: document.getElementById('sheet-demo').hidden, back: document.activeElement.id, mainInert: document.getElementById('gallery').inert, lock: document.documentElement.classList.contains('fx-lock') })")
    check('sheet: Escape closes it, focus returns to the opener, the page is live again', st == {'hidden': True, 'back': 'open-sheet', 'mainInert': False, 'lock': False}, st)
    pg.locator('#open-sheet').click(); pg.wait_for_timeout(500)
    pg.mouse.click(195, 30); pg.wait_for_timeout(600)
    check('sheet: a tap on the scrim closes it', pg.evaluate("() => document.getElementById('sheet-demo').hidden"))

    # Toasts: announced politely; an error is an alert; one with an action waits.
    pg.locator('#toast-ok').click(); pg.wait_for_timeout(300)
    t = pg.evaluate("() => { const r = document.querySelector('.fx-toasts'); return { role: r.getAttribute('role'), live: r.getAttribute('aria-live'), text: r.textContent.trim() }; }")
    check('toast: in a polite status region, with its words', t['role'] == 'status' and t['live'] == 'polite' and 'Quote sent' in t['text'], t)
    shot(pg, 'toast-390', full=False)
    pg.locator('#toast-bad').click(); pg.wait_for_timeout(5000)
    t = pg.evaluate("() => [...document.querySelectorAll('.fx-toast')].map((x) => [x.getAttribute('role'), x.textContent.trim()])")
    check('toast: an error is role="alert" and, with an action, outlasts the timer', any(r == 'alert' and 'Retry' in txt for r, txt in t), t)
    check('toast: a plain toast clears itself', not any('Quote sent' in txt for _, txt in t), t)
    ctx.close()

    # ── Reduced motion ──────────────────────────────────────────────────────
    ctx = b.new_context(viewport={'width': 390, 'height': 844}, reduced_motion='reduce')
    ctx.route('**/*', route)
    pg, _ = open_gallery(ctx)
    m = pg.evaluate("""() => ({
        btn: getComputedStyle(document.querySelector('.fx-btn')).transitionDuration,
        pulse: getComputedStyle(document.querySelector('.fx-dot--live'), '::after').display,
        spin: getComputedStyle(document.querySelector('.fx-spin')).animationName,
        bar: getComputedStyle(document.querySelector('.fx-countdown__fill')).transitionDuration })""")
    check('reduced motion: transitions collapse, the live pulse and spinner stop', all(d.startswith('1e-05s') or d == '0s' for d in m['btn'].split(', ')) and m['pulse'] == 'none' and m['spin'] == 'none' and m['bar'].split(', ')[0] in ('1e-05s', '0s'), m)
    pg.locator('#open-sheet').click(); pg.wait_for_timeout(50)
    pg.keyboard.press('Escape'); pg.wait_for_timeout(50)
    check('reduced motion: the sheet opens and closes without waiting on an animation', pg.evaluate("() => document.getElementById('sheet-demo').hidden"))
    ctx.close()

    # ── 200% text at 360px ──────────────────────────────────────────────────
    ctx = b.new_context(viewport={'width': 360, 'height': 780})
    ctx.route('**/*', route)
    pg, _ = open_gallery(ctx)
    pg.evaluate("() => { document.documentElement.style.fontSize = '200%'; }")
    pg.wait_for_timeout(300)
    o = pg.evaluate(OVERFLOW_JS)
    check('200% text at 360px: no horizontal page scroll', o['doc'] <= o['vw'], o)
    clip = pg.evaluate(CLIP_JS)
    check('200% text at 360px: no component clips its content', not clip, clip)
    lines = pg.evaluate("""() => { const t = document.querySelector('[data-test="phone-root"] .fx-appbar__title');
        const r = document.createRange(); r.selectNodeContents(t);
        const rows = new Set([...r.getClientRects()].map((x) => Math.round(x.top))); return { text: t.textContent, rows: rows.size }; }""")
    check('200% text: a title is never broken mid-word — the app bar wraps its actions instead', lines['rows'] == 1, lines)
    grow = pg.evaluate("() => { const b = document.querySelector('[data-test=\"button-variants\"] .fx-btn--primary').getBoundingClientRect(); const c = document.querySelector('[data-test=\"chips\"] .fx-chip').getBoundingClientRect(); return { btn: b.height, chip: c.height }; }")
    check('200% text: controls grow with their text (no fixed heights)', grow['btn'] > 56 and grow['chip'] > 24, grow)
    shot(pg, 'text-200-360')
    ctx.close()

    # ── Forced colours (Windows high contrast) ──────────────────────────────
    ctx = b.new_context(viewport={'width': 390, 'height': 844}, forced_colors='active')
    ctx.route('**/*', route)
    pg, _ = open_gallery(ctx)
    pg.locator('#seg-demo [data-value="active"]').focus()
    fc = pg.evaluate("() => { const s = getComputedStyle(document.activeElement); return { outline: s.outlineStyle, width: s.outlineWidth }; }")
    check('forced colours: focus stays visible', fc['outline'] != 'none' and float(fc['width'].replace('px', '')) >= 2, fc)
    sel = pg.evaluate("() => getComputedStyle(document.querySelector('#seg-demo [aria-pressed=\"true\"]')).outlineStyle")
    check('forced colours: the selected segment is marked by an outline, not only a fill', sel != 'none', sel)
    ctx.close()
    b.close()

_done = True
