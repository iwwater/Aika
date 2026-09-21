# -*- coding: utf-8 -*-
"""SER-05 浏览器验证：真实服务（fake 引擎）+ Playwright 真实页面交互。

AC-B：注入假 HTTP 响应，覆盖**三条能真正到达渲染点**的通道——
      B1 上传响应 src（/predict）
      B2 上传错误响应 detail（/predict → 400）
      B3 /meta 的 group_name（demo 分支 src 的拼接来源）
      另保留 B4：/predict/path 400 detail（错误分支）。
      每条均断言：无注入元素、不执行标记、以字面文本显示。
AC-E：真实浏览器完成选择样本、显示结果、历史、上传错误恢复（不绕过页面点击）。

已知实现细节（勿据此放宽断言）：
  demo 分支前端会用 `/meta` 的 zh/ja/group_name 覆写 r.src，
  因此直接给 `/predict/path` 注入 src 不会进入 DOM —— 必须改注 /meta。

Playwright 坑（已踩）：`route.fetch()` 重发请求会丢掉 multipart 文件体，
服务端收到空文件 → 400「空文件」。因此上传分支的注入**直接构造响应**，
不回源（AC-B 考察的是前端渲染与转义，与后端无关）。

运行：
    "C:/Users/BAi/AppData/Local/Programs/Python/Python311/python.exe" -u ser_server_browser_check.py
退出码 0=全部通过。截图与结果供 docs/ser/reports/SER-05_ACCEPTANCE.md 引用。
"""
import io
import json
import math
import os
import struct
import sys
import threading
import time
import wave

import ser_server  # noqa: E402  导入不加载真实模型

PORT = 8797
BASE = f"http://127.0.0.1:{PORT}"
OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..",
                       "docs", "ser", "reports", "evidence", "ser05")
os.makedirs(OUT_DIR, exist_ok=True)

MALICIOUS = '<img src=x onerror="window.__pwned=1">'
results = []


def check(name, ok, detail=""):
    results.append((name, ok, detail))
    print(("[PASS] " if ok else "[FAIL] ") + name + ("  | " + detail if detail else ""))


def make_wav_bytes(sr=16000, secs=0.3, freq=440.0):
    """生成合法 16kHz 单声道 wav bytes（纯音）。"""
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        frames = b"".join(
            struct.pack("<h", int(12000 * math.sin(2 * math.pi * freq * i / sr)))
            for i in range(int(sr * secs)))
        w.writeframes(frames)
    return buf.getvalue()


def write_wav(name):
    p = os.path.join(OUT_DIR, name)
    with open(p, "wb") as f:
        f.write(make_wav_bytes())
    return p


class FakeModel:
    def __init__(self):
        self.calls = 0

    def generate(self, **kwargs):
        self.calls += 1
        return [{"labels": ["中立/neutral", "开心/happy", "<unk>"],
                 "scores": [0.6, 0.3, 0.1]}]


def fake_result(src):
    """构造一份与服务端同构的预测响应（用于前端渲染/转义验证）。"""
    triples = [("neutral", "平静", "中立", "#8a94a6", 0.6),
               ("happy", "喜び", "开心", "#f0ad4e", 0.3),
               ("unknown", "不明", "未知", "#6b7280", 0.1)]
    scores = [{"label": lb, "ja": ja, "zh": zh, "color": c, "score": s}
              for lb, ja, zh, c, s in triples]
    top = scores[0]
    return {"top": top["label"], "top_ja": top["ja"], "top_zh": top["zh"],
            "scores": scores, "elapsed_s": 0.012, "duration_s": 0.3,
            "model": "emotion2vec_plus_large", "src": src}


def start_server():
    ser_server._model = FakeModel()  # 注入 fake 引擎（不触真实模型）
    import uvicorn
    config = uvicorn.Config(ser_server.app, host="127.0.0.1", port=PORT, log_level="error")
    server = uvicorn.Server(config)
    t = threading.Thread(target=server.run, daemon=True)
    t.start()
    import requests
    for _ in range(30):
        try:
            requests.get(BASE + "/health", timeout=2)
            return server
        except Exception:
            time.sleep(0.5)
    raise RuntimeError("server not up")


