# -*- coding: utf-8 -*-
"""
录屏 TTS 试音台（voice_playground.html）：6 情绪现场合成。

- 画面：选情绪按钮 → 台词 → 点「合成并播放」→ 状态「完成 · xx ms」→ 播放
- 音频：expect_response 拦截 /synthesize 的响应 body 存 wav（= 画面那次合成的真实输出）
- 记录 t_done_s（状态「完成」出现的时刻，相对镜头开始）用于 ffmpeg 贴轨
"""
import os, json, time
from playwright.sync_api import sync_playwright
import soundfile as sf

PAGE_URL = "file:///E:/Work/Chat_model/GPT-SoVITS/voice_playground.html"
OUT = r"E:\Work\AI CHAT\demo\video\raw"
WAV_DIR = os.path.join(OUT, "tts_wav")
os.makedirs(WAV_DIR, exist_ok=True)

# (style 名, 合成台词=该情绪参考音频原文) —— 与 sidecar /styles 的 prompt_text 一致
ITEMS = [
    ("温柔", "お兄ちゃん、恋人がいなくても大丈夫だよ。"),
    ("安心", "何も心配することはないよ。私、そばにいるからね。"),
    ("亲密", "もうこうやってお兄さんに抱っこされてるんだから"),
    ("嘲讽", "ねえ、お兄さんってさ、その年でまさか童貞じゃないよなー"),
    ("毒舌", "所詮雑魚、変態野郎のくせにおこがましいんだよ。キモい童貞を。"),
    ("恳求", "私、なんでもするから、見捨てないで、お兄さん"),
]
JA = {"温柔": "優しい", "安心": "安心", "亲密": "親密", "嘲讽": "皮肉", "毒舌": "毒舌", "恳求": "懇願"}

results = []
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    for style, text in ITEMS:
        saved = {}

        # route 拦截：playwright 代发 /synthesize 请求，拿到完整 body 后再回给页面
        # （直接 expect_response().body() 会和页面 blob() 消费竞争，拿到空 body）
        def handle(route):
            resp = route.fetch()
            saved["body"] = resp.body()
            route.fulfill(response=resp)

        context = browser.new_context(
            viewport={"width": 1280, "height": 800},
            record_video_dir=OUT,
            record_video_size={"width": 1280, "height": 800})
        page = context.new_page()
        page.route("**/synthesize", handle)
        t_start = time.time()
        page.goto(PAGE_URL, wait_until="networkidle")
        page.wait_for_selector(".style-btn", timeout=15000)
        page.wait_for_function("document.getElementById('health').textContent.includes('已就绪')",
                               timeout=20000)
        page.click(f".style-btn:has-text('{style}')")
        page.fill("#text", text)
        page.wait_for_timeout(300)
        page.click("#go")
        # 等状态「完成」（此时 route 已存下 body）
        page.wait_for_function("document.getElementById('status').textContent.startsWith('完成')",
                               timeout=90000)
        t_done = round(time.time() - t_start, 2)
        status_text = page.inner_text("#status")
        wav_path = os.path.join(WAV_DIR, f"tts_{style}.wav")
        with open(wav_path, "wb") as f:
            f.write(saved["body"])
        y, sr = sf.read(wav_path)
        dur = len(y) / sr
        # 等播放结束（页面里的 audio 元素在播）+ 余量
        page.wait_for_timeout(int((dur + 2.5) * 1000))
        video = page.video
        context.close()
        vp = video.path()
        results.append({"style": style, "ja": JA[style], "text": text,
                        "status": status_text, "t_done_s": t_done,
                        "audio_dur": round(dur, 2), "wav": wav_path, "video": vp})
        print(f"录完 {style:3s} {JA[style]}  {status_text}  dur={dur:.2f}s  t_done={t_done}s")
    browser.close()

with open(os.path.join(OUT, "shots_tts.json"), "w", encoding="utf-8") as f:
    json.dump(results, f, ensure_ascii=False, indent=2)
print("TTS 录制完成")
