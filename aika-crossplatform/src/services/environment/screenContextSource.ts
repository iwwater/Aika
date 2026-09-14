import type { Clock } from "../time/tokens";
import type { OcrEngine } from "./ocrText";
import type { CaptureScheduler, SchedulerQuota } from "./captureScheduler";
import {
  SCREEN_CONTEXT_SCHEMA_VERSION,
  SCREEN_CONTEXT_SOURCE_ID,
  SCREEN_CONTEXT_TTL_MS,
  AUTO_CANDIDATE_MIN_CONFIDENCE,
  detectLanguage,
  excerptText,
  isExpired,
  medianConfidence,
  projectExcerpts,
  type ScreenContextResult,
  type ScreenReadStatus,
  type ScreenRegion,
  type ScreenTextLine,
  type ScreenWindowIdentity,
} from "./screenContextProjection";

/**
 * 按需读屏上下文源（FE-32）。
 *
 * 与 FE-21 的词表 source 并列、**不替代**它：那条轨只把固定词表命中变成事件，
 * 这条轨读主显示器上获授权前台窗口客户区的可见中英文文本，并只在用户另行授权
 * 「屏幕文字用于对话」时才允许受限摘录出本机。
 *
 * 边界（SPEC 冻结）：
 * - 截图与完整 OCR 原文只在内存；本模块不写日志、不写 Trace、不落库、不外发原图。
 * - 前台是 pet/主窗时改读「点击前保存的最后一个有效外部窗口」，并重新验证其
 *   可见性与范围——不能把自己的气泡读给自己听，形成自激循环。
 * - 无法可靠排除 pet/主窗覆盖区域 → `self_obscured`，提示用户调整窗口，不硬读。
 * - TTL 60 秒从 capture 计时；暂停/关闭/撤销清空全文与摘录，迟到结果一律作废。
 * - 识别不到文字只说明「没读到」，不等于画面没有内容——状态分 empty /
 *   low_confidence / timeout / unavailable，不返回虚构描述。
 */

/** Rust 受限窗口抓取命令（窗口客户区 + 窗口身份校验）。 */
export const CAPTURE_WINDOW_COMMAND = "environment_capture_window";
/** 「屏幕文字用于对话」授权键（独立于 FE-19 的环境摘要授权）。 */
export const SETTING_SCREEN_TEXT_ENABLED = "environment.screenTextEnabled";

export interface WindowCaptureFrame {
  readonly pngBase64: string;
  readonly window: ScreenWindowIdentity;
  readonly region: ScreenRegion;
}

export type WindowCaptureOutcome =
  | { status: "ok"; frame: WindowCaptureFrame }
  /** 前台是本产品自己的窗口（pet / 主窗）。 */
  | { status: "self_window" }
  /** 目标区域被 pet/主窗覆盖且无法可靠排除。 */
  | { status: "obscured" }
  /** 没有前台窗口 / 已最小化 / 不在主显示器。 */
  | { status: "no_window" }
  /** 受保护内容、黑帧、抓取失败。 */
  | { status: "unavailable" };

export interface WindowCapturePort {
  /**
   * 抓取一个窗口的客户区。
   *
   * `windowId === null` 表示「当前前台窗口」；给定 windowId 时 Rust 侧必须
   * **重新验证**该窗口仍然存在、可见、在主显示器上，并排除 pet/主窗覆盖区域。
   */
  captureWindow(input: { windowId: string | null; signal?: AbortSignal }): Promise<WindowCaptureOutcome>;
}

export interface ScreenContextSourceDeps {
  capture: WindowCapturePort;
  ocr: OcrEngine;
  /** 与 FE-21 词表轨共用的同一个调度器实例（并发 1 / pending 1 / 10 次每分钟）。 */
  scheduler: CaptureScheduler;
  /** 与 monitor 同源的单调时钟：TTL 判定必须同源（FE-22 已固化的约束）。 */
  clock: Clock;
  /** 采集授权（屏幕感知开关）。读取抛错按未授权处理（fail-closed）。 */
  getCaptureAuthorized: () => Promise<boolean>;
  ttlMs?: number;
  randomId?: () => string;
}

