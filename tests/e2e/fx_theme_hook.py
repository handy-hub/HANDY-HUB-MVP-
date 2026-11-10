# fx_theme_hook.py — shared by the artisan browser suites (Phase 6).
#
# Each suite runs this file with exec() right after it registers its report, so
# it works under `python -I` too (no sibling imports). It adds two things to a
# suite without touching the suite's own checks:
#
#   1. THEME.   With FX_THEME=dark in the environment, every browser context
#      starts with the Dark preference stored, so the whole suite — every state
#      it reaches, every functional check it makes — runs in the dark theme.
#      (`npm run test:dark-browser` runs all the suites this way.)
#
#   2. CONTRAST.  After the page-level waits and reads a suite already makes,
#      the page is audited as it stands at that moment: every visible text
#      node, input value, placeholder, control boundary and icon is measured
#      against the background actually behind it (WCAG 2.x, computed in the
#      page). So the audit covers the states the suites drive — loading,
#      error, warning, success, sheets, toasts — in whichever theme is running,
#      not a hand-picked list of screens.
#
# Thresholds: text 4.5:1 (3:1 at >=24px, or >=18.66px bold); placeholders 4.5:1;
# the boundary of an input 3:1 against what surrounds it (WCAG 1.4.11); icons
# 3:1. Disabled controls are exempt under WCAG and are not failed, but their
# lowest ratio is reported so "disabled" never means "invisible".
#
# The result is one extra check in the suite's own report.
import os as _os, atexit as _atexit
from playwright.sync_api import Page as _FxPage, Browser as _FxBrowser

FX_THEME = (_os.environ.get('FX_THEME') or 'light').lower()
_FX_AUDIT_ON = _os.environ.get('FX_CONTRAST', '1') != '0'

_FX_SEED_JS = """
try {
  if (!localStorage.getItem('__fx_theme_seed')) {
    localStorage.setItem('__fx_theme_seed', '1');
    localStorage.setItem('pref_theme', 'Dark');
  }
} catch (e) {}
// A test harness page that carries a screen's markup without its <head> has no
// js/theme.js; apply the stored preference the way theme.js would.
(function () {
  var apply = function () {
    if (window.fxTheme || !document.documentElement) return;
    var dark = false; try { dark = localStorage.getItem('pref_theme') === 'Dark'; } catch (e) {}
    if (dark) { document.documentElement.setAttribute('data-theme', 'dark'); document.documentElement.style.colorScheme = 'dark'; }
  };
  apply(); document.addEventListener('DOMContentLoaded', apply);
})();
"""

