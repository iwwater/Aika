/**
 * Trace 事件流 → 工作台看得懂的形状。
 *
 * 这里是唯一有判断的地方（缺事件怎么算、耗时从哪减到哪、未结束的轮次怎么处理），
 * 所以它是纯函数并且单测覆盖；页面只负责把结果画出来。
 *
 * 一条贯穿本文件的规矩：**缺失就是 null，不是 0**。「没有首 token」和「首 token
 * 零毫秒」在排查卡顿时是完全相反的结论。
 */

import { sortTraceEvents, type TraceEventKind, type TraceEventV1, type TraceTurnStatus } from "./trace";

export interface TraceTurnSummary {
  turnId: string;
  /** 轮次开始时刻。没有 turn_start 时退回该轮最早事件的时刻。 */
  startedAt: number;
  /** null = 这一轮还没结束（或结束事件没落下来）。 */
  status: TraceTurnStatus | null;
  durationMs: number | null;
  firstTokenMs: number | null;
  chunks: number | null;
  estimatedPromptTokens: number | null;
  reportedTokens: number | null;
  errorCode: string | null;
  model: string | null;
  /** 这一轮记到了哪些种类的事件，按发生顺序。 */
  kinds: TraceEventKind[];
  eventCount: number;
}

export interface TraceStep {
  seq: number;
  kind: TraceEventKind;
  /** 相对这一轮开始的偏移。 */
  offsetMs: number;
  event: TraceEventV1;
}

/** 按轮次分组，最近的在前。 */
export function groupTurns(events: readonly TraceEventV1[]): TraceTurnSummary[] {
  const byTurn = new Map<string, TraceEventV1[]>();
  for (const event of sortTraceEvents(events)) {
    const bucket = byTurn.get(event.turnId);
    if (bucket) bucket.push(event);
    else byTurn.set(event.turnId, [event]);
  }
  return [...byTurn.values()]
    .map((turnEvents) => summarize(turnEvents))
    .sort((left, right) => right.startedAt - left.startedAt);
}

function summarize(turnEvents: readonly TraceEventV1[]): TraceTurnSummary {
  const start = turnEvents.find((event) => event.kind === "turn_start");
  const end = turnEvents.find((event) => event.kind === "turn_end");
  const stream = turnEvents.find((event) => event.kind === "provider_stream_meta");
  const request = turnEvents.find((event) => event.kind === "provider_request");
  const assemble = turnEvents.find((event) => event.kind === "context_assemble");

  return {
    turnId: turnEvents[0].turnId,
    // 没有 turn_start 也要能显示：Trace 中途打开时会只看到后半截。
    startedAt: start?.at ?? turnEvents[0].at,
    status: end?.kind === "turn_end" ? end.status : null,
    durationMs: end?.kind === "turn_end" ? end.durationMs : null,
    firstTokenMs: stream?.kind === "provider_stream_meta" ? stream.firstTokenMs : null,
    chunks: stream?.kind === "provider_stream_meta" ? stream.chunks : null,
    estimatedPromptTokens: assemble?.kind === "context_assemble"
      ? assemble.estimatedTokens
      : end?.kind === "turn_end" ? end.tokens.estimatedPrompt : null,
    reportedTokens: end?.kind === "turn_end" ? end.tokens.reportedTotal : null,
    errorCode: end?.kind === "turn_end" ? end.errorCode ?? null : null,
    model: request?.kind === "provider_request" ? request.model : null,
    kinds: turnEvents.map((event) => event.kind),
    eventCount: turnEvents.length,
  };
}

/** 单轮详情：按 seq 升序，带相对偏移。 */
export function turnSteps(events: readonly TraceEventV1[], turnId: string): TraceStep[] {
  const turnEvents = sortTraceEvents(events.filter((event) => event.turnId === turnId));
  if (!turnEvents.length) return [];
  const startedAt = turnEvents.find((event) => event.kind === "turn_start")?.at ?? turnEvents[0].at;
  return turnEvents.map((event) => ({
    seq: event.seq,
    kind: event.kind,
    offsetMs: event.at - startedAt,
    event,
  }));
}

/** 这一轮跑完了吗。未结束的轮次仍然要显示——静默丢掉等于把「卡住了」藏起来。 */
export function isUnfinished(summary: TraceTurnSummary): boolean {
  return summary.status === null;
}

