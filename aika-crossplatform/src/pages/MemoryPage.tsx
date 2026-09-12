import { Check, LoaderCircle, Pencil, RefreshCw, Trash2, X } from "lucide-react";
import {
  MEMORY_STATUS_LABELS, MEMORY_STATUS_V2, MEMORY_TYPE_LABELS, MEMORY_TYPES,
} from "../domain/memoryAdmin";
import type { MemoryStatusV2, MemoryType } from "../domain/memory";
import { useMemoryAdmin } from "../hooks/useMemoryAdmin";

/**
 * 长期记忆管理页（F7）。
 *
 * 右栏那份列表看的是降级过的 V1 视图；这里按 V2 原貌管理——type、状态、来源、
 * 置信度、有效期都不压缩。筛选、排序、来源文案、批量结果一句话，全部由
 * `domain/memoryAdmin.ts` 与 Presenter 决定，组件只画。
 */
export function MemoryPage() {
  const view = useMemoryAdmin();

  if (!view.available) {
    return (
      <div className="devtools-empty">
        <strong>这台机器上没有记忆能力</strong>
        <p>当前装配用的是 noMemoryPlugin（存储没有 memoryV2 端口），所以没有长期记忆可管理。这不是记忆丢了。</p>
      </div>
    );
  }

  const selectedCount = view.selected.length;

  return (
    <div className="memory-page">
      <div className="memory-toolbar">
        <input
          type="search"
          placeholder="搜索记忆内容"
          value={view.filter.text}
          onChange={(event) => view.setFilter({ text: event.target.value })}
        />
        <select
          value={view.filter.type ?? ""}
          onChange={(event) => view.setFilter({ type: (event.target.value || null) as MemoryType | null })}
        >
          <option value="">全部类型</option>
          {MEMORY_TYPES.map((type) => <option key={type} value={type}>{MEMORY_TYPE_LABELS[type]}</option>)}
        </select>
        <select
          value={view.filter.status ?? ""}
          onChange={(event) => view.setFilter({ status: (event.target.value || null) as MemoryStatusV2 | null })}
        >
          <option value="">全部状态</option>
          {MEMORY_STATUS_V2.map((status) => (
            <option key={status} value={status}>{MEMORY_STATUS_LABELS[status]}</option>
          ))}
        </select>
        <label className="memory-check">
          <input
            type="checkbox"
            checked={view.filter.includeSuperseded}
            onChange={(event) => view.setFilter({ includeSuperseded: event.target.checked })}
          />
          显示被取代的
        </label>
        <button type="button" onClick={() => void view.refresh()} disabled={view.loading}>
          {view.loading ? <LoaderCircle size={13} className="spin" /> : <RefreshCw size={13} />} 刷新
        </button>
      </div>

      <div className="memory-stats">
        <span>共 {view.total} 条</span>
        <span>待过目 {view.pendingCount}</span>
        <span>当前列出 {view.rows.length}</span>
        {view.notice && <span className="memory-notice">{view.notice}</span>}
        {view.error && <span className="memory-error">{view.error}</span>}
      </div>

      <div className="memory-batch">
        <button type="button" onClick={view.selectAllVisible} disabled={!view.rows.length}>全选当前</button>
        <button type="button" onClick={view.clearSelection} disabled={!selectedCount}>取消勾选</button>
        <button type="button" onClick={() => void view.confirmSelected()} disabled={!selectedCount}>
          确认选中（{selectedCount}）
        </button>
        <button
          type="button"
          className="danger"
          onClick={() => void view.deleteSelected()}
          disabled={!selectedCount}
        >
          删除选中（{selectedCount}）
        </button>
      </div>

      {view.empty === "none" && (
        <div className="devtools-empty">
          <strong>还没有记忆</strong>
          <p>聊过之后她会自动记下来，抽出来的条目会先落在「待过目」里等你确认。</p>
        </div>
      )}
      {view.empty === "filtered" && (
        <div className="devtools-empty">
          <strong>这些条件下没有记忆</strong>
          <p>库里有 {view.total} 条，只是都被当前的筛选条件挡住了。清掉搜索词或换个类型再看。</p>
        </div>
      )}

      <div className="memory-rows">
        {view.rows.map((row) => {
          const editing = view.editingId === row.record.id;
          return (
            <article key={row.record.id} className={`memory-row ${row.record.status} ${row.needsReview ? "review" : ""}`}>
              <label className="memory-pick">
                <input
                  type="checkbox"
                  checked={view.selected.includes(row.record.id)}
                  onChange={() => view.toggleSelect(row.record.id)}
                />
              </label>

              <div className="memory-body">
                {editing && view.draft ? (
                  <div className="memory-edit">
                    <textarea
                      value={view.draft.content}
                      rows={3}
                      onChange={(event) => view.changeDraft({ content: event.target.value })}
                    />
                    <div className="memory-edit-row">
                      <select
                        value={view.draft.type}
                        onChange={(event) => view.changeDraft({ type: event.target.value as MemoryType })}
                      >
                        {MEMORY_TYPES.map((type) => (
                          <option key={type} value={type}>{MEMORY_TYPE_LABELS[type]}</option>
                        ))}
                      </select>
                      <button type="button" onClick={() => void view.saveEdit()}>保存</button>
                      <button type="button" onClick={view.cancelEdit}>取消</button>
                    </div>
                  </div>
                ) : (
                  <p className="memory-content">{row.record.content}</p>
                )}

                <div className="memory-meta">
                  <span className="memory-tag">{row.typeLabel}</span>
                  <span className={`memory-tag status ${row.record.status}`}>{row.statusLabel}</span>
                  <span>{row.sourceLabel}</span>
                  {row.confidencePercent !== null && <span>置信度 {row.confidencePercent}%</span>}
                  {row.confidencePercent === null && <span>置信度未知</span>}
                  {row.validityNote && <span className="memory-validity">{row.validityNote}</span>}
                  {row.supersedesContent && <span className="memory-supersedes">取代了「{row.supersedesContent}」</span>}
                </div>
              </div>

              {!editing && (
                <div className="memory-row-actions">
                  {row.needsReview && (
                    <button type="button" title="确认保留" onClick={() => void view.confirm(row.record.id)}>
                      <Check size={13} />
                    </button>
                  )}
                  <button type="button" title="编辑" onClick={() => view.beginEdit(row.record.id)}>
                    <Pencil size={13} />
                  </button>
                  <button type="button" title="删除" className="danger" onClick={() => void view.remove(row.record.id)}>
                    <Trash2 size={13} />
                  </button>
                </div>
              )}
              {editing && (
                <div className="memory-row-actions">
                  <button type="button" title="取消编辑" onClick={view.cancelEdit}><X size={13} /></button>
                </div>
              )}
            </article>
          );
        })}
      </div>
    </div>
  );
}
