# -*- coding: utf-8 -*-
"""
构建 Aika 情绪对比 demo 站点

从 GPT-SoVITS 的探针输出里挑音频，复制成 web 友好的 ascii 文件名，
同时把韵律指标并进 data.json，供 index.html 使用。

用法（任意 python 3 均可）：
    python build.py
"""
import json
import os
import shutil

SRC_ROOT = r"E:\Work\Chat_model\GPT-SoVITS\output"
PROBE = os.path.join(SRC_ROOT, "demo_emotion_probe")
SLICER = os.path.join(SRC_ROOT, "slicer_opt")
METRICS = os.path.join(SRC_ROOT, "prosody_metrics.json")
HERE = os.path.dirname(os.path.abspath(__file__))
AUDIO = os.path.join(HERE, "audio")

# 情绪：序号, slug, 日文标签, 中文标签, 参考音频文件, 参考原文, 参考中文, 主题色
MOODS = [
    ("01", "yasashii", "優しい", "温柔",
     "audio [vocals].mp3_0000777920_0000900800.wav",
     "お兄ちゃん、恋人がいなくても大丈夫だよ。",
     "哥哥，就算没有恋人也没关系的。", "#e8799e"),
    ("02", "anshin", "安心", "安心",
     "audio [vocals].mp3_0000904960_0001047680.wav",
     "何も心配することはないよ。私、そばにいるからね。",
     "什么都不用担心，我会在你身边的。", "#4f93d6"),
    ("03", "shinmitsu", "親密", "亲密",
     "audio [vocals].mp3_0003075200_0003226880.wav",
     "もうこうやってお兄さんに抱っこされてるんだから",
     "你看，人家都这样被你抱着了。", "#a97bd4"),
    ("04", "hiniku", "皮肉", "嘲讽",
     "audio [vocals].mp3_0001068480_0001258240.wav",
     "ねえ、お兄さんってさ、その年でまさか童貞じゃないよなー",
     "喂，哥哥你该不会到这年纪还是处男吧——", "#e08b45"),
    ("05", "dokuzetsu", "毒舌", "毒舌",
     "audio [vocals].mp3_0005559680_0005725440.wav",
     "所詮雑魚、変態野郎のくせにおこがましいんだよ。キモい童貞を。",
     "说到底就是个杂鱼，一个变态还这么不自量力。恶心的处男。", "#d9534f"),
    ("06", "kongan", "懇願", "恳求",
     "audio [vocals].mp3_0006276800_0006448640.wav",
     "私、なんでもするから、見捨てないで、お兄さん",
     "我什么都会做的，别丢下我，哥哥。", "#3fa89b"),
]

TARGET_JA = "お兄ちゃん、おはよう。今日も一緒に頑張ろうね。"
TARGET_ZH = "哥哥，早上好。今天也一起加油吧。"

COMBOS = {
    "A": ("A_v1自训", "自训 aika 声线", "aika_jp_v1 · GPT e5 / SoVITS e8"),
    "C": ("C_底模zeroshot", "底模 zero-shot", "s1v3 + s2Gv2Pro（未微调）"),
}


def load_metrics():
    if not os.path.exists(METRICS):
        return {}
    with open(METRICS, encoding="utf-8") as f:
        data = json.load(f)
    return {(r["combo"], r["name"][:2]): r
            for r in data.get("rows", []) if r.get("kind") == "mood"}


def main():
    metrics = load_metrics()
    items = []
    copied = 0

    # 参考音频（原声）——让页面可以「参考 -> 合成」对照播放
    ref_dir = os.path.join(AUDIO, "ref")
    os.makedirs(ref_dir, exist_ok=True)
    for num, slug, ja, zh, ref_file, ref_ja, ref_zh, color in MOODS:
        src = os.path.join(SLICER, ref_file)
        if os.path.exists(src):
            shutil.copy2(src, os.path.join(ref_dir, f"mood{num}.wav"))
            copied += 1
        else:
            print("[warn] missing ref", src)

    for short, (combo_dir, label, weights) in COMBOS.items():
        src_dir = os.path.join(PROBE, combo_dir)
        dst_dir = os.path.join(AUDIO, short)
        os.makedirs(dst_dir, exist_ok=True)
        if not os.path.isdir(src_dir):
            print("[warn] missing", src_dir)
            continue

        # 文件名形如 mood_01_温柔__<台词>.wav，取序号两位
        files = {f[5:7]: f for f in os.listdir(src_dir) if f.startswith("mood_")}

        for num, slug, ja, zh, ref_file, ref_ja, ref_zh, color in MOODS:
            src_name = files.get(num)
            if not src_name:
                print(f"[warn] no audio for {combo_dir} mood {num}")
                continue
            dst_name = f"mood{num}.wav"
            shutil.copy2(os.path.join(src_dir, src_name), os.path.join(dst_dir, dst_name))
            copied += 1
            m = metrics.get((combo_dir, num), {})
            items.append({
                "combo": short, "num": num, "slug": slug,
                "ja": ja, "zh": zh, "color": color,
                "ref_ja": ref_ja, "ref_zh": ref_zh,
                "ref_src": f"audio/ref/mood{num}.wav",
                "src": f"audio/{short}/{dst_name}",
                "dur": m.get("dur_s"), "f0_cv": m.get("f0_cv"),
                "f0_range_st": m.get("f0_range_st"), "dyn_db": m.get("dyn_db"),
                "rate_zps": m.get("rate_zps"),
            })

    payload = {
        "target_ja": TARGET_JA,
        "target_zh": TARGET_ZH,
        "combos": [{"id": k, "label": v[1], "weights": v[2]} for k, v in COMBOS.items()],
        "items": items,
    }
    with open(os.path.join(HERE, "data.json"), "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=1)

    print(f"copied {copied} wav -> {AUDIO}")
    print("wrote data.json")
    for it in items:
        print(f"  {it['combo']} {it['num']} {it['zh']:<4} dur={it['dur']} f0_cv={it['f0_cv']}")


if __name__ == "__main__":
    main()
