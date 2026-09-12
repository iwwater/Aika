/**
 * 两张数据流图的判定（F6）。
 *
 * ① **装配拓扑**：从 `kernel.describe()` 现算——节点是插件、边是「消费者的
 *    requires/optional」与「services 的 providedBy」对上的结果。手画的拓扑图迟早
 *    和实际装配不一致，从注册表现算是这张图唯一的价值（CORE-09 就是为它做的）。
 * ② **一轮的数据流**：按这一轮**实际发生**的事件点亮阶段，没发生的标「未走到」。
 *
 * 两条贯穿本文件的规矩：
 * - **没人提供的依赖要列出来**，不能当作不存在。「能力缺失即 token 不注册」是本
 *   仓库的常态，看不见缺了什么等于看不见一半装配。
 * - **未激活的插件照样进图**（pending / failed / rolledBack / skipped）并带状态：
 *   「谁没装上」恰恰是最需要看见的。
 *
 * 布局也在这里：页面只负责把算好的坐标画成 SVG，不做任何判断。
 */

import type { KernelSnapshot, PluginStatus } from "../kernel";
import { sortTraceEvents, type TraceEventKind, type TraceEventV1, type TraceTurnStatus } from "./trace";
import { kindLabel, statusLabel } from "./traceView";

// ── ① 装配拓扑 ──────────────────────────────────────────────────────────

export interface GraphNode {
  id: string;
  version: string;
  status: PluginStatus;
  requires: readonly string[];
  optional: readonly string[];
  provides: readonly string[];
  /** 分层：0 层是谁都不依赖的插件，消费者在提供者下面一层。 */
  layer: number;
}

export interface GraphEdge {
  /** 消费者插件 id。 */
  from: string;
  /** 提供者插件 id。 */
  to: string;
  token: string;
  kind: "required" | "optional";
  /**
   * 这个服务真的登记在注册表里了吗。
   *
   * false = 只有插件声明说它提供，但 `services` 里还没有——插件没激活成功时就是
   * 这样。声明有、服务无，和「压根没人提供」是两回事，图上要分得开。
   */
  registered: boolean;
}

export interface MissingDependency {
  token: string;
  /** 谁在等它。 */
  consumers: readonly string[];
  /** 有任何一个消费者把它列进 requires 就是必选缺失；全是 optional 才算可选。 */
  required: boolean;
}

export interface PluginGraph {
  nodes: readonly GraphNode[];
  edges: readonly GraphEdge[];
  /** 没有任何插件提供的依赖。空数组表示装配声明层面是自洽的。 */
  missing: readonly MissingDependency[];
  /** 每一层的插件 id，层内保持登记顺序。 */
  layers: readonly (readonly string[])[];
}

interface Provider {
  pluginId: string;
  registered: boolean;
}

/** 从内核快照现算拓扑。纯函数：同一份快照永远得到同一张图。 */
export function buildPluginGraph(snapshot: KernelSnapshot | null): PluginGraph {
  if (!snapshot) return { nodes: [], edges: [], missing: [], layers: [] };

  const providers = new Map<string, Provider>();
  // 注册表里的登记优先：那是「事实上谁提供了它」。
  for (const entry of snapshot.services) {
    providers.set(entry.key, { pluginId: entry.providedBy, registered: true });
  }
  // 没激活的插件不会在 services 里留下痕迹，但它的声明仍然是图的一部分。
  for (const plugin of snapshot.plugins) {
    for (const key of plugin.provides) {
      if (!providers.has(key)) providers.set(key, { pluginId: plugin.id, registered: false });
    }
  }

  const edges: GraphEdge[] = [];
  const missing = new Map<string, { consumers: string[]; required: boolean }>();

  for (const plugin of snapshot.plugins) {
    const declared: [readonly string[], GraphEdge["kind"]][] = [
      [plugin.requires, "required"],
      [plugin.optional, "optional"],
    ];
    for (const [tokens, kind] of declared) {
      for (const token of tokens) {
        const provider = providers.get(token);
        // 自给自足不画边：它不构成插件之间的依赖，画出来只是一个自环。
        if (provider && provider.pluginId === plugin.id) continue;
        if (provider) {
          edges.push({ from: plugin.id, to: provider.pluginId, token, kind, registered: provider.registered });
          continue;
        }
        const existing = missing.get(token);
        if (existing) {
          existing.consumers.push(plugin.id);
          existing.required ||= kind === "required";
        } else {
          missing.set(token, { consumers: [plugin.id], required: kind === "required" });
        }
      }
    }
  }

  const layers = assignLayers(snapshot, edges);
  const nodes: GraphNode[] = snapshot.plugins.map((plugin) => ({
    id: plugin.id,
    version: plugin.version,
    status: plugin.status,
    requires: plugin.requires,
    optional: plugin.optional,
    provides: plugin.provides,
    layer: layers.get(plugin.id) ?? 0,
  }));

  const depth = Math.max(-1, ...nodes.map((node) => node.layer)) + 1;
  const grouped: string[][] = Array.from({ length: depth }, () => []);
  for (const node of nodes) grouped[node.layer].push(node.id);

  return {
    nodes,
    edges,
    // 必选缺失排前面：那才是「装不起来」的原因，可选缺失只是能力没开。
    missing: [...missing.entries()]
      .map(([token, value]) => ({ token, consumers: value.consumers, required: value.required }))
      .sort((left, right) => Number(right.required) - Number(left.required) || left.token.localeCompare(right.token)),
    layers: grouped,
  };
}

