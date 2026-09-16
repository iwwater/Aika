import type { Clock, Timers } from "../time/tokens";
import type { DesktopPetProcessPort, PetConnection, PetProcessMode } from "./contracts";

/**
 * Sidecar 生命周期与进程所有权（PET-05）。
 *
 * 只管理**配置好的现成可执行程序**：不下载、不更新、不安装上游，也不支持
 * 任意命令执行。两条最贵的错误在这里被结构性地挡住：
 *
 * 1. **误杀别人的进程**。所有权只来自「本次 spawn 返回的句柄」，句柄只存在
 *    内存里：PID 复用、重启后的旧记录、用户自己开的实例都不会被当成我们的。
 *    接口上根本没有「按进程名停止」这种东西。
 * 2. **无限重启**。默认不自动重启；显式开启后也只在**确定崩溃**（退出码非 0
 *    且非 null）时按预算重启，5 分钟最多 2 次。
 */

export type PetProcessHandle = unknown;

export interface PetProcessSpawnOptions {
  /**
   * 受管退出令牌。
   *
   * 只交给**本进程启动的**子进程，且只在校验通过的启动路径上传；attach 路径永不
   * 携带它。原生实现只把它写进一个具名环境变量，不给任意 env 入口。
   */
  exitToken?: string;
  /**
   * 反向点击通道（MVP-12）：`{ url, token }` 成对注入。
   *
   * 方向与退出令牌相反：这一个授权的是**子进程向我们上报点击**。只在校验通过的
   * 受管派生上传；attach 路径永不携带。缺任一个就整体不注入。
   */
  clickUrl?: string;
  clickToken?: string;
}

export interface PetProcessPort {
  /** 使用实参数组、不经过 shell；路径由调用方校验过。 */
  spawn(executablePath: string, options?: PetProcessSpawnOptions): Promise<PetProcessHandle>;
  /**
   * 武装反向点击通道，返回派生时要注入的 `{ url, token }`。
   *
   * 可选：宿主没有这个能力时返回 `null`／不实现，于是受管派生不带点击凭据、
   * 通道保持关闭（子进程零请求）。**不回退**成「没有凭据也让它上报」。
   */
  armClickChannel?(): Promise<{ url: string; token: string } | null>;
  /**
   * 归还所有权时撤销：凭据立刻失效，迟到输入被拒。
   *
   * 与 `arm` 成对出现，缺省即视为无需撤销。
   */
  disarmClickChannel?(): Promise<void>;
  isAlive(handle: PetProcessHandle): boolean | Promise<boolean>;
  /**
   * 退出原因。**可选**：拿不到它就无法断言「确定崩溃」，于是永不自动重启——
   * 这是刻意的 fail-safe，宁可少重启一次，也不要把用户正常关掉的程序拉起来。
   */
  exitInfo?(handle: PetProcessHandle): Promise<{ exited: boolean; code: number | null }>;
  stop(handle: PetProcessHandle): Promise<void>;
}

export type PetProcessErrorKind =
  | "no_port"
  | "incompatible"
  | "invalid_path"
  | "installer_rejected"
  | "script_rejected"
  | "spawn_failed"
  | "start_timeout"
  | "cancelled";

export class PetProcessError extends Error {
  constructor(readonly kind: PetProcessErrorKind) {
    super(kind);
    this.name = "PetProcessError";
  }
}

export const PET_START_PROBE_INTERVAL_MS = 500;
export const PET_START_TIMEOUT_MS = 15_000;
export const PET_STOP_TIMEOUT_MS = 3_000;
export const PET_RESTART_BUDGET = 2;
export const PET_RESTART_WINDOW_MS = 5 * 60_000;
export const PET_RESTART_DELAY_MS = 1_000;

/** 脚本一律不接受：配置的是程序，不是「让 Aiki 帮我跑一段东西」。 */
const SCRIPT_EXT = /\.(bat|cmd|ps1|psm1|vbs|vbe|js|mjs|cjs|py|sh|com|scr|msi)$/i;

