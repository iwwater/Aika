import type { ContextSnippet } from "../../domain/context";
import { buildEnvironmentSummary } from "./summary";
import type { Clock } from "../time/tokens";
import type { EnvironmentMonitor } from "./contracts";
import {
  SCREEN_CONTEXT_SOURCE_ID,
  buildScreenContextSnippets,
  type ScreenContextResult,
} from "./screenContextProjection";
import { SETTING_SCREEN_TEXT_ENABLED } from "./screenContextSource";

/**
 * 环境上下文源（FE-19）。
 *
 * 实现 LLM 已发布的 `ContextSource`（`domain/context.ts` 预留了 `environment`
 * section），把 monitor 的受控摘要转成一条 snippet：应用名 + 持续时长 + 最近
 * 事件 kind / 词表 ID 计数。**窗口标题原文与 OCR 原文不进上下文**——那两个字段
 * 在 FE-18 的规范化入口就被剥离了，这里连接触它们的机会都没有。
 *
 * 授权语义（FE-19-H）：
 * - `environment.contextEnabled` 关闭 → 零输出（本地 snapshot 照常更新）。
 * - 摘要年龄超 TTL（由 monitor.recent 的 TTL 语义保证）→ 自然消失。
 * - source 停止 → monitor 清空快照/缓存 → 下一轮 load 返回空。
 * - `load` 在每次请求装配时执行，即「请求提交前的再次验证」接入点；撤销期间
 *   装配出的旧摘要不可能发送。
 */

export const ENVIRONMENT_CONTEXT_SOURCE_ID = "environment";
export const SETTING_ENVIRONMENT_CONTEXT_ENABLED = "environment.contextEnabled";

export interface EnvironmentContextSourceDeps {
  monitor: EnvironmentMonitor;
  /** 授权读取端口；getSetting 抛错按未授权处理（fail-closed）。 */
  getContextEnabled: () => Promise<boolean>;
  clock: Clock;
}

/** 持续时长的展示口径：秒级就够，不要给模型假精确。 */
function formatDuration(durationMs: number): string {
  const seconds = Math.floor(durationMs / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} 分钟`;
}

export function createEnvironmentContextSource(deps: EnvironmentContextSourceDeps): {
  id: string;
  section: "environment";
  load: (input: { signal?: AbortSignal }) => Promise<readonly ContextSnippet[]>;
} {
  return {
    id: ENVIRONMENT_CONTEXT_SOURCE_ID,
    section: "environment",
    async load() {
      if (deps.monitor.snapshot.foreground === null && deps.monitor.recent().length === 0) {
        // monitor 没有任何有效状态：不用再查授权（避免无谓读库）。
        return [];
      }
      let authorized: boolean;
      try {
        authorized = await deps.getContextEnabled();
      } catch {
        return [];
      }
      if (!authorized) return [];

      const summary = buildEnvironmentSummary(deps.monitor, { clock: deps.clock });
      const parts: string[] = [];
      if (summary.foreground) {
        parts.push(`当前前台应用：${summary.foreground.process}（已持续约 ${formatDuration(summary.foreground.durationMs)}）`);
      }
      if (summary.recent.length > 0) {
        const counted = new Map<string, number>();
        for (const item of summary.recent) {
          const key = item.ruleId ?? item.kind;
          counted.set(key, (counted.get(key) ?? 0) + 1);
        }
        const label = [...counted.entries()].map(([key, count]) => count > 1 ? `${key}×${count}` : key).join("、");
        parts.push(`最近一分钟的环境事件：${label}`);
      }
      if (parts.length === 0) return [];
      return [{
        id: "environment-context",
        category: "environment",
        content: parts.join("。") + "。",
        source: ENVIRONMENT_CONTEXT_SOURCE_ID,
        precision: "confirmed",
        temporal: "current",
      }];
    },
  };
}

/**
 * 屏幕文字摘录上下文源（FE-32）。
 *
 * 与上面的环境摘要源**分开注册、分开授权**：
 * - `environment.contextEnabled`（FE-19）只放行「应用名 + 词表 ID 计数」的摘要；
 * - `environment.screenTextEnabled`（FE-32 新增）才放行可见文字摘录。
 *   后者在本 SPEC 范围内**替代**了「只允许固定词表摘要」的旧限制，且只在本源生效。
 *
 * `load` 落在既有 ContextSource 边界上，也就是每次请求装配的最终校验点：
 * 授权关闭、TTL 过期、会话撤销、暂停清空 → 这里返回空，旧摘录不可能被发出去。
 * 授权读取抛错按未授权处理（fail-closed）。
 */
export interface ScreenTextContextSourceDeps {
  /** 只读当前上下文；本源不发起采集（采集是用户动作或陪伴会话的事）。 */
  current: (now: number) => ScreenContextResult | null;
  /** `environment.screenTextEnabled` 读取端口。 */
  getScreenTextEnabled: () => Promise<boolean>;
  clock: Clock;
}

export function createScreenTextContextSource(deps: ScreenTextContextSourceDeps): {
  id: string;
  section: "environment";
  load: (input: { signal?: AbortSignal }) => Promise<readonly ContextSnippet[]>;
} {
  return {
    id: SCREEN_CONTEXT_SOURCE_ID,
    section: "environment",
    async load(input: { signal?: AbortSignal }) {
      const result = deps.current(deps.clock.now());
      if (!result) return [];
      let authorized: boolean;
      try {
        authorized = await deps.getScreenTextEnabled();
      } catch {
        return [];
      }
      // 等待过异步授权读取：撤销/过期可能正好发生在这中间，重新取一次当前值。
      if (input.signal?.aborted) return [];
      const fresh = deps.current(deps.clock.now());
      if (!fresh || fresh.id !== result.id) return [];
      return buildScreenContextSnippets(fresh, { now: deps.clock.now(), authorized });
    },
  };
}

export { SETTING_SCREEN_TEXT_ENABLED };
