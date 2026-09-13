/**
 * 环境事件 schema（FE-18）。
 *
 * 事件信封沿用总 PRD §18 的四字段（type/timestamp/confidence/payload），schemaVersion
 * 仿 `TraceEventV1`。后续加传感器只是 payload 加 `kind` 成员，按 `kind` 穷举的消费方
 * 补分支即可，漏不掉。
 *
 * 两条隐私红线写进类型里，而不是靠约定：
 * 1. 对外广播的 payload **没有** title/text 字段——窗口标题与 OCR 原文只允许存在于
 *    source 内部（当次匹配用），过了 monitor 的规范化入口就被剥离（2026-09-14 修订）。
 * 2. `timestamp` 是宿主墙钟，仅用于展示与未来时间诊断；排序、频控、TTL 一律用
 *    monitor 自己的单调时钟打上的 `receivedMonotonicMs`。跨时钟不得直接相减。
 */

export const ENVIRONMENT_SCHEMA_VERSION = "environment.v1";

export type EnvironmentEventKind =
  | "foreground_changed"
  | "screen_keyword"
  | "game_event"
  | "notification"
  | "idle_changed";

/** monitor 规范化之后对外广播的 payload：无任何自由文本字段。 */
export type EnvironmentEventPayload =
  | { kind: "foreground_changed"; process: string }
  | { kind: "screen_keyword"; keyword: string }
  | { kind: "game_event"; event: string }
  | { kind: "notification"; app: string }
  | { kind: "idle_changed"; idleSeconds: number };

export interface EnvironmentEvent {
  schemaVersion: typeof ENVIRONMENT_SCHEMA_VERSION;
  sourceId: string;
  eventId: string;
  hostEpoch: string;
  /** 宿主墙钟，仅展示。 */
  timestamp: number;
  /** monitor 可信单调时钟在接收时刻打上的时间戳；所有窗口计算的唯一依据。 */
  receivedMonotonicMs: number;
  timingPrecision: "measured" | "estimated" | "unknown";
  /** 有限数且 0..1；进程/空闲类确定事件为 1。 */
  confidence: number;
  payload: EnvironmentEventPayload;
}

/**
 * source 允许提交的原始事件：payload 里允许携带 title/text（旧 fixture 兼容），
 * monitor 在规范化入口剥离。字段超限、畸形数值同样在这里被拒。
 */
export type EnvironmentEventInputPayload =
  | { kind: "foreground_changed"; process: string; title?: string }
  | { kind: "screen_keyword"; keyword: string; text?: string }
  | { kind: "game_event"; event: string }
  | { kind: "notification"; app: string; title?: string }
  | { kind: "idle_changed"; idleSeconds: number };

export type EnvironmentEventInput = Omit<EnvironmentEvent, "payload" | "receivedMonotonicMs"> & {
  payload: EnvironmentEventInputPayload;
};

/** 字段上限：不是语义承诺，是防御预算——超限一律拒绝，不截断后放行。 */
export const ENVIRONMENT_FIELD_LIMITS = {
  id: 128,
  epoch: 128,
  process: 128,
  keyword: 64,
  app: 128,
} as const;

/** 墙钟未来时间容忍度：超过它按「未来时间」拒绝，防止污染任何基于墙钟的展示。 */
export const ENVIRONMENT_FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

export type EnvironmentEventRejectReason =
  | "missing_schema_version"
  | "schema_version_mismatch"
  | "bad_source_id"
  | "bad_event_id"
  | "bad_host_epoch"
  | "bad_confidence"
  | "bad_timestamp"
  | "future_timestamp"
  | "bad_timing_precision"
  | "unknown_payload_kind"
  | "bad_payload_field"
  | "source_id_mismatch";

export type NormalizeResult =
  | { ok: true; event: EnvironmentEvent }
  | { ok: false; reason: EnvironmentEventRejectReason };

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isBoundedString(value: unknown, limit: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= limit;
}

function isTimingPrecision(value: unknown): value is EnvironmentEvent["timingPrecision"] {
  return value === "measured" || value === "estimated" || value === "unknown";
}

/**
 * 规范化一个原始事件。
 *
 * 这是自由文本（title/text）与畸形数值的**唯一放行点**：通过它的事件保证
 * schemaVersion 正确、confidence 有限且 0..1、payload 只含受控字段。monitor 的
 * 去重、快照与 recent 都建立在规范化结果之上。
 *
 * `nowWallMs`（宿主墙钟）只用于未来时间诊断；传 undefined 时跳过该检查——
 * 单调时钟与墙钟不同源，monitor 不做跨时钟比较。
 */
