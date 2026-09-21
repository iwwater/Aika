# -*- coding: utf-8 -*-
"""定位 headless Chromium 里 /predict/path fetch 卡住的问题。"""
import time
from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:8787"

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()
    page.goto(BASE + "/", wait_until="networkidle")

    # 测试1: GET /health（页面加载时同样的请求，应该快）
    t0 = time.time()
    r1 = page.evaluate("fetch('/health').then(r=>r.json())")
    print("GET /health:", round(time.time() - t0, 2), "s ->", r1.get("status"))

    # 测试2: POST /predict/path（demoPlay 里卡住的请求）
    t0 = time.time()
    r2 = page.evaluate("""fetch('/predict/path', {method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({path:'ref/mood01.wav'})}).then(r=>r.json())""")
    print("POST /predict/path:", round(time.time() - t0, 2), "s -> top:", r2.get("top"), r2.get("top_ja"))

    # 测试3: 模拟完整 demoPlay 流程（含 Audio 播放）
    t0 = time.time()
    r3 = page.evaluate("""(async () => {
        const a = new Audio('/audio/ref/mood02.wav');
        a.volume = 0.8;
        const playP = a.play().catch(e => 'play_blocked:' + e.name);
        const t0 = performance.now();
        const r = await fetch('/predict/path', {method:'POST',
            headers:{'Content-Type':'application/json'},
            body: JSON.stringify({path:'ref/mood02.wav'})}).then(x=>x.json());
        const playState = await Promise.race([playP, 'pending_1s']);
        return {top: r.top, fetch_ms: Math.round(performance.now()-t0), play: String(playState)};
    })()""")
    print("带Audio播放:", round(time.time() - t0, 2), "s ->", r3)

    browser.close()
