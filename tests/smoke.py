#!/usr/bin/env python3
"""Browser smoke test for the portal (headless, Playwright).

    python tests/smoke.py --base "http://127.0.0.1:8791/?data=/data/" --shots /tmp/shots --ref tests/tile_ref.json
    python tests/smoke.py --browser webkit ...        # Safari's engine; also firefox
    python tests/smoke.py --base https://<public site>/ --shots /tmp/shots-public --ref tests/tile_ref.json

It adapts to the tiles it finds: with the full set it expects the second click to reach the native
30 m; with a reduced copy (zoom.max below zoom.native in the catalog) it expects the page to say so
and to stop at the finest level there is.

Checks that the page boots without console errors, that tiles decode to the exact numbers the
pipeline wrote (--ref, see tests/make_tile_ref.py), that hover, click-to-zoom, the pixel series,
the full record and its CSV, the globe, the fixed coverage picture, the tabs and the request form
work, and saves screenshots to look at. Exit code 1 if any check fails.

When the copy under test sits behind a session cookie, put "name=value" in the SMOKE_COOKIE
environment variable.
"""
import argparse
import json
import math
import os
import re
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

ap = argparse.ArgumentParser()
ap.add_argument("--base", default="http://127.0.0.1:8791/")
ap.add_argument("--shots", required=True)
ap.add_argument("--ref", default="")
ap.add_argument("--query", default="intro=0")
ap.add_argument("--browser", default="chromium", choices=["chromium", "webkit", "firefox"])
ap.add_argument("--cookie", default="", help="name=value to send with every request (internal copy); "
                "or set SMOKE_COOKIE in the environment to keep it off the command line")
a = ap.parse_args()
a.cookie = a.cookie or os.environ.get("SMOKE_COOKIE", "")
shots = Path(a.shots)
shots.mkdir(parents=True, exist_ok=True)
fails, notes = [], []


def check(ok, msg):
    (notes if ok else fails).append(("ok   " if ok else "FAIL ") + msg)