export function normalizeEnvironmentEvent(
  raw: EnvironmentEventInput,
  options: { sourceId: string; receivedMonotonicMs: number; nowWallMs?: number },
): NormalizeResult {
  if (raw === null || typeof raw !== "object") return { ok: false, reason: "missing_schema_version" };
  if (!raw.schemaVersion) return { ok: false, reason: "missing_schema_version" };
  if (raw.schemaVersion !== ENVIRONMENT_SCHEMA_VERSION) {
    return { ok: false, reason: "schema_version_mismatch" };
  }
  if (!isBoundedString(raw.sourceId, ENVIRONMENT_FIELD_LIMITS.id)) return { ok: false, reason: "bad_source_id" };
  if (raw.sourceId !== options.sourceId) return { ok: false, reason: "source_id_mismatch" };
  if (!isBoundedString(raw.eventId, ENVIRONMENT_FIELD_LIMITS.id)) return { ok: false, reason: "bad_event_id" };
  if (!isBoundedString(raw.hostEpoch, ENVIRONMENT_FIELD_LIMITS.epoch)) return { ok: false, reason: "bad_host_epoch" };
  if (!isFiniteNumber(raw.confidence) || raw.confidence < 0 || raw.confidence > 1) {
    return { ok: false, reason: "bad_confidence" };
  }
  if (!isFiniteNumber(raw.timestamp)) return { ok: false, reason: "bad_timestamp" };
  if (options.nowWallMs !== undefined && raw.timestamp > options.nowWallMs + ENVIRONMENT_FUTURE_TOLERANCE_MS) {
    return { ok: false, reason: "future_timestamp" };
  }
  if (!isTimingPrecision(raw.timingPrecision)) return { ok: false, reason: "bad_timing_precision" };

  const payload = raw.payload as EnvironmentEventInputPayload | null | undefined;
  if (payload === null || typeof payload !== "object") return { ok: false, reason: "unknown_payload_kind" };

  // title/text 在这里被剥离：规范化结果的类型里根本没有它们的容身之处。
  switch (payload.kind) {
    case "foreground_changed":
      if (!isBoundedString(payload.process, ENVIRONMENT_FIELD_LIMITS.process)) {
        return { ok: false, reason: "bad_payload_field" };
      }
      return build(raw, options, { kind: "foreground_changed", process: payload.process });
    case "screen_keyword":
      if (!isBoundedString(payload.keyword, ENVIRONMENT_FIELD_LIMITS.keyword)) {
        return { ok: false, reason: "bad_payload_field" };
      }
      return build(raw, options, { kind: "screen_keyword", keyword: payload.keyword });
    case "game_event":
      if (!isBoundedString(payload.event, ENVIRONMENT_FIELD_LIMITS.keyword)) {
        return { ok: false, reason: "bad_payload_field" };
      }
      return build(raw, options, { kind: "game_event", event: payload.event });
    case "notification":
      if (!isBoundedString(payload.app, ENVIRONMENT_FIELD_LIMITS.app)) {
        return { ok: false, reason: "bad_payload_field" };
      }
      return build(raw, options, { kind: "notification", app: payload.app });
    case "idle_changed":
      if (!isFiniteNumber(payload.idleSeconds) || payload.idleSeconds < 0) {
        return { ok: false, reason: "bad_payload_field" };
      }
      return build(raw, options, { kind: "idle_changed", idleSeconds: payload.idleSeconds });
    default:
      return { ok: false, reason: "unknown_payload_kind" };
  }
}

function build(
  raw: EnvironmentEventInput,
  options: { sourceId: string; receivedMonotonicMs: number },
  payload: EnvironmentEventPayload,
): NormalizeResult {
  return {
    ok: true,
    event: {
      schemaVersion: ENVIRONMENT_SCHEMA_VERSION,
      sourceId: raw.sourceId,
      eventId: raw.eventId,
      hostEpoch: raw.hostEpoch,
      timestamp: raw.timestamp,
      receivedMonotonicMs: options.receivedMonotonicMs,
      timingPrecision: raw.timingPrecision,
      confidence: raw.confidence,
      payload,
    },
  };
}

/** 事件来自固定词表时，词表 ID 就是消费方（FE-19/21/22）唯一可见的文本线索。 */
export function eventRuleId(payload: EnvironmentEventPayload): string | null {
  switch (payload.kind) {
    case "screen_keyword":
      return payload.keyword;
    case "game_event":
      return payload.event;
    default:
      return null;
  }
}
