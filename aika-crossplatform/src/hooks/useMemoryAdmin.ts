import { useCallback, useEffect, useMemo } from "react";
import { useService } from "../app/kernelContext";
import type { MemoryEdit, MemoryFilter } from "../domain/memoryAdmin";
import { MemoryPresenterToken } from "../presentation/tokens";
import { usePresenterSnapshot } from "./usePresenterSnapshot";

/**
 * 记忆管理适配器（FE-11）。
 *
 * 与另外三个 Hook 同一个形状：取 Presenter、订阅快照、把操作转成命令。
 * 不 import 任何 `services/` 实现，也不自己判断任何东西。
 */
export function useMemoryAdmin() {
  const presenter = useService(MemoryPresenterToken);
  const snapshot = usePresenterSnapshot(presenter);

  // 幂等：StrictMode 双次挂载不会重复装载。
  useEffect(() => {
    void presenter.start();
  }, [presenter]);

  const refresh = useCallback(() => presenter.refresh(), [presenter]);
  const setFilter = useCallback((patch: Partial<MemoryFilter>) => presenter.setFilter(patch), [presenter]);
  const toggleSelect = useCallback((id: string) => presenter.toggleSelect(id), [presenter]);
  const selectAllVisible = useCallback(() => presenter.selectAllVisible(), [presenter]);
  const clearSelection = useCallback(() => presenter.clearSelection(), [presenter]);
  const beginEdit = useCallback((id: string) => presenter.beginEdit(id), [presenter]);
  const changeDraft = useCallback((patch: Partial<MemoryEdit>) => presenter.changeDraft(patch), [presenter]);
  const cancelEdit = useCallback(() => presenter.cancelEdit(), [presenter]);
  const saveEdit = useCallback(() => presenter.saveEdit(), [presenter]);
  const confirm = useCallback((id: string) => presenter.confirm(id), [presenter]);
  const remove = useCallback((id: string) => presenter.remove(id), [presenter]);
  const confirmSelected = useCallback(() => presenter.confirmSelected(), [presenter]);
  const deleteSelected = useCallback(() => presenter.deleteSelected(), [presenter]);

  return useMemo(() => ({
    ...snapshot,
    refresh,
    setFilter,
    toggleSelect,
    selectAllVisible,
    clearSelection,
    beginEdit,
    changeDraft,
    cancelEdit,
    saveEdit,
    confirm,
    remove,
    confirmSelected,
    deleteSelected,
  }), [
    snapshot, refresh, setFilter, toggleSelect, selectAllVisible, clearSelection,
    beginEdit, changeDraft, cancelEdit, saveEdit, confirm, remove, confirmSelected, deleteSelected,
  ]);
}