/**
 * 分层：提供者在上、消费者在下。
 *
 * 依赖图理论上是无环的（内核的拓扑排序不接受环），但这里仍然按「正在计算中就当 0 层」
 * 兜底——画图的代码不该因为一张坏图而栈溢出。
 */
function assignLayers(snapshot: KernelSnapshot, edges: readonly GraphEdge[]): Map<string, number> {
  const upstream = new Map<string, string[]>();
  for (const edge of edges) {
    const list = upstream.get(edge.from);
    if (list) list.push(edge.to);
    else upstream.set(edge.from, [edge.to]);
  }

  const depths = new Map<string, number>();
  const visiting = new Set<string>();

  function depthOf(id: string): number {
    const known = depths.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    let depth = 0;
    for (const provider of upstream.get(id) ?? []) {
      if (provider === id) continue;
      depth = Math.max(depth, depthOf(provider) + 1);
    }
    visiting.delete(id);
    depths.set(id, depth);
    return depth;
  }

  for (const plugin of snapshot.plugins) depthOf(plugin.id);
  return depths;
}

export const PLUGIN_STATUS_LABELS: Record<PluginStatus, string> = {
  pending: "未激活",
  activated: "已激活",
  failed: "激活失败",
  rolledBack: "已回滚",
  skipped: "预检未过",
};

// ── 拓扑布局（纯几何，页面只管画） ───────────────────────────────────────

export interface LayoutOptions {
  nodeWidth: number;
  nodeHeight: number;
  gapX: number;
  gapY: number;
  padding: number;
}

export const DEFAULT_LAYOUT: LayoutOptions = {
  nodeWidth: 168, nodeHeight: 54, gapX: 22, gapY: 56, padding: 16,
};

