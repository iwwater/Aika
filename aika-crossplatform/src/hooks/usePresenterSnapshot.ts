import { useCallback, useSyncExternalStore } from "react";

/** Presenter 快照订阅的最小接口。Presenter 不认识 React，绑定只发生在这一层。 */
export interface PresenterSnapshotSource<T> {
  getSnapshot(): T;
  subscribe(listener: () => void): () => void;
}

/**
 * 把不可变快照接到 React。
 *
 * Presenter 保证「状态没变返回同一个对象」，因此不需要每帧重建；订阅随组件
 * 挂载/卸载自动建立与清理，StrictMode 双次挂载也不会留下重复订阅。
 */
export function usePresenterSnapshot<T>(presenter: PresenterSnapshotSource<T>): T {
  const subscribe = useCallback(
    (listener: () => void) => presenter.subscribe(listener),
    [presenter],
  );
  const getSnapshot = useCallback(() => presenter.getSnapshot(), [presenter]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
