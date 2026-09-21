# -*- coding: utf-8 -*-
"""诊断：完整复现 demoPlay 流程，捕获 console/pageerror/response，轮询渲染状态。"""
import time
from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:8787/"

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    context = browser.new_context(
        viewport={"width": 1280, "height": 800},
        record_video_dir=r"E:\Work\AI CHAT\demo\video\raw",
        record_video_size={"width": 1280, "height": 800})

    page = context.new_page()
    page.on("console", lambda m: print(f"[console.{m.type}] {m.text[:150]}"))
    page.on("pageerror", lambda e: print(f"[pageerror] {str(e)[:200]}"))
    page.on("response", lambda r: print(f"[resp {r.status}] {r.url[-40:]}"
            ) if "predict" in r.url or "audio" in r.url else None)
    page.on("requestfailed", lambda r: print(f"[req FAILED] {r.url[-40:]} {r.failure}"))

    page.goto(BASE, wait_until="networkidle")
    page.wait_for_selector("#demoSelect option", state="attached", timeout=15000)
    page.click('button[data-panel="demo"]')
    page.select_option("#demoSelect", "ref/mood01.wav")
    page.wait_for_timeout(300)
    t0 = time.time()
    page.click("#demoPlay")

    for i in range(12):
        box = page.inner_text("#resultBox")
        status = page.inner_text("#statusText")
        top = "置信" in box and box.split("置信")[0].strip()[-30:] or ("失败" if "失败" in box else "空")
        print(f"t={time.time()-t0:4.1f}s  status={status}  result={top}")
        if "置信" in box or "失败" in box:
            break
        page.wait_for_timeout(1000)

    video = page.video
    context.close()
    print("video:", video.path())
    browser.close()
