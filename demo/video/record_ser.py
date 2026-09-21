# -*- coding: utf-8 -*-
"""
录屏 SER demo（8787）：6 情绪逐个「播放并识别」，每个情绪一个独立 video。

headless 下点击触发的 async handler 里页面 fetch 会卡死（诊断见 diagnose.py），
因此数据改由 page.evaluate 走 playwright 网络栈请求（真实模型输出），
渲染调用页面原生 renderResult()（真实 UI）——画面与数据均为真实结果。
"""
import os, sys, json, time, urllib.request

BASE = "http://127.0.0.1:8787/"
OUT = r"E:\Work\AI CHAT\demo\video\raw"
os.makedirs(OUT, exist_ok=True)

# (demo 相对路径, slug, 日语情绪名)
MOODS = [
    ("ref/mood01.wav", "yasashii",  "優しい"),
    ("ref/mood02.wav", "anshin",    "安心"),
    ("ref/mood03.wav", "shinmitsu", "親密"),
    ("ref/mood04.wav", "hiniku",    "皮肉"),
    ("ref/mood05.wav", "dokuzetsu", "毒舌"),
    ("ref/mood06.wav", "kongan",    "懇願"),
]

VIEW_W, VIEW_H = 1280, 800


def warmup():
    body = json.dumps({"path": "ref/mood01.wav"}).encode()
    req = urllib.request.Request(BASE + "predict/path", data=body,
                                 headers={"Content-Type": "application/json"})
    try:
        urllib.request.urlopen(req, timeout=120).read()
        print("预热完成：模型已加载")
    except Exception as e:
        print("预热失败（继续）：", repr(e)[:120])


# 页面内执行：原生 fetch（playwright 栈）拿结果 + 调页面原生 renderResult 渲染
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


def record():
    from playwright.sync_api import sync_playwright
    results = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        for path, slug, ja in MOODS:
            context = browser.new_context(
                viewport={"width": VIEW_W, "height": VIEW_H},
                record_video_dir=OUT,
                record_video_size={"width": VIEW_W, "height": VIEW_H})
            page = context.new_page()
            page.goto(BASE, wait_until="networkidle")
            page.wait_for_selector("#demoSelect option", state="attached", timeout=15000)
            page.click('button[data-panel="demo"]')
            page.select_option("#demoSelect", path)
            page.wait_for_timeout(400)
            # 点「播放并识别」：画面进入识别中状态（音频贴轨对齐此时刻）
            page.click("#demoPlay")
            page.wait_for_timeout(1300)
            # 真实推理 + 页面原生渲染
            res = page.evaluate(EVAL_PREDICT, path)
            # 结果展示（配合贴轨音频的剩余时长）
            page.wait_for_timeout(6500)
            video = page.video
            context.close()
            vp = video.path()
            results.append({"path": path, "slug": slug, "ja": ja, "video": vp,
                            "pred": res})
            print(f"录完 {slug:10s} {ja} -> {res['top_ja']} {res['conf']*100:.1f}%")
        browser.close()

    with open(os.path.join(OUT, "shots.json"), "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=2)
    print("全部完成，shots.json 已写")


if __name__ == "__main__":
    warmup()
    record()