_FX_AUDIT_JS = r"""() => {
  if (!document.body || !/^https?:/.test(location.protocol)) return null;
  if (window.matchMedia && matchMedia('(forced-colors: active)').matches) return null;
  // A layer that is still arriving has in-between colours; it is measured at the next read.
  const moving = (document.getAnimations ? document.getAnimations() : []).some((a) => {
    if (a.playState !== 'running' || !a.effect) return false;
    const t = a.effect.getComputedTiming(); return Number.isFinite(t.endTime) && t.endTime < 5000;
  });
  if (moving) return null;
  // Nothing has changed since this page was last measured: say so and stop (one cheap round trip).
  let fp = 2166136261; const src = document.documentElement.getAttribute('data-theme') + innerWidth + document.body.innerHTML;
  for (let i = 0; i < src.length; i++) { fp ^= src.charCodeAt(i); fp = Math.imul(fp, 16777619); }
  for (const el of document.querySelectorAll('input, textarea, select')) fp = Math.imul(fp ^ (el.value || '').length, 16777619);
  if (window.__fxAuditFp === fp) return null;
  window.__fxAuditFp = fp;

  const parse = (c) => { const m = /rgba?\(([^)]+)\)/.exec(c || ''); if (!m) return null;
    const p = m[1].split(/[\s,\/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]; };
  const over = (top, under) => [0, 1, 2].map((i) => top[i] * top[3] + under[i] * (1 - top[3])).concat(1);
  const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const lum = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const hex = (c) => '#' + [0, 1, 2].map((i) => Math.round(c[i]).toString(16).padStart(2, '0')).join('').toUpperCase();
  const dark = /dark/.test(getComputedStyle(document.documentElement).colorScheme || '');
  const canvas = dark ? [18, 18, 18, 1] : [255, 255, 255, 1];

  // The colour actually behind an element: its own and its ancestors' fills, composited.
  const bgOf = (el) => {
    const layers = []; let image = false;
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.backgroundImage && cs.backgroundImage !== 'none') image = true;
      const c = parse(cs.backgroundColor);
      if (c && c[3] > 0) { layers.push(c); if (c[3] >= 0.999) break; }
    }
    let base = canvas; for (let i = layers.length - 1; i >= 0; i--) base = over(layers[i], base);
    return { c: base, image };
  };
  const shown = (el) => {
    if (!el.isConnected || el.closest('[hidden], [inert], .fx-sr, .sr-only, script, style, noscript, template')) return 0;
    const r = el.getBoundingClientRect(); if (r.width < 1 || r.height < 1) return 0;
    let op = 1;
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') return 0;
      if (cs.clipPath && cs.clipPath !== 'none' && r.width <= 2) return 0;
      op *= parseFloat(cs.opacity);
    }
    return op;
  };
  const name = (el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + [...el.classList].slice(0, 4).map((c) => '.' + c).join('');
  const disabled = (el) => !!el.closest(':disabled, [aria-disabled="true"]');

  const out = []; let checked = 0; let lowDisabled = null;
  const measure = (kind, el, fgRaw, min, sample, bgEl) => {
    const op = shown(el); if (!op) return;
    const bg = bgOf(bgEl || el); if (bg.image) return;       // a picture or gradient behind it: not measurable here
    let fg = parse(fgRaw); if (!fg) return;
    if (fg[3] < 1) fg = over(fg, bg.c);
    if (op < 1) fg = over([fg[0], fg[1], fg[2], op], bg.c);
    const r = ratio(fg, bg.c);
    if (disabled(el)) { if (lowDisabled === null || r < lowDisabled.r) lowDisabled = { r: +r.toFixed(2), el: name(el), fg: hex(fg), bg: hex(bg.c) }; return; }
    checked++;
    if (r < min - 0.005) out.push({ kind, el: name(el), fg: hex(fg), bg: hex(bg.c), ratio: +r.toFixed(2), min, text: (sample || '').trim().slice(0, 32) });
  };

  // 1. Text.
  const seen = new Set();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let t = walker.nextNode(); t; t = walker.nextNode()) {
    if (!t.textContent.trim()) continue;
    const el = t.parentElement; if (!el || seen.has(el)) continue; seen.add(el);
    if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|OPTION|TITLE)$/.test(el.tagName)) continue;
    const cs = getComputedStyle(el);
    const size = parseFloat(cs.fontSize), weight = parseInt(cs.fontWeight, 10) || 400;
    const large = size >= 24 || (size >= 18.66 && weight >= 700);
    measure('text', el, cs.color, large ? 3 : 4.5, t.textContent);
  }
  // 2. Form controls: the value, the placeholder, and the edge that says "this is a field".
  for (const el of document.querySelectorAll('input, textarea, select')) {
    const type = (el.getAttribute('type') || 'text').toLowerCase();
    if (/^(hidden|file|checkbox|radio|range|color|submit|button|image)$/.test(type)) continue;
    const cs = getComputedStyle(el);
    if (el.value) measure('value', el, cs.color, 4.5, el.type === 'password' ? '(password)' : el.value);
    else if (el.placeholder) measure('placeholder', el, getComputedStyle(el, '::placeholder').color, 4.5, el.placeholder);
    if (!shown(el) || disabled(el) || el.readOnly || !el.parentElement) continue;   // a read-only field is information, not a control
    const around = bgOf(el.parentElement); if (around.image) continue;
    const own = bgOf(el).c;
    let edge = 0;
    if (parseFloat(cs.borderTopWidth) > 0 && cs.borderTopStyle !== 'none') { let b = parse(cs.borderTopColor); if (b) { if (b[3] < 1) b = over(b, around.c); edge = ratio(b, around.c); } }
    const fill = ratio(own, around.c);
    checked++;
    if (Math.max(edge, fill) < 3 - 0.005) out.push({ kind: 'boundary', el: name(el), fg: cs.borderTopColor, bg: hex(around.c), ratio: +Math.max(edge, fill).toFixed(2), min: 3, text: el.getAttribute('aria-label') || el.name || el.id || '' });
  }
  // 3. Icons drawn in the current text colour. The unfilled track of a rating star is
  //    decoration (the rating is its filled part and the number beside it).
  for (const el of document.querySelectorAll('svg')) {
    if (el.matches('.fx-rep__star > svg')) continue;
    if (el.querySelector('[fill^="#"], [stroke^="#"]')) continue;        // a brand mark with its own colours
    measure('icon', el, getComputedStyle(el).color, 3, el.getAttribute('aria-label') || (el.parentElement && el.parentElement.getAttribute('aria-label')) || 'icon');
  }
  return { path: location.pathname.split('/').pop() || '/', dark, free: !!window.__fx_theme_free, checked, bad: out, lowDisabled };
}"""

