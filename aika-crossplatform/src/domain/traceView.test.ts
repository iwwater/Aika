import { describe, expect, it } from "vitest";
import { TRACE_SCHEMA_VERSION, type TraceEventV1 } from "./trace";
import { groupTurns, isUnfinished, kindLabel, statusLabel, toJsonl, turnSteps } from "./traceView";

const AT = 1_700_000_000_000;

function base(turnId: string, seq: number, at: number) {
  return { schemaVersion: TRACE_SCHEMA_VERSION as 1, turnId, seq, at };
}

function fullTurn(turnId: string, startedAt: number): TraceEventV1[] {
  return [
    { ...base(turnId, 1, startedAt), kind: "turn_start", source: "text", mode: "daily", text: null },
    {
      ...base(turnId, 2, startedAt + 10), kind: "context_assemble", estimatedTokens: 900,
      droppedSources: [], historyDropped: 0, historyRepaired: 0, retrievedSources: ["memory"],
    },
    {
      ...base(turnId, 3, startedAt + 20), kind: "provider_request", protocol: "openai-compatible",
      model: "qwen-plus", endpoint: "https://api.example.com/v1/chat/completions",
      requestChars: 2048, instructionsChars: 4096, instructionsDigest: null,
    },
    { ...base(turnId, 4, startedAt + 400), kind: "provider_stream_meta", firstTokenMs: 380, chunks: 7 },
    {
      ...base(turnId, 5, startedAt + 900), kind: "turn_end", status: "completed",
      durationMs: 900, tokens: { estimatedPrompt: 900, reportedTotal: null },
    },
  ];
}

describe("groupTurns", () => {
  it("一轮的摘要取自各自的事件", () => {
    const [summary] = groupTurns(fullTurn("t1", AT));

    expect(summary).toMatchObject({
      turnId: "t1",
      startedAt: AT,
      status: "completed",
      durationMs: 900,
      firstTokenMs: 380,
      chunks: 7,
      estimatedPromptTokens: 900,
      model: "qwen-plus",
      errorCode: null,
      eventCount: 5,
    });
    // 不知道就是 null：provider 还没上报 usage。
    expect(summary.reportedTokens).toBeNull();
  });

  it("最近的轮次在前", () => {
    const events = [...fullTurn("old", AT), ...fullTurn("new", AT + 10_000)];
    expect(groupTurns(events).map((summary) => summary.turnId)).toEqual(["new", "old"]);
  });

  it("缺事件时对应字段是 null，不是 0", () => {
    // 只有 turn_start：既没有流式统计也没有结束
    const [summary] = groupTurns([
      { ...base("t1", 1, AT), kind: "turn_start", source: "text", mode: "daily", text: null },
    ]);

    expect(summary.firstTokenMs).toBeNull();
    expect(summary.chunks).toBeNull();
    expect(summary.durationMs).toBeNull();
    expect(summary.status).toBeNull();
    expect(summary.model).toBeNull();
    expect(summary.estimatedPromptTokens).toBeNull();
  });

  it("没结束的轮次照样出现在列表里，标为未结束", () => {
    const events = [
      ...fullTurn("done", AT),
      { ...base("stuck", 1, AT + 5000), kind: "turn_start" as const, source: "text" as const, mode: "daily", text: null },
    ];
    const summaries = groupTurns(events);

    expect(summaries.map((summary) => summary.turnId)).toEqual(["stuck", "done"]);
    expect(isUnfinished(summaries[0])).toBe(true);
    expect(statusLabel(summaries[0].status)).toBe("未结束");
    expect(isUnfinished(summaries[1])).toBe(false);
  });

  it("Trace 中途打开：没有 turn_start 也能显示，开始时刻退回最早那条", () => {
    const [summary] = groupTurns([
      { ...base("t1", 4, AT + 400), kind: "provider_stream_meta", firstTokenMs: 380, chunks: 7 },
      {
        ...base("t1", 5, AT + 900), kind: "turn_end", status: "failed", errorCode: "PROVIDER_FAILED",
        durationMs: 900, tokens: { estimatedPrompt: null, reportedTotal: null },
      },
    ]);

    expect(summary.startedAt).toBe(AT + 400);
    expect(summary.status).toBe("failed");
    expect(summary.errorCode).toBe("PROVIDER_FAILED");
  });

  it("失败轮带错误码", () => {
    const events = fullTurn("t1", AT);
    events[4] = {
      ...base("t1", 5, AT + 900), kind: "turn_end", status: "failed", errorCode: "UPSTREAM_429",
      durationMs: 900, tokens: { estimatedPrompt: 900, reportedTotal: null },
    };
    expect(groupTurns(events)[0].errorCode).toBe("UPSTREAM_429");
  });
});

describe("turnSteps", () => {
  it("按 seq 升序，偏移是相对轮次开始", () => {
    const steps = turnSteps(fullTurn("t1", AT), "t1");

    expect(steps.map((step) => step.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(steps.map((step) => step.offsetMs)).toEqual([0, 10, 20, 400, 900]);
    expect(steps.map((step) => step.kind)).toEqual([
      "turn_start", "context_assemble", "provider_request", "provider_stream_meta", "turn_end",
    ]);
  });

  it("只取这一轮的事件", () => {
    const events = [...fullTurn("t1", AT), ...fullTurn("t2", AT + 1000)];
    expect(turnSteps(events, "t2").every((step) => step.event.turnId === "t2")).toBe(true);
  });

  it("没有这一轮就是空数组", () => {
    expect(turnSteps(fullTurn("t1", AT), "不存在")).toEqual([]);
  });
});

describe("toJsonl", () => {
  it("一行一个事件，每行都能 JSON.parse 回来", () => {
    const events = fullTurn("t1", AT);
    const lines = toJsonl(events).split("\n");

    expect(lines).toHaveLength(5);
    expect(lines.map((line) => (JSON.parse(line) as TraceEventV1).seq)).toEqual([1, 2, 3, 4, 5]);
  });

  it("空事件列表给空字符串，不给一行空白", () => {
    expect(toJsonl([])).toBe("");
  });
});

describe("标签", () => {
  it("每种事件与状态都有中文标签", () => {
    expect(kindLabel("provider_stream_meta")).toBe("流式统计");
    expect(statusLabel("completed")).toBe("完成");
    expect(statusLabel("cancelled")).toBe("取消");
  });
});
