import { describe, expect, it } from "vitest";
import { TRACE_SCHEMA_VERSION, type TraceEventV1 } from "./trace";
import { capabilityCalls, OUTCOME_LABELS, type CapabilityCall } from "./capabilityView";

const AT = 1_700_000_000_000;

function base(turnId: string, seq: number) {
  return { schemaVersion: TRACE_SCHEMA_VERSION as 1, turnId, seq, at: AT + seq };
}

function assemble(turnId: string, patch: Partial<Extract<TraceEventV1, { kind: "context_assemble" }>> = {}): TraceEventV1 {
  return {
    ...base(turnId, 2), kind: "context_assemble", estimatedTokens: 900,
    droppedSources: [], historyDropped: 0, historyRepaired: 0, retrievedSources: [],
    ...patch,
  };
}

function reply(turnId: string, patch: Partial<Extract<TraceEventV1, { kind: "reply" }>> = {}): TraceEventV1 {
  return {
    ...base(turnId, 5), kind: "reply", mood: "calm", replyChars: 42, translationChars: 0,
    translationDuplicatesReply: false, sticker: null, actions: [],
    ...patch,
  };
}

function memory(turnId: string, patch: Partial<Extract<TraceEventV1, { kind: "memory_extract" }>> = {}): TraceEventV1 {
  return { ...base(turnId, 6), kind: "memory_extract", candidates: 0, failed: false, ...patch };
}

function tts(turnId: string, patch: Partial<Extract<TraceEventV1, { kind: "tts" }>> = {}): TraceEventV1 {
  return { ...base(turnId, 7), kind: "tts", sentences: 0, played: false, errorCount: 0, ...patch };
}

function pick(calls: readonly CapabilityCall[], capability: string): CapabilityCall {
  const found = calls.find((call) => call.capability === capability);
  if (!found) throw new Error(`没有这一项能力：${capability}`);
  return found;
}