with sync_playwright() as pw:
    gl = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--enable-webgl"]
    br = getattr(pw, a.browser).launch(args=gl if a.browser == "chromium" else [])
    ctx = br.new_context(viewport={"width": 1440, "height": 900}, device_scale_factor=1)
    if a.cookie:
        from urllib.parse import urlparse
        name, _, value = a.cookie.partition("=")
        ctx.add_cookies([{"name": name, "value": value, "domain": urlparse(a.base).hostname, "path": "/"}])
    page = ctx.new_page()
    console, bad = [], []
    page.on("console", lambda m: console.append((m.type, m.text)))
    page.on("pageerror", lambda e: console.append(("pageerror", str(e))))
    # MapLibre cancels tile requests it no longer needs while the view moves; those are not failures
    aborted = ("ERR_ABORTED", "cancelled", "NS_BINDING_ABORTED")      # how Chromium, WebKit and Firefox name it
    page.on("requestfailed", lambda r: bad.append((r.url, r.failure)) if not any(x in str(r.failure) for x in aborted) else None)
    page.on("response", lambda r: bad.append((r.url, r.status)) if r.status >= 400 else None)

    sep = "&" if "?" in a.base else "?"
    page.goto(a.base + (sep + a.query if a.query else ""), wait_until="domcontentloaded")
    page.wait_for_function("window.__portal && window.__portal.map && window.__portal.map.loaded()", timeout=60000)
    page.wait_for_function("document.querySelector('#boot') === null", timeout=15000)
    page.wait_for_timeout(3500)
    page.wait_for_function("window.__portal.map.areTilesLoaded()", timeout=60000)
    page.screenshot(path=str(shots / "01_explore_annual.png"))

    info = page.evaluate("""() => { const p = window.__portal, m = p.map;
        return {zoom: m.getZoom(), center: m.getCenter(), cached: p.dnCache.size, layers: p.L.size,
                projection: m.getProjection && JSON.stringify(m.getProjection()), title: document.querySelector('#lyTitle').textContent,
                mean: document.querySelector('#lyMean').textContent, res: document.querySelector('#roRes').textContent}; }""")
    notes.append(f"info {info}")
    check(info["cached"] > 0, f"numeric tiles decoded and cached ({info['cached']})")
    check(page.evaluate("window.__portal.exact()"), "tiles are decoded byte for byte (no canvas round trip)")
    check(4 < info["zoom"] < 8, f"initial view fits the peninsula (zoom {info['zoom']:.2f})")
    check("km per pixel" in info["res"], f"overview resolution readout: {info['res']}")
    zm = page.evaluate("window.__portal.zoom")
    preview = zm["max"] < zm.get("native", zm["max"])
    notes.append(f"tiles: zoom {zm['min']}-{zm['max']}" + (f" of {zm['native']} (a reduced copy)" if preview else " (the full set)"))
    strip = page.evaluate("""() => { const f = document.querySelector('.logos-footer'), im = [...f.querySelectorAll('img')];
        return {shown: getComputedStyle(f).display !== 'none', n: im.length, loaded: im.every((i) => i.complete && i.naturalWidth > 0),
                noindex: !!document.querySelector('meta[name=robots]')}; }""")
    check(strip["shown"] and strip["n"] == 2 and strip["loaded"] and not strip["noindex"], f"logo strip shown with {strip['n']} logos; page is indexable")

    # coverage picture: a file shown as an image (nothing in it reacts), with the region where the data is
    cov = page.evaluate("""async () => { const im = document.querySelector('#covMap'), r = im.getBoundingClientRect(),
        c = document.querySelector('#coverCard').getBoundingClientRect(), box = document.querySelector('#map').getBoundingClientRect();
        return {tag: im.tagName, ok: im.complete && im.naturalWidth > 0, w: r.width, h: r.height, pe: getComputedStyle(im).pointerEvents,
                inCard: r.left >= c.left && r.right <= c.right && r.top >= c.top && r.bottom <= c.bottom,
                cardInMap: c.left >= box.left && c.bottom <= box.bottom, key: document.querySelector('#coverCard').innerText,
                svg: await (await fetch(im.src)).text()}; }""")
    check(cov["tag"] == "IMG" and cov["ok"] and cov["pe"] == "none" and cov["inCard"] and cov["cardInMap"] and 200 < cov["w"] < 320
          and abs(cov["w"] / cov["h"] - 720 / 316.3) < 0.05, f"coverage picture: a fixed image of {cov['w']:.0f} x {cov['h']:.0f} px inside the coverage card")
    reg = re.search(r'<g data-region="([^"]+)"><circle cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)"', cov["svg"])

    def equal_earth(lon, lat):                                   # the projection of pipeline/make_coverage_map.py, in its drawing units
        a1, a2, a3, a4, m = 1.340264, -0.081106, 0.000893, 0.003796, math.sqrt(3) / 2
        def xy(lo, la):
            th = math.asin(m * math.sin(math.radians(la)))
            return (math.radians(lo) * math.cos(th) / (m * (a1 + 3 * a2 * th**2 + th**6 * (7 * a3 + 9 * a4 * th**2))),
                    th * (a1 + a2 * th**2 + th**6 * (a3 + a4 * th**2)))
        xmax, ytop, k = xy(180, 0)[0], xy(0, 90)[1], 720 / (2 * xy(180, 0)[0])
        x, y = xy(lon, lat)
        return (x + xmax) * k, (ytop - y) * k

    ex, ey = equal_earth(127.7, 37.9)                            # the middle of the peninsula
    check(bool(reg) and reg.group(1) in cov["key"] and math.hypot(float(reg.group(2)) - ex, float(reg.group(3)) - ey) < 6
          and cov["svg"].count("<path") == 3 and len(cov["svg"]) < 120_000,
          f"coverage picture marks {reg.group(1) if reg else '?'} where it is on the Earth "
          f"({reg.group(2) if reg else '?'}, {reg.group(3) if reg else '?'} vs {ex:.1f}, {ey:.1f}); file {len(cov['svg']) / 1024:.0f} KB")

    if a.ref:
        ref = json.loads(Path(a.ref).read_text())
        for key, exp in ref.items():
            if not exp:
                continue
            name, zxy = key.split("|")
            z, x, y = map(int, zxy.split("/"))
            if z > zm["max"]:
                continue                                        # a reduced copy does not hold this level
            lid = "clim_annual" if "annual" in name else "et_" + name.split("_")[-1].split(".")[0]
            got = page.evaluate("""async ([id, z, x, y]) => { const dn = await window.__portal.getDN(id, z, x, y);
                if (!dn) return null; let s = 0, n = 0; for (const v of dn) { s += v; if (v === 255) n++; }
                return {sum: s, n255: n, px: [dn[10*256+10], dn[128*256+128], dn[50*256+200], dn[255*256+0]]}; }""", [lid, z, x, y])
            check(got is not None and got["sum"] == exp["sum"] and got["n255"] == exp["n255"] and got["px"] == exp["px"],
                  f"tile {lid} {zxy} decodes to the pipeline's numbers (sum {got and got['sum']} vs {exp['sum']})")

    # hover: the readout shows a value in physical units
    box = page.locator("#map").bounding_box()
    cx, cy = box["x"] + box["width"] * 0.5, box["y"] + box["height"] * 0.55
    page.mouse.move(cx, cy)
    page.wait_for_timeout(400)
    ro = page.inner_text("#roVal")
    check("mm/year" in ro or ro == "no data", f"hover readout: '{ro}'")

    # click: zooms in and loads the pixel series
    z0 = page.evaluate("window.__portal.map.getZoom()")
    page.mouse.click(cx, cy)
    page.wait_for_timeout(2600)
    page.wait_for_function("window.__portal.map.areTilesLoaded()", timeout=60000)
    z1 = page.evaluate("window.__portal.map.getZoom()")
    check(z1 > z0 + 1, f"click zooms in ({z0:.2f} -> {z1:.2f})")
    page.wait_for_function("!document.querySelector('#srSub').textContent.startsWith('Reading')", timeout=30000)
    check(page.locator("#chart svg path").count() >= 1, "pixel series chart drawn: " + page.inner_text("#srTitle") + " | " + page.inner_text("#srSub"))
    # the full record at that pixel: every month that has tiles, plus a CSV
    page.wait_for_function("document.querySelector('#rcSub').textContent.includes('had a clear observation')", timeout=120000)
    n_built = page.evaluate("window.__portal.L.size - 13")
    check(page.locator("#chartRecord svg path").count() == 1 and f"of {n_built} months" in page.inner_text("#rcSub"), "full record: " + page.inner_text("#rcSub"))
    with page.expect_download() as dl:
        page.click("#rcCsv")
    csv_text = Path(dl.value.path()).read_text()
    rows = [r for r in csv_text.splitlines() if r and not r.startswith("#")]
    check(rows[0] == "month,et_mm_per_month,period,sensors" and len(rows) == n_built + 1 and all(len(r.split(",")) == 4 for r in rows),
          f"record CSV: {len(rows) - 1} rows, first {rows[1]!r}, last {rows[-1]!r}")
    head = csv_text.splitlines()[:2]
    check((" cell)" in head[0] and "mean over such a cell" in head[1]) if preview else ("(30 m pixel)" in head[0] and "cell" not in head[1]),
          f"record CSV names what a value stands for: {head[0][head[0].index('('):]}")
    page.evaluate("window.scrollTo(0, 0)")          # clicking the CSV button scrolled the side panel into view
    page.wait_for_timeout(200)
    page.screenshot(path=str(shots / "02_after_click.png"))
    page.mouse.click(cx, cy)
    page.wait_for_timeout(2600)
    page.wait_for_function("window.__portal.map.areTilesLoaded()", timeout=60000)
    z2 = page.evaluate("window.__portal.map.getZoom()")
    if preview:
        check(abs(z2 - z1) < 0.05 and "finest here" in page.inner_text("#roRes") and page.text_content("#srKicker").endswith(" cell")
              and page.locator("#previewBadge").is_visible() and "Finest here" in page.text_content('#steps span[data-step="2"]')
              and "public preview" in page.inner_text("#hint"),
              f"reduced copy: a second click stays at the finest level ({page.inner_text('#roRes')}); values are from a "
              f"{page.text_content('#srKicker')}; badge reads '{page.text_content('#previewBadge')}'")
    else:
        check(z2 > 11 and "(native)" in page.inner_text("#roRes") and page.text_content("#srKicker") == "30 m pixel" and page.locator("#previewBadge").is_hidden(),
              f"second click reaches native resolution (zoom {z2:.2f}, {page.inner_text('#roRes')})")
    page.screenshot(path=str(shots / "03_native.png"))

    # chart hover tooltip and the table twin
    sv = page.locator("#chart svg").bounding_box()
    if sv:
        page.mouse.move(sv["x"] + sv["width"] * 0.55, sv["y"] + sv["height"] * 0.5)
        page.wait_for_timeout(200)
        check(page.locator("#tip").is_visible(), "chart tooltip: " + page.inner_text("#tip").replace("\n", " / "))
        page.screenshot(path=str(shots / "04_chart_tip.png"), clip={"x": 1030, "y": 120, "width": 410, "height": 780})
    page.click("#srTableBtn")
    check(page.locator("#srTable table tbody tr").count() == 12, "series table has 12 rows")
    page.click("#srTableBtn")

    # jump list: regional view around a city
    page.select_option("#jump", label="Busan")
    page.wait_for_timeout(2400)
    c = page.evaluate("(() => { const m = window.__portal.map, c = m.getCenter(); return [c.lng, c.lat, m.getZoom()]; })()")
    check(abs(c[0] - 129.0756) < 0.02 and abs(c[1] - 35.1796) < 0.02 and abs(c[2] - 9.2) < 0.05 and page.input_value("#jump") == "",
          f"jump to Busan: centre {c[0]:.3f}, {c[1]:.3f}, zoom {c[2]:.2f}")

    # single month + seasonal cycle modes
    page.click("#modeSeg button[data-mode=month]")
    page.wait_for_timeout(1200)
    page.wait_for_function("window.__portal.map.areTilesLoaded()", timeout=60000)
    ym = page.evaluate("window.__portal.state.ym")                 # the default is the last July of the training period
    check(ym[:4] in page.inner_text("#lyTitle") and "GeoTIFF" in page.inner_text("#lySub"),
          "single-month layer: " + page.inner_text("#lyTitle") + " — " + page.inner_text("#lySub"))
    page.click("#btnHome")
    page.wait_for_timeout(2200)
    page.wait_for_function("window.__portal.map.areTilesLoaded()", timeout=60000)
    page.screenshot(path=str(shots / "05_month_peninsula.png"))
    page.click("#modeSeg button[data-mode=clim]")
    page.wait_for_timeout(900)
    check("mean" in page.inner_text("#lyTitle"), "seasonal-cycle layer: " + page.inner_text("#lyTitle"))

    # globe: the view the page opens on, with the "available now" marker on the region
    page.click("#btnGlobe")
    page.wait_for_timeout(2600)
    page.wait_for_function("window.__portal.map.areTilesLoaded()", timeout=60000)
    g = page.evaluate("""() => { const m = window.__portal.map;
        return {zoom: m.getZoom(), proj: JSON.stringify(m.getProjection ? m.getProjection() : null), land: !!m.getLayer('land'),
                well: getComputedStyle(document.querySelector('.mapwrap')).backgroundColor}; }""")
    check(abs(g["zoom"] - 1.7) < 0.05 and "globe" in (g["proj"] or "") and g["land"] and g["well"] == "rgb(15, 19, 24)",
          f"globe view: zoom {g['zoom']:.2f}, projection {g['proj']}, dark well {g['well']}")
    mk = page.evaluate("""() => { const m = window.__portal.map, r = document.querySelector('.pulse').getBoundingClientRect(), box = m.getContainer().getBoundingClientRect();
        const p = m.project([127.5, 37.4]); const l = document.querySelector('.pulse-label').getBoundingClientRect();
        return {dx: r.left + r.width / 2 - box.left - p.x, dy: r.top + r.height / 2 - box.top - p.y, labelLeft: l.left - box.left, labelRight: l.right - box.left, w: box.width,
                shown: getComputedStyle(document.querySelector('.pulse').parentElement).display !== 'none'}; }""")
    check(mk["shown"] and abs(mk["dx"]) < 12 and abs(mk["dy"]) < 12 and mk["labelLeft"] > 0 and mk["labelRight"] < mk["w"],
          f"'available now' marker sits on the peninsula and its label is inside the map (offset {mk['dx']:.0f}, {mk['dy']:.0f} px)")
    page.screenshot(path=str(shots / "06_globe.png"))
    # zoomed all the way out, the map asks for tiles coarser than the archive holds; they are averaged in the browser
    page.evaluate("window.__portal.map.jumpTo({zoom: 1.2})")
    page.wait_for_timeout(1500)
    page.wait_for_function("window.__portal.map.areTilesLoaded()", timeout=60000)
    w = page.evaluate("""() => { const p = window.__portal, lid = [...p.dnCache.keys()].filter((k) => +k.split('/')[1] < 3);
        const dn = lid.length ? p.dnCache.get(lid[lid.length - 1]) : null; let n = 0; if (dn) for (const v of dn) if (v !== 255) n++;
        return {zoom: p.map.getZoom(), coarse: lid.length, valid: n}; }""")
    check(w["coarse"] > 0 and w["valid"] > 20, f"far out (zoom {w['zoom']:.2f}): {w['coarse']} coarse tile(s) built in the browser with {w['valid']} coloured px")
    page.evaluate("window.__portal.map.jumpTo({center: [5, 46], zoom: 2.2})")
    page.wait_for_timeout(1200)
    pt = page.evaluate("(() => { const p = window.__portal.map.project([2.35, 46.5]); return [p.x, p.y]; })()")
    page.mouse.click(box["x"] + pt[0], box["y"] + pt[1])
    page.wait_for_timeout(700)
    check(page.locator(".maplibregl-popup .pop").count() == 1, "click outside Korea offers an on-demand request")
    page.screenshot(path=str(shots / "07_demand_popup.png"))
    page.click(".maplibregl-popup .pop button")
    page.wait_for_timeout(300)
    west = float(page.input_value("#rqForm [name=w]") or "nan")
    check(page.locator("#tab-request").is_visible() and abs(west - 1.85) < 0.5,
          f"request tab opens with the box prefilled around the click (W={west})")
    page.fill("#rqForm [name=name]", "Test Person")
    page.fill("#rqForm [name=org]", "Test Institute")
    page.fill("#rqForm [name=email]", "test@example.org")
    page.fill("#rqForm [name=region]", "Central France")
    page.fill("#rqForm [name=from]", "2019-01")
    page.fill("#rqForm [name=to]", "2020-12")
    page.fill("#rqForm [name=use]", "Smoke test only.")
    page.screenshot(path=str(shots / "08_request.png"), full_page=True)
    page.click("#rqCopy")
    page.wait_for_timeout(200)
    check(page.locator("#rqError").is_hidden(), "request form validates: " + page.inner_text("#rqArea"))

    cta = page.evaluate("""() => { const b = document.querySelector('.tab-cta'), s = getComputedStyle(b);
        return {bg: s.backgroundColor, color: s.color, radius: s.borderTopLeftRadius, anim: s.animationName}; }""")
    # filled pill (a darker fill while its own tab is open), white text, animated unless the visitor asked for less motion
    check(cta["bg"] in ("rgb(184, 84, 52)", "rgb(156, 74, 47)") and cta["color"] == "rgb(255, 255, 255)" and cta["radius"] == "999px"
          and cta["anim"] != "none", f"request button stands out: {cta}")
    for tab, shot in (("download", "09_download.png"), ("code", "10_code.png"), ("about", "11_about.png")):
        page.click(f".tab[data-tab={tab}]")
        page.wait_for_timeout(250)
        page.screenshot(path=str(shots / shot), full_page=True)
    ab = page.evaluate("""() => { const r = (s) => document.querySelector(s).getBoundingClientRect();
        const a = r('#tab-about .prose'), s = r('.about-side'), w = document.documentElement.clientWidth;
        return {left: a.left, right: w - s.right, gap: s.left - a.right, sideTop: s.top - a.top}; }""")
    check(abs(ab["left"] - ab["right"]) < 40 and 20 < ab["gap"] < 80, f"About: article and facts column centred as a pair (margins {ab['left']:.0f}/{ab['right']:.0f} px, gap {ab['gap']:.0f} px)")
    y0 = page.evaluate("window.scrollY")
    page.click(".toc a[href='#ab-read']")
    page.wait_for_timeout(900)
    top, y1, vh = page.evaluate("[document.getElementById('ab-read').getBoundingClientRect().top, window.scrollY, innerHeight]")
    check(y1 > y0 + 100 and 0 <= top < vh * 0.5, f"About: section link scrolls its heading into view (scrolled {y1 - y0:.0f} px, heading at {top:.0f} px)")
    page.evaluate("window.scrollTo(0, 0)")
    page.click(".tab[data-tab=download]")
    check(page.locator("#dlTable tbody tr").count() == 160, "download table lists 160 months: " + page.inner_text("#dlTotal"))

    # narrow screen
    page.set_viewport_size({"width": 430, "height": 860})
    page.click(".tab[data-tab=explore]")
    page.wait_for_timeout(1500)
    page.screenshot(path=str(shots / "12_phone.png"), full_page=True)
    over = page.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth")
    check(over <= 1, f"no horizontal overflow at 430 px (overflow {over}px)")

    # request backend: with an endpoint in config.js the form is posted as JSON (the Worker's contract);
    # a failed delivery falls back to the email draft. The endpoint here is a stand-in served by the test.
    page.set_viewport_size({"width": 1440, "height": 900})
    p2, got = ctx.new_page(), []
    p2.on("pageerror", lambda e: console.append(("pageerror", str(e))))

    def with_endpoint(route):
        resp = route.fetch()
        route.fulfill(response=resp, body=resp.text() + '\nwindow.PORTAL_CONFIG.requestEndpoint = "https://requests.example.test/submit";\n')

    def endpoint(route):
        cors_h = {"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "POST, OPTIONS"}
        if route.request.method == "OPTIONS":
            return route.fulfill(status=204, headers=cors_h)
        got.append(json.loads(route.request.post_data))
        if len(got) == 1:
            return route.fulfill(status=200, content_type="application/json", headers=cors_h, body='{"ok": true}')
        route.fulfill(status=502, content_type="application/json", headers=cors_h,
                      body='{"ok": false, "error": "The request could not be delivered."}')

    p2.route("**/js/config.js*", with_endpoint)
    p2.route("https://requests.example.test/**", endpoint)
    p2.goto(a.base + sep + "intro=0&tab=request&hidefooter=1", wait_until="domcontentloaded")
    p2.wait_for_function("window.__portal && window.__portal.map", timeout=60000)
    check(p2.locator(".logos-footer").is_hidden(), "hidefooter=1 hides the logo strip (a page that embeds the portal draws its own)")
    check(p2.inner_text("#rqSend") == "Send request" and p2.locator("#rqMail").is_visible(), "with an endpoint the button reads: " + p2.inner_text("#rqSend"))

    def fill():
        for k, v in (("name", "Test Person"), ("org", "Test Institute"), ("email", "test@example.org"), ("region", "Mekong Delta"),
                     ("w", "105.2"), ("s", "9.4"), ("e", "106.4"), ("n", "10.6"), ("from", "2019-01"), ("to", "2020-12"), ("use", "Smoke test only.")):
            p2.fill(f"#rqForm [name={k}]", v)

    fill()
    p2.click("#rqSend")
    p2.wait_for_selector("#rqDone:not([hidden])", timeout=15000)
    d = got[0] if got else {}
    check(d.get("email") == "test@example.org" and d.get("bbox") == {"w": 105.2, "s": 9.4, "e": 106.4, "n": 10.6} and d.get("from") == "2019-01"
          and d.get("to") == "2020-12" and d.get("website") == "" and d.get("elapsed_ms", 0) > 0 and d.get("region") == "Mekong Delta",
          f"form posted as JSON: {json.dumps(d)[:230]}")
    check("test@example.org" in p2.inner_text("#rqDone") and p2.input_value("#rqForm [name=name]") == "", "success message shown and the form cleared: " + p2.inner_text("#rqDone"))
    p2.screenshot(path=str(shots / "13_request_sent.png"), full_page=True)
    fill()
    p2.click("#rqSend")
    p2.wait_for_selector("#rqError:not([hidden])", timeout=15000)
    check("email draft" in p2.inner_text("#rqError") and p2.input_value("#rqForm [name=name]") == "Test Person" and p2.locator("#rqDone").is_hidden(),
          "delivery failure keeps the form and points to the draft: " + p2.inner_text("#rqError"))
    p2.close()

    errs = [c for c in console if c[0] in ("error", "pageerror")]
    check(not errs, f"no console errors ({len(errs)})")
    for c in errs[:12]:
        notes.append(f"   console {c}")
    warn = [c for c in console if c[0] == "warning"]
    for c in warn[:8]:
        notes.append(f"   warning {c[1][:200]}")
    check(not bad, f"no failed or 4xx/5xx requests ({len(bad)})")
    for b in bad[:12]:
        notes.append(f"   request {b}")
    br.close()

print("\n".join(notes))
print("\n".join(fails))
print(f"\n{len(fails)} failed")
sys.exit(1 if fails else 0)