export interface ExecutableValidation {
  ok: boolean;
  path?: string;
  kind?: PetProcessErrorKind;
}

/** 安装器不是启动路径：它装完就退出，配成启动项只会每次都白跑一遍。 */
function looksLikeInstaller(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return lower.includes("setup")
    || lower.includes("installer")
    || lower.startsWith("install")
    || lower.startsWith("unins")
    || lower.startsWith("update")
    || lower.includes("-update");
}

/**
 * 校验运行程序路径。
 *
 * 要求绝对路径：相对路径会随工作目录漂移，用户以为配的是这个程序、实际跑的
 * 是另一个——这类问题不会在启动时报错，只会在「怎么没反应」时才被发现。
 *
 * 安装器判定在「文件存在」之前：上游发布的是 `…-setup.exe`，把"文件不存在"
 * 当成结论会掩盖真正的原因（用户配了安装器而不是运行程序）。
 */
export function validatePetExecutable(rawPath: unknown): ExecutableValidation {
  if (typeof rawPath !== "string") return { ok: false, kind: "invalid_path" };
  const path = rawPath.trim();
  if (!path) return { ok: false, kind: "invalid_path" };
  if (SCRIPT_EXT.test(path)) return { ok: false, kind: "script_rejected" };
  if (!/\.exe$/i.test(path)) return { ok: false, kind: "invalid_path" };
  const isAbsolute = /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\") || path.startsWith("/");
  if (!isAbsolute) return { ok: false, kind: "invalid_path" };
  const fileName = path.split(/[\\/]/).pop() ?? "";
  if (!fileName || looksLikeInstaller(fileName)) return { ok: false, kind: "installer_rejected" };
  return { ok: true, path };
}

export type PetProcessPhase =
  | "idle" | "probing" | "starting" | "ready" | "incompatible" | "offline";

export interface PetProcessStatus {
  mode: PetProcessMode;
  owned: boolean;
  alive: boolean;
  phase: PetProcessPhase;
  restarts: number;
}

export interface PetProcessConfig {
  mode: PetProcessMode;
  executablePath: string | null;
  autoRestart: boolean;
  stopOwnedOnExit: boolean;
}

export interface PetProcessDiagnostics {
  spawns: number;
  attaches: number;
  restarts: number;
  budgetExceeded: number;
  stopped: number;
  stopFailures: number;
  /** 协议退出被受理的次数。 */
  protocolExits: number;
  /** 协议退出未成功、回退到进程句柄的次数（能力缺失/凭据失效/对面拒绝）。 */
  protocolExitFallbacks: number;
  lastError: PetProcessErrorKind | null;
}

export interface PetProcessManager extends DesktopPetProcessPort {
  /**
   * 喂入一次健康检查结论。
   *
   * 由装配层在每次探测后调用：管理器据此判断「进程还活着但 API 掉线」（只降级、
   * 不重 spawn）与「进程确实崩了」（按预算重启）。它自己不轮询。
   */
  observe(connection: PetConnection): void;
  status(): PetProcessStatus;
  diagnostics(): PetProcessDiagnostics;
  cancelPending(): void;
}

export interface PetProcessManagerDeps {
  clock: Clock;
  timers: Timers;
  /** 探测桌宠端点是否就绪；返回归一化连接状态。 */
  probe: () => Promise<PetConnection>;
  config: () => PetProcessConfig;
  port?: PetProcessPort | null;
  startProbeIntervalMs?: number;
  startTimeoutMs?: number;
  stopTimeoutMs?: number;
  restartBudget?: number;
  restartWindowMs?: number;
  restartDelayMs?: number;
  /**
   * 生成受管退出令牌。缺省则协议退出不可用，一律走进程句柄。
   *
   * 令牌只存在内存里，随所有权释放而丢弃，不进日志、不进快照、不落盘。
   */
  createExitToken?: () => string;
  /**
   * 协议退出（可选增量）。
   *
   * 只在 `owned === true` 的实例上被调用。返回 `false` 表示这次没有退出成功
   * （能力未声明、凭据失效、对面拒绝、超时），调用方**必须**回退到进程句柄——
   * 这条回退是「新能力缺失时不扩大终止范围」的落点。
   */
  protocolExit?: (token: string) => Promise<boolean>;
}

