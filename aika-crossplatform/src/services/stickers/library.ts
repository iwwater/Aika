import { parseStickerManifest, STICKER_DIR, type Sticker } from "../../domain/stickers";

/**
 * 读表情包清单。
 *
 * 清单不存在、读不出来、格式坏掉——一律当作没有表情包，不报错也不提示：
 * 这是个可选功能，素材没放进来时它应该完全看不出存在过。
 */
export async function loadStickers(): Promise<Sticker[]> {
  try {
    const response = await fetch(`${STICKER_DIR}/manifest.json`, { cache: "no-cache" });
    if (!response.ok) return [];
    return parseStickerManifest(await response.json());
  } catch {
    return [];
  }
}
