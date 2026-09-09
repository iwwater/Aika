import { DEFAULT_VAD_SETTINGS } from "../../domain/vadSegmenter";
import type {
  VoiceRuntimeEvent,
  VoiceTelemetrySink,
} from "../../domain/voiceRuntime";

/**
 * 本地语音诊断收集器。
 *
 * 这里只保存事件、时钟与音频映射元数据，不保存识别正文、聊天内容或密钥。
 * 环形上限避免语音页长时间打开时诊断数据无限增长；导出结果可以直接附在
 * S1 时序报告里，或在用户明确同意后交给开发者。
 */
export interface VoiceDiagnosticsSnapshot {
  version: 1;
  metadata: {
    clock: "performance" | "date";
    clockResolutionMs: number;
    vadTailSilenceMs: number;
    audioSampleRateHz: number;
    maxEvents: number;
  };
  events: VoiceRuntimeEvent[];
}

export interface VoiceDiagnostics {
  sink: VoiceTelemetrySink;
  snapshot(): VoiceDiagnosticsSnapshot;
  exportJson(): string;
  clear(): void;
}

export interface VoiceDiagnosticsMetrics {
  speechEndToFirstAudioMs: number[];
  interruptToStopRequestedProxyMs: number[];
}

function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.floor((ordered.length - 1) * p)] ?? null;
}

/**
 * 把无正文事件聚合成 SPEC 可审阅的耗时样本。stop 事件必须带
 * `status=stopRequested`，明确它是代理样本，防止被误并入真实声学停止指标。
 */
export function summarizeVoiceDiagnostics(snapshot: VoiceDiagnosticsSnapshot) {
  const speechEnds = new Map<number, number>();
  const speechEndToFirstAudioMs: number[] = [];
  const interrupts = new Map<number, number>();
  const interruptToStopRequestedProxyMs: number[] = [];

  for (const event of snapshot.events) {
    if (event.turnId === undefined) continue;
    if (event.name === "speechEnd") speechEnds.set(event.turnId, event.atMonotonicMs);
    if (event.name === "firstAudio") {
      const speechEnd = speechEnds.get(event.turnId);
      if (speechEnd !== undefined && event.atMonotonicMs >= speechEnd) {
        speechEndToFirstAudioMs.push(event.atMonotonicMs - speechEnd);
      }
    }
    if (event.name === "interruptDetected") interrupts.set(event.turnId, event.atMonotonicMs);
    if (event.name === "playbackStopped" && event.details?.status === "stopRequested") {
      const interrupt = interrupts.get(event.turnId);
      if (interrupt !== undefined && event.atMonotonicMs >= interrupt) {
        interruptToStopRequestedProxyMs.push(event.atMonotonicMs - interrupt);
      }
    }
  }

  return {
    speechEndToFirstAudioMs,
    interruptToStopRequestedProxyMs,
    speechEndToFirstAudioP50Ms: percentile(speechEndToFirstAudioMs, 0.5),
    speechEndToFirstAudioP95Ms: percentile(speechEndToFirstAudioMs, 0.95),
    interruptToStopRequestedProxyP50Ms: percentile(interruptToStopRequestedProxyMs, 0.5),
    interruptToStopRequestedProxyP95Ms: percentile(interruptToStopRequestedProxyMs, 0.95),
  } satisfies VoiceDiagnosticsMetrics & Record<string, number[] | number | null>;
}

function measureClockResolution(): number {
  if (typeof performance === "undefined" || typeof performance.now !== "function") return 1;
  let previous = performance.now();
  let smallest = Number.POSITIVE_INFINITY;
  for (let index = 0; index < 64; index += 1) {
    const current = performance.now();
    const delta = current - previous;
    if (delta > 0) smallest = Math.min(smallest, delta);
    previous = current;
  }
  return Number.isFinite(smallest) ? smallest : 1;
}

export function createVoiceDiagnostics(maxEvents = 512): VoiceDiagnostics {
  const boundedSize = Math.max(1, Math.floor(maxEvents));
  const events: VoiceRuntimeEvent[] = [];
  const metadata: VoiceDiagnosticsSnapshot["metadata"] = {
    clock: typeof performance !== "undefined" && typeof performance.now === "function" ? "performance" : "date",
    clockResolutionMs: measureClockResolution(),
    vadTailSilenceMs: DEFAULT_VAD_SETTINGS.tailMs,
    audioSampleRateHz: 16_000,
    maxEvents: boundedSize,
  };

  return {
    sink(event) {
      events.push({ ...event, details: event.details ? { ...event.details } : undefined });
      if (events.length > boundedSize) events.splice(0, events.length - boundedSize);
    },

    snapshot() {
      return {
        version: 1,
        metadata: { ...metadata },
        events: events.map((event) => ({
          ...event,
          details: event.details ? { ...event.details } : undefined,
        })),
      };
    },

    exportJson() {
      return JSON.stringify(this.snapshot(), null, 2);
    },

    clear() {
      events.length = 0;
    },
  };
}
