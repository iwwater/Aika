import type { PetEvent } from "./contracts";
import { resolveActionId, resolveEmotionId, type PetProfileV1 } from "./profile";

/**
 * 展示语义映射（PET-04）。
 *
 * 输入是**已经被业务层判定该展示**的东西，不是 Runtime 原始事件流——把
 * `RuntimeEvent` 留给定座在 `presentation/desktopPetPresenter.ts` 的适配层，
 * 这样映射表本身不 import 编排模块，也不会有人在这里偷偷加第二条编排路径。
 *
 * 真实字段 → 语义 → 桌宠命令（执行时对 `services/runtime/companionRuntime.ts`
 * 与 `domain/companion.ts` 的实际定义核对所得）：
 *
 * | Runtime 实际字段 | 展示语义 | 桌宠命令 |
 * | --- | --- | --- |
 * | `type:"state"` + `state:"generating"` | 当前轮开始生成 | `event(thinking, 固定短文案)` |
 * | `type:"generated"` + `reply.replyText` | 最终回复 | （最多一个）`action/emotion` → `say(replyText)` |
 * | `type:"generated"` + `reply.motion/expression` | 显式动作 | `action(<已验证动画名>)` |
 * | `type:"generated"` + `reply.mood` | 情绪 | `emotion(<mood>)`，**仅在 profile 已映射时** |
 * | `type:"settled"` + `state:"completed"` 且本轮无文本 | 无文本任务成功 | `event(success)` |
 * | `type:"settled"` + `state:"failed"` 且本轮无文本 | 无文本任务失败 | `event(failure)`（**不外发错误堆栈**） |
 * | `type:"replyDelta"` | 流式增量 | **不发命令**（不按 token 发气泡） |
 * | `type:"error"` | 流式错误 | **不发命令**（终态由 `settled` 表达，避免双发） |
 * | 取消 / 换轮 | 本地撤销 | 不发上游事件，不虚构 `cancelled`/`idle` |
 *
 * **工具开始与审阅目前没有真实公开事件**：Runtime 的 `TurnState` 只有
 * `assembling/generating/awaitingDelivery/completed/cancelled/failed`，没有任何
 * 工具或审阅语义。所以这两条走**受控显式入口**（presenter 的 `notifyActivity`），
 * 绝不根据回复文本去猜「她是不是在调工具」。
 */

export const THINKING_TEXT = "让我想一下……";
export const ATTENTION_TEXT = "需要你确认一下";
export const TOOL_RUNNING_TEXT = "正在处理…";
export const REVIEWING_TEXT = "正在检查结果…";

export type PetCommandKind = "say" | "action" | "emotion" | "event";

/** 一条待发命令的语义描述；`commandId`/`expiresAt`/`generation` 由上层分配。 */
export interface PetCommandSpec {
  kind: PetCommandKind;
  /** 中间态可被同轮更晚的中间态替换，并在该轮终态到达时被清理。 */
  intermediate: boolean;
  /** 同一轮里的稳定逻辑键，用于去重（同一轮终态文本只发一次）。 */
  dedupeSuffix: string;
  text?: string;
  name?: string;
  event?: PetEvent;
  message?: string;
}

/** 只投影展示需要的最少字段；memoryCandidates、思维链等一律不进这里。 */
export interface PetReplyView {
  replyText: string;
  mood: string;
  motion?: string;
  expression?: string;
}

export interface PetSettlementView {
  state: "completed" | "cancelled" | "failed";
  /** 本轮是否已经用最终文本表达过。 */
  hadReplyText: boolean;
}

export function thinkingCommand(): PetCommandSpec {
  return {
    kind: "event",
    intermediate: true,
    dedupeSuffix: "thinking",
    event: "thinking",
    message: THINKING_TEXT,
  };
}

export function activityCommand(kind: "tool-running" | "reviewing"): PetCommandSpec {
  return {
    kind: "event",
    intermediate: true,
    dedupeSuffix: kind,
    event: kind,
    message: kind === "tool-running" ? TOOL_RUNNING_TEXT : REVIEWING_TEXT,
  };
}

export function attentionCommand(): PetCommandSpec {
  return {
    kind: "event",
    intermediate: false,
    dedupeSuffix: "attention",
    event: "attention",
    message: ATTENTION_TEXT,
  };
}

/**
 * 最终回复的有序复合任务：最多一个表现命令，然后 say。
 *
 * 「显式动作优先于 emotion」：`motion`/`expression` 是模型明确点名要做的动作，
 * 而 `mood` 只是她说话时的状态——两者都有时，前者才是用户真正想看到的那一个。
 * 映射缺失时**只保留文本**并记录 unsupported（由 Service 的能力守门表达），
 * 不把 `happy` 这种业务名当供应商动作 id 发出去。
 */
export function finalReplyCommands(reply: PetReplyView, profile: PetProfileV1 | null): PetCommandSpec[] {
  const text = reply.replyText.trim();
  // 没有正文的「最终回复」不是一次展示：不发表情、不发动作，把这一轮交给
  // `settled` 的 success/failure 表达。哪怕 mood 恰好有映射也不发——
  // 对一个什么都没说出来的轮次做个表情，用户只会更困惑。
  if (!text) return [];

  const commands: PetCommandSpec[] = [];
  const explicit = reply.motion?.trim() || reply.expression?.trim() || "";
  if (explicit && resolveActionId(profile, explicit)) {
    commands.push({
      kind: "action",
      intermediate: false,
      dedupeSuffix: "action",
      name: explicit,
    });
  } else {
    const mood = reply.mood.trim().toLowerCase();
    if (mood && resolveEmotionId(profile, mood)) {
      commands.push({
        kind: "emotion",
        intermediate: false,
        dedupeSuffix: "emotion",
        name: mood,
      });
    }
  }
  commands.push({
    kind: "say",
    intermediate: false,
    dedupeSuffix: "say",
    text,
  });
  return commands;
}

/**
 * 终态命令。
 *
 * 有文本的任务**不再补 success event**：正文已经表达过这一轮，再发一个
 * 「成功」是同一件事说两遍。只有确实没有文本的成功/失败才发。
 */
export function settlementCommands(settlement: PetSettlementView): PetCommandSpec[] {
  if (settlement.hadReplyText) return [];
  if (settlement.state === "completed") {
    return [{ kind: "event", intermediate: false, dedupeSuffix: "settled", event: "success" }];
  }
  if (settlement.state === "failed") {
    // 只发语义，不外发 errorCode、更不外发堆栈。
    return [{ kind: "event", intermediate: false, dedupeSuffix: "settled", event: "failure" }];
  }
  return [];
}
