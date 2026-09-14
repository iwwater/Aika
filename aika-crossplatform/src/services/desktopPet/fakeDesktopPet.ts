import type { Clock, Timers } from "../time/tokens";
import type {
  DesktopPetAdapter,
  DesktopPetProcessPort,
  PetCapabilityMap,
  PetConnection,
  PetContext,
  PetEvent,
  PetResult,
  PetStatus,
} from "./contracts";
import { PetHttpFailure, type PetHttpPort, type PetHttpRequest, type PetHttpResponse } from "./openPetProtocol";
import type { PetProcessPort } from "./processManager";
import type { PetProfileV1 } from "./profile";

/**
 * 测试资产（PET-02 / PET-03 / PET-05）。
 *
 * fake 只替代**外部依赖**：桌宠 Runtime 是第三方进程、时钟与定时器是宿主能力、
 * HTTP 是原生宿主传输。被验收的 Service、profile 校验、能力推导、协议判定
 * 全部跑生产实现——这里没有任何一个替身冒充被测逻辑。
 */

export interface FakeClock extends Clock {
  advance(ms: number): void;
  set(ms: number): void;
}

export function createFakeClock(startAt = 0): FakeClock {
  let now = startAt;
  return {
    now: () => now,
    advance(ms) { now += ms; },
    set(ms) { now = ms; },
  };
}

export interface FakeTimers extends Timers {
  /** 推进时间并同步跑完到期的回调（回调里新排的定时器同批处理）。 */
  advance(ms: number): void;
  /** 尚未触发的定时器数量——用来证明 disable 之后没有残留循环。 */
  active(): number;
  pendingDelays(): number[];
}

export function createFakeTimers(): FakeTimers {
  let nextId = 1;
  let now = 0;
  const scheduled = new Map<number, { at: number; handler: () => void }>();
  return {
    setTimeout(handler, ms) {
      const id = nextId++;
      scheduled.set(id, { at: now + Math.max(0, ms), handler });
      return id;
    },
    clearTimeout(handle) {
      if (typeof handle === "number") scheduled.delete(handle);
    },
    advance(ms) {
      now += ms;
      for (;;) {
        const due = [...scheduled.entries()]
          .filter(([, entry]) => entry.at <= now)
          .sort((a, b) => a[1].at - b[1].at);
        const first = due[0];
        if (!first) break;
        scheduled.delete(first[0]);
        first[1].handler();
      }
    },
    active() {
      return scheduled.size;
    },
    pendingDelays() {
      return [...scheduled.values()].map((entry) => entry.at - now).sort((a, b) => a - b);
    },
  };
}

export function readyCapabilities(overrides: Partial<PetCapabilityMap> = {}): PetCapabilityMap {
  return {
    say: "native", action: "mapped", emotion: "mapped", event: "native",
    interactionEvents: "unsupported", audio: "unsupported", lipSync: "unsupported",
    ...overrides,
  };
}

export function fakePetStatus(overrides: Partial<PetStatus> = {}): PetStatus {
  return {
    provider: "openpet",
    connection: "ready",
    checkedAt: 0,
    stale: false,
    capabilities: readyCapabilities(),
    actions: ["wave", "nod"],
    ...overrides,
  };
}

export function fakePetProfile(overrides: Partial<PetProfileV1> = {}): PetProfileV1 {
  return {
    schemaVersion: 1,
    provider: "openpet",
    release: "v0.1.6",
    petId: "default",
    source: "manual",
    actions: { wave: "anim_wave", nod: "anim_nod" },
    emotions: { happy: "anim_happy" },
    events: {},
    ...overrides,
  };
}

export interface FakeAdapterCalls {
  status: number;
  say: string[];
  action: string[];
  emotion: string[];
  event: Array<{ type: PetEvent; message?: string }>;
  dispose: number;
  /** 每次业务调用的归一化上下文（验证 deadline/commandId 由 Service 分配）。 */
  contexts: PetContext[];
}

export interface DeferredStatus {
  resolve(status: PetStatus): void;
  reject(error: unknown): void;
}

export interface FakeDesktopPetAdapter extends DesktopPetAdapter {
  readonly calls: FakeAdapterCalls;
  setStatus(next: PetStatus | (() => Promise<PetStatus>)): void;
  setResult(next: PetResult | (() => Promise<PetResult>)): void;
  /** 按命令类型分别设定结果（例如「action 失败但 say 仍成功」）。 */
  setResultFor(kind: "say" | "action" | "emotion" | "event", next: PetResult): void;
  /** 让下一次 status 挂起，用于验证迟到探测不覆盖新状态。 */
  deferNextStatus(): DeferredStatus;
  /** 记录到的最后一次请求上下文。 */
  lastContext(): PetContext | undefined;
}

export interface FakeAdapterOptions {
  status?: PetStatus | (() => Promise<PetStatus>);
  result?: PetResult | (() => Promise<PetResult>);
}

