
# FE-21 固定图生成器 v2：自制合成画面（PIL + Anonymous Pro，SIL OFL 1.1）。
# 开发集 30 张（调参），独立验收集 120 张（冻结评估），写 manifest（来源 + sha256）。
# 运行：python scripts/generate-ocr-fixtures.py
import hashlib
import json
import random
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "src/services/environment/fixtures"
DEV_DIR = OUT / "dev"
VAL_DIR = OUT / "validation"
FONT_PATH = ROOT / "scripts/fonts/AnonymousPro-Regular.ttf"
DEV_DIR.mkdir(parents=True, exist_ok=True)
VAL_DIR.mkdir(parents=True, exist_ok=True)

POSITIVE_WORDS = ["VICTORY", "DEFEAT", "PENTAKILL", "Error", "Failed"]
SCENE_OF_WORD = {"VICTORY": "game", "DEFEAT": "game", "PENTAKILL": "game", "Error": "ide", "Failed": "ide"}
NEGATIVE_WORDS = {
    "game": ["PAUSED", "LOADING", "REPLAY", "SETTINGS", "EXIT", "SCORE", "MISSION", "PENTAKILLED", "ERRORS", "WAVE"],
    "video": ["LIVE", "VIEWS", "SUBSCRIBE", "NEXT", "WATCH", "FAILURES", "DEFEATED", "COMMENT", "SHARE", "CLIP"],
    "ide": ["BUILD", "WARNINGS", "TERMINAL", "OUTPUT", "DEBUG", "PLUGIN", "VICTORS", "FAILING", "PROBLEMS", "TRACE"],
}


def render(text, size, fg, bg, noise, seed, invert):
    rng = random.Random(seed)
    font = ImageFont.truetype(str(FONT_PATH), size)
    # ROI 比例约 4:1 的横带（模拟 80%×20% 主显示器区域裁剪）。
    width, height = 640, 160
    image = Image.new("RGB", (width, height), (bg, bg, bg))
    draw = ImageDraw.Draw(image)
    # 背景纹理（游戏/视频/IDE 画面近似，不含文字）。
    if noise == "grain":
        for _ in range(2400):
            x, y = rng.randrange(width), rng.randrange(height)
            v = max(0, min(255, bg + rng.randint(-18, 18)))
            image.putpixel((x, y), (v, v, v))
    elif noise == "stripes":
        for x in range(0, width, 24):
            draw.rectangle([x, 0, x + 11, height], fill=(max(0, bg - 16),) * 3)
    elif noise == "blocks":
        for row in range(0, height, 26):
            if (row // 26) % 2 == 0:
                draw.rectangle([0, row, width, row + 25], fill=(max(0, bg - 12),) * 3)

    left, top, right, bottom = draw.textbbox((0, 0), text, font=font)
    text_w, text_h = right - left, bottom - top
    x = (width - text_w) // 2 - left
    y = (height - text_h) // 2 - top
    draw.text((x, y), text, font=font, fill=(fg, fg, fg))
    if invert:
        # 顶部/底部装饰条（HUD 风格）。
        draw.rectangle([0, 0, width, 6], fill=(fg, fg, fg))
        draw.rectangle([0, height - 6, width, height], fill=(fg, fg, fg))
    return image


manifest = {
    "source": "synthetic-selfmade",
    "generator": "scripts/generate-ocr-fixtures.py",
    "font": {"name": "Anonymous Pro Regular", "license": "SIL OFL 1.1", "file": "scripts/fonts/AnonymousPro-Regular.ttf"},
    "license": "self-made synthetic images; OFL font; no third-party copyrighted material; no personal data",
    "note": "dev set for tuning; validation set frozen for evaluation. Matching is case-insensitive.",
    "images": {},
}


def make(dir_path, name, word, scene, size, fg, bg, noise, invert, expected):
    seed = random.Random(f"{name}")
    image = render(word, size, fg, bg, noise, seed.randrange(2**32), invert)
    file = dir_path / f"{name}.png"
    image.save(file, "PNG")
    rel = str(file.relative_to(OUT)).replace("\\", "/")
    manifest["images"][rel] = {
        "kind": "dev" if dir_path is DEV_DIR else "validation",
        "scene": scene,
        "rendered": word,
        "expected": expected,
        "sha256": hashlib.sha256(file.read_bytes()).hexdigest(),
    }


def invert_params(i):
    return (i % 2 == 1)


# 开发集 30：每词 4 张 + 每场景负例 3~4 张。
for word in POSITIVE_WORDS:
    for i in range(4):
        invert = invert_params(i)
        make(DEV_DIR, f"dev_{word.lower()}_{i}", word, SCENE_OF_WORD[word],
             size=28 + i * 8, fg=18 if invert else 240, bg=205 if invert else 22,
             noise=["none", "grain", "stripes", "blocks"][i % 4], invert=invert, expected=word)
for i in range(10):
    scene = ["game", "video", "ide"][i % 3]
    pool = NEGATIVE_WORDS[scene]
    make(DEV_DIR, f"dev_neg_{i:02d}", pool[i % len(pool)], scene,
         size=26 + (i % 4) * 9, fg=35 if i % 2 else 230, bg=200 if i % 2 else 35,
         noise=["grain", "stripes", "blocks", "none"][i % 4], invert=False, expected=None)

# 验收集 120：60 正例（每词 12：三种字号 × 两种底色 × 四种噪声）+ 60 负例（三场景各 20）。
for word in POSITIVE_WORDS:
    for i in range(12):
        invert = invert_params(i)
        make(VAL_DIR, f"val_pos_{word.lower()}_{i:02d}", word, SCENE_OF_WORD[word],
             size=30 + (i % 3) * 14, fg=18 if invert else 240, bg=205 if invert else 22,
             noise=["none", "grain", "stripes", "blocks"][i % 4], invert=invert, expected=word)
for scene in ["game", "video", "ide"]:
    pool = NEGATIVE_WORDS[scene]
    for i in range(20):
        make(VAL_DIR, f"val_neg_{scene}_{i:02d}", pool[(i + i // len(pool)) % len(pool)], scene,
             size=26 + (i % 5) * 10, fg=35 if i % 3 == 1 else 230, bg=200 if i % 3 == 1 else 35,
             noise=["grain", "stripes", "blocks", "none"][i % 4], invert=False, expected=None)

(OUT / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
print(f"dev=30 validation=120 -> {OUT}")
