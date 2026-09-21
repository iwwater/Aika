# -*- coding: utf-8 -*-
"""
把 6 段录屏（webm）贴对应真实 demo 音频，转码成 mp4。

音频 adelay 约 2000ms 对齐「点播放」动作（goto+切面板+选情绪约 2s）。
"""
import json, subprocess, os

RAW = r"E:\Work\AI CHAT\demo\video\raw"
AUDIO = r"E:\Work\AI CHAT\demo\aika-emotion-demo\audio"
OUT = r"E:\Work\AI CHAT\demo\video\clips"
os.makedirs(OUT, exist_ok=True)
FFMPEG = r"D:\Tools\ffmpeg-full\extracted\ffmpeg-master-latest-win64-gpl\bin\ffmpeg.exe"

shots = json.load(open(os.path.join(RAW, "shots.json"), encoding="utf-8"))
for i, s in enumerate(shots):
    webm = s["video"]
    wav = os.path.join(AUDIO, s["path"])
    mp4 = os.path.join(OUT, f"{i:02d}_{s['slug']}.mp4")
    cmd = [FFMPEG, "-y", "-i", webm, "-i", wav,
           "-filter_complex", "[1:a]adelay=2000|2000,aresample=44100[a]",
           "-map", "0:v", "-map", "[a]",
           "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
           "-c:a", "aac", "-b:a", "128k", "-shortest", mp4]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        print("FAIL", s["slug"], r.stderr[-400:])
    else:
        print("ok", s["slug"], "->", os.path.basename(mp4))
print("clips 完成")
