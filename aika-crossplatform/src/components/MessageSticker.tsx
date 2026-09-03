import { useState } from "react";
import { resolveSticker, stickerUrl, type Sticker } from "../domain/stickers";

/**
 * 消息里的表情包。
 *
 * 两种情况都安静地什么都不显示：清单里没有这个 id（她编的），
 * 或者图片文件后来被删了。历史消息不该因为素材换了一批就变成一个碎图标。
 */
export function MessageSticker(props: { id?: string; stickers: readonly Sticker[] }) {
  const [broken, setBroken] = useState(false);
  const sticker = resolveSticker(props.stickers, props.id);
  if (!sticker || broken) return null;

  return (
    <img
      className="message-sticker"
      src={stickerUrl(sticker)}
      alt={sticker.when}
      loading="lazy"
      onError={() => setBroken(true)}
    />
  );
}
