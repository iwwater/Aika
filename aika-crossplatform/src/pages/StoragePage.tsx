import { LoaderCircle, Play, RefreshCw, Table2 } from "lucide-react";
import { formatCell, SQL_ROW_LIMIT } from "../domain/sqlConsole";
import { useStorageBrowser } from "../hooks/useStorageBrowser";

/**
 * 存储浏览页（F8）。
 *
 * 控制台**只读**（规划文档 §7 问题 3）。判定全在 `domain/sqlConsole.ts`——组件里
 * 一个 if 都没有，连「这条能不能跑」都不判：拦不住就是真的写进去了，那种判断
 * 不能散落在渲染层。
 */
export function StoragePage() {
  const view = useStorageBrowser();

  if (!view.available) {
    return (
      <div className="devtools-empty">
        <strong>这台机器上没有 SQL 能力</strong>
        <p>
          当前存储是浏览器 localStorage 降级实现，没有 <code>sqlExecutor</code>，所以没有表可浏览。
          桌面应用（SQLite）里才有这一页的内容——这不是库空了。
        </p>
      </div>
    );
  }

  return (
    <div className="storage-page">
      <div className="storage-head">
        <span>{view.tables.length} 张表 / 视图</span>
        <button type="button" onClick={() => void view.refresh()} disabled={view.loading}>
          {view.loading ? <LoaderCircle size={13} className="spin" /> : <RefreshCw size={13} />} 刷新
        </button>
        {view.error && <span className="storage-error">{view.error}</span>}
      </div>

      <div className="storage-body">
        <aside className="storage-tables">
          {view.tables.map((table) => (
            <button
              key={table.name}
              type="button"
              className={table.name === view.selectedTable ? "active" : ""}
              onClick={() => void view.selectTable(table.name)}
            >
              <Table2 size={12} />
              <span className="storage-table-name">{table.name}</span>
              <span className="storage-table-rows">{table.rowCount === null ? "—" : table.rowCount}</span>
              {table.kind === "view" && <span className="storage-table-kind">视图</span>}
            </button>
          ))}
        </aside>

        <section className="storage-detail">
          {view.selectedTable && (
            <>
              <h3>{view.selectedTable} 的结构</h3>
              <table className="storage-schema">
                <thead>
                  <tr><th>列</th><th>类型</th><th>非空</th><th>主键</th><th>默认值</th></tr>
                </thead>
                <tbody>
                  {view.columns.map((column) => (
                    <tr key={column.name}>
                      <td>{column.name}</td>
                      <td>{column.type}</td>
                      <td>{column.notNull ? "是" : "—"}</td>
                      <td>{column.primaryKey ? "是" : "—"}</td>
                      <td>{column.defaultValue ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {view.createSql && <pre className="storage-create-sql">{view.createSql}</pre>}
            </>
          )}

          <h3>只读 SQL 控制台</h3>
          <p className="storage-note">
            只接受 SELECT / WITH / EXPLAIN / 只读 PRAGMA。写操作走应用内界面——手写的 UPDATE 不会触发
            记忆抑制、摘要作废这些联动，库里会留下代码认不出来的状态。
            拦截靠语句判定，<strong>不是数据库级只读连接</strong>（plugin-sql 只给一个执行器）。
          </p>
          <textarea
            className="storage-query"
            rows={4}
            spellCheck={false}
            placeholder={"SELECT * FROM messages ORDER BY created_at DESC LIMIT 20"}
            value={view.query}
            onChange={(event) => view.setQuery(event.target.value)}
          />
          <div className="storage-actions">
            <button type="button" onClick={() => void view.runQuery()} disabled={view.loading}>
              <Play size={12} /> 执行
            </button>
            <span className="storage-note">最多返回 {SQL_ROW_LIMIT} 行</span>
          </div>

          {view.result && (
            <>
              <div className="storage-result-head">
                <span>{view.resultSource === "preview" ? "表预览" : "查询结果"}</span>
                <span>{view.result.rows.length} 行 · {view.result.elapsedMs}ms</span>
                {view.result.truncated && <span className="storage-truncated">只显示前 {view.result.rows.length} 行，还有没显示的</span>}
              </div>
              <div className="storage-result">
                <table>
                  <thead>
                    <tr>{view.result.columns.map((column) => <th key={column}>{column}</th>)}</tr>
                  </thead>
                  <tbody>
                    {view.result.rows.map((row, rowIndex) => (
                      <tr key={rowIndex}>
                        {row.map((cell, cellIndex) => (
                          <td key={cellIndex} className={cell === null ? "null" : ""}>{formatCell(cell)}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
