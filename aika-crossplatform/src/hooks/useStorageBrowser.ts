import { useCallback, useEffect, useMemo } from "react";
import { useService } from "../app/kernelContext";
import { StoragePresenterToken } from "../presentation/tokens";
import { usePresenterSnapshot } from "./usePresenterSnapshot";

/**
 * 存储浏览适配器（FE-12）。
 *
 * 与另外几个 Hook 同一个形状：取 Presenter、订阅快照、把操作转成命令。
 * 只读门禁在 domain，这里不做任何判断——包括「这条 SQL 能不能跑」。
 */
export function useStorageBrowser() {
  const presenter = useService(StoragePresenterToken);
  const snapshot = usePresenterSnapshot(presenter);

  // 幂等：StrictMode 双次挂载不会重复装载。
  useEffect(() => {
    void presenter.start();
  }, [presenter]);

  const refresh = useCallback(() => presenter.refresh(), [presenter]);
  const selectTable = useCallback((name: string) => presenter.selectTable(name), [presenter]);
  const setQuery = useCallback((sql: string) => presenter.setQuery(sql), [presenter]);
  const runQuery = useCallback(() => presenter.runQuery(), [presenter]);

  return useMemo(
    () => ({ ...snapshot, refresh, selectTable, setQuery, runQuery }),
    [snapshot, refresh, selectTable, setQuery, runQuery],
  );
}
