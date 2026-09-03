/**
 * 表情包清单。
 *
 * 「她会问的问题」的第二层：第一层是问句本身（见 prompt.ts 的 QUESTION_RULES），
 * 第二层是她只有文字这一种表达方式——真人聊天里，一个表情包顶三句解释。
 *
 * 机制的边界写死在这里：**她只能从清单里挑，不生成图，也不能编造 id。**
 * 清单为空时整套机制自动隐身：提示词里一个字都不提，结构化输出也不多这个字段。
 * 这样素材还没放进目录时，行为和没有这个功能完全一样。
 */

export interface Sticker {
  /** 模型选用的稳定标识，也是提示词里她看到的那个名字。 */
  id: string;
  /** stickers/ 目录下的文件名。 */
  file: string;
  /** 什么时候该用它。写不出来的表情她就选不准，所以这条是必填。 */
  when: string;
}

/** 静态资源目录，清单和图片都在这儿。 */
export const STICKER_DIR = "stickers";

/**
 * 一次最多让她看见多少张。
 * 清单太长时她挑不准，还会把提示词撑大；宁可少几张、每张都用对。
 */
export const MAX_STICKERS = 24;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * 解析清单。
 *
 * 缺 id、文件名或使用场景的条目一律丢掉，不给默认值——
 * 没有使用场景的表情包她只能瞎猜，用错比不用更糟。
 */
export function parseStickerManifest(raw: unknown): Sticker[] {
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { stickers?: unknown })?.stickers)
      ? (raw as { stickers: unknown[] }).stickers
      : [];

  const seen = new Set<string>();
  const stickers: Sticker[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as Record<string, unknown>;
    const id = text(item.id);
    const file = text(item.file);
    const when = text(item.when);
    if (!id || !file || !when || seen.has(id)) continue;
    seen.add(id);
    stickers.push({ id, file, when });
    if (stickers.length >= MAX_STICKERS) break;
  }
  return stickers;
}

/** 图片路径。相对路径，桌面 WebView 和浏览器开发模式下都能直接用。 */
export function stickerUrl(sticker: Sticker): string {
  return `${STICKER_DIR}/${sticker.file}`;
}

/** 把模型给的 id 换成真的表情包。编出来的 id 一律当没选，不显示任何东西。 */
export function resolveSticker(
  stickers: readonly Sticker[],
  id: string | undefined | null,
): Sticker | null {
  const wanted = text(id);
  if (!wanted) return null;
  return stickers.find((sticker) => sticker.id === wanted) ?? null;
}

/**
 * 提示词里的表情包规则。清单为空时返回空串——整块不出现。
 *
 * 「大多数时候不发」是刻意的：每句话都配一张图不是熟人，是营销号。
 */
export function formatStickerRules(stickers: readonly Sticker[]): string {
  if (!stickers.length) return "";
  return [
    "你有一组表情包，说完话之后可以再配一张：",
    ...stickers.map((sticker) => `- ${sticker.id}：${sticker.when}`),
    "只能从上面这个清单里选，不要编造清单以外的名字，也不要描述图片内容。",
    "大多数时候不发。情绪已经在话里说清楚了就不用再配图。",
    "不要用表情包代替说话，也不要解释自己为什么发它。",
    "不发的时候 sticker 字段留空字符串。",
  ].join("\n");
}