describe("capabilityCalls", () => {
  it("六项能力按固定顺序给出，一项都不少", () => {
    // 顺序固定是页面能横向对比两轮的前提：同一行永远是同一项能力。
    expect(capabilityCalls([], "t1").map((call) => call.capability)).toEqual([
      "上下文检索", "来源降级", "表情包", "双语回包", "记忆抽取", "语音播放",
    ]);
  });

  it("事件齐全时每项取自对应事件（FE-10-A）", () => {
    const events = [
      assemble("t1", {
        estimatedTokens: 1200,
        retrievedSources: ["memory", "knowledge"],
        droppedSources: [{ source: "environment", section: "environment", reason: "timeout" }],
      }),
      reply("t1", { replyChars: 88, translationChars: 71, sticker: "smile", actions: ["sticker"] }),
      memory("t1", { candidates: 3 }),
      tts("t1", { sentences: 4, played: true }),
    ];

    const calls = capabilityCalls(events, "t1");

    expect(pick(calls, "上下文检索")).toMatchObject({
      outcome: "ok",
      detail: "注入 2 个来源，估算 1200 token",
      items: ["memory", "knowledge"],
    });
    expect(pick(calls, "来源降级")).toMatchObject({
      outcome: "degraded",
      items: ["environment · environment · 来源超时"],
    });
    expect(pick(calls, "表情包")).toMatchObject({ outcome: "ok", detail: "挑了 smile", items: ["sticker"] });
    expect(pick(calls, "双语回包")).toMatchObject({ outcome: "ok", detail: "正文 88 字 · 翻译 71 字" });
    expect(pick(calls, "记忆抽取")).toMatchObject({ outcome: "ok", detail: "抽出 3 条候选" });
    expect(pick(calls, "语音播放")).toMatchObject({ outcome: "ok", detail: "4 句 · 播过" });
  });

  it("「未发生」与「空结果」分得开（FE-10-A）", () => {
    // 这一条是整份 SPEC 的核心分界：没有 memory_extract 事件是「这一轮压根没跑抽取」，
    // candidates: 0 是「跑了但一条都没抽出来」——排查方向完全相反。
    const ran = pick(capabilityCalls([memory("t1", { candidates: 0 })], "t1"), "记忆抽取");
    const never = pick(capabilityCalls([], "t1"), "记忆抽取");

    expect(ran.outcome).toBe("empty");
    expect(ran.detail).toBe("跑了，但一条候选都没有");
    expect(never.outcome).toBe("absent");
    expect(never.detail).toBe("这一轮没有发生");
    expect(OUTCOME_LABELS[never.outcome]).toBe("未发生");
    expect(OUTCOME_LABELS[ran.outcome]).toBe("空结果");
  });

  it("缺事件的那几项标 absent，其余照常判定", () => {
    // 只有 reply：检索、降级、记忆、语音都没发生，但表情包与双语回包要如实给结论。
    const calls = capabilityCalls([reply("t1", { sticker: "wink" })], "t1");

    expect(calls.filter((call) => call.outcome === "absent").map((call) => call.capability))
      .toEqual(["上下文检索", "来源降级", "记忆抽取", "语音播放"]);
    expect(pick(calls, "表情包").outcome).toBe("ok");
  });

  it("检索到 0 个来源是空结果，不是未发生", () => {
    const calls = capabilityCalls([assemble("t1", { estimatedTokens: 700 })], "t1");

    expect(pick(calls, "上下文检索")).toMatchObject({
      outcome: "empty",
      detail: "没有注入任何来源，估算 700 token",
      items: [],
    });
    // 装配跑过且一个都没丢，是「正常」——与「没装配过」不同。
    expect(pick(calls, "来源降级")).toMatchObject({ outcome: "ok", detail: "没有来源被丢掉" });
  });

  it("丢弃原因翻成中文，未知原因原样显示", () => {
    const calls = capabilityCalls([
      assemble("t1", {
        droppedSources: [
          { source: "knowledge", section: "knowledge", reason: "trimmed" },
          { source: "history", section: "history", reason: "cancelled" },
          // 旧版本写进库里的原因可能已不在当前 union 里，不能因此丢掉这一条。
          { source: "legacy", section: "summary", reason: "obsolete" as never },
        ],
      }),
    ], "t1");

    expect(pick(calls, "来源降级")).toMatchObject({
      outcome: "degraded",
      detail: "3 个来源没进上下文",
      items: [
        "knowledge · knowledge · 超预算被裁",
        "history · history · 已取消",
        "legacy · summary · obsolete",
      ],
    });
  });

  it("正文与翻译同句这一轮被显式标成退化（FE-10-B）", () => {
    const degraded = pick(
      capabilityCalls([reply("t1", { translationChars: 42, translationDuplicatesReply: true })], "t1"),
      "双语回包",
    );

    expect(degraded.outcome).toBe("degraded");
    expect(degraded.detail).toBe("正文与翻译是同一句（语义退化）");
    expect(OUTCOME_LABELS[degraded.outcome]).toBe("降级");
  });

  it("没有翻译是空结果，不是退化", () => {
    const call = pick(capabilityCalls([reply("t1", { replyChars: 42 })], "t1"), "双语回包");

    expect(call.outcome).toBe("empty");
    expect(call.detail).toBe("正文 42 字 · 没有翻译");
  });

  it("没挑表情包是空结果；actions 如实带出", () => {
    const calls = capabilityCalls([reply("t1", { sticker: null, actions: [] })], "t1");

    expect(pick(calls, "表情包")).toMatchObject({ outcome: "empty", detail: "这一轮没挑表情包", items: [] });
  });

  it("记忆抽取失败与抽不到分开", () => {
    const failed = pick(capabilityCalls([memory("t1", { candidates: 0, failed: true })], "t1"), "记忆抽取");

    expect(failed.outcome).toBe("failed");
    expect(failed.detail).toBe("抽取失败");
  });

  it("语音：播过、没播出、部分失败三种结论不同", () => {
    const played = pick(capabilityCalls([tts("t1", { sentences: 3, played: true })], "t1"), "语音播放");
    const silent = pick(capabilityCalls([tts("t1", { sentences: 3, played: false })], "t1"), "语音播放");
    const partial = pick(
      capabilityCalls([tts("t1", { sentences: 3, played: true, errorCount: 1 })], "t1"),
      "语音播放",
    );

    expect(played.outcome).toBe("ok");
    expect(silent).toMatchObject({ outcome: "failed", detail: "3 句 · 没播出来" });
    expect(partial).toMatchObject({ outcome: "degraded", detail: "3 句 · 播过 · 失败 1 句" });
  });

  it("只看这一轮的事件，别轮的不串台", () => {
    const events = [
      reply("t1", { sticker: "smile" }),
      reply("t2", { sticker: "cry" }),
      memory("t2", { candidates: 9 }),
    ];

    expect(pick(capabilityCalls(events, "t1"), "表情包").detail).toBe("挑了 smile");
    // t1 没有 memory_extract，即使 t2 有也不能算到 t1 头上。
    expect(pick(capabilityCalls(events, "t1"), "记忆抽取").outcome).toBe("absent");
    expect(pick(capabilityCalls(events, "t2"), "记忆抽取").detail).toBe("抽出 9 条候选");
  });

  it("每种结论都有中文标签", () => {
    expect(Object.values(OUTCOME_LABELS)).toEqual(["正常", "空结果", "降级", "失败", "未发生"]);
  });
});
