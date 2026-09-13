import type { AikaPlugin } from "../../kernel";
import { ClockToken } from "../../services/time/tokens";
import { createSystemClock } from "../../services/time/systemTime";
import { createRuleProactivePolicy } from "../../services/environment/ruleProactivePolicy";
import { createEnvironmentMonitor } from "../../services/environment/monitor";
import {
  EnvironmentMonitorToken,
  EnvironmentSourcesToken,
  ProactivePolicyToken,
  type EnvironmentSource,
} from "../../services/environment/contracts";

/**
 * 环境能力插件（FE-18）。
 *
 * - `environment.proactivePolicy` **恒注册**：纯策略不依赖任何宿主能力。
 * - `environment.monitor` 只在宿主真的有传感器时注册——「能力缺失即 token 不注册」，
 *   无源时 tryResolve 得 null，消费方降级（FE-19 起接线）。
 *
 * 传感器集合由装配方传入（FE-19 的宿主装配在能力探测成功后构造 foreground source，
 * 再把数组交给本插件）；`EnvironmentSourcesToken` 是这套契约的宿主侧发布形态，
 * 供测试与未来装配路径使用。
 */

export interface EnvironmentPluginOptions {
  /** 宿主探测到的传感器；空/缺省 = 本宿主没有环境能力。 */
  sources?: readonly EnvironmentSource[];
  /** monitor 时钟；缺省回落系统时钟。测试注入假时钟。 */
  clock?: import("../../services/time/tokens").Clock;
  /**
   * 宿主 epoch：事件归属校验与 FE-19 真实 source 打点共用同一值。
   * 缺省时 monitor 自造（单元测试各得其所）；生产装配传宿主 lifecycle 的 epoch。
   */
  hostEpoch?: string;
}

export function environmentPlugin(options: EnvironmentPluginOptions = {}): AikaPlugin {
  const sources = options.sources ?? [];
  const hasSources = sources.length > 0;
  return {
    id: "app.environment",
    version: "1.0.0",
    optional: [ClockToken, EnvironmentSourcesToken],
    provides: hasSources
      ? [EnvironmentMonitorToken, ProactivePolicyToken]
      : [ProactivePolicyToken],
    activate(context) {
      // FE-22：默认策略升级为生产规则策略（替换 FE-18 的静态 ignore 占位）。
      context.registrar.provide(ProactivePolicyToken, () => createRuleProactivePolicy());
      if (!hasSources) return;

      const resolvedSources = options.sources ?? context.registrar.tryResolve(EnvironmentSourcesToken) ?? [];
      const clock = context.registrar.tryResolve(ClockToken) ?? createSystemClock();
      const monitor = createEnvironmentMonitor(resolvedSources, {
        clock,
        hostEpoch: options.hostEpoch,
      });
      context.registrar.provide(EnvironmentMonitorToken, () => monitor, {
        disposer: () => monitor.dispose(),
      });
    },
  };
}

export {
  EnvironmentMonitorToken,
  EnvironmentSourcesToken,
  ProactivePolicyToken,
} from "../../services/environment/contracts";
