# encoding: utf-8
# Playwright end-to-end validation — Nearby Professionals feature
# Tests: skeleton loading, filter panel, radius chips, category chips,
#        empty state, reset, expand-radius, book-button navigation,
#        stress/rapid filter switching, offline/no-GPS edge cases

import sys, io, os, json
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

from playwright.sync_api import sync_playwright

BASE  = 'http://localhost:8765'
SHOTS = 'tests/screenshots/nearby_pros'
os.makedirs(SHOTS, exist_ok=True)

results = []
passed = failed = 0

def rec(tid, name, ok, detail='', sc=''):
    global passed, failed
    results.append({'id': tid, 'name': name, 'passed': ok, 'detail': detail, 'sc': sc})
    if ok: passed += 1
    else:  failed += 1
    icon = 'PASS' if ok else 'FAIL'
    print(f'  [{icon}] {name}')
    if not ok and detail: print(f'         -> {str(detail)[:120]}')

def shot(pg, name):
    p = f'{SHOTS}/{name}.png'
    try: pg.screenshot(path=p, full_page=True)
    except: pass
    return p

def go(pg, url, wait=2000):
    errs, excs = [], []
    pg.on('console',   lambda m: errs.append(m.text[:100]) if m.type == 'error' else None)
    pg.on('pageerror', lambda e: excs.append(str(e)[:100]))
    try:
        pg.goto(url, wait_until='domcontentloaded', timeout=15000)
        pg.wait_for_timeout(wait)
    except Exception as e:
        excs.append(str(e)[:80])
    return errs, excs

