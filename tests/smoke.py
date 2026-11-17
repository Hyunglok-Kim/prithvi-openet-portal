#!/usr/bin/env python3
"""Browser smoke test for the portal (headless, Playwright).

    python tests/smoke.py --base "http://127.0.0.1:8791/?data=/data/" --shots /tmp/shots --ref tests/tile_ref.json
    python tests/smoke.py --browser webkit ...        # Safari's engine; also firefox
    python tests/smoke.py --base https://<public site>/ --shots /tmp/shots-public --ref tests/tile_ref.json

It adapts to the tiles it finds:
  - the full set: the second click reaches the native 30 m;
  - a reduced copy (zoom.max below zoom.native in the catalog): the page says so and stops at the
    finest level there is, with a note at the top of the map when the visitor zooms past it;
  - a reduced copy with sample areas (catalog "fine"): those areas go on to 30 m and hold the full
    set's numbers; outside their outlines nothing is finer than the copy;
  - a background layer (catalog "background"): the rest of the globe carries another product, and
    every value read from it is shown under that product's name.

Checks that the page boots without console errors and opens on the whole globe — turning into place
once, sized to the map box, on a phone too — that tiles decode to
the exact numbers the pipeline wrote (--ref, see tests/make_tile_ref.py), that hover, click-to-zoom,
the pixel series, the full record and its CSV, the notes about what is published where, the fixed
coverage picture, the tabs and the request form work, and saves screenshots to look at. Exit code 1
if any check fails.

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
ap.add_argument("--query", default="")
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
    def new_context(**kw):
        c = br.new_context(**kw)
        if a.cookie:
            from urllib.parse import urlparse
            name, _, value = a.cookie.partition("=")
            c.add_cookies([{"name": name, "value": value, "domain": urlparse(a.base).hostname, "path": "/"}])
        return c

    ctx = new_context(viewport={"width": 1440, "height": 900}, device_scale_factor=1)
    page = ctx.new_page()
    console, bad = [], []
    page.on("console", lambda m: console.append((m.type, m.text)))
    page.on("pageerror", lambda e: console.append(("pageerror", str(e))))
    # MapLibre cancels tile requests it no longer needs while the view moves; those are not failures
    aborted = ("ERR_ABORTED", "cancelled", "NS_BINDING_ABORTED")      # how Chromium, WebKit and Firefox name it
    page.on("requestfailed", lambda r: bad.append((r.url, r.failure)) if not any(x in str(r.failure) for x in aborted) else None)
    page.on("response", lambda r: bad.append((r.url, r.status)) if r.status >= 400 else None)

    def settle(ms=1500):
        """Let a move finish and its tiles arrive."""
        page.wait_for_timeout(ms)
        page.wait_for_function("!window.__portal.map.isMoving()", timeout=60000)      # on a busy machine a flight outlasts its nominal time
        page.wait_for_function("window.__portal.map.areTilesLoaded()", timeout=60000)
        page.wait_for_timeout(300)

    def xy(lng, lat):
        """Window position of a place on the map."""
        b = page.locator("#map").bounding_box()
        p = page.evaluate("([a, b]) => { const p = window.__portal.map.project([a, b]); return [p.x, p.y]; }", [lng, lat])
        return b["x"] + p[0], b["y"] + p[1]

    def view():
        return page.evaluate("(() => { const m = window.__portal.map, c = m.getCenter(); return {z: m.getZoom(), lng: c.lng, lat: c.lat}; })()")

    def note():
        return page.evaluate("""() => { const n = document.querySelector('#zoomNote');
            return {kind: window.__portal.note(), shown: !n.hidden && getComputedStyle(n).display !== 'none', text: n.innerText,
                    buttons: [...n.querySelectorAll('#znBtns button')].map((b) => b.textContent)}; }""")

    # What a page says about its opening globe: where the turn starts, where it rests, how large the globe is drawn.
    GLOBE_JS = """() => { const p = window.__portal, m = p.map, c = m.getCenter(), box = m.getContainer(), gv = p.globeView();
        const p0 = m.project([c.lng, c.lat]), p1 = m.project([c.lng + 89, 0]);
        return {zoom: m.getZoom(), lng: c.lng, lat: c.lat, w: box.clientWidth, h: box.clientHeight, rest: gv, opening: p.opening,
                D: 2 * Math.hypot(p1.x - p0.x, p1.y - p0.y) / Math.sin(89 * Math.PI / 180), minZoom: m.getMinZoom(), moving: m.isMoving()}; }"""
    AT_REST = "(() => { const p = window.__portal, m = p.map, g = p.globeView(), c = m.getCenter(); return !m.isMoving() && Math.abs(c.lng - g.center[0]) < 0.01 && Math.abs(m.getZoom() - g.zoom) < 0.01; })()"
    IN_OPENING = "['opening', 'waiting', 'opened', 'arrived', 'entered'].some((k) => document.documentElement.classList.contains(k))"

    sep = "&" if "?" in a.base else "?"
    page.goto(a.base + (sep + a.query if a.query else ""), wait_until="domcontentloaded")
    page.wait_for_function("window.__portal && window.__portal.map", timeout=60000)
    op = page.evaluate("window.__portal.opening")       # how the page means to open; null when the turn is switched off
    page.wait_for_function("window.__portal.map.loaded()", timeout=60000)
    page.wait_for_function("document.querySelector('#boot') === null", timeout=15000)
    page.wait_for_function(AT_REST, timeout=20000)      # the opening turn, if any, has come to rest on the globe view
    settle(2500)                                      # long enough for a further move to have started, if there were one
    page.screenshot(path=str(shots / "01_open_globe.png"))
    g0 = page.evaluate(GLOBE_JS)
    if "intro=0" not in a.query and "view=region" not in a.query:
        page.wait_for_function("!" + IN_OPENING, timeout=15000)      # the opening has finished and tidied up after itself
        st = page.evaluate("""() => { const o = (q) => +getComputedStyle(document.querySelector(q)).opacity;
            return {panels: [o('#coverCard'), o('.map-tr'), o('#legend'), o('#readout')], mark: o('.pulse'), minZoom: window.__portal.map.getMinZoom()}; }""")
        check(op is not None and op["turn"] >= 90 and abs(op["from"]["center"][0] - (g0["rest"]["center"][0] - op["turn"])) < 0.01
              and abs(op["from"]["center"][1] - (g0["rest"]["center"][1] - op["south"])) < 0.01
              and abs(op["from"]["zoom"] - max(0, g0["rest"]["zoom"] - op["back"])) < 0.01,
              f"the globe comes in turning: from {op and op['turn']}° to the west and {op and op['south']}° to the south, at zoom {op and op['from']['zoom']:.2f}, and settles on the globe view")
        check(st["panels"] == [1, 1, 1, 1] and st["mark"] == 1 and st["minZoom"] == 0.5,
              f"after the opening the panels and the mark are in place and nothing of it is left (opacities {st['panels']}, mark {st['mark']}, zoom limit {st['minZoom']})")

    info = page.evaluate("""() => { const p = window.__portal, m = p.map;
        return {zoom: m.getZoom(), center: m.getCenter(), cached: p.dnCache.size, layers: p.L.size,
                projection: m.getProjection && JSON.stringify(m.getProjection()), title: document.querySelector('#lyTitle').textContent,
                mean: document.querySelector('#lyMean').textContent, res: document.querySelector('#roRes').textContent,
                paper: (window.PORTAL_CONFIG || {}).paperStatus || '', notice: (window.PORTAL_CONFIG || {}).notice || '',
                internal: new URLSearchParams(location.search).has('nas')}; }""")
    notes.append(f"info {info}")
    check(info["cached"] > 0, f"numeric tiles decoded and cached ({info['cached']})")
    check(page.evaluate("window.__portal.exact()"), "tiles are decoded byte for byte (no canvas round trip)")
    check(abs(g0["zoom"] - g0["rest"]["zoom"]) < 0.01 and abs(g0["lng"] - g0["rest"]["center"][0]) < 0.01 and "globe" in (info["projection"] or "")
          and "zoom in" in info["res"] and 1.3 < g0["zoom"] < 1.6 and g0["D"] < 0.8 * min(g0["w"], g0["h"]),
          f"the page rests on the whole globe and stays there (zoom {g0['zoom']:.2f}, globe {g0['D']:.0f} px in a {g0['w']} x {g0['h']} map; readout: {info['res']})")
    zm = page.evaluate("window.__portal.zoom")
    preview = zm["max"] < zm.get("native", zm["max"])
    bg = page.evaluate("window.__portal.bg && {name: window.__portal.bg.name, km: window.__portal.bg.cell_km, layers: Object.keys(window.__portal.bg.layers)}")
    fine = page.evaluate("window.__portal.fine.map((a) => ({id: a.id, name: a.name, center: a.center}))")
    fine_zoom = page.evaluate("window.__portal.fineZoom")
    notes.append(f"tiles: zoom {zm['min']}-{zm['max']}" + (f" of {zm['native']} (a reduced copy)" if preview else " (the full set)")
                 + (f"; 30 m kept in {', '.join(f['name'] for f in fine)}" if fine else "")
                 + (f"; background {bg['name']} ({', '.join(bg['layers'])})" if bg else "; no background layer"))
    strip = page.evaluate("""() => { const f = document.querySelector('.logos-footer'), im = [...f.querySelectorAll('img')];
        return {shown: getComputedStyle(f).display !== 'none', n: im.length, loaded: im.every((i) => i.complete && i.naturalWidth > 0),
                noindex: !!document.querySelector('meta[name=robots]')}; }""")
    check(strip["shown"] and strip["n"] == 2 and strip["loaded"] and not strip["noindex"], f"logo strip shown with {strip['n']} logos; page is indexable")
    # the line at the very top: where the paper stands and when the data will be released (not on the lab's internal copy)
    if info["notice"]:
        pn = page.evaluate("""() => { const n = document.querySelector('#pageNotice'), r = n.getBoundingClientRect(), h = document.querySelector('header.top').getBoundingClientRect();
            return {shown: !n.hidden && r.height > 0, text: n.textContent, top: r.top, above: r.bottom <= h.top + 1, wide: r.width >= innerWidth - 2}; }""")
        if info["internal"]:
            check(not pn["shown"], "the lab's internal copy does not carry the public notice")
        else:
            check(pn["shown"] and pn["text"] == info["notice"] and pn["top"] <= 1 and pn["above"] and pn["wide"],
                  f"notice at the very top of the page: {pn['text']}")

    # the background layer: another product under our maps, named wherever a value from it is shown
    if bg:
        lg = page.evaluate("(() => { const n = document.querySelector('#lgBg'); return {shown: !n.hidden, text: n.textContent}; })()")
        check(lg["shown"] and bg["name"] in lg["text"] and "not this model" in lg["text"], f"legend names the background: {lg['text']}")
        page.mouse.move(*xy(105, 30))                              # central China, on the opening globe
        page.wait_for_timeout(400)
        ro = page.inner_text("#roVal")
        check(ro.startswith(bg["name"] + ":") and "mm/year" in ro, f"a value read outside our maps carries the product's name: '{ro}'")
        page.mouse.move(*xy(127.9, 36.6))                          # central Korea
        page.wait_for_timeout(400)
        ro = page.inner_text("#roVal")
        check("mm/year" in ro and bg["name"] not in ro, f"a value read on our maps does not: '{ro}'")
        vis = page.evaluate("window.__portal.map.getLayoutProperty('ctx', 'visibility')")
        check(vis == "visible", "background layer drawn with the annual-mean layer")

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
        def proj(lo, la):
            th = math.asin(m * math.sin(math.radians(la)))
            return (math.radians(lo) * math.cos(th) / (m * (a1 + 3 * a2 * th**2 + th**6 * (7 * a3 + 9 * a4 * th**2))),
                    th * (a1 + a2 * th**2 + th**6 * (a3 + a4 * th**2)))
        xmax, ytop, k = proj(180, 0)[0], proj(0, 90)[1], 720 / (2 * proj(180, 0)[0])
        x, y = proj(lon, lat)
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
            name, zxy, *win = key.split("|")
            z, x, y = map(int, zxy.split("/"))
            if z > zm["max"] and not (win and fine and z <= fine_zoom):
                continue                                        # a reduced copy holds this level only inside its sample areas
            lid = "clim_annual" if "annual" in name else "et_" + name.split("_")[-1].split(".")[0]
            if win:                                             # a window inside a sample area: the full set's numbers
                r0, c0, h, w = map(int, win[0].split(","))
                got = page.evaluate("""async ([id, z, x, y, r0, c0, h, w]) => { const dn = await window.__portal.getDN(id, z, x, y);
                    if (!dn) return null; let s = 0, n = 0;
                    for (let r = r0; r < r0 + h; r++) for (let c = c0; c < c0 + w; c++) { const v = dn[r * 256 + c]; s += v; if (v === 255) n++; }
                    return {sum: s, n255: n}; }""", [lid, z, x, y, r0, c0, h, w])
                check(got is not None and got["sum"] == exp["sum"] and got["n255"] == exp["n255"],
                      f"tile {lid} {zxy}, a {h} x {w} px window at native zoom, holds the full set's numbers (sum {got and got['sum']} vs {exp['sum']})")
                continue
            got = page.evaluate("""async ([id, z, x, y]) => { const dn = await window.__portal.getDN(id, z, x, y);
                if (!dn) return null; let s = 0, n = 0; for (const v of dn) { s += v; if (v === 255) n++; }
                return {sum: s, n255: n, px: [dn[10*256+10], dn[128*256+128], dn[50*256+200], dn[255*256+0]]}; }""", [lid, z, x, y])
            check(got is not None and got["sum"] == exp["sum"] and got["n255"] == exp["n255"] and got["px"] == exp["px"],
                  f"tile {lid} {zxy} decodes to the pipeline's numbers (sum {got and got['sum']} vs {exp['sum']})")

    # the Peninsula button fits the region that has maps
    page.click("#btnHome")
    settle(2200)
    v = view()
    res = page.inner_text("#roRes")
    check(4 < v["z"] < 8 and "km per pixel" in res, f"'Peninsula' fits the region (zoom {v['z']:.2f}, {res})")
    if fine:
        def tags():
            return page.evaluate("""() => [...document.querySelectorAll('.fine-tag')].map((t) => { const r = t.getBoundingClientRect();
                return {text: t.textContent, shown: getComputedStyle(t).display !== 'none', compact: t.classList.contains('compact'), w: r.width}; })""")
        far = tags()
        cov = page.evaluate("(() => { const r = document.querySelector('#covFine'); return {shown: !r.hidden, text: r.textContent}; })()")
        go = page.evaluate("""[...document.querySelectorAll('#jump optgroup[label="30 m areas"] option')].map((o) => o.textContent)""")
        check(len(far) == len(fine) and all(t["shown"] and "30 m" in t["text"] and t["compact"] and t["w"] < 20 for t in far)
              and page.evaluate("!!window.__portal.map.getLayer('fine-line')") and cov["shown"] and "30 m" in cov["text"]
              and go == [f["name"] for f in fine],
              f"sample areas: {len(far)} small squares on the peninsula view, a line in the coverage card ('{cov['text'].strip()}'), all in the 'Go to' list")
        page.screenshot(path=str(shots / "02_peninsula.png"))
        # a click just beside a square is meant for the area, and so is a click inside the outline at the regional view
        x, y = xy(*fine[1]["center"])
        page.mouse.click(x + 7, y + 5)
        settle(3000)
        v = view()
        check(v["z"] >= fine_zoom + 0.55 and abs(v["lng"] - fine[1]["center"][0]) < 0.04 and abs(v["lat"] - fine[1]["center"][1]) < 0.04
              and "(native)" in page.inner_text("#roRes"),
              f"a click beside a square goes to {fine[1]['name']} (zoom {v['z']:.2f}, {page.inner_text('#roRes')})")
        page.evaluate("([lng, lat]) => window.__portal.map.jumpTo({center: [lng, lat], zoom: 9.2})", fine[2]["center"])
        settle(1200)
        hint = page.inner_text("#roRes")
        page.mouse.click(*xy(*fine[2]["center"]))
        settle(3000)
        v = view()
        check("zoom in for 30 m" in hint and v["z"] >= fine_zoom + 0.55 and abs(v["lng"] - fine[2]["center"][0]) < 0.04 and "(native)" in page.inner_text("#roRes"),
              f"at the regional view the readout says '{hint}', and a click inside the outline goes to {fine[2]['name']} (zoom {v['z']:.2f})")
        page.evaluate("([lng, lat]) => window.__portal.map.jumpTo({center: [lng, lat], zoom: 7.6})", fine[0]["center"])
        settle(900)
        near = tags()
        check(all(t["shown"] and not t["compact"] and t["w"] > 40 for t in near) and page.inner_text(".fine-tag") != "",
              f"closer in the squares become name tags: {[t['text'] for t in near][:4]} …")
        page.screenshot(path=str(shots / "02b_area_tags.png"))
        page.click("#btnHome")
        settle(2200)
    else:
        page.screenshot(path=str(shots / "02_peninsula.png"))

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
    settle(2600)
    z1 = page.evaluate("window.__portal.map.getZoom()")
    check(z1 > z0 + 1, f"click zooms in ({z0:.2f} -> {z1:.2f})")
    page.wait_for_function("!document.querySelector('#srSub').textContent.startsWith('Reading')", timeout=30000)
    check(page.locator("#chart svg path").count() >= 1, "pixel series chart drawn: " + page.inner_text("#srTitle") + " | " + page.inner_text("#srSub"))
    # the full record at that pixel: every month that has tiles, plus a CSV
    page.wait_for_function("document.querySelector('#rcSub').textContent.includes('had a clear observation')", timeout=120000)
    n_built = page.evaluate("window.__portal.L.size - 13")
    check(page.locator("#chartRecord svg path").count() == 1 and f"of {n_built} months" in page.inner_text("#rcSub"), "full record: " + page.inner_text("#rcSub"))

    def record_csv():
        with page.expect_download() as dl:
            page.click("#rcCsv")
        text = Path(dl.value.path()).read_text()
        page.evaluate("window.scrollTo(0, 0)")          # clicking the CSV button scrolled the side panel into view
        page.wait_for_timeout(200)
        return text, [r for r in text.splitlines() if r and not r.startswith("#")]

    csv_text, rows = record_csv()
    check(rows[0] == "month,et_mm_per_month,period,sensors" and len(rows) == n_built + 1 and all(len(r.split(",")) == 4 for r in rows),
          f"record CSV: {len(rows) - 1} rows, first {rows[1]!r}, last {rows[-1]!r}")
    head = csv_text.splitlines()[:2]
    check((" cell)" in head[0] and "mean over such a cell" in head[1]) if preview else ("(30 m pixel)" in head[0] and "cell" not in head[1]),
          f"record CSV names what a value stands for: {head[0][head[0].index('('):]}")
    page.screenshot(path=str(shots / "03_after_click.png"))
    page.mouse.click(cx, cy)
    settle(2600)
    z2 = page.evaluate("window.__portal.map.getZoom()")
    if preview:
        check(abs(z2 - z1) < 0.05 and "finest here" in page.inner_text("#roRes") and page.text_content("#srKicker").endswith(" cell")
              and page.locator("#previewBadge").is_visible() and "Finest here" in page.text_content('#steps span[data-step="2"]')
              and "public preview" in page.inner_text("#hint") and not note()["shown"],
              f"reduced copy: a second click stays at the finest level ({page.inner_text('#roRes')}); values are from a "
              f"{page.text_content('#srKicker')}; badge reads '{page.text_content('#previewBadge')}'")
        # zooming past the finest level brings up the note that says where the detail is
        page.evaluate("window.__portal.map.jumpTo({zoom: 10.6})")
        settle(1200)
        n = note()
        check(n["kind"] == "finest" and n["shown"] and "finest level here" in n["text"] and "30 m" in n["text"] and len(n["buttons"]) == min(3, len(fine))
              and (not info["paper"] or not fine or info["paper"] in n["text"]),
              "past the finest level a note says so: " + " ".join(n["text"].split())[:260])
        page.screenshot(path=str(shots / "04_finest_note.png"))
        page.click("#znClose")
        page.wait_for_timeout(200)
        check(not note()["shown"], "the note closes")
        if fine:
            # a sample area: the note's button goes there, and there the copy is at the native 30 m
            page.evaluate("window.__portal.map.jumpTo({zoom: 9.2})")        # leave the situation, so the closed note may come back
            page.wait_for_timeout(400)
            page.evaluate("window.__portal.map.jumpTo({zoom: 10.6})")
            settle(900)
            # the note offers the nearest areas, nearest first
            c0, names = view(), note()["buttons"]
            by_dist = sorted(fine, key=lambda f: math.hypot((f["center"][0] - c0["lng"]) * math.cos(math.radians(c0["lat"])), f["center"][1] - c0["lat"]))
            check(names == [f"{f['name']} · 30 m" for f in by_dist[:3]], f"the note offers the nearest areas: {names}")
            page.click("#znBtns button:first-child")
            settle(3000)
            v, f0 = view(), by_dist[0]
            px = 2 ** (v["z"] - (fine_zoom - 1))                    # screen pixels per native pixel
            check(fine_zoom + 0.55 <= v["z"] <= fine_zoom + 1.55 and px >= 2.9 and abs(v["lng"] - f0["center"][0]) < 0.04 and abs(v["lat"] - f0["center"][1]) < 0.04
                  and "(native)" in page.inner_text("#roRes") and not note()["shown"]
                  and page.evaluate("""(() => { const s = document.querySelector('#steps span[data-step="2"]'); return s.classList.contains('on') && s.textContent === 'Native 30 m'; })()"""),
                  f"the note's button goes to {f0['name']} with its pixels in view: zoom {v['z']:.2f}, {px:.1f} screen px per pixel, {page.inner_text('#roRes')}")
            page.mouse.click(*xy(*f0["center"]))
            page.wait_for_timeout(600)
            page.wait_for_function("!document.querySelector('#srSub').textContent.startsWith('Reading')", timeout=30000)
            page.wait_for_function("document.querySelector('#rcSub').textContent.includes('had a clear observation')", timeout=120000)
            csv_text, rows = record_csv()
            head = csv_text.splitlines()[:2]
            check(page.text_content("#srKicker") == "30 m pixel" and "(30 m pixel)" in head[0] and "cell" not in head[1] and len(rows) == n_built + 1,
                  f"inside a sample area a clicked spot is a {page.text_content('#srKicker')} and its CSV says so: {head[0][head[0].index('('):]}")
            page.screenshot(path=str(shots / "05_sample_area.png"))
            # just outside the outline the copy is back to its own finest level
            page.evaluate("([lng, lat]) => window.__portal.map.jumpTo({center: [lng + 0.09, lat], zoom: 11.7})", f0["center"])
            settle(1200)
            n = note()
            check(n["kind"] == "finest" and n["shown"] and "finest here" in page.inner_text("#roRes"),
                  f"outside the outline the note is back ({page.inner_text('#roRes')})")
            page.evaluate("([lng, lat]) => window.__portal.map.jumpTo({center: [lng, lat], zoom: 9.2})", [v["lng"], v["lat"]])
            settle(900)
    else:
        check(z2 > 11 and "(native)" in page.inner_text("#roRes") and page.text_content("#srKicker") == "30 m pixel" and page.locator("#previewBadge").is_hidden()
              and not note()["shown"],
              f"second click reaches native resolution (zoom {z2:.2f}, {page.inner_text('#roRes')})")
    page.screenshot(path=str(shots / "06_native_or_finest.png"))

    # chart hover tooltip and the table twin
    sv = page.locator("#chart svg").bounding_box()
    if sv:
        page.mouse.move(sv["x"] + sv["width"] * 0.55, sv["y"] + sv["height"] * 0.5)
        page.wait_for_timeout(200)
        check(page.locator("#tip").is_visible(), "chart tooltip: " + page.inner_text("#tip").replace("\n", " / "))
        page.screenshot(path=str(shots / "07_chart_tip.png"), clip={"x": 1030, "y": 120, "width": 410, "height": 780})
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
    settle(1200)
    ym = page.evaluate("window.__portal.state.ym")                 # the default is the last July of the training period
    check(ym[:4] in page.inner_text("#lyTitle") and "GeoTIFF" in page.inner_text("#lySub"),
          "single-month layer: " + page.inner_text("#lyTitle") + " — " + page.inner_text("#lySub"))
    page.click("#btnHome")
    settle(2200)
    page.screenshot(path=str(shots / "08_month_peninsula.png"))
    page.click("#modeSeg button[data-mode=clim]")
    page.wait_for_timeout(900)
    check("mean" in page.inner_text("#lyTitle"), "seasonal-cycle layer: " + page.inner_text("#lyTitle"))
    if bg and "clim_07" not in bg["layers"]:
        off = page.evaluate("({vis: window.__portal.map.getLayoutProperty('ctx', 'visibility'), lg: document.querySelector('#lgBg').hidden})")
        check(off["vis"] == "none" and off["lg"], "a layer the background has no counterpart for is shown without it")

    # globe: the view the page opens on, with the "available now" marker on the region
    page.click("#btnGlobe")
    settle(2600)
    g = page.evaluate("""() => { const m = window.__portal.map;
        return {zoom: m.getZoom(), proj: JSON.stringify(m.getProjection ? m.getProjection() : null), land: !!m.getLayer('land'),
                well: getComputedStyle(document.querySelector('.mapwrap')).backgroundColor}; }""")
    check(page.evaluate(AT_REST) and "globe" in (g["proj"] or "") and g["land"] and g["well"] == "rgb(15, 19, 24)",
          f"globe view: zoom {g['zoom']:.2f}, projection {g['proj']}, dark well {g['well']}")
    mk = page.evaluate("""() => { const m = window.__portal.map, r = document.querySelector('.pulse').getBoundingClientRect(), box = m.getContainer().getBoundingClientRect();
        const p = m.project([127.5, 37.4]); const l = document.querySelector('.pulse-label').getBoundingClientRect();
        return {dx: r.left + r.width / 2 - box.left - p.x, dy: r.top + r.height / 2 - box.top - p.y, labelLeft: l.left - box.left, labelRight: l.right - box.left, w: box.width,
                shown: getComputedStyle(document.querySelector('.pulse').parentElement).display !== 'none'}; }""")
    check(mk["shown"] and abs(mk["dx"]) < 12 and abs(mk["dy"]) < 12 and mk["labelLeft"] > 0 and mk["labelRight"] < mk["w"],
          f"'available now' marker sits on the peninsula and its label is inside the map (offset {mk['dx']:.0f}, {mk['dy']:.0f} px)")
    page.screenshot(path=str(shots / "09_globe_seasonal.png"))
    # zoomed all the way out, the map asks for tiles coarser than the archive holds; they are averaged in the browser
    page.evaluate("window.__portal.map.jumpTo({zoom: 1.2})")
    settle(1500)
    w = page.evaluate("""() => { const p = window.__portal, lid = [...p.dnCache.keys()].filter((k) => !k.startsWith('bg_') && +k.split('/')[1] < 3);
        let best = 0, made = 0;                                     // tiles away from the region come out empty; count the fullest
        for (const k of lid) { const dn = p.dnCache.get(k); if (!dn) continue; made++; let n = 0; for (const v of dn) if (v !== 255) n++; best = Math.max(best, n); }
        return {zoom: p.map.getZoom(), coarse: made, valid: best}; }""")
    check(w["coarse"] > 0 and w["valid"] > 20, f"far out (zoom {w['zoom']:.2f}): {w['coarse']} coarse tile(s) built in the browser, the fullest with {w['valid']} coloured px")
    page.click("#modeSeg button[data-mode=annual]")
    settle(1200)

    # outside the region with maps: a click moves in on the place, twice; there a note says what is published,
    # and the next click offers to request the place
    place = (78.5, 22.5)                                          # central India
    page.evaluate("window.__portal.map.jumpTo({center: [60, 25], zoom: 1.7})")
    settle(1200)
    page.mouse.click(*xy(*place))
    settle(2000)
    v1 = view()
    page.mouse.click(*xy(*place))
    settle(2400)
    v2, n = view(), note()
    check(abs(v1["z"] - 4.6) < 0.05 and 7.3 <= v2["z"] <= 8.5 and abs(v2["lng"] - place[0]) < 0.3 and abs(v2["lat"] - place[1]) < 0.3
          and page.locator(".maplibregl-popup").count() == 0,
          f"outside Korea two clicks move in on the place (zoom {v1['z']:.2f}, then {v2['z']:.2f})")
    check(n["kind"] == "outside" and n["shown"] and "Korean Peninsula" in n["text"] and "on request" in n["text"] and len(n["buttons"]) == 2
          and (not bg or (bg["name"] in n["text"] and "not Prithvi-OpenET-Tower" in n["text"])) and (not info["paper"] or info["paper"] in n["text"])
          and page.evaluate("getComputedStyle(document.querySelector('#steps')).visibility") == "hidden",
          "there a note says what is published: " + " ".join(n["text"].split())[:330])
    if bg:
        page.mouse.move(*xy(*place))
        page.wait_for_timeout(400)
        check(page.inner_text("#roVal").startswith(bg["name"] + ":") and "Background" in page.inner_text("#roRes"),
              f"readout there: {page.inner_text('#roRes')} | {page.inner_text('#roVal')}")
    page.screenshot(path=str(shots / "10_outside_note.png"))
    page.mouse.click(*xy(*place))
    page.wait_for_timeout(700)
    check(page.locator(".maplibregl-popup .pop").count() == 1, "the next click offers an on-demand request")
    page.screenshot(path=str(shots / "11_demand_popup.png"))
    page.click(".maplibregl-popup .pop button")
    page.wait_for_timeout(300)
    west = float(page.input_value("#rqForm [name=w]") or "nan")
    check(page.locator("#tab-request").is_visible() and abs(west - (place[0] - 0.5)) < 0.5,
          f"request tab opens with the box prefilled around the click (W={west})")
    page.fill("#rqForm [name=name]", "Test Person")
    page.fill("#rqForm [name=org]", "Test Institute")
    page.fill("#rqForm [name=email]", "test@example.org")
    page.fill("#rqForm [name=region]", "Central India")
    page.fill("#rqForm [name=from]", "2019-01")
    page.fill("#rqForm [name=to]", "2020-12")
    page.fill("#rqForm [name=use]", "Smoke test only.")
    page.screenshot(path=str(shots / "12_request.png"), full_page=True)
    page.click("#rqCopy")
    page.wait_for_timeout(200)
    check(page.locator("#rqError").is_hidden(), "request form validates: " + page.inner_text("#rqArea"))
    # the note's own buttons: back to the region with maps
    page.click(".tab[data-tab=explore]")
    page.wait_for_timeout(400)
    page.keyboard.press("Escape")
    page.click("#znBtns button:first-child")
    settle(2400)
    v = view()
    check(4 < v["z"] < 8 and abs(v["lng"] - 128.1) < 1.5 and not note()["shown"], f"the note's button goes to the Korean Peninsula (zoom {v['z']:.2f})")

    cta = page.evaluate("""() => { const b = document.querySelector('.tab-cta'), s = getComputedStyle(b);
        return {bg: s.backgroundColor, color: s.color, radius: s.borderTopLeftRadius, anim: s.animationName}; }""")
    # filled pill (a darker fill while its own tab is open), white text, animated unless the visitor asked for less motion
    check(cta["bg"] in ("rgb(184, 84, 52)", "rgb(156, 74, 47)") and cta["color"] == "rgb(255, 255, 255)" and cta["radius"] == "999px"
          and cta["anim"] != "none", f"request button stands out: {cta}")
    for tab, shot in (("download", "13_download.png"), ("code", "14_code.png"), ("about", "15_about.png")):
        page.click(f".tab[data-tab={tab}]")
        page.wait_for_timeout(250)
        page.screenshot(path=str(shots / shot), full_page=True)
    ab = page.evaluate("""() => { const r = (s) => document.querySelector(s).getBoundingClientRect();
        const a = r('#tab-about .prose'), s = r('.about-side'), w = document.documentElement.clientWidth;
        return {left: a.left, right: w - s.right, gap: s.left - a.right, sideTop: s.top - a.top}; }""")
    check(abs(ab["left"] - ab["right"]) < 40 and 20 < ab["gap"] < 80, f"About: article and facts column centred as a pair (margins {ab['left']:.0f}/{ab['right']:.0f} px, gap {ab['gap']:.0f} px)")
    if bg:
        t = page.inner_text("#abBg")
        check(page.locator("#abBg").is_visible() and "background layer" in t and "has not been run" in t and bg["name"] in page.inner_text("#abCredits"),
              "About says what the background is: " + t[:150] + "…")
    if info["paper"]:
        check(page.inner_text("#abPaper") == f"Manuscript {info['paper']}.", "citation gives the paper's status: " + page.inner_text("#abPaper"))
    y0 = page.evaluate("window.scrollY")
    page.click(".toc a[href='#ab-read']")
    page.wait_for_timeout(900)
    for _ in range(20):                                             # the scroll is smooth; on a busy machine it takes longer than that
        ya = page.evaluate("window.scrollY"); page.wait_for_timeout(250)
        if page.evaluate("window.scrollY") == ya: break
    top, y1, vh = page.evaluate("[document.getElementById('ab-read').getBoundingClientRect().top, window.scrollY, innerHeight]")
    check(y1 > y0 + 100 and 0 <= top < vh * 0.5, f"About: section link scrolls its heading into view (scrolled {y1 - y0:.0f} px, heading at {top:.0f} px)")
    page.evaluate("window.scrollTo(0, 0)")
    page.click(".tab[data-tab=download]")
    check(page.locator("#dlTable tbody tr").count() == 160, "download table lists 160 months: " + page.inner_text("#dlTotal"))

    # narrow screen
    page.set_viewport_size({"width": 430, "height": 860})
    page.click(".tab[data-tab=explore]")
    page.wait_for_timeout(1500)
    page.screenshot(path=str(shots / "16_phone.png"), full_page=True)
    over = page.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth")
    check(over <= 1, f"no horizontal overflow at 430 px (overflow {over}px)")

    # a phone: the opening globe is sized to the map box (a fixed desktop zoom spilled it out of the box), both in
    # the page as the lab site embeds it and on its own; the readout sits clear of the legend and the controls
    for label, q in (("embedded", "embed=1&hidefooter=1"), ("on its own", "")):
        pc = new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, has_touch=True, is_mobile=True)
        ph = pc.new_page()
        ph.on("pageerror", lambda e: console.append(("pageerror", str(e))))
        ph.goto(a.base + sep + "intro=0" + ("&" + q if q else ""), wait_until="domcontentloaded")
        ph.wait_for_function("window.__portal && window.__portal.map && window.__portal.map.loaded()", timeout=60000)
        ph.wait_for_function("document.querySelector('#boot') === null", timeout=15000)
        ph.wait_for_timeout(1200)
        g = ph.evaluate(GLOBE_JS)
        lay = ph.evaluate("""() => { const r = (q) => { const b = document.querySelector(q).getBoundingClientRect(); return [b.left, b.top, b.right, b.bottom]; };
            const hit = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
            const m = r('#map'), ro = r('#readout'), lg = r('#legend'), tr = r('.map-tr');
            return {onLegend: hit(ro, lg), onControls: hit(ro, tr), inside: ro[0] >= m[0] && ro[2] <= m[2], legendTop: lg[1] - m[1],
                    text: document.querySelector('#roRes').textContent}; }""")
        bottom = g["h"] / 2 + g["D"] / 2                              # the globe sits in the middle of its box
        check(g["opening"] is None and abs(g["zoom"] - g["rest"]["zoom"]) < 0.01 and abs(g["lng"] - g["rest"]["center"][0]) < 0.01
              and g["D"] <= 0.9 * min(g["w"], g["h"]) and g["minZoom"] <= g["zoom"],
              f"phone, {label}: the globe fits its box ({g['D']:.0f} px across in a {g['w']} x {g['h']} map, zoom {g['zoom']:.2f}); intro=0 opens at rest")
        check(not lay["onLegend"] and not lay["onControls"] and lay["inside"] and (not q or bottom <= lay["legendTop"] + 2),
              f"phone, {label}: the readout ('{lay['text']}') is clear of the legend and the controls"
              + (f"; the legend starts below the globe ({lay['legendTop']:.0f} px, globe ends at {bottom:.0f} px)" if q else ""))
        ph.locator(".mapwrap").screenshot(path=str(shots / f"16b_phone_map_{'embedded' if q else 'alone'}.png"))
        # 'Peninsula' fits the region between the readout and the legend, not behind the legend
        ph.tap("#btnHome")
        ph.wait_for_timeout(2400)
        fit = ph.evaluate("""() => { const p = window.__portal, m = p.map, mb = m.getContainer().getBoundingClientRect();
            const lg = document.querySelector('#legend').getBoundingClientRect(), ro = document.querySelector('#readout').getBoundingClientRect();
            const b = m.getBounds(), sw = m.project([126.2, 34.3]), ne = m.project([129.6, 42.4]);     // the south-west tip of the mainland and the north-east
            return {south: sw.y, west: sw.x, north: ne.y, east: ne.x, legendTop: lg.top - mb.top, readoutBottom: ro.bottom - mb.top, w: mb.width, zoom: m.getZoom()}; }""")
        check(fit["south"] <= fit["legendTop"] + 2 and fit["north"] >= fit["readoutBottom"] - 2 and 0 <= fit["west"] and fit["east"] <= fit["w"],
              f"phone, {label}: 'Peninsula' shows the region above the legend (its south at {fit['south']:.0f} px, the legend from {fit['legendTop']:.0f} px; zoom {fit['zoom']:.2f})")
        ph.locator(".mapwrap").screenshot(path=str(shots / f"16c_phone_peninsula_{'embedded' if q else 'alone'}.png"))
        pc.close()

    # On a phone the map starts below the fold. The opening turn waits until the visitor has scrolled to the map, and
    # meanwhile the panels are there (an empty dark box would look broken); then it runs and tidies up. The window is
    # cut to end above the middle of the map, wherever that is on the copy under test.
    pc = new_context(viewport={"width": 390, "height": 700}, device_scale_factor=2, has_touch=True, is_mobile=True)
    ph = pc.new_page()
    ph.on("pageerror", lambda e: console.append(("pageerror", str(e))))
    ph.goto(a.base + sep + "intro=0", wait_until="domcontentloaded")      # first, where the middle of the map is on this page (a copy without the notice is shorter)
    ph.wait_for_function("window.__portal && window.__portal.map && window.__portal.map.loaded()", timeout=60000)      # and let it finish: Firefox has crashed when a map was navigated away from while starting up
    mid = ph.evaluate("document.querySelector('#mapMid').getBoundingClientRect().top")
    ph.set_viewport_size({"width": 390, "height": int(min(700, mid - 40))})      # a window that ends above it
    ph.goto(a.base, wait_until="domcontentloaded")
    ph.wait_for_function("window.__portal && window.__portal.map && window.__portal.map.loaded()", timeout=60000)
    ph.wait_for_function("document.querySelector('#boot') === null", timeout=15000)
    ph.wait_for_timeout(1800)
    WAIT_JS = """() => { const p = window.__portal, m = p.map, c = m.getCenter(); const o = (q) => { const e = document.querySelector(q); return e ? +getComputedStyle(e).opacity : null; };
        return {cls: document.documentElement.className, lng: c.lng, start: p.opening && p.opening.from.center[0], legend: o('#legend'), controls: o('.map-tr'), mark: o('.pulse'),
                mid: document.querySelector('#mapMid').getBoundingClientRect().top, low: document.querySelector('#mapLow').getBoundingClientRect().top,
                vh: innerHeight, scrollY: scrollY, moving: m.isMoving(), minZoom: m.getMinZoom()}; }"""
    w0 = ph.evaluate(WAIT_JS)
    ph.evaluate("document.querySelector('.mapwrap').scrollIntoView({block: 'center'})")
    ph.wait_for_function(AT_REST, timeout=20000)
    ph.wait_for_function("!" + IN_OPENING, timeout=15000)
    w1 = ph.evaluate(WAIT_JS)
    check(w0["mid"] > w0["vh"] and "waiting" in w0["cls"] and w0["start"] is not None and abs(w0["lng"] - w0["start"]) < 0.01
          and w0["legend"] == 1 and w0["controls"] == 1 and w0["mark"] == 0,
          f"phone: with the map below the fold the turn waits (centre still at {w0['lng']:.1f}°E) and the panels are already there")
    check(w1["mark"] == 1 and w1["minZoom"] == 0.5 and w1["legend"] == 1,
          "phone: once the map is scrolled into view the globe turns into place, the mark lands and nothing of the opening is left")
    pc.close()

    # A laptop window on the lab site shows the upper part of the map only: its middle is on screen, the part below is
    # not. The visitor has just come in, so the opening runs at once there instead of waiting for a scroll. The window
    # is cut to end between the two points the opening looks at (embed=1 gives the map its fixed embedded height).
    pc = new_context(viewport={"width": 1440, "height": 900}, device_scale_factor=1)
    lp = pc.new_page()
    lp.on("pageerror", lambda e: console.append(("pageerror", str(e))))
    lp.goto(a.base + sep + "intro=0&embed=1&hidefooter=1", wait_until="domcontentloaded")
    lp.wait_for_function("window.__portal && window.__portal.map && window.__portal.map.loaded()", timeout=60000)
    pts = lp.evaluate("['#mapMid', '#mapLow'].map((q) => document.querySelector(q).getBoundingClientRect().top)")
    lp.set_viewport_size({"width": 1440, "height": round((pts[0] + pts[1]) / 2)})
    lp.goto(a.base + sep + "embed=1&hidefooter=1", wait_until="domcontentloaded")
    lp.wait_for_function("window.__portal && window.__portal.map", timeout=60000)
    try:                                                    # no waiting for the tiles here: over a slow line the turn is over before the last one is in
        lp.wait_for_function("window.__portal.map.isMoving()", timeout=30000)      # the turn starts by itself
    except Exception:
        pass
    l0 = lp.evaluate(WAIT_JS)
    lp.wait_for_function(AT_REST, timeout=20000)
    lp.wait_for_function("!" + IN_OPENING, timeout=15000)
    l1 = lp.evaluate(WAIT_JS)
    check(l0["mid"] < l0["vh"] < l0["low"] and l0["moving"] and "waiting" not in l0["cls"] and l1["scrollY"] == 0 and l1["mark"] == 1 and l1["minZoom"] == 0.5,
          f"laptop window on the lab site: with the middle of the map on screen ({l0['mid']:.0f} px of {l0['vh']}) and its lower part not, the opening runs at once, without a scroll")
    pc.close()

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
    p2.goto(a.base + sep + "view=region&tab=request&hidefooter=1", wait_until="domcontentloaded")
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
    p2.screenshot(path=str(shots / "17_request_sent.png"), full_page=True)
    fill()
    p2.click("#rqSend")
    p2.wait_for_selector("#rqError:not([hidden])", timeout=15000)
    check("email draft" in p2.inner_text("#rqError") and p2.input_value("#rqForm [name=name]") == "Test Person" and p2.locator("#rqDone").is_hidden(),
          "delivery failure keeps the form and points to the draft: " + p2.inner_text("#rqError"))
    # view=region asks for the region with maps instead of the globe; the page was opened on another tab, so the fit waited
    p2.click(".tab[data-tab=explore]")
    p2.wait_for_timeout(1200)
    zr = p2.evaluate("window.__portal.map.getZoom()")
    check(4 < zr < 8, f"view=region opens on the region with maps instead of the globe (zoom {zr:.2f})")
    p2.close()

    # A browser that gives no WebGL context (graphics acceleration switched off, or lost for the session): the page
    # says so where the map would be instead of staying on its loading screen, and the rest of it works.
    pc = new_context(viewport={"width": 1440, "height": 900}, device_scale_factor=1)
    pc.add_init_script("""(() => { const real = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function (type, ...rest) { return /webgl/i.test(String(type)) ? null : real.call(this, type, ...rest); }; })();""")
    ng = pc.new_page()
    ng.on("pageerror", lambda e: console.append(("pageerror", str(e))))
    ng.goto(a.base, wait_until="domcontentloaded")
    try:
        ng.wait_for_function("document.documentElement.classList.contains('nomap') && document.querySelector('#boot') === null", timeout=30000)
    except Exception:
        pass
    VIS = "const vis = (q) => { const e = document.querySelector(q); return !!e && !e.hidden && getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().height > 0; };"
    st = ng.evaluate("() => { " + VIS + """ return {cls: document.documentElement.className, boot: !!document.querySelector('#boot'), msg: vis('#noMap'), text: document.querySelector('#noMap').innerText,
        map: vis('#map'), legend: vis('#legend'), controls: vis('.map-tr'), hint: vis('#hint'), cards: vis('#cardLayer'), title: document.querySelector('#lyTitle').textContent}; }""")
    ng.click("#modeSeg button[data-mode=clim]")                       # the layer buttons drive the cards beside the map too
    ng.wait_for_timeout(600)
    t2 = ng.inner_text("#lyTitle")
    ng.click(".tab[data-tab=download]")
    ng.wait_for_timeout(400)
    dl = ng.locator("#tab-download").is_visible()
    ng.click(".tab[data-tab=explore]")
    ng.wait_for_timeout(300)
    check(st["cls"].split() == ["nomap"] and not st["boot"] and st["msg"] and "WebGL" in st["text"] and "open it again" in st["text"]
          and not st["map"] and not st["legend"] and not st["controls"] and not st["hint"] and st["cards"],
          "without WebGL the page says in the map's place why there is no map, and its loading screen goes: " + st["text"].splitlines()[0])
    check(t2 != st["title"] and "mean" in t2 and dl and ng.evaluate("() => { " + VIS + " return vis('#noMap'); }"),
          f"without WebGL the rest of the page works (layer card goes to '{t2}', the Download tab opens)")
    ng.screenshot(path=str(shots / "18_no_webgl.png"))
    pc.close()

    # A WebGL context lost while the page is open (the browser's graphics process failed): if it has not come back
    # after a few seconds the page says the map is gone; when it does come back, so does the map.
    pc = new_context(viewport={"width": 1440, "height": 900}, device_scale_factor=1)
    lc = pc.new_page()
    lc.on("pageerror", lambda e: console.append(("pageerror", str(e))))
    lc.goto(a.base + sep + "intro=0", wait_until="domcontentloaded")
    lc.wait_for_function("window.__portal && window.__portal.map && window.__portal.map.loaded()", timeout=60000)
    lc.wait_for_function("document.querySelector('#boot') === null", timeout=15000)
    has = lc.evaluate("""() => { const c = window.__portal.map.getCanvas(), gl = c.getContext('webgl2') || c.getContext('webgl');
        const x = gl && gl.getExtension('WEBGL_lose_context'); if (!x) return false; window.__lose = x; x.loseContext(); return true; }""")
    if has:
        lc.wait_for_timeout(2500)
        early = lc.evaluate("document.documentElement.classList.contains('nomap')")      # not at once: a context usually comes back
        try:
            lc.wait_for_function("document.documentElement.classList.contains('nomap')", timeout=12000)
        except Exception:
            pass
        gone = lc.evaluate("() => { " + VIS + " return {msg: vis('#noMap'), map: vis('#map'), noMap: window.__portal.noMap}; }")
        lc.evaluate("window.__lose.restoreContext()")
        try:
            lc.wait_for_function("!document.documentElement.classList.contains('nomap') && window.__portal.map.loaded()", timeout=30000)
        except Exception:
            pass
        lc.wait_for_timeout(800)
        back = lc.evaluate("() => { " + VIS + " return {msg: vis('#noMap'), map: vis('#map'), noMap: window.__portal.noMap, loaded: window.__portal.map.loaded(), zoom: window.__portal.map.getZoom()}; }")
        check(not early and gone["msg"] and not gone["map"] and gone["noMap"] is True,
              "a WebGL context lost while the page is open: after a few seconds without it the page says the map is gone")
        check(not back["msg"] and back["map"] and back["noMap"] is False and back["loaded"],
              f"when the context comes back the map returns (zoom {back['zoom']:.2f})")
        lc.screenshot(path=str(shots / "19_context_restored.png"))
    else:
        notes.append("   (this browser has no WEBGL_lose_context: the lost-context check was skipped)")
    pc.close()

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