export interface LayoutNode extends GraphNode {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LayoutEdge extends GraphEdge {
  /** 提供者底边中点。 */
  x1: number;
  y1: number;
  /** 消费者顶边中点。 */
  x2: number;
  y2: number;
}

export interface GraphLayout {
  width: number;
  height: number;
  nodes: readonly LayoutNode[];
  edges: readonly LayoutEdge[];
}

/** 分层布局：每层一行，行内居中排开。不引图形库（规划文档 §3 F6 的约束）。 */
export function layoutGraph(graph: PluginGraph, options: Partial<LayoutOptions> = {}): GraphLayout {
  const opt = { ...DEFAULT_LAYOUT, ...options };
  const rowWidth = (count: number) => count * opt.nodeWidth + Math.max(0, count - 1) * opt.gapX;
  const widest = Math.max(0, ...graph.layers.map((row) => rowWidth(row.length)));

  const placed = new Map<string, LayoutNode>();
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  graph.layers.forEach((row, layer) => {
    const left = opt.padding + (widest - rowWidth(row.length)) / 2;
    row.forEach((id, index) => {
      const node = byId.get(id);
      if (!node) return;
      placed.set(id, {
        ...node,
        x: left + index * (opt.nodeWidth + opt.gapX),
        y: opt.padding + layer * (opt.nodeHeight + opt.gapY),
        width: opt.nodeWidth,
        height: opt.nodeHeight,
      });
    });
  });

  const edges: LayoutEdge[] = [];
  for (const edge of graph.edges) {
    const provider = placed.get(edge.to);
    const consumer = placed.get(edge.from);
    if (!provider || !consumer) continue;
    edges.push({
      ...edge,
      x1: provider.x + provider.width / 2,
      y1: provider.y + provider.height,
      x2: consumer.x + consumer.width / 2,
      y2: consumer.y,
    });
  }

  return {
    width: widest + opt.padding * 2,
    height: opt.padding * 2 + graph.layers.length * opt.nodeHeight
      + Math.max(0, graph.layers.length - 1) * opt.gapY,
    nodes: [...placed.values()],
    edges,
  };
}

// ── ② 一轮的数据流 ──────────────────────────────────────────────────────

export type FlowState = "done" | "failed" | "notReached";

export interface FlowStage {
  kind: TraceEventKind;
  label: string;
  state: FlowState;
  detail: string;
  /** 相对这一轮开始的偏移；没走到就是 null，不是 0。 */
  offsetMs: number | null;
}

export interface TurnFlow {
  stages: readonly FlowStage[];
  status: TraceTurnStatus | null;
  /** 最后一个真的发生了的阶段。这一轮一个事件都没有时为 null。 */
  lastReached: TraceEventKind | null;
  /**
   * 没跑完时停在哪一步的中文名（不含「结束」本身）。
   * 正常完成时为 null——完成的轮次没有「停在哪」这一说。
   */
  stoppedAfter: string | null;
}

/** 固定顺序，与 Runtime 实际编排一致；缺哪一步就看得出缺在哪。 */
const FLOW_ORDER: readonly TraceEventKind[] = [
  "turn_start", "context_assemble", "context_snapshot", "provider_request", "provider_stream_meta",
  "reply", "memory_extract", "tts", "turn_end",
];

/** 按这一轮实际发生的事件点亮阶段。 */
export function turnFlow(events: readonly TraceEventV1[], turnId: string): TurnFlow {
  const turnEvents = sortTraceEvents(events.filter((event) => event.turnId === turnId));
  const startedAt = turnEvents.find((event) => event.kind === "turn_start")?.at ?? turnEvents[0]?.at ?? null;
  const end = turnEvents.find((event) => event.kind === "turn_end");
  const status = end?.kind === "turn_end" ? end.status : null;

  const stages = FLOW_ORDER.map<FlowStage>((kind) => {
    const event = turnEvents.find((candidate) => candidate.kind === kind);
    if (!event) {
      return { kind, label: kindLabel(kind), state: "notReached", detail: "未走到", offsetMs: null };
    }
    return {
      kind,
      label: kindLabel(kind),
      // 只有结束事件自己说失败才算失败：其余阶段发生了就是发生了。
      state: kind === "turn_end" && status === "failed" ? "failed" : "done",
      detail: describeStage(event),
      offsetMs: startedAt === null ? null : event.at - startedAt,
    };
  });

  const reached = stages.filter((stage) => stage.state !== "notReached");
  const lastBeforeEnd = [...reached].reverse().find((stage) => stage.kind !== "turn_end") ?? null;

  return {
    stages,
    status,
    lastReached: reached.length ? reached[reached.length - 1].kind : null,
    // 完成的轮次没有「停在哪」；失败、取消、以及还没结束的轮次都要指出最后走到哪。
    stoppedAfter: status === "completed" ? null : lastBeforeEnd?.label ?? null,
  };
}

/** 每个阶段一句话，只挑这一类事件里最能说明问题的那两三个字段。 */
function describeStage(event: TraceEventV1): string {
  switch (event.kind) {
    case "turn_start":
      return `${event.source} · ${event.mode}`;
    case "context_assemble":
      return `≈${event.estimatedTokens} token · 来源 ${event.retrievedSources.length} · 丢弃 ${event.droppedSources.length}`;
    case "context_snapshot":
      return `快照 · 保留 ${event.counts.snippetsKept}/${event.counts.snippetsTotal}${event.counts.truncated ? " · 已截断" : ""}`;
    case "provider_request":
      return `${event.protocol} · ${event.model}`;
    case "provider_stream_meta":
      return `首 token ${event.firstTokenMs === null ? "—" : `${event.firstTokenMs}ms`} · ${event.chunks} chunk`;
    case "reply":
      return `${event.replyChars} 字${event.translationDuplicatesReply ? " · 正文与翻译同句" : ""}`;
    case "memory_extract":
      return event.failed ? "抽取失败" : `候选 ${event.candidates}`;
    case "tts":
      return `${event.sentences} 句 · ${event.played ? "播过" : "未播出"}`;
    case "turn_end":
      return `${statusLabel(event.status)} · ${event.durationMs}ms${event.errorCode ? ` · ${event.errorCode}` : ""}`;
  }
}
