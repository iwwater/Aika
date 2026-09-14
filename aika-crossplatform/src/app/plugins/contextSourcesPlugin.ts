import { type AikaPlugin } from "../../kernel";
import { ContextSourcesToken } from "../../services/context/tokens";
import type { ContextSource } from "../../services/context/contextAssembler";
import { createKnowledgeContextSource } from "../../services/knowledge/knowledgeSource";
import { createKnowledgeIndex } from "../../services/knowledge/knowledgeIndex";
import { createKnowledgeWiki, KnowledgeWikiToken } from "../../services/knowledge/wiki";
import { DEFAULT_CHARACTER } from "../../domain/character";
import { createMemorySource } from "../../services/memory/memorySource";
import { MemoryRepositoryToken } from "../../services/memory/tokens";
import { SettingsToken, StorageToken } from "../../services/storage/tokens";
import {
  createEnvironmentContextSource, createScreenTextContextSource,
} from "../../services/environment/contextSource";
import {
  EnvironmentMonitorToken, ScreenContextSourceToken,
} from "../../services/environment/contracts";
import {
  EnvironmentBusyObserverToken, readBusyObservation,
} from "../../services/environment/busySource";
import { SETTING_KEYS } from "../../services/storage/contracts";
import { ClockToken } from "../../services/time/tokens";
import { createSystemClock } from "../../services/time/systemTime";

/**
 * 上下文来源的**唯一装配点**（LLM-05）。
 *
 * Memory 源照旧进来（optional：noMemoryPlugin 宿主没有仓储，不该挡住知识）；
 * Knowledge 源只在存储暴露 sqlExecutor 时加入——浏览器 localStorage 宿主没有
 * SQL 可用，知识能力整体不装，而不是装一个永远为空的假源。两类来源互不绑架：
 * memoryV2 缺失不让 Knowledge 一起消失，反之亦然。
 */
export function contextSourcesPlugin(): AikaPlugin {
  return {
    id: "llm.contextSources",
    version: "1.0.0",
    requires: [StorageToken],
    optional: [
      MemoryRepositoryToken, EnvironmentMonitorToken, ScreenContextSourceToken,
      EnvironmentBusyObserverToken, SettingsToken, ClockToken,
    ],
    provides: [ContextSourcesToken, KnowledgeWikiToken],
    activate(context) {
      const storage = context.registrar.resolve(StorageToken);
      const memoryRepository = context.registrar.tryResolve(MemoryRepositoryToken);
      const settings = context.registrar.tryResolve(SettingsToken);
      const sources: ContextSource[] = [];
      if (memoryRepository) {
        sources.push(createMemorySource(memoryRepository, {
          // MVP-06 AC-D：长期记忆总开关。关 = 记忆源零检索（Recent 会话不受影响）。
          isEnabled: async () => settings
            ? settings.getBoolean(SETTING_KEYS.memoryEnabled, true)
            : true,
        }));
      }
      const db = storage.sqlExecutor;
      if (db) {
        const index = createKnowledgeIndex({ db });
        sources.push(createKnowledgeContextSource(index, {
          // MVP-06 AC-D：RAG 总开关。关 = 知识源零检索调用；Wiki 条目仍在库里、仍可管理。
          isEnabled: async () => settings
            ? settings.getBoolean(SETTING_KEYS.knowledgeEnabled, true)
            : true,
        }));
        // Wiki 管理面：不受检索开关影响（关掉 RAG 不该把用户的条目藏起来）。
        context.registrar.provide(KnowledgeWikiToken, () =>
          createKnowledgeWiki(index, { characterId: DEFAULT_CHARACTER.id }));
      }

      /**
       * 环境来源（FE-19 摘要 + FE-32 屏幕文字摘录）。
       *
       * 这两条在本次之前**从未接进请求装配**——模块写好了却没人装，等于
       * 摘要与摘录永远到不了模型。两者分开注册、分开授权：
       * `environment.contextEnabled` 只放行「应用名 + 词表 ID 计数」，
       * `environment.screenTextEnabled` 才放行可见文字摘录。
       * 授权读取失败一律按未授权（fail-closed），装配期不缓存授权值。
       */
      const monitor = context.registrar.tryResolve(EnvironmentMonitorToken);
      const clock = context.registrar.tryResolve(ClockToken) ?? createSystemClock();
      if (monitor) {
        sources.push(createEnvironmentContextSource({
          monitor,
          clock,
          getContextEnabled: async () => settings
            ? settings.getBoolean(SETTING_KEYS.environmentContextEnabled, false)
            : false,
        }));
      }
      const screenContext = context.registrar.tryResolve(ScreenContextSourceToken);
      if (screenContext) {
        // 锁屏观测（MVP-04 AC-B）：宿主有 busy 观测能力时，锁屏一律不产出摘录。
        // 没有该能力（浏览器/测试装配）→ 不阻断，行为与之前一致。
        const busyObserver = context.registrar.tryResolve(EnvironmentBusyObserverToken);
        sources.push(createScreenTextContextSource({
          current: (now) => screenContext.current(now),
          getScreenTextEnabled: async () => settings
            ? settings.getBoolean(SETTING_KEYS.environmentScreenTextEnabled, false)
            : false,
          clock,
          ...(busyObserver
            ? { isLocked: async () => (await readBusyObservation(busyObserver, clock)).locked }
            : {}),
        }));
      }

      context.registrar.provide(ContextSourcesToken, () => sources);
    },
  };
}
