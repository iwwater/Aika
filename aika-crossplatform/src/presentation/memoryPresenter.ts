/**
 * 记忆管理页的 Presenter（F7）。
 *
 * 与 React 无关，所以它是这个页面**唯一可测的行为面**（仓库没有 DOM 测试环境）。
 * 判定全在 `domain/memoryAdmin.ts`，这里只管：取数、改完通知别人、把失败如实留住。
 *
 * 一条贯穿的规矩：**批量不是事务**。仓储只有逐条 `forget`/`upsert`，所以「删了 3 条、
 * 2 条失败」必须能说出来——显示成全成功会让人以为库里已经干净了。
 */

import {
  applyMemoryEdit, batchSummary, confirmMemoryRecord, DEFAULT_MEMORY_FILTER,
  emptyBatchOutcome, emptyKind, filterMemories,
  type BatchOutcome, type MemoryEdit, type MemoryEmptyKind, type MemoryFilter, type MemoryRow,
} from "../domain/memoryAdmin";
import type { MemoryRecordV2 } from "../domain/memory";
import type { MemoryAccess } from "../services/memory/tokens";

export interface MemoryAdminViewModel {
  /** 没有记忆能力（宿主装的是 noMemoryPlugin）时为 false：页面说「没有记忆能力」而不是给一份空列表。 */
  available: boolean;
  loading: boolean;
  rows: readonly MemoryRow[];
  /** 库里一共多少条（含被取代的）。用来分辨两种空状态。 */
  total: number;
  /** 待过目的条数，审核流的入口。 */
  pendingCount: number;
  filter: MemoryFilter;
  empty: MemoryEmptyKind;
  /** 勾选的 id；筛掉的那些会被自动摘掉，避免「删了看不见的东西」。 */
  selected: readonly string[];
  editingId: string | null;
  draft: MemoryEdit | null;
  /** 上一次操作的结果，成功失败都放这儿。 */
  notice: string;
  error: string;
}

