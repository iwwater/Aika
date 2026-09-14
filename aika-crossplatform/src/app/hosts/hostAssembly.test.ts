import { describe, expect, it } from "vitest";
import type { AikaPlugin } from "../../kernel";
import { tauriHostPlugins } from "./index";
import { storagePlugin } from "./plugins";
import { createAikaKernel } from "../composition";
import { createSqliteStorage } from "../../services/storage/sqliteStorage";
import { openMemorySqlite } from "../../services/storage/nodeSqlite.harness";
import {
  CaptureSchedulerToken, EnvironmentMonitorToken, ScreenContextSourceToken,
} from "../../services/environment/contracts";
import { EnvironmentBusyObserverToken } from "../../services/environment/busySource";
import { ContextSourcesToken } from "../../services/context/tokens";
import { CompanionPresenterToken, EnvironmentPresenterToken } from "../../presentation/tokens";

/**
 * 生产宿主装配的启动门禁（2026-09-14 补，FE-33 前置）。
 *
 * 背景：`composition.test.ts` 里所有断言 `report.ok === true` 的用例用的都是
 * `testHostPlugins`，而真实 Tauri 宿主（`tauriHostPlugins`）**只被校验过插件 id 列表**，
 * 从来没有真正装配过一次。FE-26 那次「presentationPlugin 漏声明 optional →
 * DEPENDENCY_NOT_DECLARED 拒启动」正是这一类只会在生产宿主暴露的缺陷。
 *
 * 这里用真实 `tauriHostPlugins()`（只把 `host.storage` 换成内存 SQLite——Node 里
 * 打不开 plugin-sql，其余宿主插件原样）+ 真实 `capabilityPlugins()` + 展示层装配，
 * 断言内核启动成功且环境链路的关键 token 真的注册上了。
 *
 * 局限（如实记）：存储实现被替换，因此本用例**不**覆盖 plugin-sql 的真实行为；
 * 那部分归 INT-01。它覆盖的是插件图、依赖声明与 token 注册。
 */
describe("生产宿主装配（tauriHostPlugins + capabilityPlugins）", () => {
  async function assemble(): Promise<{
    ok: boolean;
    failed: unknown;
    has: (token: unknown) => boolean;
    dispose: () => Promise<void>;
  }> {
    const { db, executor } = openMemorySqlite();
    const storage = await createSqliteStorage(executor);
    const host = tauriHostPlugins().filter((plugin: AikaPlugin) => plugin.id !== "host.storage");

    const { kernel, report } = await createAikaKernel({
      hostPlugins: [...host, storagePlugin(async () => storage)],
      installLegacyPorts: false,
    });

    return {
      ok: report.ok,
      failed: report.failed,
      has: (token) => kernel.registry.has(token as never),
      dispose: async () => {
        await kernel.dispose();
        db.close();
      },
    };
  }

  it("真实宿主插件集能启动，且环境链路 token 全部注册", async () => {
    const session = await assemble();
    try {
      expect(session.failed).toEqual([]);
      expect(session.ok).toBe(true);

      // 环境链路（FE-18~22/31/32）：这几个 token 少一个，设置页的环境分组就会
      // 整块消失、陪伴分组退回 null——真机上表现为「环境感知不见了」。
      for (const [name, token] of Object.entries({
        "environment.monitor": EnvironmentMonitorToken,
        "screen.contextSource": ScreenContextSourceToken,
        "capture.scheduler": CaptureSchedulerToken,
        "environment.busy": EnvironmentBusyObserverToken,
        "context.sources": ContextSourcesToken,
        "presentation.environment": EnvironmentPresenterToken,
        "presentation.companion": CompanionPresenterToken,
      })) {
        expect(session.has(token), `${name} 未注册`).toBe(true);
      }
    } finally {
      await session.dispose();
    }
  });
});
