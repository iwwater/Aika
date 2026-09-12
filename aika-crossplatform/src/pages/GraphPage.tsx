import { RefreshCw } from "lucide-react";
import { TurnPicker } from "../components/TurnPicker";
import {
  buildPluginGraph, layoutGraph, PLUGIN_STATUS_LABELS, turnFlow,
} from "../domain/pluginGraph";
import type { useDevTools } from "../hooks/useDevTools";
import { useKernelSnapshot } from "../hooks/useKernelSnapshot";

/**
 * 数据流图（F6）。
 *
 * 两张：装配拓扑从 `kernel.describe()` 现算（所以图不会与代码漂移），一轮的数据流
 * 按实际发生的事件点亮。节点位置、边的端点、缺失清单全部由 `domain/pluginGraph.ts`
 * 算好，这里只把它们画成 SVG——不引图形库。
 */
export function GraphPage(props: { devTools: ReturnType<typeof useDevTools> }) {
  const view = props.devTools;
  const { snapshot, refresh } = useKernelSnapshot();
  const graph = buildPluginGraph(snapshot);
  const layout = layoutGraph(graph);
  const flow = view.selectedTurnId
    ? turnFlow(view.steps.map((step) => step.event), view.selectedTurnId)
    : null;

  return (
    <div className="graph-page">
      <section className="graph-block">
        <header className="graph-head">
          <h3>装配拓扑</h3>
          <span className="graph-note">
            {snapshot ? `${graph.nodes.length} 个插件 · ${graph.edges.length} 条依赖 · 内核 ${snapshot.state}` : "内核不可用"}
          </span>
          <button type="button" onClick={refresh}><RefreshCw size={12} /> 重读</button>
        </header>

        {graph.nodes.length === 0 && (
          <div className="devtools-empty">
            <strong>读不到装配</strong>
            <p>没有内核实例，或者它一个插件都没登记。装配失败时这里同样应当有内容，读不到本身就是线索。</p>
          </div>
        )}

        {graph.nodes.length > 0 && (
          <svg className="graph-svg" width={layout.width} height={layout.height} viewBox={`0 0 ${layout.width} ${layout.height}`}>
            {layout.edges.map((edge, index) => (
              <g key={`${edge.from}-${edge.token}-${index}`}>
                <line
                  x1={edge.x1} y1={edge.y1} x2={edge.x2} y2={edge.y2}
                  className={`graph-edge ${edge.kind} ${edge.registered ? "" : "unregistered"}`}
                />
                <title>{`${edge.from} → ${edge.to}：${edge.token}${edge.kind === "optional" ? "（可选）" : ""}${edge.registered ? "" : "（声明有、服务未登记）"}`}</title>
              </g>
            ))}
            {layout.nodes.map((node) => (
              <g key={node.id} transform={`translate(${node.x},${node.y})`}>
                <rect
                  width={node.width} height={node.height} rx={9}
                  className={`graph-node ${node.status}`}
                />
                <text x={10} y={21} className="graph-node-id">{node.id}</text>
                <text x={10} y={38} className="graph-node-meta">
                  {`v${node.version} · ${PLUGIN_STATUS_LABELS[node.status]} · 提供 ${node.provides.length}`}
                </text>
              </g>
            ))}
          </svg>
        )}

        <div className="graph-legend">
          <span><i className="swatch required" /> 必选依赖</span>
          <span><i className="swatch optional" /> 可选依赖</span>
          <span><i className="swatch unregistered" /> 声明有、服务未登记</span>
        </div>

        <div className="graph-missing">
          <h4>没人提供的依赖（{graph.missing.length}）</h4>
          {graph.missing.length === 0 && <p className="graph-note">没有。所有声明的依赖都找得到提供者。</p>}
          {graph.missing.map((item) => (
            <p key={item.token} className={item.required ? "missing required" : "missing"}>
              <span className="missing-tag">{item.required ? "必选" : "可选"}</span>
              <code>{item.token}</code>
              <span className="graph-note">等它的是：{item.consumers.join("、")}</span>
            </p>
          ))}
        </div>
      </section>

      <section className="graph-block">
        <header className="graph-head">
          <h3>这一轮的数据流</h3>
          <span className="graph-note">
            {flow ? (flow.stoppedAfter ? `没跑完，停在「${flow.stoppedAfter}」之后` : "跑完了") : "选一轮看它走到哪"}
          </span>
        </header>

        <TurnPicker
          turns={view.turns}
          selectedTurnId={view.selectedTurnId}
          loading={view.loading}
          onSelect={(turnId) => view.select(turnId)}
          onRefresh={() => void view.refresh()}
        />

        {flow && (
          <ol className="flow-stages">
            {flow.stages.map((stage) => (
              <li key={stage.kind} className={`flow-stage ${stage.state}`}>
                <span className="flow-offset">{stage.offsetMs === null ? "—" : `+${stage.offsetMs}ms`}</span>
                <span className="flow-label">{stage.label}</span>
                <span className="flow-detail">{stage.detail}</span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