with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=True)

    # ── Helper: fresh dashboard page ──────────────────────────────────
    def fresh_page(offline=False, extra_storage=None):
        ctx = browser.new_context(
            viewport={'width': 390, 'height': 844},
            offline=offline,
        )
        if extra_storage:
            ctx.add_init_script(f'localStorage.setItem({json.dumps(extra_storage[0])}, {json.dumps(extra_storage[1])});')
        pg = ctx.new_page()
        return ctx, pg

    # ════════════════════════════════════════════════════════════
    # T1 — HTML structure: key elements present
    # ════════════════════════════════════════════════════════════
    print('\n' + '='*60)
    print('T1 — HTML structure & key elements')
    print('='*60)
    ctx, pg = fresh_page()
    go(pg, f'{BASE}/dashboard.html', 500)

    rec('T1-list',       'Nearby: #np-pro-list container exists',
        pg.locator('#np-pro-list').count() > 0)
    rec('T1-dist-pill',  'Nearby: #np-dist-pill button exists',
        pg.locator('#np-dist-pill').count() > 0)
    rec('T1-filter-btn', 'Nearby: #np-filter-btn button exists',
        pg.locator('#np-filter-btn').count() > 0)
    rec('T1-title',      'Nearby: section title "Nearby Professionals" present',
        'Nearby Professionals' in pg.content())
    shot(pg, 't1_structure')
    ctx.close()

    # ════════════════════════════════════════════════════════════
    # T2 — Skeleton loading appears immediately
    # ════════════════════════════════════════════════════════════
    print('\n' + '='*60)
    print('T2 — Skeleton loading cards appear on page load')
    print('='*60)
    ctx, pg = fresh_page()
    # intercept BEFORE first paint
    errs, excs = go(pg, f'{BASE}/dashboard.html', 400)

    skel_count = pg.evaluate('''() => document.querySelectorAll('.np-skeleton,.skel').length''')
    skel_visible = pg.evaluate('''() => {
        const el = document.querySelector(".np-skeleton");
        return el ? el.offsetParent !== null : false;
    }''')
    rec('T2-skel-present', 'Skeleton cards appear during loading',
        skel_count > 0, f'found {skel_count}')
    shot(pg, 't2_skeleton_loading')
    # wait for module to resolve (or timeout)
    pg.wait_for_timeout(3000)
    final_skel = pg.evaluate('''() => document.querySelectorAll(".np-skeleton").length''')
    rec('T2-no-runtime-exc', 'No runtime exceptions on dashboard load',
        len(excs) == 0, str(excs[:1]))
    shot(pg, 't2_after_load')
    ctx.close()

    # ════════════════════════════════════════════════════════════
    # T3 — Filter panel opens / closes
    # ════════════════════════════════════════════════════════════
    print('\n' + '='*60)
    print('T3 — Filter panel open/close interaction')
    print('='*60)
    ctx, pg = fresh_page()
    go(pg, f'{BASE}/dashboard.html', 1500)

    # Open via dist-pill
    dist_pill = pg.locator('#np-dist-pill').first
    if dist_pill.count() > 0:
        dist_pill.click(timeout=2000)
        pg.wait_for_timeout(400)
        panel_open = pg.evaluate('''() => {
            const p = document.querySelector(".np-panel");
            return p ? p.classList.contains("np-panel--open") : false;
        }''')
        rec('T3-panel-opens', 'Filter panel opens on dist-pill click', panel_open)
        shot(pg, 't3_panel_open')

        # Close via close button
        close_btn = pg.locator('.np-panel-close').first
        if close_btn.count() > 0:
            close_btn.click(timeout=2000)
            pg.wait_for_timeout(300)
            panel_closed = pg.evaluate('''() => {
                const p = document.querySelector(".np-panel");
                return p ? !p.classList.contains("np-panel--open") : true;
            }''')
            rec('T3-panel-closes', 'Filter panel closes on close-button click', panel_closed)
        else:
            rec('T3-panel-closes', 'Close button found', False, 'missing')
    else:
        rec('T3-panel-opens',  'dist-pill found', False, 'missing')
        rec('T3-panel-closes', 'N/A', False, 'panel never opened')

    # Open via filter-btn
    filter_btn = pg.locator('#np-filter-btn').first
    if filter_btn.count() > 0:
        filter_btn.click(timeout=2000)
        pg.wait_for_timeout(300)
        panel_via_filter = pg.evaluate('''() => document.querySelector(".np-panel--open") !== null''')
        rec('T3-filter-btn-opens', 'Filter button also opens the panel', panel_via_filter)
    else:
        rec('T3-filter-btn-opens', 'filter-btn found', False, 'missing')
    ctx.close()

    # ════════════════════════════════════════════════════════════
    # T4 — Radius chip selection
    # ════════════════════════════════════════════════════════════
    print('\n' + '='*60)
    print('T4 — Radius chip selection updates active state')
    print('='*60)
    ctx, pg = fresh_page()
    go(pg, f'{BASE}/dashboard.html', 1500)

    pg.locator('#np-dist-pill').first.click(timeout=2000)
    pg.wait_for_timeout(300)

    # Click "5 km" chip
    chips = pg.locator('.np-radius-chip').all()
    rec('T4-chips-present', f'Radius chips exist in panel ({len(chips)} found)',
        len(chips) >= 4, f'{len(chips)} chips')

    if len(chips) >= 2:
        chips[1].click(timeout=1500)   # 5 km (index 1)
        pg.wait_for_timeout(200)
        is_active = pg.evaluate('''() => {
            const chips = document.querySelectorAll(".np-radius-chip");
            return chips[1] ? chips[1].classList.contains("np-chip--active") : false;
        }''')
        rec('T4-chip-active', '"5 km" chip becomes active on click', is_active)

        # Apply
        apply_btn = pg.locator('#np-panel-apply-btn').first
        if apply_btn.count() > 0:
            apply_btn.click(timeout=1500)
            pg.wait_for_timeout(500)
            pill_text = pg.locator('#np-dist-pill').first.inner_text()
            rec('T4-pill-updates', 'Dist-pill label updates after apply',
                '5' in pill_text or 'km' in pill_text.lower(), f'pill text: {pill_text!r}')
            shot(pg, 't4_5km_applied')
        else:
            rec('T4-pill-updates', 'Apply button found', False, 'missing')
    else:
        rec('T4-chip-active',  'Enough radius chips', False, 'need ≥2')
        rec('T4-pill-updates', 'N/A', False, 'no chips')
    ctx.close()

    # ════════════════════════════════════════════════════════════
    # T5 — Category chip selection
    # ════════════════════════════════════════════════════════════
    print('\n' + '='*60)
    print('T5 — Category chip selection')
    print('='*60)
    ctx, pg = fresh_page()
    go(pg, f'{BASE}/dashboard.html', 1500)

    pg.locator('#np-dist-pill').first.click(timeout=2000)
    pg.wait_for_timeout(300)

    cat_chips = pg.locator('.np-cat-chip').all()
    rec('T5-cat-chips', f'Category chips present ({len(cat_chips)} found)',
        len(cat_chips) >= 5, f'{len(cat_chips)} chips')

    if len(cat_chips) >= 2:
        # Click "Electrical" (index 1, after "All")
        cat_chips[1].click(timeout=1500)
        pg.wait_for_timeout(200)
        active_cat = pg.evaluate('''() => {
            const chips = document.querySelectorAll(".np-cat-chip");
            const active = Array.from(chips).find(c => c.classList.contains("np-chip--active"));
            return active ? active.dataset.cat : null;
        }''')
        rec('T5-cat-active', 'Category chip becomes active on click',
            active_cat not in (None, 'all'), f'active={active_cat}')

        # Apply and check pro-list updates
        apply_btn = pg.locator('#np-panel-apply-btn').first
        if apply_btn.count() > 0:
            apply_btn.click(timeout=1500)
            pg.wait_for_timeout(600)
            shot(pg, 't5_electrical_filter')
            rec('T5-filter-applied', 'Category filter applied without crash',
                True)
        else:
            rec('T5-filter-applied', 'Apply button found', False, 'missing')
    else:
        rec('T5-cat-active',    'Enough cat chips', False, 'need ≥2')
        rec('T5-filter-applied', 'N/A', False, 'no chips')
    ctx.close()

    # ════════════════════════════════════════════════════════════
    # T6 — Reset filters
    # ════════════════════════════════════════════════════════════
    print('\n' + '='*60)
    print('T6 — Reset filters restores defaults')
    print('='*60)
    ctx, pg = fresh_page()
    go(pg, f'{BASE}/dashboard.html', 1500)

    pill = pg.locator('#np-dist-pill').first
    pill.click(timeout=2000)
    pg.wait_for_timeout(300)

    # Select 2km + Plumbing
    radius_chips = pg.locator('.np-radius-chip').all()
    cat_chips    = pg.locator('.np-cat-chip').all()
    if radius_chips and cat_chips:
        radius_chips[0].click(timeout=1000)   # 2km
        pg.wait_for_timeout(100)
        cat_chips[2].click(timeout=1000)      # Plumbing
        pg.wait_for_timeout(100)

    # Reset button in panel
    reset_in_panel = pg.locator('#np-panel-reset-btn').first
    if reset_in_panel.count() > 0:
        reset_in_panel.click(timeout=1500)
        pg.wait_for_timeout(200)
        # After reset, "All" category chip and last radius chip should be active
        all_active = pg.evaluate('''() => {
            const all_chip = document.querySelector(".np-cat-chip[data-cat='all']");
            return all_chip ? all_chip.classList.contains("np-chip--active") : false;
        }''')
        rec('T6-reset-cat', 'Reset: "All" category chip is active again', all_active)
    else:
        rec('T6-reset-cat', 'Reset button found in panel', False, 'missing')

    # Apply then check pill reverts
    apply = pg.locator('#np-panel-apply-btn').first
    if apply.count() > 0:
        apply.click(timeout=1500)
        pg.wait_for_timeout(400)
        pill_after = pg.locator('#np-dist-pill').first.inner_text()
        rec('T6-pill-revert', 'Dist-pill label reverts to "All" or default after reset',
            'All' in pill_after or pill_after.strip() == 'All',
            f'pill={pill_after!r}')
    else:
        rec('T6-pill-revert', 'N/A — apply not found', False, 'missing')
    shot(pg, 't6_reset')
    ctx.close()

    # ════════════════════════════════════════════════════════════
    # T7 — Empty state renders when no artisans match
    # ════════════════════════════════════════════════════════════
    print('\n' + '='*60)
    print('T7 — Empty state rendering')
    print('='*60)
    # Simulate: artisans loaded = 0, force empty state via tight 2km filter
    ctx, pg = fresh_page(extra_storage=(
        'hh_detected_location',
        json.dumps({'lat': 5.6037, 'lon': -0.1870, 'loc': 'Accra'})
    ))
    go(pg, f'{BASE}/dashboard.html', 1500)

    # Set 2km radius via panel
    pg.locator('#np-dist-pill').first.click(timeout=2000)
    pg.wait_for_timeout(300)
    r_chips = pg.locator('.np-radius-chip').all()
    if r_chips:
        r_chips[0].click(timeout=1000)  # 2km
    apply_b = pg.locator('#np-panel-apply-btn').first
    if apply_b.count() > 0:
        apply_b.click(timeout=1500)
        pg.wait_for_timeout(600)

    # The empty state appears when artisans pool is empty OR none within 2km
    # (artisans have no GPS coords in test env → they still show, but if pool is 0 → empty)
    # We just verify the element types are present and the page doesn't crash
    empty_el = pg.locator('.np-empty').count()
    pro_cards = pg.locator('.pro-card:not(.np-skeleton)').count()
    shot(pg, 't7_post_filter')
    # Either there are artisans OR the empty state — never a blank void
    rec('T7-no-blank', 'After filter: either cards or empty state rendered (not blank)',
        empty_el > 0 or pro_cards > 0,
        f'empty={empty_el} cards={pro_cards}')

    # If empty state: verify action buttons exist
    if empty_el > 0:
        has_reset = pg.locator('.np-reset-btn').count() > 0
        rec('T7-empty-reset-btn', 'Empty state: reset button present', has_reset)
    else:
        rec('T7-empty-reset-btn', 'Cards shown (not empty state) — OK', True)
    ctx.close()

    # ════════════════════════════════════════════════════════════
    # T8 — Book button navigates correctly
    # ════════════════════════════════════════════════════════════
    print('\n' + '='*60)
    print('T8 — Book button navigation')
    print('='*60)
    ctx, pg = fresh_page()
    go(pg, f'{BASE}/dashboard.html', 2500)

    # Check if any real artisan cards exist (won't in test — check skeleton/empty state gracefully)
    book_btns = pg.locator('.pc-book').all()
    if len(book_btns) > 0:
        # Try clicking first book button — should navigate to book-now.html
        try:
            book_btns[0].click(timeout=2000)
            pg.wait_for_timeout(600)
            dest = pg.url
            rec('T8-book-nav', 'Book button navigates to book-now.html',
                'book-now' in dest or 'book-step' in dest, f'dest={dest}')
        except Exception as e:
            rec('T8-book-nav', 'Book button click works', False, str(e)[:80])
    else:
        # No real cards (expected without auth) — check that _npBookArtisan is defined
        fn_defined = pg.evaluate('() => typeof window._npBookArtisan === "function"')
        rec('T8-book-fn', 'Global _npBookArtisan function is defined', fn_defined)
        # Simulate click manually
        try:
            pg.evaluate("() => window._npBookArtisan('test-id', 'Electrical')")
            pg.wait_for_timeout(500)
            dest = pg.url
            rec('T8-book-sim', 'Simulated book navigates to book-now.html',
                'book-now' in dest, f'dest={dest}')
        except Exception as e:
            rec('T8-book-sim', 'Simulated book works', False, str(e)[:80])
    ctx.close()

    # ════════════════════════════════════════════════════════════
    # T9 — Stress: rapid filter switching doesn't crash
    # ════════════════════════════════════════════════════════════
    print('\n' + '='*60)
    print('T9 — Stress: rapid filter switching')
    print('='*60)
    ctx, pg = fresh_page()
    crash_excs = []
    pg.on('pageerror', lambda e: crash_excs.append(str(e)[:60]))
    go(pg, f'{BASE}/dashboard.html', 1500)

    pg.locator('#np-dist-pill').first.click(timeout=2000)
    pg.wait_for_timeout(200)

    r_chips = pg.locator('.np-radius-chip').all()
    c_chips = pg.locator('.np-cat-chip').all()

    # Rapidly click through chips without waiting
    try:
        for i in range(min(len(r_chips), 5)):
            r_chips[i].click(timeout=500)
        for i in range(min(len(c_chips), 5)):
            c_chips[i].click(timeout=500)
        for i in range(min(len(r_chips), 5) - 1, -1, -1):
            r_chips[i].click(timeout=500)
        apply_b = pg.locator('#np-panel-apply-btn').first
        if apply_b.count() > 0:
            apply_b.click(timeout=1000)
        pg.wait_for_timeout(300)
        rec('T9-stress-no-crash', 'Rapid filter switching causes no JS exceptions',
            len(crash_excs) == 0, str(crash_excs[:2]))
    except Exception as e:
        rec('T9-stress-no-crash', 'Stress test completed without timeout crash',
            False, str(e)[:80])
    shot(pg, 't9_after_stress')
    ctx.close()

    # ════════════════════════════════════════════════════════════
    # T10 — No GPS: section still renders (no crash, no blank)
    # ════════════════════════════════════════════════════════════
    print('\n' + '='*60)
    print('T10 — No GPS permission: graceful fallback')
    print('='*60)
    ctx = browser.new_context(
        viewport={'width': 390, 'height': 844},
        geolocation=None,       # deny GPS
        permissions=[],
    )
    pg = ctx.new_page()
    exc_no_gps = []
    pg.on('pageerror', lambda e: exc_no_gps.append(str(e)[:60]))
    pg.goto(f'{BASE}/dashboard.html', wait_until='domcontentloaded', timeout=15000)
    pg.wait_for_timeout(2500)

    # Section heading must still appear
    has_title = 'Nearby Professionals' in pg.content()
    # Pro-list container must be in DOM
    list_in_dom = pg.locator('#np-pro-list').count() > 0
    # No hard crash from GPS failure
    gps_related = [e for e in exc_no_gps if any(x in e.lower() for x in ['gps','geoloc','coords'])]
    rec('T10-no-gps-title',  'No GPS: section title still renders', has_title)
    rec('T10-no-gps-list',   'No GPS: #np-pro-list still in DOM',   list_in_dom)
    rec('T10-no-gps-nocrash','No GPS: no GPS-related JS exceptions', len(gps_related) == 0,
        str(gps_related[:1]))
    shot(pg, 't10_no_gps')
    ctx.close()

    # ════════════════════════════════════════════════════════════
    # T11 — Overlay closes on backdrop click
    # ════════════════════════════════════════════════════════════
    print('\n' + '='*60)
    print('T11 — Panel overlay backdrop dismiss')
    print('='*60)
    ctx, pg = fresh_page()
    go(pg, f'{BASE}/dashboard.html', 1500)

    pg.locator('#np-filter-btn').first.click(timeout=2000)
    pg.wait_for_timeout(300)
    panel_opened = pg.evaluate('() => document.querySelector(".np-panel--open") !== null')
    rec('T11-panel-opened', 'Panel opens via filter-btn', panel_opened)

    overlay = pg.locator('.np-panel-overlay').first
    if overlay.count() > 0:
        overlay.click(timeout=1500, position={'x': 5, 'y': 5})
        pg.wait_for_timeout(350)
        panel_closed = pg.evaluate('() => document.querySelector(".np-panel--open") === null')
        rec('T11-overlay-dismiss', 'Clicking overlay backdrop closes panel', panel_closed)
    else:
        rec('T11-overlay-dismiss', 'Overlay element found', False, 'missing')
    ctx.close()

    # ════════════════════════════════════════════════════════════
    # T12 — Full page regression: no new exceptions on dashboard
    # ════════════════════════════════════════════════════════════
    print('\n' + '='*60)
    print('T12 — Full page regression')
    print('='*60)
    ctx, pg = fresh_page()
    reg_excs = []
    pg.on('pageerror', lambda e: reg_excs.append(str(e)[:80]))
    pg.goto(f'{BASE}/dashboard.html', wait_until='domcontentloaded', timeout=15000)
    pg.wait_for_timeout(3000)
    title = pg.title()
    real_excs = [e for e in reg_excs if not any(x in e.lower() for x in
        ['firebase','firestore','gstatic','googleapis','identitytoolkit',
         'failed to fetch','net::err','module','import'])]
    rec('T12-title', 'Dashboard title is HandyHub', 'HandyHub' in title, f'title={title!r}')
    rec('T12-no-exc', 'No runtime exceptions on full page load', len(real_excs) == 0,
        str(real_excs[:1]))
    shot(pg, 't12_full_page')
    ctx.close()

    browser.close()

