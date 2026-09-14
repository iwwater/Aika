import type { Clock } from "../time/tokens";
import type { EnvironmentEventInput } from "../../domain/environment";
import { EnvironmentSourceError, type EnvironmentSource } from "./contracts";
import type { OcrEngine } from "./ocrText";
import type { CaptureScheduler } from "./captureScheduler";
import { matchKeywords } from "./keywordRules";

/**
 * Screen Event source（FE-21）。
 *
 * 管线：Rust 帧变化通知（`environment://screen-change`，节流 ≥2s）→ 固定 ROI
 * 局部截图（`environment_capture_region`，主显示器中央 80%×20%）→ 本地英文 OCR
 * → 词表规则 → `EnvironmentEventInput`。无显著变化时零 OCR；OCR 每分钟至多
 * 10 次（单调时钟滚动窗口）、并发 1、忙时只保留最新候选（不积压图片）。
 *
 * 隐私：原图只在内存里走 base64 → OCR → 丢弃；事件只携带词表 ID 与归一化
 * 置信度，OCR 原文不出本模块（FE-18 monitor 在规范化入口还会再剥一次）。
 */

export const SCREEN_SOURCE_ID = "screen";
export const SCREEN_CHANGE_EVENT = "environment://screen-change";
export const CAPTURE_REGION_COMMAND = "environment_capture_region";

export const SCREEN_CHANGE_THROTTLE_MS = 2000;
export const OCR_MAX_PER_MINUTE = 10;
/** 主显示器中央横带：宽 80%、高 20%（相对坐标，Rust 侧按当前帧尺寸换算）。 */
export const FIXED_ROI = { x: 0.1, y: 0.4, width: 0.8, height: 0.2 } as const;

export interface ScreenChangePayload {
  magnitude?: unknown;
  atMs?: unknown;
}

export interface ScreenCapturePort {
  listenChange(handler: (payload: ScreenChangePayload) => void): Promise<() => void>;
  /** 固定 ROI 截图 → PNG base64；失败/黑帧/越界返回 null（丢弃该帧）。 */
  captureRegion(): Promise<string | null>;
  /** Rust enable/disable（真实桥需要；纯编排测试的 fake 可不实现）。 */
  invoke?(command: string, args?: Record<string, unknown>): Promise<unknown>;
}

export interface ScreenSourceDeps {
  capture: ScreenCapturePort;
  ocr: OcrEngine;
  clock: Clock;
  hostEpoch: string;
  throttleMs?: number;
  maxPerMinute?: number;
  /**
   * 统一调度器（FE-32）。传入时本 source 的采集+识别改走它，与按需读屏
   * **共用同一份每分钟 10 次的总额**；不传时沿用自带的滚动限流（既有行为不变，
   * FE-21 的用例因此不需要改）。
   */
  scheduler?: CaptureScheduler;
}

export function createScreenSource(deps: ScreenSourceDeps): EnvironmentSource {
  const throttleMs = deps.throttleMs ?? SCREEN_CHANGE_THROTTLE_MS;
  const maxPerMinute = deps.maxPerMinute ?? OCR_MAX_PER_MINUTE;
  const ocrRuns: number[] = [];

  return {
    id: SCREEN_SOURCE_ID,
    kind: "screen",
    async start(emit, signal) {
      let unlisten: (() => void) | null = null;
      let stopped = false;
      let lastProcessedAt = -Infinity;
      let pending: { queuedAt: number } | null = null;
      let processing = false;
      let seq = 0;

      /** 单调时钟滚动窗口的 OCR 限流；只记无正文计数语义，超限静默丢弃。 */
      const rateLimited = (now: number): boolean => {
        while (ocrRuns.length > 0 && now - ocrRuns[0] >= 60_000) ocrRuns.shift();
        if (ocrRuns.length >= maxPerMinute) return true;
        ocrRuns.push(now);
        return false;
      };

      /** 一次「抓图 + 识别」。走不走统一调度器只影响在哪里排队与计额度。 */
      const captureAndRecognize = async () => {
        if (deps.scheduler) {
          const outcome = await deps.scheduler.submit(async () => {
            const png = await deps.capture.captureRegion();
            if (png === null) return null;
            return deps.ocr.recognize(png);
          }, { priority: "auto", signal });
          return outcome.status === "done" ? outcome.value : null;
        }
        const png = await deps.capture.captureRegion();
        if (png === null) return null;
        return deps.ocr.recognize(png);
      };

      const processCandidate = async (): Promise<void> => {
        if (processing || stopped) return;
        processing = true;
        try {
          while (pending && !stopped && !signal.aborted) {
            pending = null;
            const now = deps.clock.now();
            if (now - lastProcessedAt < throttleMs) break;
            // 自带限流只在没有统一调度器时生效，避免同一次识别被算两遍额度。
            if (!deps.scheduler && rateLimited(now)) break;
            lastProcessedAt = now;

            const result = await captureAndRecognize();
            if (stopped || signal.aborted) return;
            if (result === null) continue; // 黑帧/超时/失败/被顶掉：本次无事件。
            // 原文到此为止：只留下规则命中。
            const wordConfidence = new Map(result.words.map((word) => [word.word, word.confidence]));
            const matches = matchKeywords(result.text, wordConfidence);
            for (const match of matches) {
              seq += 1;
              const event: EnvironmentEventInput = {
                schemaVersion: "environment.v1",
                sourceId: SCREEN_SOURCE_ID,
                eventId: `screen-${seq}`,
                hostEpoch: deps.hostEpoch,
                timestamp: Date.now(),
                timingPrecision: "measured",
                confidence: match.confidence,
                payload: match.kind === "game_event"
                  ? { kind: "game_event", event: match.event }
                  : { kind: "screen_keyword", keyword: match.event },
              };
              emit(event);
            }
          }
        } finally {
          processing = false;
        }
      };

      // 1. 先订阅变化通知。
      unlisten = await deps.capture.listenChange((payload) => {
        if (stopped || signal.aborted) return;
        void payload;
        // 忙时只保留最新候选：pending 槽被覆盖，不排队积压。
        pending = { queuedAt: deps.clock.now() };
        void processCandidate();
      });

      // 2. enable 由 Rust 命令控制（screen 插件的 enable 即订阅+线程启动，位于
      //    capture 端口后面；这里显式启用）。
      try {
        await deps.capture.invoke?.("environment_screen_enable", { enabled: true });
      } catch (error) {
        unlisten();
        unlisten = null;
        stopped = true;
        const detail = error instanceof Error ? error.message : String(error);
        throw new EnvironmentSourceError(/denied|permission/i.test(detail) ? "denied" : "unavailable", detail);
      }

      const stop = async (): Promise<void> => {
        if (stopped) return;
        stopped = true;
        pending = null;
        unlisten?.();
        unlisten = null;
        // 撤销 generation 后中止 worker：在途识别完成也不广播。
        await deps.ocr.dispose();
        try {
          await deps.capture.invoke?.("environment_screen_enable", { enabled: false });
        } catch {
          // 停止失败由真实桥上抛路径处理；fake 测试不关心。
        }
      };

      if (signal.aborted) {
        await stop();
      }
      return stop;
    },
  };
}
