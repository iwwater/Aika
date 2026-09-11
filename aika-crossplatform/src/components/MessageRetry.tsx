import { RefreshCw } from "lucide-react";
import { retryableTurn, type ChatMessage } from "../domain/conversation";

/**
 * 失败气泡上的重试入口。
 *
 * 这里没有自己的判断：能不能重试由 domain 的 retryableTurn 决定——主动消息轮
 * 没有用户原话，重投无从谈起，那种失败就不给入口，而不是给一个点了没反应的按钮。
 */
export function MessageRetry(props: {
  message: ChatMessage;
  messages: readonly ChatMessage[];
  sending: boolean;
  onRetry: (messageId: string) => void;
}) {
  if (!props.message.error) return null;
  if (!retryableTurn(props.messages, props.message.id)) return null;

  return (
    <button
      type="button"
      className="message-retry"
      disabled={props.sending}
      onClick={() => props.onRetry(props.message.id)}
    >
      <RefreshCw size={13} /> 重试
    </button>
  );
}
