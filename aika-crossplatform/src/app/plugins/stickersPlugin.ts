import type { AikaPlugin } from "../../kernel";
import { loadStickers } from "../../services/stickers/library";
import { StickerLibraryToken, type StickerLibrary } from "../../services/stickers/tokens";

/**
 * 表情包能力插件。
 *
 * 清单为空是**正常状态**，不是错误：素材没放进来时返回空数组，提示词里不提表情包、
 * 界面不显示图标，应用照常跑。所以这个插件没有任何硬依赖，也不会因为素材缺失而
 * 让内核启动失败。
 */
export function stickersPlugin(library: StickerLibrary = loadStickers): AikaPlugin {
  return {
    id: "stickers.library",
    version: "1.0.0",
    provides: [StickerLibraryToken],
    activate(context) {
      context.registrar.provide(StickerLibraryToken, () => library);
    },
  };
}
