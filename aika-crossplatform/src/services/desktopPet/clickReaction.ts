import type { Clock } from "../time/tokens";

/**
 * 点击的 Aiki 侧回应（MVP-15 选项 B，2026-09-16 拍板）。
 *
 * 语义：用户点了桌宠 → 她说一句**固定短语**。四条硬边界，都是刻意的：
 *
 * 1. **不调 provider**：短语来自本地池，不是生成式内容——点击不花一分钱、不产生新的外发类型。
 * 2. **点击不排队**：30s 冷却内的点击直接丢并计数，不做「攒着一起说」。连点是人的手滑，
 *    不是待办事项。
 * 3. **不打断**：她正在说话时一律不叠话（`speaking` 抑制），宁可少说一句。
 * 4. **绝不冒错**：点击是低频的手势，任何依赖抛错都吞掉并计数，不许顺着调用栈回到窗口事件上。
 *
 * canSend 终审由调用方注入（勿扰时段 / 每日上限 / 最小间隔），**这里不重新实现一套**——
 * 口径来自 `domain/proactive.ts` 的纯函数，与主动消息共用一个出口。
 *
 * 「点击到达 Aika 之后做什么」的产品语义到此为止：**不生成对话轮、不写记忆、不命令宠物做动作**
 * （shell 本地的 clickAction 已经在播动作，双重动作会打架）。
 */

/** 最小间隔：同一只宠物被连点也只回应一次。写进 SPEC 的常数（2026-09-16 用户定为 5s）。 */
export const CLICK_REACTION_MIN_INTERVAL_MS = 5_000;

/**
 * 固定短语池。
 *
 * 全部是「确认收到」而非「假装懂」：池子里没有需要上下文才成立的话，
 * 所以它永远不会说出与事实不符的内容。要更丰富的回应就得调模型——那超出选项 B 的授权范围。
 */
export const CLICK_REACTION_PHRASES: readonly string[] = [
  "嗯？",
  "在呢。",
  "怎么啦？",
  "我在这儿。",
  "嗯，听得见。",
];

/** 没回应的原因。每一个都要能计数——被抑制不是「什么都没发生」，是「明确地没说」。 */
export type ClickReactionSuppression =
  /** 用户关掉了这个行为。 */
  | "disabled"
  /** 距上次回应不足 `CLICK_REACTION_MIN_INTERVAL_MS`（点击不排队，直接丢）。 */
  | "cooldown"
  /** canSend 终审没过（勿扰时段 / 每日上限 / 最小间隔）。 */
  | "gate"
  /** 她正在说话，不打断。 */
  | "speaking"
  /** 出声通道不可用，或某个依赖抛错。 */
  | "unavailable";

export interface ClickReactionDiagnostics {
  received: number;
  responded: number;
  suppressed: Record<ClickReactionSuppression, number>;
}

export interface ClickReactionDeps {
  clock: Clock;
  /** 真的开口。返回 `false` 表示没出声（引擎不可用/被拒绝），此时**不占用冷却**。 */
  speak(text: string): boolean;
  /**
   * 桌宠气泡（`/api/say`）：短话同时在宠物头顶冒出来（2026-09-16 用户要求）。
   * 失败只静默——气泡是锦上添花，不能反过来影响出声。
   */
  bubble?(text: string): void;
  /** canSend 终审——与主动消息同一个出口，不在这里另造一套。 */
  gate(): Promise<boolean>;
  isEnabled?: () => boolean;
  isSpeaking?: () => boolean;
  /** 短语选择；缺省在池内轮转（可注入以便测试断言）。 */
  pickPhrase?: (phrases: readonly string[]) => string;
}

export interface ClickReaction {
  /**
   * 更新用户开关。
   *
   * 装配层在每次点击前读一次设置再喂进来（设置端口没有变更订阅），所以「关掉」
   * 立刻生效，不用重启应用。不调用就用构造时的值（缺省视为开）。
   */
  setEnabled(enabled: boolean): void;
  /**
   * 收到一次点击事实。返回 `null` = 已经回应，否则是抑制原因。
   * **不抛错、不排队、不重试。**
   */
  handle(): Promise<ClickReactionSuppression | null>;
  diagnostics(): ClickReactionDiagnostics;
}

export function createClickReaction(deps: ClickReactionDeps): ClickReaction {
  const isEnabled = deps.isEnabled ?? (() => true);
  const isSpeaking = deps.isSpeaking ?? (() => false);
  /** 装配层在每次点击前刷新的开关值；`null` = 还没刷过，用构造时那个判断。 */
  let enabledOverride: boolean | null = null;
  let lastRespondedAt: number | null = null;
  let cursor = 0;

  const diagnostics: ClickReactionDiagnostics = {
    received: 0,
    responded: 0,
    suppressed: { disabled: 0, cooldown: 0, gate: 0, speaking: 0, unavailable: 0 },
  };

  function suppress(reason: ClickReactionSuppression): ClickReactionSuppression {
    diagnostics.suppressed[reason] += 1;
    return reason;
  }

  return {
    setEnabled(next) {
      enabledOverride = next;
    },

    async handle() {
      diagnostics.received += 1;
      try {
        if (!(enabledOverride ?? isEnabled())) return suppress("disabled");

        const now = deps.clock.now();
        if (lastRespondedAt !== null && now - lastRespondedAt < CLICK_REACTION_MIN_INTERVAL_MS) {
          return suppress("cooldown");
        }

        if (isSpeaking()) return suppress("speaking");

        if (!(await deps.gate())) return suppress("gate");

        const pick = deps.pickPhrase ?? ((phrases: readonly string[]) => phrases[cursor++ % phrases.length]);
        const phrase = pick(CLICK_REACTION_PHRASES);
        if (!deps.speak(phrase)) {
          // 没出声就不算回应过：冷却不推进，下一次点击仍有机会。
          return suppress("unavailable");
        }

        lastRespondedAt = deps.clock.now();
        diagnostics.responded += 1;
        // 气泡与出声同一句；它出问题绝不回滚「已回应」的状态。
        if (deps.bubble) {
          try {
            deps.bubble(phrase);
          } catch {
            /* 气泡失败不影响出声 */
          }
        }
        return null;
      } catch {
        // 点击是旁路：任何实现意外都不许回到窗口事件链路上。
        return suppress("unavailable");
      }
    },

    diagnostics() {
      return {
        received: diagnostics.received,
        responded: diagnostics.responded,
        suppressed: { ...diagnostics.suppressed },
      };
    },
  };
}
