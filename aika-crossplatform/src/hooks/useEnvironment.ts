import { useEffect } from "react";
import { useService } from "../app/kernelContext";
import { EnvironmentPresenterToken } from "../presentation/tokens";
import { usePresenterSnapshot } from "./usePresenterSnapshot";

/**
 * 环境感知设置（FE-19）。
 *
 * Presenter 由注册表提供、快照经 useSyncExternalStore 订阅；start 在挂载时跑一次
 * （幂等），让持久化的开关状态与真实传感器状态对齐。
 */
export function useEnvironment() {
  const presenter = useService(EnvironmentPresenterToken);
  const snapshot = usePresenterSnapshot(presenter);
  useEffect(() => {
    void presenter.start();
  }, [presenter]);
  return { presenter, snapshot };
}
