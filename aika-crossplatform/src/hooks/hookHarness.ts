/**
 * Hook 测试用的最小 React 运行时。
 *
 * 它按调用顺序保存 ref/state/memo/effect 槽位，能覆盖 useCompanionSession 用到的
 * 全部 Hook，并支持 rerender 与 cleanup。放在这里是为了让多个 Hook 测试共用同一份，
 * 而不是各抄一遍导致行为慢慢分叉。
 */

export class HookHarness {
  private slots: Array<{ kind: string; value: any; deps?: readonly unknown[]; cleanup?: () => void }> = [];
  private cursor = 0;
  private renderFunction: (() => unknown) | null = null;
  result: any;

  render(renderFunction: () => unknown) {
    this.renderFunction = renderFunction;
    this.cursor = 0;
    this.result = renderFunction();
    return this.result;
  }

  rerender() {
    if (!this.renderFunction) throw new Error("hook has not been rendered");
    return this.render(this.renderFunction);
  }

  useRef(initial: unknown) {
    const slot = this.take("ref", { current: initial });
    return slot.value;
  }

  useState(initial: unknown) {
    const slot = this.take("state", typeof initial === "function" ? (initial as () => unknown)() : initial);
    const setState = (next: unknown) => {
      slot.value = typeof next === "function"
        ? (next as (value: unknown) => unknown)(slot.value)
        : next;
    };
    return [slot.value, setState] as const;
  }

  useMemo(factory: () => unknown, deps: readonly unknown[] | undefined) {
    const slot = this.take("memo", undefined);
    if (!slot.deps || !sameDeps(slot.deps, deps)) {
      slot.value = factory();
      slot.deps = deps;
    }
    return slot.value;
  }

  useCallback(factory: unknown, deps: readonly unknown[] | undefined) {
    return this.useMemo(() => factory, deps);
  }

  useEffect(effect: () => void | (() => void), deps: readonly unknown[] | undefined) {
    const slot = this.take("effect", undefined);
    if (!slot.deps || !sameDeps(slot.deps, deps)) {
      slot.cleanup?.();
      const cleanup = effect();
      slot.cleanup = typeof cleanup === "function" ? cleanup : undefined;
      slot.deps = deps;
    }
  }

  /**
   * Presenter 快照订阅。
   *
   * 真实 React 会在 subscribe 身份变化时重订阅；这里按槽位订阅一次，
   * 快照每次渲染实时读，足以验证「订阅建立/清理」与「快照即取即用」。
   */
  useSyncExternalStore(subscribe: (listener: () => void) => () => void, getSnapshot: () => unknown) {
    const slot = this.take("store", undefined);
    if (!slot.cleanup) slot.cleanup = subscribe(() => undefined);
    return getSnapshot();
  }

  cleanup() {
    for (const slot of this.slots) slot.cleanup?.();
    this.slots = [];
  }

  private take(kind: string, initial: unknown) {
    const current = this.slots[this.cursor];
    if (current && current.kind !== kind) throw new Error(`hook order changed: ${current.kind} -> ${kind}`);
    const slot = current ?? { kind, value: initial };
    this.slots[this.cursor] = slot;
    this.cursor += 1;
    return slot;
  }
}

export function sameDeps(left: readonly unknown[], right: readonly unknown[] | undefined) {
  if (!right || left.length !== right.length) return false;
  return left.every((value, index) => Object.is(value, right[index]));
}

/** 推进若干轮微任务，让 Hook 里的异步链走到下一段。 */
export async function flushMicrotasks(times = 20): Promise<void> {
  for (let index = 0; index < times; index += 1) await Promise.resolve();
}