export function createFakeAdapter(options: FakeAdapterOptions = {}): FakeDesktopPetAdapter {
  const calls: FakeAdapterCalls = {
    status: 0, say: [], action: [], emotion: [], event: [], dispose: 0, contexts: [],
  };
  let statusImpl: () => Promise<PetStatus> = asStatus(options.status ?? fakePetStatus());
  let resultImpl: () => Promise<PetResult> = asResult(options.result ?? { outcome: "accepted" });
  const perKind = new Map<string, PetResult>();
  let deferred: DeferredStatus | null = null;

  function record(context: PetContext): void {
    calls.contexts.push(context);
  }

  function resultFor(kind: string): Promise<PetResult> {
    return Promise.resolve(perKind.get(kind) ?? resultImpl()).then((value) => value);
  }

  return {
    calls,

    setStatus(next) {
      statusImpl = asStatus(next);
    },

    setResult(next) {
      resultImpl = asResult(next);
    },

    setResultFor(kind, next) {
      perKind.set(kind, next);
    },

    deferNextStatus() {
      let resolveFn: (status: PetStatus) => void = () => {};
      let rejectFn: (error: unknown) => void = () => {};
      const promise = new Promise<PetStatus>((resolve, reject) => {
        resolveFn = resolve;
        rejectFn = reject;
      });
      deferred = { resolve: resolveFn, reject: rejectFn };
      statusImpl = () => promise;
      return deferred;
    },

    lastContext() {
      return calls.contexts[calls.contexts.length - 1];
    },

    async status() {
      calls.status += 1;
      if (deferred) deferred = null;
      return statusImpl();
    },

    async say(text, context) {
      calls.say.push(text);
      record(context);
      return resultFor("say");
    },

    async action(name, context) {
      calls.action.push(name);
      record(context);
      return resultFor("action");
    },

    async emotion(name, context) {
      calls.emotion.push(name);
      record(context);
      return resultFor("emotion");
    },

    async event(type, message, context) {
      calls.event.push(message === undefined ? { type } : { type, message });
      record(context);
      return resultFor("event");
    },

    async dispose() {
      calls.dispose += 1;
    },
  };
}

function asStatus(value: PetStatus | (() => Promise<PetStatus>)): () => Promise<PetStatus> {
  return typeof value === "function" ? value : async () => value;
}

function asResult(value: PetResult | (() => Promise<PetResult>)): () => Promise<PetResult> {
  return typeof value === "function" ? value : async () => value;
}

export interface FakeProcessPort extends DesktopPetProcessPort {
  /** 成功就绪次数。 */
  readonly ready: number;
  /** ensureReady 被调用次数（含失败的那次）。 */
  readonly attempts: number;
  readonly disposed: number;
  setFailure(error: unknown | null): void;
}

export function createFakeProcessPort(
  mode: "attach" | "managed" = "managed",
  alive = false,
): FakeProcessPort {
  let failure: unknown | null = null;
  let readyCount = 0;
  let attemptCount = 0;
  let disposeCount = 0;
  let live = alive;
  return {
    get ready() { return readyCount; },
    get attempts() { return attemptCount; },
    get disposed() { return disposeCount; },
    setFailure(error) { failure = error; },
    state() {
      return { mode, owned: mode === "managed", alive: live };
    },
    async ensureReady() {
      attemptCount += 1;
      if (failure) throw failure;
      readyCount += 1;
      live = true;
    },
    async dispose() {
      disposeCount += 1;
      live = false;
    },
  };
}

export function connection(value: PetConnection): PetStatus {
  return fakePetStatus({ connection: value, capabilities: readyCapabilities(), actions: [] });
}

interface FakeProcessRecord {
  alive: boolean;
  exited: boolean;
  code: number | null;
}

export interface FakeOsProcessPort extends PetProcessPort {
  /** spawn 收到过的路径（按顺序）。 */
  readonly spawns: string[];
  readonly stopCalls: number[];
  /** 让某个进程表现为「确定崩溃」（非零退出码）。不传 pid 时作用于最近一次 spawn。 */
  crash(pid?: number, code?: number): void;
  /** 让某个进程表现为「正常退出」（退出码 0）。 */
  exitNormally(pid?: number): void;
  /** 让某个进程表现为「原因不明」（已退出但拿不到退出码）。 */
  exitUnknown(pid?: number): void;
  /** 关掉 exitInfo：模拟宿主不提供退出原因。 */
  disableExitInfo(): void;
  /** 控制 spawn 是否失败。 */
  failSpawnWith(error: unknown | null): void;
  /** 控制 stop 是否永远不返回（验证停止超时有界）。 */
  setStopBehavior(behavior: "ok" | "hang"): void;
  aliveCount(): number;
  lastPid(): number | undefined;
}

/**
 * 假的**操作系统进程端口**（PET-05）。
 *
 * 它只模拟「起一个进程、它还活着吗、它怎么退出的」这三件事；被测的是管理器的
 * 状态机与所有权判断，不是 Windows API。原生实现见 `desktop_pet_process.rs`。
 *
 * 还没有任何 spawn 时调用 `crash()/exitNormally()` 会记成「下一个进程的退出」，
 * 这样测试不必去猜内部异步时序。
 */