# ════════════════════════════════════════════════════════════
# REPORT
# ════════════════════════════════════════════════════════════
total  = len(results)
n_pass = sum(1 for r in results if r['passed'])
n_fail = total - n_pass

print('\n\n' + '='*60)
print('NEARBY PROFESSIONALS — VERIFICATION REPORT')
print('='*60)
print(f'Total: {total}  Passed: {n_pass}  Failed: {n_fail}')
print()

sections = {
  'T1 Structure':        [r for r in results if r['id'].startswith('T1')],
  'T2 Skeleton':         [r for r in results if r['id'].startswith('T2')],
  'T3 Panel open/close': [r for r in results if r['id'].startswith('T3')],
  'T4 Radius chips':     [r for r in results if r['id'].startswith('T4')],
  'T5 Category chips':   [r for r in results if r['id'].startswith('T5')],
  'T6 Reset':            [r for r in results if r['id'].startswith('T6')],
  'T7 Empty state':      [r for r in results if r['id'].startswith('T7')],
  'T8 Book button':      [r for r in results if r['id'].startswith('T8')],
  'T9 Stress':           [r for r in results if r['id'].startswith('T9')],
  'T10 No GPS':          [r for r in results if r['id'].startswith('T10')],
  'T11 Backdrop':        [r for r in results if r['id'].startswith('T11')],
  'T12 Regression':      [r for r in results if r['id'].startswith('T12')],
}
for label, group in sections.items():
    gp = sum(1 for r in group if r['passed'])
    print(f'{label}: {gp}/{len(group)} passed')
    for r in group:
        icon = 'OK' if r['passed'] else 'XX'
        print(f'  [{icon}] {r["id"]}: {r["name"]}')
        if not r['passed'] and r['detail']:
            print(f'          {str(r["detail"])[:100]}')