export function createPetProcessManager(deps: PetProcessManagerDeps): PetProcessManager {
  const startProbeIntervalMs = deps.startProbeIntervalMs ?? PET_START_PROBE_INTERVAL_MS;
  const startTimeoutMs = deps.startTimeoutMs ?? PET_START_TIMEOUT_MS;
  const stopTimeoutMs = deps.stopTimeoutMs ?? PET_STOP_TIMEOUT_MS;
  const restartBudget = deps.restartBudget ?? PET_RESTART_BUDGET;
  const restartWindowMs = deps.restartWindowMs ?? PET_RESTART_WINDOW_MS;
  const restartDelayMs = deps.restartDelayMs ?? PET_RESTART_DELAY_MS;

  let handle: PetProcessHandle | null = null;
  let owned = false;
  /** 只在本进程持有所有权期间存在。 */
  let ownedExitToken: string | null = null;
  let phase: PetProcessPhase = "idle";
  let disposed = false;
  let cancelled = false;
  let startInFlight: Promise<void> | null = null;
  let restartTimes: number[] = [];
  const restartTimers = new Set<unknown>();
  const diagnostics: PetProcessDiagnostics = {
    spawns: 0, attaches: 0, restarts: 0, budgetExceeded: 0,
    stopped: 0, stopFailures: 0, protocolExits: 0, protocolExitFallbacks: 0,
    lastError: null,
  };

  /**
   * 放弃所有权：两种凭据都要一起丢。
   *
   * 退出令牌不再属于我们就不再使用；点击凭据必须**主动撤销**——否则迟到的点击
   * 仍会被受理，等于「实例已经不属于我们了，它还能替我们说话」。
   */
  function releaseOwnership(): void {
    handle = null;
    owned = false;
    ownedExitToken = null;
    if (deps.port?.disarmClickChannel) {
      void deps.port.disarmClickChannel().catch(() => {
        // 撤销失败由宿主侧记账；这里不重试，也不阻塞所有权释放。
      });
    }
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      deps.timers.setTimeout(resolve, ms);
    });
  }

  async function withTimeout<T>(work: Promise<T>, ms: number, kind: PetProcessErrorKind): Promise<T> {
    let timer: unknown = null;
    const timeout = new Promise<never>((_, reject) => {
      timer = deps.timers.setTimeout(() => reject(new PetProcessError(kind)), ms);
    });
    try {
      return await Promise.race([work, timeout]);
    } finally {
      if (timer !== null) deps.timers.clearTimeout(timer);
    }
  }

  async function alive(current: PetProcessHandle): Promise<boolean> {
    if (!deps.port) return false;
    try {
      return await Promise.resolve(deps.port.isAlive(current));
    } catch {
      // 探测不了就当作不确定 → 不视为存活，也不据此重启。
      return false;
    }
  }

  async function probeOnce(): Promise<PetConnection> {
    try {
      return await deps.probe();
    } catch {
      return "offline";
    }
  }

  async function waitForReady(): Promise<boolean> {
    const deadline = deps.clock.now() + startTimeoutMs;
    for (;;) {
      if (disposed || cancelled) return false;
      if (deps.clock.now() >= deadline) return false;
      await sleep(startProbeIntervalMs);
      if (disposed || cancelled) return false;
      const connection = await probeOnce();
      // 子进程活着不等于窗口/HTTP 就绪：就绪只以探测结论为准。
      if (connection === "ready") return true;
      if (connection === "incompatible") return false;
    }
  }

  async function startManaged(): Promise<void> {
    const config = deps.config();
    if (!deps.port) {
      diagnostics.lastError = "no_port";
      throw new PetProcessError("no_port");
    }

    // 先 probe 再 spawn：已有兼容实例就 attach，**永不接管**它。
    const before = await probeOnce();
    if (before === "ready") {
      phase = "ready";
      owned = false;
      handle = null;
      diagnostics.attaches += 1;
      return;
    }
    if (before === "incompatible") {
      // 端口被别的服务占着：不抢端口、不终止占用者，只如实报不兼容。
      phase = "incompatible";
      diagnostics.lastError = "incompatible";
      throw new PetProcessError("incompatible");
    }

    const validation = validatePetExecutable(config.executablePath);
    if (!validation.ok || !validation.path) {
      phase = "offline";
      diagnostics.lastError = validation.kind ?? "invalid_path";
      throw new PetProcessError(validation.kind ?? "invalid_path");
    }

    phase = "starting";
    // 令牌只发给**这次由我们启动的**进程：attach 分支在上面已经返回，走不到这里。
    // 生成不了就当作没有令牌——协议退出失效，回退到既有句柄策略，而不是让启动失败。
    let exitToken: string | null = null;
    if (deps.createExitToken) {
      try {
        exitToken = deps.createExitToken() || null;
      } catch {
        exitToken = null;
      }
    }
    // 反向点击通道：只在**这一次受管派生**上武装。拿不到凭据就不带——通道保持
    // 关闭（子进程零请求），而不是让它没凭据也乱报、只换来一串 403。
    let click: { url: string; token: string } | null = null;
    if (deps.port.armClickChannel) {
      try {
        click = await deps.port.armClickChannel();
      } catch {
        click = null;
      }
    }
    const spawnOptions: PetProcessSpawnOptions = {};
    if (exitToken) spawnOptions.exitToken = exitToken;
    if (click) {
      spawnOptions.clickUrl = click.url;
      spawnOptions.clickToken = click.token;
    }

    let spawned: PetProcessHandle;
    try {
      spawned = await deps.port.spawn(
        validation.path,
        Object.keys(spawnOptions).length > 0 ? spawnOptions : undefined,
      );
    } catch {
      phase = "offline";
      diagnostics.lastError = "spawn_failed";
      // 武装过但没有实例在位：立刻撤销，别让凭据悬着。
      if (click && deps.port.disarmClickChannel) {
        void deps.port.disarmClickChannel().catch(() => {});
      }
      throw new PetProcessError("spawn_failed");
    }
    handle = spawned;
    owned = true;
    ownedExitToken = exitToken;
    diagnostics.spawns += 1;

    if (!(await waitForReady())) {
      phase = "offline";
      diagnostics.lastError = "start_timeout";
      // 保留所有权：进程是我们起的，用户仍然可以选择停止它。
      throw new PetProcessError(cancelled ? "cancelled" : "start_timeout");
    }

    // 单实例转交：我们起的那个进程已经退出，但服务端点是通的——说明窗口由
    // **别的实例**提供。这时候按 attach 处理，绝不把它当成自己的进程。
    if (!(await alive(spawned))) {
      releaseOwnership();
      diagnostics.attaches += 1;
    }
    phase = "ready";
  }

  function recordRestart(): boolean {
    const now = deps.clock.now();
    restartTimes = restartTimes.filter((at) => now - at < restartWindowMs);
    if (restartTimes.length >= restartBudget) {
      diagnostics.budgetExceeded += 1;
      return false;
    }
    restartTimes.push(now);
    return true;
  }

  function scheduleRestart(): void {
    if (!deps.config().autoRestart) return;
    if (!recordRestart()) return;
    const timer = deps.timers.setTimeout(() => {
      restartTimers.delete(timer);
      if (disposed || cancelled) return;
      releaseOwnership();
      diagnostics.restarts += 1;
      void ensureReady().catch(() => {
        // 重启失败就是 offline；用户仍可手动重连。
      });
    }, restartDelayMs);
    restartTimers.add(timer);
  }

  async function checkAfterOffline(): Promise<void> {
    const current = handle;
    if (!current || !owned || disposed) return;
    if (await alive(current)) {
      // 存活但 API 掉线：降级并等下一次探测，**不重复 spawn**。
      phase = "offline";
      return;
    }
    phase = "offline";
    const info = deps.port?.exitInfo ? await deps.port.exitInfo(current).catch(() => null) : null;
    // 只有「确定崩溃」（exited 且退出码非 0）才谈重启；正常退出与原因不明一律
    // 释放所有权，交给用户手动重连——把用户主动关掉的程序拉起来是最糟的行为。
    const crashed = info !== null && info.exited && info.code !== null && info.code !== 0;
    releaseOwnership();
    if (crashed) scheduleRestart();
  }

  function cancelPending(): void {
    cancelled = true;
    for (const timer of restartTimers) deps.timers.clearTimeout(timer);
    restartTimers.clear();
    if (phase === "starting" || phase === "probing") phase = "offline";
  }

  function ensureReady(): Promise<void> {
    if (disposed) return Promise.reject(new PetProcessError("cancelled"));
    const config = deps.config();

    if (config.mode === "attach") {
      // attach 模式：只探测。任何错误分支都零 spawn、零 stop。
      cancelled = false;
      phase = "probing";
      return probeOnce().then((connection) => {
        phase = connection === "ready"
          ? "ready"
          : connection === "incompatible" ? "incompatible" : "offline";
      });
    }

    // 并发启动合并：同一时刻只有一次启动过程。
    if (startInFlight) return startInFlight;
    cancelled = false;
    const run = startManaged().finally(() => {
      if (startInFlight === run) startInFlight = null;
    });
    startInFlight = run;
    return run;
  }

  return {
    ensureReady,

    observe(connection: PetConnection): void {
      if (disposed) return;
      const config = deps.config();
      if (config.mode !== "managed") return;
      if (connection === "incompatible") {
        phase = "incompatible";
        return;
      }
      if (connection !== "offline") return;
      void checkAfterOffline();
    },

    status(): PetProcessStatus {
      return { mode: deps.config().mode, owned, alive: handle !== null && owned, phase, restarts: diagnostics.restarts };
    },

    diagnostics(): PetProcessDiagnostics {
      return { ...diagnostics };
    },

    state() {
      return { mode: deps.config().mode, owned, alive: handle !== null && owned };
    },

    cancelPending,

    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      cancelPending();
      // 等一次在途启动结束，避免它在 dispose 之后又把进程拉起来。
      if (startInFlight) {
        try {
          await startInFlight;
        } catch {
          // 启动失败本身就是被抓过的结果。
        }
      }
      const config = deps.config();
      const current = handle;
      // 只有「自己启动的 + 配置允许终止」才谈终止；attach 与已释放所有权的分支
      // 一律零动作，绝不扩大终止范围。
      if (current !== null && owned && config.stopOwnedOnExit && deps.port) {
        if (await alive(current)) {
          const token = ownedExitToken;
          if (token !== null && deps.protocolExit) {
            // 先请 sidecar 自己退出：它会释放 HTTP 监听、托盘与渲染资源。
            let graceful = false;
            try {
              graceful = await withTimeout(deps.protocolExit(token), stopTimeoutMs, "cancelled");
            } catch {
              graceful = false;
            }
            if (graceful) diagnostics.protocolExits += 1;
            else diagnostics.protocolExitFallbacks += 1;
          }
          try {
            // 协议退出成功时这一步只是释放句柄（进程已自行退出）；它失败时，
            // 这一步才是真正的终止路径。
            await withTimeout(deps.port.stop(current), stopTimeoutMs, "cancelled");
            diagnostics.stopped += 1;
          } catch {
            // 超时有界：不能因为一个停不掉的进程拖住 Aiki 退出。
            diagnostics.stopFailures += 1;
          }
        }
      }
      // stopOwnedOnExit=false：保留自有进程并**释放所有权**，下次只 attach。
      releaseOwnership();
      phase = "idle";
    },
  };
}
