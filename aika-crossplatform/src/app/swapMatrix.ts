import type { AikaKernel, AikaPlugin } from "../kernel";
import { createAikaKernel } from "./composition";

/**
 * CORE-07 替换矩阵的驱动（测试支撑，不是生产代码；不 import vitest）。
 *
 * 它只做一件事：给定「同一份消费侧场景」和「若干格（每格只描述装哪个实现）」，
 * 逐格装配一个真实内核并把场景跑一遍，把结果原样交回给测试去比对。
 *
 * 两件刻意不做的事：
 * - **不直接 new 实现塞进注册表**。每格给的是插件列表，装配一律走组合根，
 *   这样测的是产品的装配路径，不是测试代码的拼装。
 * - **不替测试下结论**。装配失败、观察结果是什么，都如实返回；判定留给断言。
 */

export type ConsumerObservation = Record<string, unknown>;

/** 消费侧场景：只依赖端口契约，拿到的只有内核——它无从知道装的是哪个实现。 */
export interface ConsumerScenario {
  name: string;
  run(kernel: AikaKernel): Promise<ConsumerObservation>;
}

export interface MatrixCase {
  port: string;
  implementation: string;
  open(): Promise<{
    hostPlugins: readonly AikaPlugin[];
    featurePlugins: readonly AikaPlugin[];
    close?: () => void | Promise<void>;
  }>;
}

export interface MatrixEntry {
  implementation: string;
  /** 装配是否成功；失败时 `failure` 写明原因。 */
  ok: boolean;
  failure?: string;
  observation?: ConsumerObservation;
}

export interface MatrixResult {
  port: string;
  scenario: string;
  entries: MatrixEntry[];
}

export async function runMatrix(
  scenario: ConsumerScenario,
  cases: readonly MatrixCase[],
): Promise<MatrixResult> {
  const port = cases[0]?.port ?? "(empty)";
  const entries: MatrixEntry[] = [];

  for (const item of cases) {
    const opened = await item.open();
    try {
      const { kernel, report } = await createAikaKernel({
        hostPlugins: opened.hostPlugins,
        featurePlugins: opened.featurePlugins,
        // 矩阵只验注册表注入这条路径，不依赖任何过渡转发。
        installLegacyPorts: false,
      });
      try {
        if (!report.ok) {
          entries.push({
            implementation: item.implementation,
            ok: false,
            failure: `装配失败：${JSON.stringify(report.failed)}`,
          });
          continue;
        }
        entries.push({
          implementation: item.implementation,
          ok: true,
          observation: await scenario.run(kernel),
        });
      } finally {
        await kernel.dispose();
      }
    } finally {
      await opened.close?.();
    }
  }

  return { port, scenario: scenario.name, entries };
}
