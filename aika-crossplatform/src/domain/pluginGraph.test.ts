import { describe, expect, it } from "vitest";
import type { KernelSnapshot, PluginRecord } from "../kernel";
import { TRACE_SCHEMA_VERSION, type TraceEventV1 } from "./trace";
import {
  buildPluginGraph, layoutGraph, PLUGIN_STATUS_LABELS, turnFlow, type PluginGraph,
} from "./pluginGraph";

function plugin(id: string, patch: Partial<PluginRecord> = {}): PluginRecord {
  return {
    id, version: "1.0.0", status: "activated", requires: [], optional: [], provides: [], ...patch,
  };
}

function snapshot(plugins: PluginRecord[], services?: { key: string; providedBy: string }[]): KernelSnapshot {
  return {
    state: "ready",
    plugins,
    // 默认：已激活的插件声明提供什么，注册表里就有什么（内核的 CORE-09-C 保证）。
    services: (services ?? plugins
      .filter((record) => record.status === "activated")
      .flatMap((record) => record.provides.map((key) => ({ key, providedBy: record.id }))))
      .map((entry) => ({ ...entry, instantiated: true })),
  };
}

function edgeOf(graph: PluginGraph, from: string, token: string) {
  return graph.edges.find((edge) => edge.from === from && edge.token === token);
}

describe("buildPluginGraph", () => {
  it("边由消费者的 requires 与 services 的 providedBy 对上生成（FE-10-C）", () => {
    const graph = buildPluginGraph(snapshot([
      plugin("storage", { provides: ["service.storage"] }),
      plugin("runtime", { requires: ["service.storage"], provides: ["service.runtime"] }),
    ]));

    expect(graph.edges).toEqual([
      { from: "runtime", to: "storage", token: "service.storage", kind: "required", registered: true },
    ]);
    expect(graph.missing).toEqual([]);
  });

  it("optional 也画边，但与 required 分开标（FE-10-C）", () => {
    const graph = buildPluginGraph(snapshot([
      plugin("trace", { provides: ["service.trace"] }),
      plugin("runtime", { optional: ["service.trace"] }),
    ]));

    expect(edgeOf(graph, "runtime", "service.trace")).toMatchObject({ kind: "optional", to: "trace" });
  });

  it("没人提供的依赖进缺失清单，必选与可选分开标（FE-10-C）", () => {
    const graph = buildPluginGraph(snapshot([
      plugin("runtime", { requires: ["service.storage"], optional: ["service.voice"] }),
    ]));

    expect(graph.missing).toEqual([
      { token: "service.storage", consumers: ["runtime"], required: true },
      { token: "service.voice", consumers: ["runtime"], required: false },
    ]);
    // 缺失不能变成一条指向不存在节点的边。
    expect(graph.edges).toEqual([]);
  });

  it("同一个缺失 token 被多个插件等待时合并，只要有人 requires 就算必选", () => {
    const graph = buildPluginGraph(snapshot([
      plugin("a", { optional: ["service.voice"] }),
      plugin("b", { requires: ["service.voice"] }),
    ]));

    expect(graph.missing).toEqual([
      { token: "service.voice", consumers: ["a", "b"], required: true },
    ]);
  });

  it("未激活的插件照样在图里并带状态（FE-10-D）", () => {
    const graph = buildPluginGraph(snapshot([
      plugin("storage", { provides: ["service.storage"] }),
      plugin("voice", { status: "failed", provides: ["service.voice"] }),
      plugin("memory", { status: "rolledBack" }),
      plugin("late", { status: "pending" }),
      plugin("blocked", { status: "skipped" }),
    ]));

    expect(graph.nodes.map((node) => [node.id, node.status])).toEqual([
      ["storage", "activated"], ["voice", "failed"], ["memory", "rolledBack"],
      ["late", "pending"], ["blocked", "skipped"],
    ]);
    expect(Object.keys(PLUGIN_STATUS_LABELS).sort())
      .toEqual(["activated", "failed", "pending", "rolledBack", "skipped"]);
  });

  it("失败插件声明的服务：边还在，但标为未登记——与「没人提供」分得开（FE-10-D）", () => {
    const graph = buildPluginGraph(snapshot([
      // voice 没激活成功，所以 services 里没有 service.voice，只剩它的声明。
      plugin("voice", { status: "failed", provides: ["service.voice"] }),
      plugin("runtime", { optional: ["service.voice"] }),
    ]));

    expect(edgeOf(graph, "runtime", "service.voice")).toMatchObject({ to: "voice", registered: false });
    expect(graph.missing).toEqual([]);
  });

  it("分层：提供者在上、消费者在下", () => {
    const graph = buildPluginGraph(snapshot([
      plugin("storage", { provides: ["service.storage"] }),
      plugin("memory", { requires: ["service.storage"], provides: ["service.memory"] }),
      plugin("runtime", { requires: ["service.storage", "service.memory"] }),
    ]));

    expect(graph.layers).toEqual([["storage"], ["memory"], ["runtime"]]);
    expect(graph.nodes.map((node) => node.layer)).toEqual([0, 1, 2]);
  });

  it("自给自足的 token 不画自环，也不算缺失", () => {
    const graph = buildPluginGraph(snapshot([
      plugin("solo", { requires: ["service.solo"], provides: ["service.solo"] }),
    ]));

    expect(graph.edges).toEqual([]);
    expect(graph.missing).toEqual([]);
    expect(graph.layers).toEqual([["solo"]]);
  });

  it("有环也不栈溢出：环内一律落在 0 层", () => {
    // 内核的拓扑排序不接受环，但画图的代码不该因为一张坏图就崩掉。
    const graph = buildPluginGraph(snapshot([
      plugin("a", { requires: ["service.b"], provides: ["service.a"] }),
      plugin("b", { requires: ["service.a"], provides: ["service.b"] }),
    ]));

    expect(graph.edges).toHaveLength(2);
    expect(graph.nodes.every((node) => node.layer >= 0)).toBe(true);
  });

  it("没有内核快照时是一张空图，不是抛错", () => {
    expect(buildPluginGraph(null)).toEqual({ nodes: [], edges: [], missing: [], layers: [] });
  });
});

