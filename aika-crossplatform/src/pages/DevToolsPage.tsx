import { useState } from "react";
import { Bug, X } from "lucide-react";
import type { useDevTools } from "../hooks/useDevTools";
import { TracePage } from "./TracePage";

/**
 * 工作台外壳（F2）。
 *
 * 页签用一个 state 切，不引路由库（规划文档 §2 的边界）。后续 F5/F6/F7/F8/F9
 * 各自是一个页签，各自一个文件——这里只负责切换与标题栏，不承载任何页面逻辑。
 */
type DevToolsTab = "trace" | "settings";

export function DevToolsPage(props: { devTools: ReturnType<typeof useDevTools>; onClose: () => void }) {
  const [tab, setTab] = useState<DevToolsTab>("trace");
  const view = props.devTools;

  return (
    <section className="devtools">
      <header className="devtools-head">
        <div className="devtools-title"><Bug size={17} /> 调试工作台</div>
        <nav className="devtools-tabs">
          <button type="button" className={tab === "trace" ? "active" : ""} onClick={() => setTab("trace")}>
            Trace
          </button>
          <button type="button" className={tab === "settings" ? "active" : ""} onClick={() => setTab("settings")}>
            开关
          </button>
        </nav>
        <button type="button" className="devtools-close" onClick={props.onClose}><X size={16} /></button>
      </header>

      {tab === "trace" && <TracePage devTools={view} />}

      {tab === "settings" && (
        <div className="devtools-switches">
          <label>
            <input
              type="checkbox"
              checked={view.traceEnabled}
              onChange={(event) => void view.setTraceEnabled(event.target.checked)}
            />
            <span>
              <strong>记录 Trace</strong>
              开发构建默认开、生产默认关。关掉之后新轮次不再产生任何事件。
            </span>
          </label>
          <label>
            <input
              type="checkbox"
              checked={view.traceIncludeText}
              onChange={(event) => void view.setTraceIncludeText(event.target.checked)}
            />
            <span>
              <strong>连正文一起记</strong>
              默认不记。打开后你的原话与提示词摘要会写进本地 Trace；API Key 任何情况下都不会被记录。
            </span>
          </label>
          <p className="devtools-note">
            两个开关都存在本地设置里，重启后保持。Trace 只写本机，不会发往任何地方。
          </p>
        </div>
      )}
    </section>
  );
}
