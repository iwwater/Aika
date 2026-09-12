import { LoaderCircle, RefreshCw } from "lucide-react";
import { statusLabel, type TraceTurnSummary } from "../domain/traceView";

/**
 * 选一轮（FE-10）。
 *
 * 能力调用视图与数据流图都要先有「哪一轮」，选中状态存在 Presenter 里，所以两个
 * 页签之间是同一轮——在 Trace 页点开的那一轮，切过去还是它。
 */
export function TurnPicker(props: {
  turns: readonly TraceTurnSummary[];
  selectedTurnId: string | null;
  loading: boolean;
  onSelect: (turnId: string) => void;
  onRefresh: () => void;
}) {
  return (
    <div className="turn-picker">
      <span className="turn-picker-label">选一轮</span>
      {props.turns.map((turn) => (
        <button
          key={turn.turnId}
          type="button"
          className={turn.turnId === props.selectedTurnId ? "active" : ""}
          onClick={() => props.onSelect(turn.turnId)}
        >
          <code>{turn.turnId.slice(0, 8)}</code>
          <span>{statusLabel(turn.status)}</span>
        </button>
      ))}
      {props.turns.length === 0 && <span className="turn-picker-empty">还没有记录到轮次</span>}
      <button type="button" className="turn-picker-refresh" onClick={props.onRefresh} disabled={props.loading}>
        {props.loading ? <LoaderCircle size={12} className="spin" /> : <RefreshCw size={12} />} 刷新
      </button>
    </div>
  );
}