_fx_fails, _fx_stats = {}, {'audits': 0, 'checked': 0, 'dark_seen': 0, 'pages': set(), 'low_disabled': None}

import time as _fx_time
_fx_cost = [0.03]          # a running estimate of one audit, in seconds

def _fx_audit(pg):
    if not _FX_AUDIT_ON:
        return
    t0 = _fx_time.perf_counter()
    try:
        res = pg.evaluate(_FX_AUDIT_JS)
    except Exception:
        return
    if not res:
        return
    _fx_cost[0] = 0.7 * _fx_cost[0] + 0.3 * (_fx_time.perf_counter() - t0)
    _fx_stats['audits'] += 1
    _fx_stats['checked'] += res['checked']
    _fx_stats['dark_seen'] += 1 if (res['dark'] or res.get('free')) else 0   # 'free': a test that sets the theme itself
    _fx_stats['pages'].add(res['path'])
    ld = res.get('lowDisabled')
    if ld and (_fx_stats['low_disabled'] is None or ld['r'] < _fx_stats['low_disabled']['r']):
        _fx_stats['low_disabled'] = dict(ld, page=res['path'])
    for b in res['bad']:
        _fx_fails.setdefault((b['kind'], b['el'], b['fg'], b['bg']), dict(b, page=res['path']))

def _fx_after(method):
    orig = getattr(_FxPage, method)
    def wrapped(self, *a, **k):
        out = orig(self, *a, **k)
        _fx_audit(self)
        return out
    setattr(_FxPage, method, wrapped)

def _fx_before(method):
    orig = getattr(_FxPage, method)
    def wrapped(self, *a, **k):
        _fx_audit(self)
        return orig(self, *a, **k)
    setattr(_FxPage, method, wrapped)

for _m in ('wait_for_selector', 'wait_for_function', 'query_selector', 'inner_text', 'text_content', 'get_attribute'):
    _fx_after(_m)

# wait_for_timeout(t) still takes t: the audit runs inside the wait, in its last part.
_fx_wait = _FxPage.wait_for_timeout
def _fx_wait_and_audit(self, timeout):
    t0 = _fx_time.perf_counter()
    budget = min(_fx_cost[0] * 1000 * 1.5, timeout * 0.5)
    _fx_wait(self, max(timeout - budget, 0))
    _fx_audit(self)
    left = timeout - (_fx_time.perf_counter() - t0) * 1000
    if left > 1:
        _fx_wait(self, left)
_FxPage.wait_for_timeout = _fx_wait_and_audit
_fx_before('screenshot')

_fx_new_context = _FxBrowser.new_context
def _fx_context(self, *a, **k):
    ctx = _fx_new_context(self, *a, **k)
    if FX_THEME == 'dark':
        ctx.add_init_script(_FX_SEED_JS)
    return ctx
_FxBrowser.new_context = _fx_context

def _fx_summary():
    if not _FX_AUDIT_ON:
        return
    s = _fx_stats
    worst = sorted(_fx_fails.values(), key=lambda b: b['ratio'])
    detail = [f"{b['page']} {b['kind']} {b['el']} \"{b['text']}\" {b['fg']} on {b['bg']} = {b['ratio']}:1 (needs {b['min']})" for b in worst]
    for line in detail:
        print('   contrast: ' + line)
    low = s['low_disabled']
    note = f"; lowest disabled control {low['r']}:1 ({low['el']} on {low['page']})" if low else ''
    check(f"contrast, {FX_THEME} theme: {s['checked']} measurements in {s['audits']} page states on {len(s['pages'])} page(s) meet WCAG AA{note}",
          not worst and s['audits'] > 0, detail[:25] if worst else 'no page state was audited')
    if FX_THEME == 'dark':
        check('dark theme: the pages under test really rendered dark', s['dark_seen'] > 0 and s['dark_seen'] >= s['audits'] * 0.9,
              f"{s['dark_seen']} of {s['audits']} audited states were dark")
_atexit.register(_fx_summary)
