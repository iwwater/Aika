import { useCallback, useEffect, useMemo } from "react";
import { useService } from "../app/kernelContext";
import { DevToolsPresenterToken } from "../presentation/tokens";
import { usePresenterSnapshot } from "./usePresenterSnapshot";

/**
 * 工作台适配器。
 *
 * 与另外两个 Hook 同一个形状：取 Presenter、订阅快照、把操作转成命令。
 * 不 import 任何 `services/` 实现。
 */
export function useDevTools() {
  const presenter = useService(DevToolsPresenterToken);
  const snapshot = usePresenterSnapshot(presenter);

  // 幂等：StrictMode 双次挂载不会重复装载。
  useEffect(() => {
    void presenter.start();
  }, [presenter]);

  const refresh = useCallback(() => presenter.refresh(), [presenter]);
  const select = useCallback((turnId: string | null) => presenter.select(turnId), [presenter]);
  const setDevMode = useCallback((enabled: boolean) => presenter.setDevMode(enabled), [presenter]);
  const setTraceEnabled = useCallback((enabled: boolean) => presenter.setTraceEnabled(enabled), [presenter]);
  const setTraceIncludeText = useCallback(
    (enabled: boolean) => presenter.setTraceIncludeText(enabled),
    [presenter],
  );

  return useMemo(() => ({
    ...snapshot,
    refresh,
    select,
    setDevMode,
    setTraceEnabled,
    setTraceIncludeText,
  }), [snapshot, refresh, select, setDevMode, setTraceEnabled, setTraceIncludeText]);
}
