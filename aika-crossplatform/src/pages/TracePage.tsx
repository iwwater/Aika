import { LoaderCircle, RefreshCw } from "lucide-react";
import { isUnfinished, kindLabel, statusLabel } from "../domain/traceView";
import type { useDevTools } from "../hooks/useDevTools";

/**
 * Trace 查看页（F4）。
 *
 * 这里没有判断：哪一轮算未结束、耗时怎么算、缺字段显示什么，全部由
 * `domain/traceView.ts` 决定。组件只负责画，以及把「选中哪一轮」交回 Presenter。
 */
export function TracePage(props: { devTools: ReturnType<typeof useDevTools> }) {
  const view = props.devTools;

  if (!view.available) {
    return (
      <div className="devtools-empty">
        <strong>Trace 未启用</strong>
        <p>当前装配没有 Trace 能力，所以没有事件可看。生产构建默认关闭；在下面的开关里打开后重启即可。</p>
      </div>
    );
  }

  return (
    <div className="trace-page">
      <div className="trace-toolbar">
        <span>{view.turns.length} 轮</span>
        <button type="button" onClick={() => void view.refresh()} disabled={view.loading}>
          {view.loading ? <LoaderCircle size={13} className="spin" /> : <RefreshCw size={13} />} 刷新
        </button>
        {view.selectedTurnId && (
          <button type="button" onClick={() => view.select(null)}>返回全部</button>
        )}
        {view.error && <span className="trace-error">{view.error}</span>}
      </div>

      {view.turns.length === 0 && !view.loading && (
        <div className="devtools-empty">
          <strong>还没有事件</strong>
          <p>Trace 已启用但这一次运行还没记录到轮次。说一句话再回来看。</p>
        </div>
      )}

      <div className="trace-turns">
        {view.turns.map((turn) => (
          <article
            key={turn.turnId}
            className={`trace-turn ${turn.turnId === view.selectedTurnId ? "active" : ""} ${turn.errorCode ? "failed" : ""}`}
            onClick={() => view.select(turn.turnId === view.selectedTurnId ? null : turn.turnId)}
          >
            <header>
              <span className={`trace-status ${isUnfinished(turn) ? "unfinished" : ""}`}>
                {statusLabel(turn.status)}
              </span>
              <code>{turn.turnId.slice(0, 8)}</code>
              <span className="trace-model">{turn.model ?? "—"}</span>
            </header>
            <dl className="trace-metrics">
              <div><dt>耗时</dt><dd>{format(turn.durationMs, "ms")}</dd></div>
              <div><dt>首 token</dt><dd>{format(turn.firstTokenMs, "ms")}</dd></div>
              <div><dt>chunk</dt><dd>{format(turn.chunks)}</dd></div>
              <div><dt>估算 token</dt><dd>{format(turn.estimatedPromptTokens)}</dd></div>
              <div><dt>实际 token</dt><dd>{format(turn.reportedTokens)}</dd></div>
              <div><dt>事件</dt><dd>{turn.eventCount}</dd></div>
            </dl>
            {turn.errorCode && <p className="trace-errorcode">{turn.errorCode}</p>}
            <div className="trace-kinds">
              {turn.kinds.map((kind, index) => <span key={`${turn.turnId}-${index}`}>{kindLabel(kind)}</span>)}
            </div>
          </article>
        ))}
      </div>

      {view.steps.length > 0 && (
        <section className="trace-detail">
          <h3>这一轮的事件</h3>
          <ol>
            {view.steps.map((step) => (
              <li key={step.seq}>
                <span className="trace-offset">+{step.offsetMs}ms</span>
                <span className="trace-kind">{kindLabel(step.kind)}</span>
                <code>{summarizeStep(step.event)}</code>
              </li>
            ))}
          </ol>
        </section>
      )}

      <section className="trace-raw">
        <h3>原始 JSONL</h3>
        <pre>{view.jsonl || "（空）"}</pre>
      </section>
    </div>
  );
}

/** 缺失一律显示破折号，不显示 0——那会把「不知道」画成一个确定值。 */
function format(value: number | null, unit = ""): string {
  return value === null ? "—" : `${value}${unit}`;
}

/** 每一步的一句话摘要：只挑这一类事件里最有用的那两三个字段。 */
function summarizeStep(event: import("../domain/trace").TraceEventV1): string {
  switch (event.kind) {
    case "turn_start":
      return `${event.source} · ${event.mode}${event.text ? ` · ${event.text}` : ""}`;
    case "context_assemble":
      return `≈${event.estimatedTokens} token · 来源 ${event.retrievedSources.length} · 丢弃 ${event.droppedSources.length}`;
    case "context_snapshot":
      return `保留 ${event.counts.snippetsKept}/${event.counts.snippetsTotal}${event.counts.truncated ? " · 已截断" : ""} · ≈${event.budget.estimatedUsed} token`;
    case "provider_request":
      return `${event.protocol} · ${event.model} · ${event.endpoint}`;
    case "provider_stream_meta":
      return `首 token ${event.firstTokenMs === null ? "—" : `${event.firstTokenMs}ms`} · ${event.chunks} chunk`;
    case "reply":
      return [
        event.mood,
        `正文 ${event.replyChars} 字`,
        `翻译 ${event.translationChars} 字`,
        event.translationDuplicatesReply ? "⚠ 正文与翻译同句" : null,
        event.sticker ? `表情包 ${event.sticker}` : null,
        ...event.actions,
      ].filter(Boolean).join(" · ");
    case "memory_extract":
      return event.failed ? "抽取失败" : `候选 ${event.candidates}`;
    case "tts":
      return `${event.sentences} 句 · ${event.played ? "播过" : "未播出"} · 失败 ${event.errorCount}`;
    case "turn_end":
      return `${statusLabel(event.status)} · ${event.durationMs}ms${event.errorCode ? ` · ${event.errorCode}` : ""}`;
  }
}
