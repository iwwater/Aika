import { useCallback, useEffect, useState } from "react";
import { useKernelDescribe } from "../app/kernelContext";
import type { KernelSnapshot } from "../kernel";

/**
 * 装配拓扑的取数（FE-10）。
 *
 * 只读 `kernel.describe()`，不 resolve 任何服务——工作台看拓扑不该成为第四个取依赖
 * 的入口。快照在挂载时取一次，之后靠手动刷新：装配在 `start()` 之后就不再变了，
 * 为一张调试图挂订阅不值得。
 */
export function useKernelSnapshot(): { snapshot: KernelSnapshot | null; refresh: () => void } {
  const describe = useKernelDescribe();
  const [snapshot, setSnapshot] = useState<KernelSnapshot | null>(null);

  const refresh = useCallback(() => {
    setSnapshot(describe ? describe() : null);
  }, [describe]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { snapshot, refresh };
}