export function createFakeOsProcessPort(): FakeOsProcessPort {
  const spawns: string[] = [];
  const stopCalls: number[] = [];
  const processes = new Map<number, FakeProcessRecord>();
  let nextPid = 1000;
  let lastSpawned: number | undefined;
  let exitInfoEnabled = true;
  let spawnFailure: unknown | null = null;
  let stopBehavior: "ok" | "hang" = "ok";
  let pendingExit: { code: number | null } | null = null;

  function mark(pid: number | undefined, code: number | null): void {
    const id = pid ?? lastSpawned;
    if (id === undefined) {
      pendingExit = { code };
      return;
    }
    const entry = processes.get(id);
    if (entry) {
      entry.alive = false;
      entry.exited = true;
      entry.code = code;
    }
  }

  return {
    get spawns() { return spawns; },
    get stopCalls() { return stopCalls; },

    crash(pid, code = 1) {
      mark(pid, code);
    },

    exitNormally(pid) {
      mark(pid, 0);
    },

    exitUnknown(pid) {
      mark(pid, null);
    },

    disableExitInfo() {
      exitInfoEnabled = false;
    },

    failSpawnWith(error) {
      spawnFailure = error;
    },

    setStopBehavior(behavior) {
      stopBehavior = behavior;
    },

    aliveCount() {
      return [...processes.values()].filter((entry) => entry.alive).length;
    },

    lastPid() {
      return lastSpawned;
    },

    async spawn(executablePath) {
      if (spawnFailure) throw spawnFailure;
      spawns.push(executablePath);
      const pid = nextPid++;
      lastSpawned = pid;
      const record: FakeProcessRecord = { alive: true, exited: false, code: null };
      if (pendingExit) {
        record.alive = false;
        record.exited = true;
        record.code = pendingExit.code;
        pendingExit = null;
      }
      processes.set(pid, record);
      return { pid };
    },

    isAlive(handle) {
      const entry = processes.get((handle as { pid: number }).pid);
      return entry?.alive ?? false;
    },

    async exitInfo(handle) {
      if (!exitInfoEnabled) {
        throw new Error("exit info unsupported");
      }
      const entry = processes.get((handle as { pid: number }).pid);
      if (!entry) return { exited: true, code: null };
      return { exited: entry.exited, code: entry.code };
    },

    async stop(handle) {
      const pid = (handle as { pid: number }).pid;
      stopCalls.push(pid);
      if (stopBehavior === "hang") {
        return new Promise<void>(() => {});
      }
      const entry = processes.get(pid);
      if (entry) {
        entry.alive = false;
        entry.exited = true;
        entry.code = 0;
      }
    },
  };
}

/** 把进程端口接到环境连接结论上，模拟「探测到的连接状态」。 */
export function createFakeProbe(...sequence: PetConnection[]): () => Promise<PetConnection> {
  let index = 0;
  return async () => {
    const value = sequence[Math.min(index, Math.max(0, sequence.length - 1))] ?? "offline";
    index += 1;
    return value;
  };
}

export type FakeHttpHandler = (request: PetHttpRequest) => Promise<PetHttpResponse> | PetHttpResponse;

export interface FakePetHttpPort extends PetHttpPort {
  /** 全部请求（含被拒的那些），用来证明 POST 没有重发。 */
  readonly calls: PetHttpRequest[];
  setHandler(next: FakeHttpHandler): void;
  /** 按顺序消费的响应队列；用完后回落到 handler。 */
  enqueue(...responses: Array<PetHttpResponse | Error>): void;
  /** 只统计某个端点的请求数。 */
  countOf(endpoint: PetHttpRequest["endpoint"]): number;
}

/**
 * 假 HTTP 端口。
 *
 * 默认行为是「连接被拒绝」——测试必须显式给出响应，避免忘记准备 fixture 时
 * 用例静默地"成功"。
 */
export function createFakePetHttp(handler?: FakeHttpHandler): FakePetHttpPort {
  const calls: PetHttpRequest[] = [];
  const queue: Array<PetHttpResponse | Error> = [];
  let current: FakeHttpHandler = handler ?? (() => {
    throw new PetHttpFailure("connection");
  });

  return {
    calls,

    setHandler(next) {
      current = next;
    },

    enqueue(...responses) {
      queue.push(...responses);
    },

    countOf(endpoint) {
      return calls.filter((call) => call.endpoint === endpoint).length;
    },

    async send(request) {
      calls.push(request);
      if (request.signal?.aborted) throw new PetHttpFailure("aborted");
      const queued = queue.shift();
      if (queued instanceof Error) throw queued;
      if (queued) return queued;
      return current(request);
    },
  };
}

/** 固定响应器：所有请求都返回同一个状态。 */
export function alwaysRespond(response: PetHttpResponse): FakeHttpHandler {
  return () => response;
}

/** 失败注入器。 */
export function alwaysFail(error: unknown): FakeHttpHandler {
  return () => {
    throw error;
  };
}