def goto_demo_panel(page):
    """切到 Demo 分段（默认面板是录音）。"""
    segs = page.eval_on_selector_all("#seg button", "els => els.map(e => e.dataset.panel)")
    target = next((s for s in segs if s == "demo"), segs[0])
    page.click(f"#seg button[data-panel='{target}']")
    page.wait_for_selector("#demoSelect", state="visible", timeout=10000)


def main():
    server = start_server()
    ok_a = write_wav("ok_audio_a.wav")
    ok_b = write_wav("ok_audio_b.wav")

    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_context(viewport={"width": 1280, "height": 900}).new_page()
        page.on("dialog", lambda d: (results.append(("dialog", False, "出现弹窗=脚本执行")),
                                      d.dismiss()))
        page.goto(BASE + "/", wait_until="networkidle")
        page.wait_for_selector("#demoSelect option", state="attached", timeout=15000)
        goto_demo_panel(page)

        # ---- AC-E-1：选择样本 → 点「播放并识别」→ 结果渲染（真实路由 + fake 引擎）----
        page.select_option("#demoSelect", index=1)
        page.click("#demoPlay")
        page.wait_for_selector(".top-result", timeout=15000)
        top_txt = page.inner_text(".top-result")
        check("AC-E 选择样本并渲染结果", "中立" in top_txt and "置信" in top_txt,
              top_txt[:40])
        hist_n = page.eval_on_selector_all("#hist li", "els => els.length")
        check("AC-E 历史列表渲染", hist_n >= 1, f"{hist_n} 条")
        page.screenshot(path=os.path.join(OUT_DIR, "e1_result.png"))

        # ---- AC-B-1：上传响应 src 注入（前端不覆写 src 的唯一通道）----
        def inject_upload_src(route):
            if route.request.url.rstrip("/").endswith("/predict/path"):
                return route.continue_()
            route.fulfill(status=200,
                          body=json.dumps(fake_result(MALICIOUS), ensure_ascii=False),
                          headers={"content-type": "application/json"})

        page.route("**/predict*", inject_upload_src)
        page.set_input_files("#fileInput", ok_a)
        page.wait_for_selector(".meta-line", timeout=15000)
        page.wait_for_timeout(300)
        shown = page.inner_text(".meta-line")
        imgs = page.eval_on_selector_all("#resultBox img, #hist img", "els => els.length")
        pwned = page.evaluate("window.__pwned === 1")
        check("AC-B1 src 注入不产生元素/不执行", imgs == 0 and not pwned,
              f"imgs={imgs} pwned={pwned}")
        check("AC-B1 src 以字面文本显示", "img" in shown and "onerror" in shown,
              shown[:60])
        hist_txt = page.inner_text("#hist li:first-child .h-src")
        hist_imgs = page.eval_on_selector_all("#hist img", "els => els.length")
        check("AC-B1 历史分支同样安全",
              hist_imgs == 0 and "img" in hist_txt and "onerror" in hist_txt,
              f"hist imgs={hist_imgs} | {hist_txt[:50]}")
        page.unroute("**/predict*")
        page.screenshot(path=os.path.join(OUT_DIR, "b1_injected_src.png"))

        # ---- AC-B-2：上传错误响应 detail 注入 ----
        def inject_upload_detail(route):
            if route.request.url.rstrip("/").endswith("/predict/path"):
                return route.continue_()
            route.fulfill(status=400, json={"detail": MALICIOUS},
                          headers={"content-type": "application/json"})

        page.route("**/predict*", inject_upload_detail)
        page.set_input_files("#fileInput", ok_b)
        page.wait_for_timeout(800)
        txt = page.inner_text("#resultBox")
        imgs = page.eval_on_selector_all("#resultBox img", "els => els.length")
        pwned = page.evaluate("window.__pwned === 1")
        check("AC-B2 上传错误分支注入安全",
              imgs == 0 and not pwned and "img" in txt and "onerror" in txt,
              f"imgs={imgs} pwned={pwned} | {txt[:50]}")
        page.unroute("**/predict*")
        page.screenshot(path=os.path.join(OUT_DIR, "b2_injected_upload_error.png"))

        # ---- AC-B-3：/meta 的 group_name 注入（demo 分支 src 的拼接来源）----
        def inject_meta(route):
            resp = route.fetch()
            body = json.loads(resp.text())
            for d in body.get("demos", []):
                d["group_name"] = MALICIOUS
            route.fulfill(response=resp,
                          body=json.dumps(body, ensure_ascii=False),
                          headers={"content-type": "application/json"})

        page.route("**/meta", inject_meta)
        page.goto(BASE + "/", wait_until="networkidle")
        page.wait_for_selector("#demoSelect option", state="attached", timeout=15000)
        goto_demo_panel(page)
        page.select_option("#demoSelect", index=1)
        page.click("#demoPlay")
        page.wait_for_selector(".meta-line", timeout=15000)
        page.wait_for_timeout(300)
        shown = page.inner_text(".meta-line")
        imgs = page.eval_on_selector_all("#resultBox img, #hist img", "els => els.length")
        pwned = page.evaluate("window.__pwned === 1")
        check("AC-B3 /meta 注入不产生元素/不执行", imgs == 0 and not pwned,
              f"imgs={imgs} pwned={pwned}")
        check("AC-B3 /meta 注入以字面文本显示",
              "img" in shown and "onerror" in shown, shown[:60])
        page.unroute("**/meta")
        page.screenshot(path=os.path.join(OUT_DIR, "b3_injected_meta.png"))

        # ---- AC-B-4：/predict/path 400 detail 注入（错误分支）----
        page.goto(BASE + "/", wait_until="networkidle")
        page.wait_for_selector("#demoSelect option", state="attached", timeout=15000)
        goto_demo_panel(page)

        def inject_error(route):
            route.fulfill(status=400, json={"detail": MALICIOUS},
                          headers={"content-type": "application/json"})

        page.route("**/predict/path", inject_error)
        page.click("#demoPlay")
        page.wait_for_timeout(800)
        imgs = page.eval_on_selector_all("#resultBox img", "els => els.length")
        pwned = page.evaluate("window.__pwned === 1")
        txt = page.inner_text("#resultBox")
        check("AC-B4 错误分支注入安全", imgs == 0 and not pwned and "img" in txt,
              f"imgs={imgs} pwned={pwned}")
        page.unroute("**/predict/path")
        page.screenshot(path=os.path.join(OUT_DIR, "b4_injected_error.png"))

        # ---- AC-E-2：上传坏音频 → 错误恢复（真实坏文件，无需麦克风）----
        bad_wav = os.path.join(OUT_DIR, "bad_audio.wav")
        with open(bad_wav, "wb") as f:
            f.write(b"\x00\x01not-a-wav")
        page.set_input_files("#fileInput", bad_wav)
        page.wait_for_timeout(800)
        err_txt = page.inner_text("#resultBox")
        check("AC-E 上传坏音频显示错误恢复", "识别失败" in err_txt or "无法解码" in err_txt,
              err_txt[:40])
        page.screenshot(path=os.path.join(OUT_DIR, "e2_upload_error.png"))

        # ---- AC-E-3：错误后再次正常识别（错误恢复闭环）----
        goto_demo_panel(page)
        page.click("#demoPlay")
        page.wait_for_selector(".top-result", timeout=15000)
        ok_txt = page.inner_text(".top-result")
        check("AC-E 错误后恢复正常识别", "中立" in ok_txt, ok_txt[:30])

        browser.close()

    server.should_exit = True
    time.sleep(1)
    fails = [r for r in results if not r[1]]
    print(f"\n===== 浏览器验证汇总: {len(results) - len(fails)}/{len(results)} PASS =====")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