describe("layoutGraph", () => {
  const graph = buildPluginGraph(snapshot([
    plugin("storage", { provides: ["service.storage"] }),
    plugin("memory", { requires: ["service.storage"], provides: ["service.memory"] }),
    plugin("runtime", { requires: ["service.memory"] }),
  ]));

  it("每层一行，行内居中；边从提供者底边连到消费者顶边", () => {
    const layout = layoutGraph(graph, { nodeWidth: 100, nodeHeight: 40, gapX: 20, gapY: 40, padding: 10 });
    const at = (id: string) => layout.nodes.find((node) => node.id === id);

    expect(at("storage")).toMatchObject({ x: 10, y: 10, width: 100, height: 40 });
    expect(at("memory")).toMatchObject({ x: 10, y: 90 });
    expect(at("runtime")).toMatchObject({ x: 10, y: 170 });

    const edge = layout.edges.find((candidate) => candidate.token === "service.storage");
    expect(edge).toMatchObject({ x1: 60, y1: 50, x2: 60, y2: 90 });
  });

  it("画布大小容得下最宽的一行与所有层", () => {
    const wide = buildPluginGraph(snapshot([
      plugin("a"), plugin("b"),
      plugin("c", { requires: ["service.none"] }),
    ]));
    const layout = layoutGraph(wide, { nodeWidth: 100, nodeHeight: 40, gapX: 20, gapY: 40, padding: 10 });

    // 最宽一行是 0 层的三个节点（c 的依赖没人提供，它没有上游，仍在 0 层）。
    expect(layout.width).toBe(100 * 3 + 20 * 2 + 10 * 2);
    expect(layout.height).toBe(40 + 10 * 2);
  });

  it("空图不产生负数尺寸", () => {
    const layout = layoutGraph({ nodes: [], edges: [], missing: [], layers: [] }, { padding: 10 });
    expect(layout).toMatchObject({ width: 20, height: 20, nodes: [], edges: [] });
  });
});

// ── 一轮的数据流 ────────────────────────────────────────────────────────

const AT = 1_700_000_000_000;

function base(turnId: string, seq: number, at: number) {
  return { schemaVersion: TRACE_SCHEMA_VERSION as 1, turnId, seq, at };
}

function start(turnId: string, at = AT): TraceEventV1 {
  return { ...base(turnId, 1, at), kind: "turn_start", source: "text", mode: "daily", text: null };
}

