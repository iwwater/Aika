import { useCallback, useEffect, useMemo } from "react";
import { useService } from "../app/kernelContext";
import { OpsPresenterToken } from "../presentation/tokens";
import { usePresenterSnapshot } from "./usePresenterSnapshot";

/**
 * F9 Ops 成本页适配器（FE-26）。与工作台其它 Hook 同一形状。
 */
export function useOps() {
  const presenter = useService(OpsPresenterToken);
  const snapshot = usePresenterSnapshot(presenter);

  useEffect(() => {
    void presenter.start();
  }, [presenter]);

  const refresh = useCallback(() => presenter.refresh(), [presenter]);
  const loadMore = useCallback(() => presenter.loadMore(), [presenter]);
  const setTimeZone = useCallback((timeZone: string) => presenter.setTimeZone(timeZone), [presenter]);
  const savePrice = useCallback(async (entry: Parameters<typeof presenter.savePrice>[0]) => {
    await presenter.savePrice(entry);
  }, [presenter]);
  const removePrice = useCallback((id: string) => presenter.removePrice(id), [presenter]);

  return useMemo(() => ({
    ...snapshot,
    refresh,
    loadMore,
    setTimeZone,
    savePrice,
    removePrice,
  }), [snapshot, refresh, loadMore, setTimeZone, savePrice, removePrice]);
}