/** 原始视图：一行一个事件，每行都能被 JSON.parse 读回来。 */
export function toJsonl(events: readonly TraceEventV1[]): string {
  return sortTraceEvents(events).map((event) => JSON.stringify(event)).join("\n");
}

const KIND_LABELS: Record<TraceEventKind, string> = {
  turn_start: "开始",
  context_assemble: "组装上下文",
  context_snapshot: "上下文快照",
  provider_request: "发出请求",
  provider_stream_meta: "流式统计",
  reply: "回包",
  memory_extract: "记忆抽取",
  tts: "语音播放",
  turn_end: "结束",
};

export function kindLabel(kind: TraceEventKind): string {
  return KIND_LABELS[kind] ?? kind;
}

const STATUS_LABELS: Record<TraceTurnStatus, string> = {
  completed: "完成",
  failed: "失败",
  cancelled: "取消",
};

export function statusLabel(status: TraceTurnStatus | null): string {
  return status === null ? "未结束" : STATUS_LABELS[status];
}

// ---------------------------------------------------------------------------
// 泳道时间线（FE-24）。
//
// 只有**真实起止配对**才产生耗时数字：turn_end.durationMs（采集端计的总耗时）
// 与 provider_stream_meta.firstTokenMs（当前采集测点的首 token）。除此之外
// 一律是「相邻事件差」= 阶段间隔，不能冒充模型或工具耗时；缺 turn_end 就没有
// 总耗时；负时钟差不显示任何数字——宁缺毋假。
// ---------------------------------------------------------------------------

export interface TurnTimelineStage {
  kind: TraceEventKind;
  seq: number;
  /** 与上一事件的差（阶段间隔，非工作耗时）；负时钟差时为 null。首个事件为 0。 */
  intervalMs: number | null;
}

export interface TurnTimeline {
  turnId: string;
  status: TraceTurnStatus | "running";
  /** 真实配对的测得总耗时；缺 turn_end 为 null，绝不从相邻差补算。 */
  totalMs: number | null;
  /** 首个 token 的采集测点耗时；null = 未知。不补算平台 TTFB。 */
  firstTokenMs: number | null;
  /** 首可见正文（reply 事件）相对 turn_start 的间隔。与首字节分开命名，不是 TTFT。 */
  replyIntervalMs: number | null;
  stages: TurnTimelineStage[];
  usage: { estimatedPrompt: number | null; reportedTotal: number | null };
}

export function buildTurnTimeline(allEvents: readonly TraceEventV1[], turnId: string): TurnTimeline | null {
  // 重复吞掉（同 turnId+seq 只留一条），乱序由排序修复（AC-A）。
  const byKey = new Map<string, TraceEventV1>();
  for (const event of allEvents) {
    if (event.turnId !== turnId) continue;
    byKey.set(`${event.turnId}:${event.seq}`, event);
  }
  const turnEvents = sortTraceEvents([...byKey.values()]);
  if (!turnEvents.length) return null;

  let previousAt: number | null = null;
  const stages: TurnTimelineStage[] = turnEvents.map((event) => {
    const intervalMs = previousAt === null ? 0 : event.at - previousAt;
    previousAt = event.at;
    // 负时钟差（时钟回拨/乱序落盘）不给数字：宁缺毋假。
    return { kind: event.kind, seq: event.seq, intervalMs: intervalMs < 0 ? null : intervalMs };
  });

  const end = turnEvents.find((event) => event.kind === "turn_end");
  const start = turnEvents.find((event) => event.kind === "turn_start");
  const stream = turnEvents.find((event) => event.kind === "provider_stream_meta");
  const reply = turnEvents.find((event) => event.kind === "reply");
  const assemble = turnEvents.find((event) => event.kind === "context_assemble");
  const replyIntervalMs = reply && start ? reply.at - start.at : null;

  return {
    turnId,
    status: end?.kind === "turn_end" ? end.status : "running",
    totalMs: end?.kind === "turn_end" ? end.durationMs : null,
    firstTokenMs: stream?.kind === "provider_stream_meta" ? stream.firstTokenMs : null,
    replyIntervalMs: replyIntervalMs !== null && replyIntervalMs >= 0 ? replyIntervalMs : null,
    stages,
    usage: {
      estimatedPrompt: assemble?.kind === "context_assemble"
        ? assemble.estimatedTokens
        : end?.kind === "turn_end" ? end.tokens.estimatedPrompt : null,
      reportedTotal: end?.kind === "turn_end" ? end.tokens.reportedTotal : null,
    },
  };
}