describe("turnFlow", () => {
  it("按实际事件点亮阶段，缺事件的标未走到（FE-10-E）", () => {
    const flow = turnFlow([
      start("t1"),
      {
        ...base("t1", 2, AT + 12), kind: "context_assemble", estimatedTokens: 900,
        droppedSources: [], historyDropped: 0, historyRepaired: 0, retrievedSources: ["memory"],
      },
    ], "t1");

    expect(flow.stages.map((stage) => [stage.kind, stage.state])).toEqual([
      ["turn_start", "done"],
      ["context_assemble", "done"],
      ["provider_request", "notReached"],
      ["provider_stream_meta", "notReached"],
      ["reply", "notReached"],
      ["memory_extract", "notReached"],
      ["tts", "notReached"],
      ["turn_end", "notReached"],
    ]);
    expect(flow.stages[1]).toMatchObject({ label: "组装上下文", detail: "≈900 token · 来源 1 · 丢弃 0", offsetMs: 12 });
    // 没走到就是 null，不是 0——「零毫秒完成」和「压根没跑」是相反的结论。
    expect(flow.stages[2].offsetMs).toBeNull();
    expect(flow.stages[2].detail).toBe("未走到");
  });

  it("失败轮能看出停在哪一步（FE-10-E）", () => {
    const flow = turnFlow([
      start("t1"),
      {
        ...base("t1", 2, AT + 10), kind: "provider_request", protocol: "openai-compatible",
        model: "qwen-plus", endpoint: "https://api.example.com/v1/chat/completions",
        requestChars: 10, instructionsChars: 20, instructionsDigest: null,
      },
      {
        ...base("t1", 3, AT + 900), kind: "turn_end", status: "failed", durationMs: 900,
        errorCode: "PROVIDER_TIMEOUT", tokens: { estimatedPrompt: null, reportedTotal: null },
      },
    ], "t1");

    expect(flow.status).toBe("failed");
    // 停在「发出请求」之后：请求发出去了，回包这一步没走到。
    expect(flow.stoppedAfter).toBe("发出请求");
    expect(flow.lastReached).toBe("turn_end");
    const end = flow.stages.find((stage) => stage.kind === "turn_end");
    expect(end).toMatchObject({ state: "failed", detail: "失败 · 900ms · PROVIDER_TIMEOUT" });
    expect(flow.stages.find((stage) => stage.kind === "reply")?.state).toBe("notReached");
  });

  it("完成的轮次没有「停在哪」这一说", () => {
    const flow = turnFlow([
      start("t1"),
      {
        ...base("t1", 2, AT + 500), kind: "turn_end", status: "completed", durationMs: 500,
        tokens: { estimatedPrompt: 900, reportedTotal: null },
      },
    ], "t1");

    expect(flow.stoppedAfter).toBeNull();
    expect(flow.stages.find((stage) => stage.kind === "turn_end")?.state).toBe("done");
  });

  it("还没结束的轮次：状态为 null，但看得出走到哪了", () => {
    const flow = turnFlow([
      start("t1"),
      { ...base("t1", 2, AT + 300), kind: "provider_stream_meta", firstTokenMs: 280, chunks: 4 },
    ], "t1");

    expect(flow.status).toBeNull();
    expect(flow.stoppedAfter).toBe("流式统计");
  });

  it("取消的轮次同样指出停在哪", () => {
    const flow = turnFlow([
      start("t1"),
      {
        ...base("t1", 2, AT + 100), kind: "reply", mood: "calm", replyChars: 12, translationChars: 0,
        translationDuplicatesReply: false, sticker: null, actions: [],
      },
      {
        ...base("t1", 3, AT + 200), kind: "turn_end", status: "cancelled", durationMs: 200,
        tokens: { estimatedPrompt: null, reportedTotal: null },
      },
    ], "t1");

    expect(flow.stoppedAfter).toBe("回包");
    // 取消不是失败：结束这一步照常算走到了。
    expect(flow.stages.find((stage) => stage.kind === "turn_end")?.state).toBe("done");
  });

  it("退化的回包在数据流上也看得见", () => {
    const flow = turnFlow([
      start("t1"),
      {
        ...base("t1", 2, AT + 100), kind: "reply", mood: "calm", replyChars: 12, translationChars: 12,
        translationDuplicatesReply: true, sticker: null, actions: [],
      },
    ], "t1");

    expect(flow.stages.find((stage) => stage.kind === "reply")?.detail).toBe("12 字 · 正文与翻译同句");
  });

  it("没有 turn_start 也能算偏移：退回该轮最早的事件", () => {
    // Trace 中途打开时只看得到后半截，这时候仍要能画。
    const flow = turnFlow([
      { ...base("t1", 4, AT + 50), kind: "provider_stream_meta", firstTokenMs: null, chunks: 0 },
      {
        ...base("t1", 5, AT + 90), kind: "turn_end", status: "completed", durationMs: 90,
        tokens: { estimatedPrompt: null, reportedTotal: null },
      },
    ], "t1");

    expect(flow.stages.find((stage) => stage.kind === "provider_stream_meta"))
      .toMatchObject({ offsetMs: 0, detail: "首 token — · 0 chunk" });
    expect(flow.stages.find((stage) => stage.kind === "turn_end")?.offsetMs).toBe(40);
  });

  it("只看这一轮：别轮的事件不点亮本轮阶段", () => {
    const flow = turnFlow([start("t1"), start("t2"), {
      ...base("t2", 2, AT + 10), kind: "memory_extract", candidates: 2, failed: false,
    }], "t1");

    expect(flow.stages.find((stage) => stage.kind === "memory_extract")?.state).toBe("notReached");
  });

  it("空轮次：全部未走到，lastReached 为 null", () => {
    const flow = turnFlow([], "t1");

    expect(flow.stages.every((stage) => stage.state === "notReached")).toBe(true);
    expect(flow.lastReached).toBeNull();
    expect(flow.stoppedAfter).toBeNull();
  });
});
