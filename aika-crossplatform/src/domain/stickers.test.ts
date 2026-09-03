import { describe, expect, it } from "vitest";
import {
  formatStickerRules, MAX_STICKERS, parseStickerManifest, resolveSticker, stickerUrl,
} from "./stickers";

const wink = { id: "wink", file: "wink.png", when: "开玩笑逗对方的时候" };

describe("parseStickerManifest", () => {
  it("接受 {stickers:[...]} 和裸数组两种写法", () => {
    expect(parseStickerManifest({ stickers: [wink] })).toEqual([wink]);
    expect(parseStickerManifest([wink])).toEqual([wink]);
  });

  it("缺使用场景的条目直接丢掉，不给默认值", () => {
    // 没有使用场景她只能瞎猜，用错的表情包比不用更糟
    expect(parseStickerManifest([{ id: "a", file: "a.png", when: "  " }])).toEqual([]);
    expect(parseStickerManifest([{ id: "a", when: "开心" }])).toEqual([]);
    expect(parseStickerManifest([{ file: "a.png", when: "开心" }])).toEqual([]);
  });

  it("id 重复时只留第一条", () => {
    const parsed = parseStickerManifest([wink, { ...wink, file: "wink2.png" }]);
    expect(parsed).toEqual([wink]);
  });

  it("清单过长时截断：她挑不准，提示词也会被撑大", () => {
    const many = Array.from({ length: MAX_STICKERS + 5 }, (_, index) => ({
      id: `s${index}`, file: `s${index}.png`, when: "测试",
    }));
    expect(parseStickerManifest(many)).toHaveLength(MAX_STICKERS);
  });

  it("清单文件坏掉或为空时返回空数组，不抛错", () => {
    expect(parseStickerManifest(null)).toEqual([]);
    expect(parseStickerManifest("坏掉的内容")).toEqual([]);
    expect(parseStickerManifest({})).toEqual([]);
  });
});

describe("resolveSticker", () => {
  it("编造出来的 id 一律当没选", () => {
    expect(resolveSticker([wink], "cry")).toBeNull();
    expect(resolveSticker([wink], "")).toBeNull();
    expect(resolveSticker([wink], undefined)).toBeNull();
  });

  it("清单里有就返回那一张", () => {
    expect(resolveSticker([wink], " wink ")).toEqual(wink);
  });
});

describe("formatStickerRules", () => {
  it("清单为空时整块不出现——素材没放进来时行为和没这个功能一样", () => {
    expect(formatStickerRules([])).toBe("");
  });

  it("列出 id 和使用场景，并写明不许编造", () => {
    const rules = formatStickerRules([wink]);
    expect(rules).toContain("wink：开玩笑逗对方的时候");
    expect(rules).toContain("不要编造");
    expect(rules).toContain("大多数时候不发");
  });
});

describe("stickerUrl", () => {
  it("是相对路径，桌面 WebView 和浏览器开发模式下都能用", () => {
    expect(stickerUrl(wink)).toBe("stickers/wink.png");
  });
});
