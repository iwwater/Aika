import { token } from "../../kernel";
import type { Sticker } from "../../domain/stickers";

/**
 * 表情包清单端口。
 *
 * 清单不存在、读不出来、格式坏掉一律返回空数组——这是个可选能力，素材没放进来时
 * 它应该完全看不出存在过。消费方拿到空数组就不在提示词里提表情包、也不显示图标，
 * 不弹错误、不阻断启动。
 */
export type StickerLibrary = () => Promise<readonly Sticker[]>;

export const StickerLibraryToken = token<StickerLibrary>("stickers.library");
