import { displayTranslation, type ChatMessage } from "../domain/conversation";

/**
 * 气泡里的次级字幕。
 *
 * 这里没有自己的判断：显示什么、值不值得显示，全由 domain 的 displayTranslation 决定，
 * 因为同一条规则手机终端也要用（domain/remote.ts），两边不能各写一份。
 */
export function MessageTranslation(props: { message: ChatMessage; visible: boolean }) {
  if (!props.visible) return null;
  const translation = displayTranslation(props.message);
  if (!translation) return null;

  return <span className="translation">{translation}</span>;
}
