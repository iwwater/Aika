import { TurnPicker } from "../components/TurnPicker";
import { capabilityCalls, OUTCOME_LABELS } from "../domain/capabilityView";
import type { useDevTools } from "../hooks/useDevTools";

/**
 * 能力调用视图（F5）。
 *
 * 这一轮各项能力分别做了什么，全部由 `domain/capabilityView.ts` 判定；组件只把
 * 结论摆出来，自己不看事件、不做任何 if。
 *
 * 按现有能力如实展示：这个仓库的 tool call 面很窄（`actions` 只有 sticker 一种），
 * 所以页面不假装有一套通用工具链，也不为将来可能有的能力留空占位。
 */
export function CapabilitiesPage(props: { devTools: ReturnType<typeof useDevTools> }) {
  const view = props.devTools;

  if (!view.available) {
    return (
      <div className="devtools-empty">
        <strong>Trace 未启用</strong>
        <p>能力调用视图读的就是 Trace 事件。没有事件就没有这一轮做过什么的记录。</p>
      </div>
    );
  }

  // steps 已经是选中那一轮的事件（Presenter 按 turnId 过滤过），这里不再自己筛。
  const calls = view.selectedTurnId
    ? capabilityCalls(view.steps.map((step) => step.event), view.selectedTurnId)
    : [];

  return (
    <div className="capability-page">
      <TurnPicker
        turns={view.turns}
        selectedTurnId={view.selectedTurnId}
        loading={view.loading}
        onSelect={(turnId) => view.select(turnId)}
        onRefresh={() => void view.refresh()}
      />

      {!view.selectedTurnId && (
        <div className="devtools-empty">
          <strong>先选一轮</strong>
          <p>选中之后这里会列出这一轮各项能力分别做了什么：检索到哪些来源、丢了哪些、抽了几条记忆、念了几句。</p>
        </div>
      )}

      <div className="capability-list">
        {calls.map((call) => (
          <article key={call.capability} className={`capability-card ${call.outcome}`}>
            <header>
              <strong>{call.capability}</strong>
              <span className={`capability-outcome ${call.outcome}`}>{OUTCOME_LABELS[call.outcome]}</span>
            </header>
            <p>{call.detail}</p>
            {call.items.length > 0 && (
              <ul>
                {call.items.map((item, index) => <li key={`${call.capability}-${index}`}>{item}</li>)}
              </ul>
            )}
          </article>
        ))}
      </div>
    </div>
  );
}