export interface MemoryPresenter {
  getSnapshot(): MemoryAdminViewModel;
  subscribe(listener: () => void): () => void;
  /** 幂等：重复调用只装载一次。 */
  start(): Promise<void>;
  refresh(): Promise<void>;
  setFilter(patch: Partial<MemoryFilter>): void;
  toggleSelect(id: string): void;
  selectAllVisible(): void;
  clearSelection(): void;
  beginEdit(id: string): void;
  changeDraft(patch: Partial<MemoryEdit>): void;
  cancelEdit(): void;
  saveEdit(): Promise<void>;
  confirm(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  confirmSelected(): Promise<void>;
  deleteSelected(): Promise<void>;
  dispose(): void;
}

export interface MemoryPresenterDeps {
  /** 没装记忆能力时为 null。 */
  access: MemoryAccess | null;
  clock?: () => number;
}

export function createMemoryPresenter(deps: MemoryPresenterDeps): MemoryPresenter {
  const listeners = new Set<() => void>();
  const now = deps.clock ?? (() => Date.now());
  let disposed = false;
  let started = false;
  let unsubscribe: (() => void) | null = null;

  let records: MemoryRecordV2[] = [];
  let loading = false;
  let filter: MemoryFilter = { ...DEFAULT_MEMORY_FILTER };
  let selected = new Set<string>();
  let editingId: string | null = null;
  let draft: MemoryEdit | null = null;
  let notice = "";
  let error = "";

  let cached: MemoryAdminViewModel | null = null;
  let dirty = true;

  function commit(): void {
    dirty = true;
    if (disposed) return;
    for (const listener of [...listeners]) listener();
  }

  function getSnapshot(): MemoryAdminViewModel {
    if (!cached || dirty) {
      const rows = filterMemories(records, filter, now());
      const visible = new Set(rows.map((row) => row.record.id));
      // 勾选只在可见范围内有效：筛选一变，看不见的那些不该还留在批量操作里。
      const effective = [...selected].filter((id) => visible.has(id));
      cached = Object.freeze({
        available: Boolean(deps.access),
        loading,
        rows,
        total: records.length,
        pendingCount: records.filter((record) => record.status === "candidate").length,
        filter: { ...filter },
        empty: emptyKind(records.length, rows.length),
        selected: effective,
        editingId,
        draft: draft ? { ...draft } : null,
        notice,
        error,
      });
      dirty = false;
    }
    return cached;
  }

  async function reload(): Promise<void> {
    const access = deps.access;
    if (!access) {
      commit();
      return;
    }
    loading = true;
    commit();
    try {
      const rows = await access.repository.list();
      if (disposed) return;
      records = [...rows];
      error = "";
    } catch (loadError) {
      error = messageOf(loadError);
    } finally {
      loading = false;
      commit();
    }
  }

  /** 逐条跑，失败的留下 id 与原因。成功的不回滚——半途失败也不该把已删的塞回去。 */
  async function runBatch(
    ids: readonly string[],
    action: (id: string) => Promise<void>,
  ): Promise<BatchOutcome> {
    const outcome = emptyBatchOutcome();
    for (const id of ids) {
      try {
        await action(id);
        outcome.ok += 1;
      } catch (batchError) {
        outcome.failed += 1;
        outcome.errors.push({ id, message: messageOf(batchError) });
      }
    }
    return outcome;
  }

  function find(id: string): MemoryRecordV2 | null {
    return records.find((record) => record.id === id) ?? null;
  }

  async function confirmOne(id: string): Promise<void> {
    const access = deps.access;
    const record = find(id);
    if (!access || !record) throw new Error("这条记忆已经不在了");
    await access.repository.upsert([confirmMemoryRecord(record, now())]);
  }

  async function removeOne(id: string): Promise<void> {
    const access = deps.access;
    if (!access) throw new Error("没有记忆能力");
    // forget 会落下抑制标记并让摘要作废：被删的来源之后不会让这条记忆复活。
    const removed = await access.repository.forget(id);
    if (!removed) throw new Error("这条记忆已经不在了");
  }

  /** 改完之后：通知别的消费者重读（右栏那份列表），再自己重读一遍。 */
  async function afterMutation(): Promise<void> {
    deps.access?.notifyChanged();
    await reload();
  }

  return {
    getSnapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    async start() {
      if (started || disposed) return;
      started = true;
      // 别人改了记忆（对话里抽出新的、右栏删了一条）时重读，不靠用户手动刷新。
      unsubscribe = deps.access?.onChanged(() => {
        void reload();
      }) ?? null;
      await reload();
    },

    refresh: reload,

    setFilter(patch) {
      filter = { ...filter, ...patch };
      commit();
    },

    toggleSelect(id) {
      if (selected.has(id)) selected.delete(id);
      else selected.add(id);
      commit();
    },

    selectAllVisible() {
      for (const row of getSnapshot().rows) selected.add(row.record.id);
      commit();
    },

    clearSelection() {
      selected = new Set();
      commit();
    },

    beginEdit(id) {
      const record = find(id);
      if (!record) return;
      editingId = id;
      draft = { content: record.content, type: record.type };
      commit();
    },

    changeDraft(patch) {
      if (!draft) return;
      draft = { ...draft, ...patch };
      commit();
    },

    cancelEdit() {
      editingId = null;
      draft = null;
      commit();
    },

    async saveEdit() {
      const access = deps.access;
      const record = editingId ? find(editingId) : null;
      if (!access || !record || !draft) return;
      const next = applyMemoryEdit(record, draft, now());
      if (!next) {
        // 空正文不写盘：删一条记忆要走删除，不是把正文清空。
        error = "记忆内容不能为空；要删掉它请用删除。";
        commit();
        return;
      }
      try {
        await access.repository.upsert([next]);
        editingId = null;
        draft = null;
        notice = "已保存";
        error = "";
      } catch (saveError) {
        error = messageOf(saveError);
      }
      await afterMutation();
    },

    async confirm(id) {
      try {
        await confirmOne(id);
        notice = "已确认 1 条";
        error = "";
      } catch (confirmError) {
        error = messageOf(confirmError);
      }
      await afterMutation();
    },

    async remove(id) {
      try {
        await removeOne(id);
        selected.delete(id);
        notice = "已删除 1 条";
        error = "";
      } catch (removeError) {
        error = messageOf(removeError);
      }
      await afterMutation();
    },

    async confirmSelected() {
      const ids = getSnapshot().selected;
      if (!ids.length) return;
      const outcome = await runBatch(ids, confirmOne);
      notice = batchSummary("确认", outcome);
      for (const id of ids) {
        if (!outcome.errors.some((item) => item.id === id)) selected.delete(id);
      }
      await afterMutation();
    },

    async deleteSelected() {
      const ids = getSnapshot().selected;
      if (!ids.length) return;
      const outcome = await runBatch(ids, removeOne);
      notice = batchSummary("删除", outcome);
      for (const id of ids) {
        if (!outcome.errors.some((item) => item.id === id)) selected.delete(id);
      }
      await afterMutation();
    },

    dispose() {
      disposed = true;
      unsubscribe?.();
      unsubscribe = null;
      listeners.clear();
    },
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
