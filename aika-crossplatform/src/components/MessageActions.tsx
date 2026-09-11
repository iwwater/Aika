import { RefreshCw, RotateCcw, Undo2, Volume2, VolumeX } from "lucide-react";
import {
  regeneratableTurn, retryableTurn, WELCOME_MESSAGE_ID, type ChatMessage,
} from "../domain/conversation";

/**
 * 气泡下面那排操作。
 *
 * 这里没有自己的判断：谁有资格出现全由 domain 的两个判定决定——主动消息轮没有
 * 用户原话，重投无从谈起，那种气泡就不给重试/重新生成，而不是给一个点了没反应的按钮。
 *
 * 重试与重新生成互斥：失败的那条给「重试」，成功的那条给「重新生成」，
 * 同一个气泡上不会同时冒出两个意思一样的按钮。
 */
export function MessageActions(props: {
  message: ChatMessage;
  messages: readonly ChatMessage[];
  sending: boolean;
  /** 这一条正在被朗读。同一条再点一次就是停止。 */
  speaking: boolean;
  /** 语音会话开着时说话权归会话，朗读入口不可用。 */
  canSpeak: boolean;
  onSpeak: (messageId: string) => void;
  onRetry: (messageId: string) => void;
  onRegenerate: (messageId: string) => void;
  onWithdraw: (messageId: string) => void;
}) {
  const { message, messages, sending } = props;
  if (message.pending) return null;

  const canRetry = Boolean(retryableTurn(messages, message.id));
  const canRegenerate = Boolean(regeneratableTurn(messages, message.id));
  // 开场白不落库，撤回它只会让问候语凭空消失，所以它一个入口都没有。
  const canWithdraw = message.id !== WELCOME_MESSAGE_ID;
  // 念的是她说的话；用户自己那句不需要读回来，失败气泡也没什么可念的。
  const canRead = props.canSpeak && message.role === "assistant" && !message.error
    && Boolean((message.japaneseText ?? message.content).trim());
  if (!canRetry && !canRegenerate && !canWithdraw && !canRead) return null;

  return (
    <div className="message-actions">
      {canRead && (
        <button type="button" onClick={() => props.onSpeak(message.id)}>
          {props.speaking ? <><VolumeX size={12} /> 停止</> : <><Volume2 size={12} /> 朗读</>}
        </button>
      )}
      {canRetry && (
        <button type="button" disabled={sending} onClick={() => props.onRetry(message.id)}>
          <RefreshCw size={12} /> 重试
        </button>
      )}
      {canRegenerate && (
        <button type="button" disabled={sending} onClick={() => props.onRegenerate(message.id)}>
          <RotateCcw size={12} /> 重新生成
        </button>
      )}
      {canWithdraw && (
        <button type="button" disabled={sending} onClick={() => props.onWithdraw(message.id)}>
          <Undo2 size={12} /> 撤回
        </button>
      )}
    </div>
  );
}
