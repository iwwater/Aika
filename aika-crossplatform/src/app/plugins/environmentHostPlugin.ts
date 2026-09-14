import type { AikaPlugin } from "../../kernel";
import { ClockToken } from "../../services/time/tokens";
import { createSystemClock } from "../../services/time/systemTime";
import { SettingsToken } from "../../services/storage/tokens";
import {
  CaptureSchedulerToken,
  ScreenContextSourceToken,
} from "../../services/environment/contracts";
import {
  EnvironmentBusyObserverToken,
  createBusyObserver,
  createTauriBusyAdapter,
} from "../../services/environment/busySource";
import { createCaptureScheduler } from "../../services/environment/captureScheduler";
import { createScreenContextSource, type WindowCaptureOutcome } from "../../services/environment/screenContextSource";
import { SETTING_KEYS } from "../../services/storage/contracts";

/**
 * 环境能力的宿主装配（FE-32 / FE-31）。
 *
 * 在这之前，`environmentPlugin`、`createForegroundSource`、`createScreenSource`
 * 全都只有自己的测试在用——生产装配里一个传感器都没接。这个插件补上那一段：
 * busy 观测者、统一调度器、按需读屏上下文源与陪伴会话控制器，全部按
 * 「能力缺失即 token 不注册」的既有规矩来。
 *
 * 它**不**自己探测平台：`environment_*` 命令在不支持的平台上会失败，source 的
 * start 把失败映射成 `unavailable`/`denied`，设置页如实显示「权限被拒/错误」——
 * 这比装配期猜一个 supported 布尔更诚实。
 */

export interface EnvironmentHostPluginOptions {
  invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
  hostEpoch: string;
  /** 共享的 OCR 引擎（与 FE-21 词表轨同一个实例，不另开 worker）。 */
  ocr: import("../../services/environment/ocrText").OcrEngine;
  /**
   * 统一采集调度器（MVP-05-E）。
   *
   * 词表轨（FE-21）在 `hosts/index.ts` 里构造，比本插件早，所以调度器必须
   * **在宿主装配处建一次**再注入两边；不传时退回本插件自建（既有测试与
   * 单插件装配行为不变）。此前装配处漏传，"两条轨共用一份 10 次/分钟"
   * 只是注释里的承诺。
   */
  scheduler?: import("../../services/environment/captureScheduler").CaptureScheduler;
}

/** Rust `environment_capture_window` 的返回投影；形状不符按不可用处理。 */
function toCaptureOutcome(raw: unknown): WindowCaptureOutcome {
  if (!raw || typeof raw !== "object") return { status: "unavailable" };
  const payload = raw as Record<string, unknown>;
  switch (payload.status) {
    case "self_window":
      return { status: "self_window" };
    case "obscured":
      return { status: "obscured" };
    case "no_window":
      return { status: "no_window" };
    case "ok": {
      const frame = payload.frame as Record<string, unknown> | undefined;
      const window = frame?.window as Record<string, unknown> | undefined;
      const region = frame?.region as Record<string, unknown> | undefined;
      if (typeof frame?.pngBase64 !== "string" || !window || !region) return { status: "unavailable" };
      if (typeof window.processName !== "string" || typeof window.windowId !== "string" || typeof window.monitorId !== "string") {
        return { status: "unavailable" };
      }
      for (const key of ["x", "y", "width", "height"]) {
        if (typeof region[key] !== "number") return { status: "unavailable" };
      }
      return {
        status: "ok",
        frame: {
          pngBase64: frame.pngBase64,
          window: {
            processName: window.processName,
            windowId: window.windowId,
            monitorId: window.monitorId,
          },
          region: {
            x: region.x as number,
            y: region.y as number,
            width: region.width as number,
            height: region.height as number,
          },
        },
      };
    }
    default:
      return { status: "unavailable" };
  }
}

export function environmentHostPlugin(options: EnvironmentHostPluginOptions): AikaPlugin {
  return {
    id: "host.environment",
    version: "1.0.0",
    optional: [ClockToken, SettingsToken],
    provides: [
      EnvironmentBusyObserverToken,
      CaptureSchedulerToken,
      ScreenContextSourceToken,
    ],
    activate(context) {
      const clock = context.registrar.tryResolve(ClockToken) ?? createSystemClock();
      const settings = context.registrar.tryResolve(SettingsToken);

      const busy = createBusyObserver(createTauriBusyAdapter(options.invoke), {
        clock,
        hostEpoch: options.hostEpoch,
      });
      context.registrar.provide(EnvironmentBusyObserverToken, () => busy);

      // 一个调度器，两条轨共用：FE-21 词表轨与 FE-32 按需读屏共享 10 次/分钟。
      // 宿主装配通常已经把同一个实例注入进来了（见 options.scheduler）。
      const scheduler = options.scheduler ?? createCaptureScheduler({ clock });
      context.registrar.provide(CaptureSchedulerToken, () => scheduler);

      const screenContext = createScreenContextSource({
        capture: {
          async captureWindow({ windowId }) {
            try {
              return toCaptureOutcome(await options.invoke("environment_capture_window", { windowId }));
            } catch {
              // 命令不存在 / 平台不支持 / 被拒：都是「读不到」，不是「没有文字」。
              return { status: "unavailable" };
            }
          },
        },
        ocr: options.ocr,
        scheduler,
        clock,
        // 采集授权 = 屏幕感知开关；读取失败按未授权（fail-closed）。
        getCaptureAuthorized: async () => {
          if (!settings) return false;
          return settings.getBoolean(SETTING_KEYS.environmentScreenEnabled, false);
        },
      });
      context.registrar.provide(ScreenContextSourceToken, () => screenContext);
    },
  };
}