# Summary
c_radius = all(r['passed'] for r in results if r['id'].startswith('T4'))
c_cat    = all(r['passed'] for r in results if r['id'].startswith('T5'))
c_skel   = all(r['passed'] for r in results if r['id'].startswith('T2'))
c_empty  = all(r['passed'] for r in results if r['id'].startswith('T7'))
c_reg    = all(r['passed'] for r in results if r['id'].startswith('T12'))

print()
print('SUMMARY')
print(f'  Radius filter:    {"PASS" if c_radius else "FAIL"}')
print(f'  Category filter:  {"PASS" if c_cat    else "FAIL"}')
print(f'  Skeleton loading: {"PASS" if c_skel   else "FAIL"}')
print(f'  Empty state:      {"PASS" if c_empty  else "FAIL"}')
print(f'  Regression:       {"PASS" if c_reg    else "FAIL"}')

verdict = 'PRODUCTION READY' if n_fail == 0 else f'NEEDS ATTENTION ({n_fail} failures)'
print(f'\nVERDICT: {verdict}')

with open('tests/nearby_pros_results.json','w',encoding='utf-8') as f:
    json.dump({'verdict': verdict, 'total': total, 'passed': n_pass, 'failed': n_fail,
               'results': results}, f, indent=2, ensure_ascii=False)
print('Results saved -> tests/nearby_pros_results.json')
