import type { AikaPlugin } from "../../kernel";
import { StorageToken } from "../../services/storage/tokens";
import { ClockToken } from "../../services/time/tokens";
import { TraceSettingsToken } from "../../services/trace/tokens";
import { createMemoryUsageLedger } from "../../services/usage/memoryUsageLedger";
import { createSqliteUsageLedger } from "../../services/usage/sqliteUsageLedger";
import { createUsageLedgerRecorder } from "../../services/usage/usageRecorder";
import { UsageLedgerToken } from "../../services/usage/tokens";

/**
 * Provider 用量台账（LLM-12）。
 *
 * 装不装由组合根决定（能力缺失即 token 不注册）：没装时 adapter/extractor
 * 原样发请求，FE-26 成本页负责说清楚「没有采集」。
 *
 * 采集开关与 Trace 的 enabled 同源（LLM-12 契约「和 Trace 开关语义一致」）：
 * 没装 tracePlugin 或开关关着时，一个记录都不新写。正文开关（includeText）
 * 与台账无关——台账里本来就没有正文，只有数字。
 */
export interface UsagePluginOptions {
  /** 记录保留天数。默认 DEFAULT_USAGE_RETENTION_DAYS（30）。 */
  retentionDays?: number;
}

export function usagePlugin(options: UsagePluginOptions = {}): AikaPlugin {
  return {
    id: "llm.usage",
    version: "1.0.0",
    requires: [ClockToken],
    optional: [StorageToken, TraceSettingsToken],
    provides: [UsageLedgerToken],
    async activate(context) {
      const clock = context.registrar.resolve(ClockToken);
      const storage = context.registrar.tryResolve(StorageToken);
      const traceSettings = context.registrar.tryResolve(TraceSettingsToken);

      // SQLite 可用就落盘（能跨重启恢复）；localStorage 宿主用内存临时台账，
      // 两套实现同一套读写语义，页面一关就没是「临时」的如实含义。
      const executor = storage?.kind === "sqlite" ? storage.sqlExecutor : undefined;
      const store = executor
        ? await createSqliteUsageLedger(executor, {
          clock: () => clock.now(),
          ...(options.retentionDays === undefined ? {} : { retentionDays: options.retentionDays }),
        })
        : createMemoryUsageLedger({
          clock: () => clock.now(),
          ...(options.retentionDays === undefined ? {} : { retentionDays: options.retentionDays }),
        });

      const recorder = createUsageLedgerRecorder({
        store,
        isEnabled: () => (traceSettings ? traceSettings.get().enabled : false),
        clock: () => clock.now(),
      });

      context.registrar.provide(UsageLedgerToken, () => recorder);
    },
  };
}
