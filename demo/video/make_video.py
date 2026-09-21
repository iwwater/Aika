# -*- coding: utf-8 -*-
"""
最终合成：TTS 6 镜头 + SER 6 镜头 + 标题卡 → 完整演示视频（aika_voice_demo.mp4）。

镜头处理：webm 画面 + 真实音频贴轨(adelay) + 尾部定格(tpad) + 左上角情绪名标注(drawtext)。
标题卡：lavfi 纯色底 + drawtext（Meiryo 日文），带静音轨保证 concat 一致。
"""
import json, os, subprocess

FF = r"D:\Tools\ffmpeg-full\extracted\ffmpeg-master-latest-win64-gpl\bin\ffmpeg.exe"
RAW = r"E:\Work\AI CHAT\demo\video\raw"
AUDIO = r"E:\Work\AI CHAT\demo\aika-emotion-demo\audio"
CLIPS = r"E:\Work\AI CHAT\demo\video\clips"
OUT = r"E:\Work\AI CHAT\demo\video"
FINAL = os.path.join(OUT, "aika_voice_demo.mp4")
FONT_F = "C\\:/Windows/Fonts/meiryo.ttc"

VENC = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
        "-pix_fmt", "yuv420p", "-r", "30"]
AENC = ["-c:a", "aac", "-b:a", "128k", "-ar", "44100"]


def run(cmd):
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(r.stderr[-600:])
    return r


def clip(webm, wav, delay_ms, ja_label, total_t, out):
    """一个镜头：画面 + 贴轨音频 + 尾部定格 + 可选情绪名标注。"""
    vchain = "[0:v]tpad=stop_mode=clone:stop_duration=3"
    if ja_label:
        vchain += (f",drawtext=fontfile='{FONT_F}':text='{ja_label}':fontsize=42:"
                   f"fontcolor=0x2a2438:box=1:boxcolor=white@0.85:boxborderw=18:x=30:y=26")
    fc = (vchain + "[v];"
          f"[1:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,"
          f"adelay={delay_ms}:all=1[a]")
    run([FF, "-y", "-i", webm, "-i", wav, "-filter_complex", fc,
         "-map", "[v]", "-map", "[a]", "-t", f"{total_t:.2f}", *VENC, *AENC, out])


def shot_clip(shot, wav, audio_dur, out):
    """SER 镜头（截图序列）：a已选情绪 1.5s + b识别中 1.2s + c结果 (dur+2.2)s，音频 2.7s 起贴。"""
    a, b, c = shot["a"], shot["b"], shot["c"]
    total = 1.5 + 1.2 + audio_dur + 2.2
    fc = ("[0:v]scale=1280:800,setsar=1,format=yuv420p[s0];"
          "[1:v]scale=1280:800,setsar=1,format=yuv420p[s1];"
          "[2:v]scale=1280:800,setsar=1,format=yuv420p[s2];"
          "[s0][s1][s2]concat=n=3:v=1:a=0,fps=30[v];"
          "[3:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,"
          "adelay=2700:all=1[a]")
    run([FF, "-y",
         "-loop", "1", "-t", "1.5", "-framerate", "30", "-i", a,
         "-loop", "1", "-t", "1.2", "-framerate", "30", "-i", b,
         "-loop", "1", "-t", f"{audio_dur + 2.2:.2f}", "-framerate", "30", "-i", c,
         "-i", wav, "-filter_complex", fc,
         "-map", "[v]", "-map", "[a]", "-t", f"{total:.2f}", *VENC, *AENC, out])


def title_card(text, sub, dur, out):
    """标题卡：深紫底 + 白字主标题 + 灰紫副标题，带静音轨。"""
    fc = (f"drawtext=fontfile='{FONT_F}':text='{text}':fontcolor=white:fontsize=52:"
          f"x=(w-text_w)/2:y=(h-text_h)/2-50,"
          f"drawtext=fontfile='{FONT_F}':text='{sub}':fontcolor=0x9f93c9:fontsize=25:"
          f"x=(w-text_w)/2:y=(h-text_h)/2+45")
    run([FF, "-y", "-f", "lavfi", "-i", f"color=c=0x201a33:s=1280x800:d={dur}:r=30",
         "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo",
         "-vf", fc, "-map", "0:v", "-map", "1:a",
         "-t", str(dur), *VENC, *AENC, out])


def concat(files, out):
    lst = os.path.join(OUT, "concat.txt")
    with open(lst, "w", encoding="utf-8") as f:
        for p in files:
            f.write(f"file '{p}'\n")
    run([FF, "-y", "-f", "concat", "-safe", "0", "-i", lst, "-c", "copy", out])


def main():
    os.makedirs(CLIPS, exist_ok=True)
    parts = []

    # ---- 开场卡 ----
    p = os.path.join(CLIPS, "90_title_open.mp4")
    title_card("韻律駆動の感情音声対話", "Aika 音声モジュール — 感情合成と感情認識", 4.0, p)
    parts.append(p)

    # ---- 段1 标题 + TTS 现场合成 6 情绪 ----
    p = os.path.join(CLIPS, "91_seg1.mp4")
    title_card("① 感情 → 韻律", "参照音声の感情リズムを転移した音声合成（GPT-SoVITS）", 3.0, p)
    parts.append(p)

    shots_tts = json.load(open(os.path.join(RAW, "shots_tts.json"), encoding="utf-8"))
    for i, s in enumerate(shots_tts):
        delay = int(s["t_done_s"] * 1000)
        total = s["t_done_s"] + s["audio_dur"] + 2.2
        p = os.path.join(CLIPS, f"1{i}_{s['style']}.mp4")
        clip(s["video"], s["wav"], delay, s["ja"], total, p)
        parts.append(p)
        print("clip ok:", s["style"])

    # ---- 段2 标题 + SER 识别 6 情绪 ----
    p = os.path.join(CLIPS, "92_seg2.mp4")
    title_card("② 韻律 → 感情", "音響情報だけからの感情推定（emotion2vec+ / acoustic-only SER）", 3.0, p)
    parts.append(p)

    shots_v2 = json.load(open(os.path.join(RAW, "ser_shots", "shots_v2.json"), encoding="utf-8"))
    for i, s in enumerate(shots_v2):
        wav = os.path.join(AUDIO, s["path"])
        import soundfile as sf
        y, sr = sf.read(wav)
        dur = len(y) / sr
        p = os.path.join(CLIPS, f"2{i}_{s['slug']}.mp4")
        shot_clip(s, wav, dur, p)
        parts.append(p)
        print("clip ok:", s["slug"])

    # ---- 结尾卡 ----
    p = os.path.join(CLIPS, "99_title_end.mp4")
    title_card("韻律は感情の運搬路である",
               "感情合成 × 音響感情認識 × リアルタイム対話統合", 5.0, p)
    parts.append(p)

    concat(parts, FINAL)
    print("成片:", FINAL)


if __name__ == "__main__":
    main()
