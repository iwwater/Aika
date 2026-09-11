import { describe, expect, it } from "vitest";
import {
  digestText, redactEndpoint, redactTraceEvent, sortTraceEvents, TRACE_SCHEMA_VERSION,
  type TraceEventV1,
} from "./trace";

const AT = 1_700_000_000_000;

function turnStart(text: string | null): TraceEventV1 {
  return {
    schemaVersion: TRACE_SCHEMA_VERSION, turnId: "t1", seq: 1, at: AT,
    kind: "turn_start", source: "text", mode: "daily", text,
  };
}

function providerRequest(endpoint: string): TraceEventV1 {
  return {
    schemaVersion: TRACE_SCHEMA_VERSION, turnId: "t1", seq: 2, at: AT + 10,
    kind: "provider_request", protocol: "openai-compatible", model: "qwen-plus",
    endpoint, requestChars: 1234,
  };
}

describe("redactEndpoint", () => {
  it("整段 query 都砍掉：Gemini 把 key 放在 ?key= 里", () => {
    const redacted = redactEndpoint("https://generativelanguage.googleapis.com/v1beta/models?key=SECRET123");
    expect(redacted).not.toContain("SECRET123");
    expect(redacted).not.toContain("?");
    expect(redacted).toContain("/v1beta/models");
  });

  it("不靠「认识 key 参数名」：其他参数一并去掉", () => {
    // 需要维护一张「哪家把 key 放哪个参数」的清单，就一定会漏
    expect(redactEndpoint("https://api.example.com/v1/chat?token=abc&x=1")).toBe("https://api.example.com/v1/chat");
  });

  it("URL 里的用户名密码也不留", () => {
    expect(redactEndpoint("https://user:pass@api.example.com/v1")).not.toContain("pass");
  });

  it("解析不了的串退回到 ? 之前那一截，不抛", () => {
    expect(redactEndpoint("不是URL?key=SECRET")).toBe("不是URL");
    expect(redactEndpoint("")).toBe("");
  });
});

describe("redactTraceEvent", () => {
  it("默认不带正文：turn_start.text 变 null，而不是空串", () => {
    const redacted = redactTraceEvent(turnStart("今天有点累"));
    expect(redacted.kind).toBe("turn_start");
    // null 与 "" 必须分得开：一个是「没记」，一个是「用户真的什么都没说」。
    if (redacted.kind === "turn_start") expect(redacted.text).toBeNull();
  });

  it("显式允许正文时原样保留", () => {
    const kept = redactTraceEvent(turnStart("今天有点累"), { includeText: true });
    if (kept.kind === "turn_start") expect(kept.text).toBe("今天有点累");
  });

  it("instructions 摘要同样受开关控制", () => {
    const event: TraceEventV1 = {
      schemaVersion: TRACE_SCHEMA_VERSION, turnId: "t1", seq: 2, at: AT,
      kind: "context_assemble", estimatedTokens: 900, droppedSources: [],
      historyDropped: 0, historyRepaired: 0, retrievedSources: ["memory"],
      instructionsChars: 4096, instructionsDigest: "你是…",
    };
    const off = redactTraceEvent(event);
    const on = redactTraceEvent(event, { includeText: true });
    if (off.kind === "context_assemble") expect(off.instructionsDigest).toBeNull();
    if (on.kind === "context_assemble") expect(on.instructionsDigest).toBe("你是…");
  });

  it("endpoint 的 query 无论开关都要砍掉", () => {
    for (const policy of [{ includeText: false }, { includeText: true }]) {
      const redacted = redactTraceEvent(providerRequest("https://api.example.com/v1?key=SECRET"), policy);
      expect(JSON.stringify(redacted)).not.toContain("SECRET");
    }
  });

  it("整个事件序列化之后搜不到密钥值——因为压根没有字段可放", () => {
    const events = [turnStart("今天有点累"), providerRequest("https://api.example.com/v1?key=sk-REAL-KEY")];
    const json = JSON.stringify(events.map((event) => redactTraceEvent(event)));
    expect(json).not.toContain("sk-REAL-KEY");
    expect(json).not.toContain("apiKey");
  });
});

describe("digestText", () => {
  it("压掉空白并截断，留得出是哪一轮", () => {
    expect(digestText("  今天   有点累  ")).toBe("今天 有点累");
    expect(digestText("啊".repeat(100), 10)).toBe(`${"啊".repeat(10)}…`);
  });

  it("刚好到上限不加省略号", () => {
    expect(digestText("12345", 5)).toBe("12345");
  });
});

describe("sortTraceEvents", () => {
  it("同轮按 seq，跨轮按时刻", () => {
    const events = [
      { ...turnStart(null), turnId: "t2", seq: 2, at: AT + 300 },
      { ...turnStart(null), turnId: "t1", seq: 2, at: AT + 200 },
      { ...turnStart(null), turnId: "t2", seq: 1, at: AT + 250 },
      { ...turnStart(null), turnId: "t1", seq: 1, at: AT + 100 },
    ];
    expect(sortTraceEvents(events).map((event) => `${event.turnId}#${event.seq}`))
      .toEqual(["t1#1", "t1#2", "t2#1", "t2#2"]);
  });

  it("不改原数组", () => {
    const events = [{ ...turnStart(null), seq: 2 }, { ...turnStart(null), seq: 1 }];
    sortTraceEvents(events);
    expect(events.map((event) => event.seq)).toEqual([2, 1]);
  });
});
