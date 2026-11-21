#!/usr/bin/env python3
"""The portal as visitors meet it: on the lab site, after a click on its dataset card.

    python tests/card_click.py                         # the live Data page, three desktop windows and a phone
    python tests/card_click.py --browser webkit --size 1440x900
    python tests/card_click.py --hub http://127.0.0.1:8797/data.html --size 390x844m

For each window it opens the hub page, clicks the card (`a.hd-card[href="#et"]`), finds the portal's
frame and reports what a visitor gets: whether the opening turn started by itself or waited for a
scroll (it waits where the middle of the map is below the fold: a short laptop window, a phone),
that it then ran, and that it ended on the resting globe with the mark in place and none of its
classes left on <html>. `m` after a size means a phone (touch, mobile layout).

It does not decide which windows should start at once: that depends on what the lab site puts above
the map (see "The opening globe" in CLAUDE.md). It fails only when the opening never runs, does not
end on the globe view, or the page throws. Drawn in software (Chromium with SwiftShader); needs
Python with playwright and its browsers.
"""
import argparse
import json
import sys

from playwright.sync_api import sync_playwright

ap = argparse.ArgumentParser()
ap.add_argument("--hub", default="https://hydroai.net/data")
ap.add_argument("--card", default="et", help="the card's hash on the hub page")
ap.add_argument("--frame", default="prithvi-openet-portal", help="a piece of the portal frame's address")
ap.add_argument("--browser", default="chromium", choices=["chromium", "webkit", "firefox"])
ap.add_argument("--size", action="append", default=[], help="WIDTHxHEIGHT, with m for a phone; repeatable")
a = ap.parse_args()
sizes = a.size or ["2048x1100", "1440x900", "1366x768", "390x844m"]

# Runs in every frame before its scripts: keeps the classes <html> goes through and when the map first moved.
INIT = """(() => { if (window.__seen) return; const s = window.__seen = { cls: [], moved: null, t0: performance.now() };
  const start = () => { const root = document.documentElement; if (!root) return setTimeout(start, 10);      // a frame that has no document yet
    const note = () => { const c = root.className.trim(); if (s.cls[s.cls.length - 1] !== c) s.cls.push(c); };
    new MutationObserver(note).observe(root, { attributes: true, attributeFilter: ['class'] }); note(); };
  start();
  const wait = setInterval(() => { const p = window.__portal; if (!p || !p.map) return; clearInterval(wait);
    p.map.on('movestart', () => { if (s.moved === null) s.moved = Math.round(performance.now() - s.t0); }); }, 50); })()"""
STATE = """() => { const p = window.__portal, m = p.map, g = p.globeView(), c = m.getCenter(), o = (q) => { const e = document.querySelector(q); return e ? +getComputedStyle(e).opacity : null; };
  return { classes: document.documentElement.className.trim(), lng: +c.lng.toFixed(1), atGlobeView: !m.isMoving() && Math.abs(c.lng - g.center[0]) < 0.01 && Math.abs(m.getZoom() - g.zoom) < 0.01,
           mark: o('.pulse'), legend: o('#legend'), minZoom: m.getMinZoom(), seen: window.__seen.cls, moved: window.__seen.moved,
           mid: Math.round(document.querySelector('#mapMid').getBoundingClientRect().top) }; }"""
OPENING = "['opening', 'waiting', 'opened', 'arrived', 'entered'].some((k) => document.documentElement.classList.contains(k))"

fails = 0
with sync_playwright() as pw:
    gl = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]
    br = getattr(pw, a.browser).launch(args=gl if a.browser == "chromium" else [])
    for size in sizes:
        phone = size.endswith("m")
        w, h = (int(v) for v in size.rstrip("m").split("x"))
        kw = {"viewport": {"width": w, "height": h}}
        if phone and a.browser != "firefox":
            kw.update(device_scale_factor=2, has_touch=True, is_mobile=True)
        ctx = br.new_context(**kw)
        ctx.add_init_script(INIT)
        page = ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)[:160]))
        page.goto(a.hub, wait_until="load")
        page.wait_for_timeout(1500)
        page.click(f'a.hd-card[href="#{a.card}"]')
        frame = None
        for _ in range(120):                                       # the frame is given its address on the click
            frame = next((f for f in page.frames if a.frame in f.url), None)
            if frame:
                try:
                    if frame.evaluate("!!(window.__portal && window.__portal.map)"):
                        break
                except Exception:
                    pass
            page.wait_for_timeout(250)
        try:
            frame.wait_for_function("document.querySelector('#boot') === null", timeout=60000)
            page.wait_for_timeout(2500)
            early = frame.evaluate(STATE)                          # two and a half seconds after the loading screen
            by_itself = "waiting" not in early["classes"] and (early["moved"] is not None or any(k in " ".join(early["seen"]) for k in ("opened", "arrived")))
            top = page.evaluate("(part) => { const f = [...document.querySelectorAll('iframe')].find((i) => (i.src || '').includes(part)); return f ? Math.round(f.getBoundingClientRect().top + scrollY) : 0; }", a.frame)
            scrolled = False
            if "waiting" in early["classes"]:                      # the map's middle is below the fold: the visitor scrolls
                page.mouse.wheel(0, 600) if not phone else page.evaluate("window.scrollBy(0, 600)")
                scrolled = True
            frame.wait_for_function("!" + OPENING, timeout=30000)
            frame.wait_for_function("!window.__portal.map.isMoving()", timeout=30000)
            end = frame.evaluate(STATE)
            ok = end["atGlobeView"] and end["mark"] == 1 and end["minZoom"] == 0.5 and not errors and any("open" in c for c in end["seen"])
            print(("ok   " if ok else "FAIL ") + f"{a.browser} {size}: the map's middle is {top + early['mid']} px down the page in a window {h} px tall; "
                  + ("the opening started by itself" if by_itself else "the opening waited" + (" and ran after a scroll" if scrolled else ""))
                  + f"; ends on the globe view: {end['atGlobeView']}, mark {end['mark']}, classes left: '{end['classes']}'"
                  + (f"; page errors: {errors}" if errors else ""))
            fails += 0 if ok else 1
        except Exception as e:
            fails += 1
            print(f"FAIL {a.browser} {size}: {str(e)[:200]} | seen: {json.dumps(frame.evaluate('window.__seen') if frame else None)[:300]}")
        ctx.close()
    br.close()
print(f"{fails} failed")
sys.exit(1 if fails else 0)
