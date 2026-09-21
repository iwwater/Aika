# -*- coding: utf-8 -*-
"""
SER 段素材采集 v2：截图序列方案（不录像）。

GPU 当前推理 8~35s（whisper+TTS 占用），录屏无法真实呈现识别过程；
改为每情绪采集 3 个关键节点截图（真实 UI）：
  a = 已选情绪（未播放）
  b = 识别中（点播放后）
  c = 识别结果（evaluate 走真实模型推理后，页面原生 renderResult 渲染）
节奏由 ffmpeg 合成时控制，推理耗时被剪掉。
"""
import os, json, urllib.request
from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:8787/"
OUT = r"E:\Work\AI CHAT\demo\video\raw\ser_shots"
os.makedirs(OUT, exist_ok=True)

MOODS = [
    ("ref/mood01.wav", "yasashii",  "優しい"),
    ("ref/mood02.wav", "anshin",    "安心"),
    ("ref/mood03.wav", "shinmitsu", "親密"),
    ("ref/mood04.wav", "hiniku",    "皮肉"),
    ("ref/mood05.wav", "dokuzetsu", "毒舌"),
    ("ref/mood06.wav", "kongan",    "懇願"),
]

EVAL_PREDICT = """async (p) => {
    const r = await fetch('/predict/path', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({path: p})
    }).then(x => x.json());
    if (r.detail) throw new Error(r.detail);
    const d = meta.demos.find(x => x.path === p);
    r.src = `${d.zh}（${d.ja}）· ${d.group_name}`;
    renderResult(r);
    setStatus('ok', '模型 ' + r.model);
    return {top: r.top, top_ja: r.top_ja, conf: r.scores[0].score};
}"""


def warmup():
    body = json.dumps({"path": "ref/mood01.wav"}).encode()
    req = urllib.request.Request(BASE + "predict/path", data=body,
                                 headers={"Content-Type": "application/json"})
    try:
        urllib.request.urlopen(req, timeout=300).read()
        print("预热完成")
    except Exception as e:
        print("预热失败（继续）：", repr(e)[:120])


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    results = []
    for path, slug, ja in MOODS:
        ctx = browser.new_context(viewport={"width": 1280, "height": 800})
        page = ctx.new_page()
        page.goto(BASE, wait_until="networkidle")
        page.wait_for_selector("#demoSelect option", state="attached", timeout=15000)
        page.click('button[data-panel="demo"]')
        page.select_option("#demoSelect", path)
        page.wait_for_timeout(500)
        pa = os.path.join(OUT, f"{slug}_a.png")
        page.screenshot(path=pa)
        page.click("#demoPlay")
        page.wait_for_timeout(500)
        pb = os.path.join(OUT, f"{slug}_b.png")
        page.screenshot(path=pb)
        res = page.evaluate(EVAL_PREDICT, path)
        page.wait_for_timeout(300)
        pc = os.path.join(OUT, f"{slug}_c.png")
        page.screenshot(path=pc)
        results.append({"path": path, "slug": slug, "ja": ja, "pred": res,
                        "a": pa, "b": pb, "c": pc})
        print(f"ok {slug:10s} -> {res['top_ja']} {res['conf']*100:.1f}%")
        ctx.close()
    browser.close()

with open(os.path.join(OUT, "shots_v2.json"), "w", encoding="utf-8") as f:
    json.dump(results, f, ensure_ascii=False, indent=2)
print("SER 截图序列完成")