export interface ScreenContextReadInput {
  reason: "manual" | "change";
  /** 调用方（陪伴会话）的代数；撤销后旧请求的结果作废。 */
  sessionGeneration: number;
  signal?: AbortSignal;
}

export interface ScreenContextSource {
  readOnce(input: ScreenContextReadInput): Promise<ScreenContextResult>;
  /** TTL 内的最新结果；过期或已清空返回 null。 */
  current(now?: number): ScreenContextResult | null;
  /** 暂停/结束：清空全文与摘录，撤销未开始候选并中止在途识别。 */
  clear(): void;
  /** 会话代数前移：小于该代数的结果全部作废（迟到结果同样丢弃）。 */
  revoke(sessionGeneration: number): void;
  quota(): SchedulerQuota;
  /** 诊断：当前记住的「最后一个有效外部窗口」。 */
  lastExternalWindow(): ScreenWindowIdentity | null;
}

let fallbackCounter = 0;

function defaultId(): string {
  fallbackCounter += 1;
  return `screen-context-${fallbackCounter}`;
}

export function createScreenContextSource(deps: ScreenContextSourceDeps): ScreenContextSource {
  const ttlMs = deps.ttlMs ?? SCREEN_CONTEXT_TTL_MS;
  const newId = deps.randomId ?? defaultId;

  let captureGeneration = 0;
  let minSessionGeneration = 0;
  let latest: ScreenContextResult | null = null;
  let lastExternal: ScreenWindowIdentity | null = null;

  function emptyResult(
    input: ScreenContextReadInput,
    readStatus: ScreenReadStatus,
    extra?: { window?: ScreenWindowIdentity | null; retryAtMonotonicMs?: number | null },
  ): ScreenContextResult {
    const now = deps.clock.now();
    return {
      schemaVersion: SCREEN_CONTEXT_SCHEMA_VERSION,
      id: newId(),
      sourceId: SCREEN_CONTEXT_SOURCE_ID,
      sourceTrust: "environment",
      captureGeneration,
      sessionGeneration: input.sessionGeneration,
      reason: input.reason,
      window: extra?.window ?? null,
      region: null,
      capturedMonotonicMs: now,
      expiresAtMonotonicMs: now,
      language: "unknown",
      confidence: 0,
      readStatus,
      excerpts: [],
      truncated: false,
      retryAtMonotonicMs: extra?.retryAtMonotonicMs ?? null,
    };
  }

  /** 抓取：前台是自己的窗口时退到「最后一个有效外部窗口」重新验证。 */
  async function captureTarget(signal: AbortSignal): Promise<WindowCaptureOutcome> {
    const first = await deps.capture.captureWindow({ windowId: null, signal });
    if (first.status !== "self_window") return first;
    if (!lastExternal) return { status: "no_window" };
    // 点 pet 之后前台就是 pet：改读点击前记下的外部窗口，由 Rust 重新验证可见性。
    return deps.capture.captureWindow({ windowId: lastExternal.windowId, signal });
  }

  async function performRead(
    input: ScreenContextReadInput,
    signal: AbortSignal,
  ): Promise<ScreenContextResult> {
    const generation = (captureGeneration += 1);
    const outcome = await captureTarget(signal);
    if (signal.aborted) return emptyResult(input, "cancelled");
    if (outcome.status === "self_window") return emptyResult(input, "self_obscured");
    if (outcome.status === "obscured") return emptyResult(input, "self_obscured");
    if (outcome.status === "no_window" || outcome.status === "unavailable") {
      return emptyResult(input, "unavailable");
    }

    const { frame } = outcome;
    lastExternal = frame.window;
    // 采集时刻在这里定格：TTL 是「画面有多旧」，不是「识别完多久」。
    const capturedAt = deps.clock.now();

    const recognized = await deps.ocr.recognize(frame.pngBase64);
    if (signal.aborted) return emptyResult(input, "cancelled", { window: frame.window });
    if (recognized === null) {
      // 引擎把超时与失败都收敛成 null：对外统一报 timeout，不猜测具体原因。
      return emptyResult(input, "timeout", { window: frame.window });
    }

    const lines: readonly ScreenTextLine[] = recognized.lines && recognized.lines.length > 0
      ? recognized.lines
      : recognized.text
        .split(/\r?\n/)
        .map((text) => ({ text, confidence: medianWordConfidence(recognized.words) }));

    const { excerpts, truncated } = projectExcerpts(lines);
    const confidence = medianConfidence(excerpts);
    const readStatus: ScreenReadStatus = excerpts.length === 0
      ? "empty"
      : confidence < AUTO_CANDIDATE_MIN_CONFIDENCE
        ? "low_confidence"
        : "ok";

    return {
      schemaVersion: SCREEN_CONTEXT_SCHEMA_VERSION,
      id: newId(),
      sourceId: SCREEN_CONTEXT_SOURCE_ID,
      sourceTrust: "environment",
      captureGeneration: generation,
      sessionGeneration: input.sessionGeneration,
      reason: input.reason,
      window: frame.window,
      region: frame.region,
      capturedMonotonicMs: capturedAt,
      expiresAtMonotonicMs: capturedAt + ttlMs,
      language: detectLanguage(excerptText({ excerpts })),
      confidence,
      readStatus,
      excerpts,
      truncated,
      retryAtMonotonicMs: null,
    };
  }

  return {
    async readOnce(input: ScreenContextReadInput): Promise<ScreenContextResult> {
      if (input.signal?.aborted) return emptyResult(input, "cancelled");
      if (input.sessionGeneration < minSessionGeneration) return emptyResult(input, "cancelled");

      let authorized = false;
      try {
        authorized = await deps.getCaptureAuthorized();
      } catch {
        authorized = false;
      }
      if (!authorized) return emptyResult(input, "unauthorized");
      // 等待过异步授权读取：边界重新验证（撤销可能刚刚发生）。
      if (input.signal?.aborted || input.sessionGeneration < minSessionGeneration) {
        return emptyResult(input, "cancelled");
      }

      const outcome = await deps.scheduler.submit(
        (signal) => performRead(input, signal),
        { priority: input.reason === "manual" ? "manual" : "auto", ...(input.signal ? { signal: input.signal } : {}) },
      );

      if (outcome.status === "rate_limited") {
        return emptyResult(input, "rate_limited", { retryAtMonotonicMs: outcome.retryAtMonotonicMs });
      }
      if (outcome.status === "superseded") return emptyResult(input, "superseded");
      if (outcome.status === "cancelled") return emptyResult(input, "cancelled");
      if (outcome.status === "failed") return emptyResult(input, "unavailable");

      const result = outcome.value;
      // 结果落地前最后一次边界校验：会话撤销/信号中止后不留任何证据。
      if (input.signal?.aborted || input.sessionGeneration < minSessionGeneration) {
        return emptyResult(input, "cancelled");
      }
      latest = result;
      return result;
    },

    current(now?: number): ScreenContextResult | null {
      if (!latest) return null;
      if (latest.sessionGeneration < minSessionGeneration) return null;
      if (isExpired(latest, now ?? deps.clock.now())) return null;
      return latest;
    },

    clear(): void {
      latest = null;
      deps.scheduler.cancelAll();
    },

    revoke(sessionGeneration: number): void {
      minSessionGeneration = Math.max(minSessionGeneration, sessionGeneration);
      if (latest && latest.sessionGeneration < minSessionGeneration) latest = null;
      deps.scheduler.cancelAll();
    },

    quota(): SchedulerQuota {
      return deps.scheduler.quota();
    },

    lastExternalWindow(): ScreenWindowIdentity | null {
      return lastExternal;
    },
  };
}

/** 引擎没给行级结果时的兜底置信度：词级中位数，拿不到按 0（不冒充高置信）。 */
function medianWordConfidence(words: readonly { confidence: number }[]): number {
  if (words.length === 0) return 0;
  const sorted = [...words.map((word) => word.confidence)].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
