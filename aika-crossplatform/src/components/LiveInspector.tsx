import { useEffect, useRef, useState } from "react";
import { ChevronsDownUp, ChevronsUpDown, X } from "lucide-react";
import { useService } from "../app/kernelContext";
import { usePresenterSnapshot } from "../hooks/usePresenterSnapshot";
import { InspectorPresenterToken } from "../presentation/tokens";
import type { TraceEventV1 } from "../domain/trace";

/**
 * Live Inspector 外壳（FE-23）。
 *
 * 应用内浮层：可拖动、可折叠成胶囊、Esc 关闭；position:fixed 且只在自己的
 * 面板上拦截指针，聊天保持可操作。拖拽手感与窄窗表现归浏览器目视——这里
 * 保证的是结构、状态与数据链路。
 */

const KIND_LABELS: Record<string, string> = {
  turn_start: "开始",
  context_assemble: "组装",
  context_snapshot: "快照",
  provider_request: "请求",
  provider_stream_meta: "流式",
  reply: "回包",
  memory_extract: "抽取",
  tts: "语音",
  turn_end: "结束",
};

function summarize(event: TraceEventV1): string {
  switch (event.kind) {
    case "turn_start":
      return `${event.mode}${event.text ? ` · ${event.text}` : ""}`;
    case "context_assemble":
      return `≈${event.estimatedTokens} token · 来源 ${event.retrievedSources.length}`;
    case "context_snapshot":
      return `保留 ${event.counts.snippetsKept}/${event.counts.snippetsTotal}${event.counts.truncated ? " · 已截断" : ""}`;
    case "provider_request":
      return `${event.protocol} · ${event.model}`;
    case "provider_stream_meta":
      return `首 token ${event.firstTokenMs === null ? "—" : `${event.firstTokenMs}ms`}`;
    case "reply":
      return `${event.replyChars} 字${event.translationDuplicatesReply ? " · 同句" : ""}`;
    case "memory_extract":
      return event.failed ? "抽取失败" : `候选 ${event.candidates}`;
    case "tts":
      return `${event.sentences} 句 · ${event.played ? "播过" : "未播"}`;
    case "turn_end":
      return `${event.status} · ${event.durationMs}ms`;
    default:
      return "";
  }
}

export function LiveInspector() {
  const presenter = useService(InspectorPresenterToken);
  const view = usePresenterSnapshot(presenter);
  const [collapsed, setCollapsed] = useState(false);
  const [position, setPosition] = useState({ x: window.innerWidth - 372, y: 72 });
  const dragState = useRef<{ pointerId: number; offsetX: number; offsetY: number } | null>(null);
  const narrow = window.innerWidth < 900;

  useEffect(() => {
    void presenter.open();
    return () => presenter.close();
  }, [presenter]);

  useEffect(() => {
    const onKey = (keyboardEvent: KeyboardEvent) => {
      if (keyboardEvent.key === "Escape") presenter.close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [presenter]);

  const onPointerMove = (pointerEvent: React.PointerEvent) => {
    if (!dragState.current) return;
    setPosition({
      x: Math.max(8, pointerEvent.clientX - dragState.current.offsetX),
      y: Math.max(8, pointerEvent.clientY - dragState.current.offsetY),
    });
  };

  if (narrow) {
    return (
      <button
        className="live-inspector-capsule"
        title="Live Inspector（窄窗收起）"
        onClick={() => setCollapsed((value) => !value)}
      >
        TR {view.events.length}
      </button>
    );
  }

  if (!view.traceEnabled) {
    return (
      <section className="live-inspector" style={{ left: position.x, top: position.y }} role="complementary" aria-label="Live Inspector">
        <header className="live-inspector-header">
          <span>LIVE INSPECTOR</span>
          <button className="icon-button" onClick={() => presenter.close()} title="关闭（Esc）"><X size={14} /></button>
        </header>
        <p className="live-inspector-empty">
          Trace 目前是关的。到工作台设置里打开才会产生事件；这里不会替你打开。
        </p>
      </section>
    );
  }

  if (collapsed) {
    return (
      <button
        className="live-inspector-capsule"
        title="展开 Live Inspector"
        onClick={() => setCollapsed(false)}
      >
        TR {view.events.length}
      </button>
    );
  }

  return (
    <section
      className="live-inspector"
      style={{ left: position.x, top: position.y }}
      role="complementary"
      aria-label="Live Inspector"
    >
      <header
        className="live-inspector-header"
        onPointerDown={(pointerEvent) => {
          dragState.current = { pointerId: pointerEvent.pointerId, offsetX: pointerEvent.clientX - position.x, offsetY: pointerEvent.clientY - position.y };
          (pointerEvent.target as HTMLElement).setPointerCapture(pointerEvent.pointerId);
        }}
        onPointerMove={onPointerMove}
        onPointerUp={() => {
          dragState.current = null;
        }}
      >
        <span>LIVE INSPECTOR · {view.historyStatus === "loading" ? "载入中…" : view.historyStatus === "unavailable" ? "历史不可用（实时继续）" : `${view.events.length} 条`}</span>
        <span className="live-inspector-actions">
          <button className="icon-button" onClick={() => setCollapsed(true)} title="折叠"><ChevronsDownUp size={14} /></button>
          <button className="icon-button" onClick={() => presenter.close()} title="关闭（Esc）"><X size={14} /></button>
        </span>
      </header>
      {view.evictionNote && <p className="live-inspector-note">{view.evictionNote}</p>}
      {view.maskingNote && <p className="live-inspector-note">正文开关是关的：这里是显示屏蔽，历史落盘正文不受影响。</p>}
      <div className="live-inspector-list">
        {view.events.slice().reverse().map((event) => (
          <div key={`${event.turnId}:${event.seq}`} className="live-inspector-row">
            <span className="live-inspector-kind">{KIND_LABELS[event.kind] ?? event.kind}</span>
            <span className="live-inspector-summary">{summarize(event)}</span>
          </div>
        ))}
        {!view.events.length && view.historyStatus === "ready" && <p className="live-inspector-empty">还没有事件。发一轮对话试试。</p>}
      </div>
      <footer className="live-inspector-footer">
        <button className="icon-button" onClick={() => setCollapsed(true)} title="折叠成胶囊"><ChevronsUpDown size={13} /> 收起</button>
      </footer>
    </section>
  );
}
