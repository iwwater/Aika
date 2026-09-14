import type { Clock, Timers } from "../time/tokens";
import {
  DEFAULT_PET_PROBE_POLICY,
  PET_CONFIG_DEFAULTS,
  PET_DEFAULT_DEADLINE_MS,
  PET_MAX_STATUS_POINTS,
  PET_MAX_TEXT_POINTS,
  PET_MAX_TTL_MS,
  PET_MIN_TTL_MS,
  isPetEvent,
  normalizePetConfig,
  projectPetText,
  skipped,
  unknownResult,
  type Capability,
  type DesktopPetAdapter,
  type DesktopPetProcessPort,
  type DesktopPetService,
  type DesktopPetSnapshot,
  type PetCallOptions,
  type PetCapabilityMap,
  type PetCapabilityName,
  type PetConfig,
  type PetConfigInput,
  type PetConnection,
  type PetContext,
  type PetDiagnosticEvent,
  type PetDiagnostics,
  type PetEvent,
  type PetProfileLike,
  type PetProbePolicy,
  type PetProviderId,
  type PetResult,
  type PetResultCode,
  type PetStatus,
} from "./contracts";
import {
  capabilityAllows,
  deriveCapabilities,
  resolveActionId,
  resolveEmotionId,
  semanticActionNames,
  unknownCapabilities,
  validatePetProfile,
  type PetProfileV1,
} from "./profile";

/**
 * 桌宠接入服务（PET-02）。
 *
 * 职责只有四件：**分配**（commandId / deadline / generation）、**守门**
 * （enabled / 期限 / 能力 / 白名单）、**降级**（离线、incompatible、adapter 异常
 * 全部变成结构化结果）、**观测**（快照订阅 + 计数诊断）。
 *
 * 它**不是**第二套对话编排：轮次顺序、取消、终态只由 `CompanionRuntime` 决定，
 * 这里只消费已经被业务层判定为「该展示」的最终结果。它也不做动画排程——
 * 那是第三方 Runtime 的事。
 *
 * 三处刻意的设计：
 * 1. 能力是「profile ∩ 已验证映射 ∩ 连接状态」的交集，任何一环缺失都降级。
 * 2. 断线不把缓存当可用：非 ready 一律 `stale`，能力回落到 unknown。
 * 3. 一切可预期错误都返回 `PetResult`，未知异常在边界转成诊断——业务轮次
 *    绝不因为桌宠挂了而失败。
 */

export interface DesktopPetServiceDeps {
  adapter: DesktopPetAdapter;
  clock: Clock;
  timers: Timers;
  profile?: PetProfileV1 | null;
  config?: PetConfigInput;
  /** 进程端口（PET-05）；浏览器宿主没有它就只做 attach 探测。 */
  process?: DesktopPetProcessPort;
  probe?: PetProbePolicy;
  onDiagnostic?: (event: PetDiagnosticEvent) => void;
  /**
   * profile 被换成什么了（PET-06）。
   *
   * adapter 也要按同一份 profile 把语义名翻成 animationId；它在装配期拿到的是
   * 一个 getter，所以必须有人把「换过了」这件事传下去，否则 Service 校验通过、
   * adapter 却按旧映射发命令。
   */
  onProfileChange?: (profile: PetProfileV1 | null) => void;
}

export function createDesktopPetService(deps: DesktopPetServiceDeps): DesktopPetService {
  const policy = deps.probe ?? DEFAULT_PET_PROBE_POLICY;

  let config: PetConfig = normalizePetConfig({ ...PET_CONFIG_DEFAULTS, ...(deps.config ?? {}) });
  let profile: PetProfileV1 | null = deps.profile ? validatePetProfile(deps.profile) : null;
  let generation = 0;
  let enabled = false;
  let disposed = false;

  let connection: PetConnection = "disabled";
  let runtimeVersion: string | undefined;
  let petId: string | undefined;
  let declared: Partial<PetCapabilityMap> = {};
  let capabilities: PetCapabilityMap = unknownCapabilities();
  let stale = true;
  let checkedAt = 0;

  let commandSeq = 0;
  let probeHandle: unknown = null;
  let backoffIndex = 0;
  let probeInFlight: Promise<PetStatus> | null = null;

  const listeners = new Set<(snapshot: DesktopPetSnapshot) => void>();
  const diagnostics: PetDiagnostics = {
    sent: 0, accepted: 0, skipped: 0, failed: 0, unknown: 0,
    truncatedTexts: 0, invalidInputs: 0, staleDropped: 0,
    probes: 0, probeFailures: 0, lastErrorCode: null, lastCheckedAt: 0,
  };

  let snapshotCache: DesktopPetSnapshot = buildSnapshot();

  function provider(): PetProviderId {
    return config.provider;
  }

  function buildSnapshot(): DesktopPetSnapshot {
    return {
      enabled,
      connection,
      stale,
      actions: capabilityAllows(capabilities.action) ? semanticActionNames(profile) : [],
      capabilities: { ...capabilities },
      checkedAt,
      generation,
    };
  }

  function diagnose(event: PetDiagnosticEvent): void {
    try {
      deps.onDiagnostic?.(event);
    } catch {
      // 诊断回调是宿主的事，它的异常不该改变接入层行为。
    }
  }

  function notify(event: PetDiagnosticEvent): void {
    snapshotCache = buildSnapshot();
    diagnose(event);
    for (const listener of [...listeners]) {
      try {
        listener(snapshotCache);
      } catch {
        // 单个订阅者抛错不影响其他人（Presenter 卸载竞态）。
      }
    }
  }

  function refreshDerived(): void {
    capabilities = deriveCapabilities({
      declared,
      profile,
      connection,
      provider: provider(),
      ...(runtimeVersion !== undefined ? { runtimeVersion } : {}),
      ...(petId !== undefined ? { petId } : {}),
    });
    // 非 ready 一律标 stale：缓存的能力不允许被当作「当前可用」。
    stale = connection !== "ready";
  }

  function currentStatus(): PetStatus {
    return {
      provider: provider(),
      connection,
      ...(runtimeVersion !== undefined ? { runtimeVersion } : {}),
      ...(petId !== undefined ? { petId } : {}),
      checkedAt,
      stale,
      capabilities: { ...capabilities },
      actions: capabilityAllows(capabilities.action) ? semanticActionNames(profile) : [],
    };
  }

  function applyProbe(raw: PetStatus): void {
    const previousPet = petId;
    connection = raw.connection;
    runtimeVersion = raw.runtimeVersion;
    petId = raw.petId;
    declared = raw.capabilities ?? {};
    checkedAt = raw.checkedAt || deps.clock.now();
    diagnostics.lastCheckedAt = checkedAt;
    refreshDerived();
    // adapter 明确报告快照是缓存的，即使连接恢复也不当当前可用。
    if (raw.stale) stale = true;
    // 角色在运行期间被换掉：旧动作映射立即失效，并让在途命令的结果不算数。
    if (previousPet !== undefined && raw.petId !== previousPet) {
      generation += 1;
      diagnose({ type: "probe", code: "role_changed" });
    }
  }

  function stopProbeLoop(): void {
    if (probeHandle !== null) {
      deps.timers.clearTimeout(probeHandle);
      probeHandle = null;
    }
  }

  function startProbeLoop(): void {
    stopProbeLoop();
    if (!enabled || disposed) return;
    const backoff = policy.backoffMs;
    const delay = connection === "ready"
      ? policy.intervalMs
      : backoff[Math.min(backoffIndex, Math.max(0, backoff.length - 1))] ?? policy.intervalMs;
    probeHandle = deps.timers.setTimeout(() => {
      probeHandle = null;
      if (!enabled || disposed) return;
      void probeOnce().then(() => {
        backoffIndex = connection === "ready" ? 0 : backoffIndex + 1;
        startProbeLoop();
      });
    }, delay);
  }

  /** 单飞探测：同一时刻最多 1 个在途请求（契约 §4）。 */
  function probeOnce(): Promise<PetStatus> {
    if (probeInFlight) return probeInFlight;
    const seenGeneration = generation;
    const run = (async (): Promise<PetStatus> => {
      diagnostics.probes += 1;
      try {
        const raw = await deps.adapter.status();
        if (disposed || seenGeneration !== generation) return currentStatus();
        applyProbe(raw);
        notify({ type: "probe" });
        return currentStatus();
      } catch {
        if (disposed || seenGeneration !== generation) return currentStatus();
        diagnostics.probeFailures += 1;
        connection = "offline";
        refreshDerived();
        notify({ type: "error", code: "probe_failed" });
        return currentStatus();
      }
    })();
    probeInFlight = run;
    run.then(() => {
      if (probeInFlight === run) probeInFlight = null;
    }, () => {
      if (probeInFlight === run) probeInFlight = null;
    });
    return run;
  }

  function countResult(result: PetResult): void {
    switch (result.outcome) {
      case "accepted": diagnostics.accepted += 1; break;
      case "skipped": diagnostics.skipped += 1; break;
      case "failed": diagnostics.failed += 1; break;
      case "unknown": diagnostics.unknown += 1; break;
    }
    if (result.code) diagnostics.lastErrorCode = result.code;
  }

  type Preparation =
    | { ok: true; context: PetContext }
    | { ok: false; result: PetResult };

  function prepare(capability: PetCapabilityName, options?: PetCallOptions): Preparation {
    if (disposed || !enabled) return { ok: false, result: skipped("disabled") };
    if (connection === "connecting" || connection === "offline") {
      return { ok: false, result: skipped("offline") };
    }
    if (connection === "incompatible") return { ok: false, result: skipped("unsupported") };
    if (!capabilityAllows(capabilities[capability])) {
      return { ok: false, result: skipped("unsupported") };
    }
    const now = deps.clock.now();
    const bounded = Math.min(options?.deadlineMs ?? PET_DEFAULT_DEADLINE_MS, PET_DEFAULT_DEADLINE_MS);
    const expiresAt = now + Math.max(0, bounded);
    // 剩余寿命不足就不要再发：一句三秒前的回复此刻冒出来比不显示更糟。
    if (expiresAt - now < PET_MIN_TTL_MS) return { ok: false, result: skipped("expired") };
    // 展示时长独立于发送期限：调用方按文本长短给值，这里只做 500–10000ms 收口。
    const ttlMs = Math.min(Math.max(options?.ttlMs ?? bounded, PET_MIN_TTL_MS), PET_MAX_TTL_MS);
    commandSeq += 1;
    return {
      ok: true,
      context: {
        commandId: `${generation}-${commandSeq}`,
        ...(options?.runtimeTurnId !== undefined ? { runtimeTurnId: options.runtimeTurnId } : {}),
        expiresAt,
        ttlMs,
      },
    };
  }

  /**
   * 统一发送路径。
   *
   * 发出去之后的迟到结果**不更新新状态**：generation 已经前移说明用户换了目标
   * 或角色，旧结果只作为本次调用的返回值如实上交，由调用方决定是否展示。
   */
  async function send(
    capability: PetCapabilityName,
    options: PetCallOptions | undefined,
    call: (context: PetContext) => Promise<PetResult>,
  ): Promise<PetResult> {
    const prepared = prepare(capability, options);
    if (!prepared.ok) {
      countResult(prepared.result);
      diagnose({ type: "rejected", code: prepared.result.code });
      return prepared.result;
    }
    const seenGeneration = generation;
    diagnostics.sent += 1;
    let result: PetResult;
    try {
      result = await call(prepared.context);
    } catch {
      // adapter 内部的未知异常在这里变成结果，绝不冒泡到对话编排。
      result = unknownResult("protocol_error");
    }
    if (disposed || seenGeneration !== generation) {
      diagnostics.staleDropped += 1;
      return result;
    }
    countResult(result);
    diagnose({ type: "command", outcome: result.outcome, ...(result.code ? { code: result.code } : {}) });
    return result;
  }

  function invalid(code: PetResultCode): PetResult {
    diagnostics.invalidInputs += 1;
    const result = skipped(code);
    countResult(result);
    diagnose({ type: "rejected", code });
    return result;
  }

  return {
    async enable(): Promise<void> {
      if (disposed || enabled) return;
      enabled = true;
      generation += 1;
      connection = "connecting";
      refreshDerived();
      notify({ type: "probe" });

      if (config.mode === "managed" && deps.process) {
        try {
          await deps.process.ensureReady();
        } catch {
          connection = "offline";
          refreshDerived();
        }
      }
      await probeOnce();
      // 退避序列从第一档（2s）开始；就绪时 startProbeLoop 用的是正常间隔。
      backoffIndex = 0;
      startProbeLoop();
    },

    async disable(): Promise<void> {
      if (!enabled && connection === "disabled") return;
      enabled = false;
      generation += 1;
      stopProbeLoop();
      // 取消未完成的启动/重启计划；已经在跑的实例不在这里终止。
      deps.process?.cancelPending?.();
      connection = "disabled";
      runtimeVersion = undefined;
      petId = undefined;
      declared = {};
      checkedAt = 0;
      refreshDerived();
      // 关闭不停止进程：attach 实例从来不是我们的，托管实例按 stopOwnedOnExit 另行处理。
      notify({ type: "probe" });
    },

    isEnabled(): boolean {
      return enabled;
    },

    snapshot(): DesktopPetSnapshot {
      return snapshotCache;
    },

    async status(): Promise<PetStatus> {
      // 关闭状态零网络：探测只在启用后发生。
      if (disposed || !enabled) return currentStatus();
      return probeOnce();
    },

    async say(text: string, options?: PetCallOptions): Promise<PetResult> {
      const projection = projectPetText(text, PET_MAX_TEXT_POINTS);
      if (!projection.text) return invalid("invalid_input");
      if (projection.truncated) diagnostics.truncatedTexts += 1;
      return send("say", options, (context) => deps.adapter.say(projection.text, context));
    },

    async action(name: string, options?: PetCallOptions): Promise<PetResult> {
      const semantic = typeof name === "string" ? name.trim() : "";
      if (!semantic) return invalid("invalid_input");
      if (!resolveActionId(profile, semantic)) {
        // 白名单之外的动作不是「重试就好」，是「这份 profile 没有它」。
        return invalid("unsupported");
      }
      return send("action", options, (context) => deps.adapter.action(semantic, context));
    },

    async emotion(name: string, options?: PetCallOptions): Promise<PetResult> {
      const mood = typeof name === "string" ? name.trim().toLowerCase() : "";
      if (!mood) return invalid("invalid_input");
      if (!resolveEmotionId(profile, mood)) return invalid("unsupported");
      return send("emotion", options, (context) => deps.adapter.emotion(mood, context));
    },

    async event(type: PetEvent, message?: string, options?: PetCallOptions): Promise<PetResult> {
      if (!isPetEvent(type)) return invalid("invalid_input");
      const projection = projectPetText(message, PET_MAX_STATUS_POINTS);
      if (projection.truncated) diagnostics.truncatedTexts += 1;
      const text = projection.text || undefined;
      return send("event", options, (context) => deps.adapter.event(type, text, context));
    },

    subscribe(listener: (snapshot: DesktopPetSnapshot) => void): () => void {
      if (disposed) return () => {};
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    diagnostics(): PetDiagnostics {
      return { ...diagnostics };
    },

    setProfile(next: PetProfileLike | null): void {
      if (disposed) return;
      profile = next ? validatePetProfile(next) : null;
      deps.onProfileChange?.(profile);
      generation += 1;
      // 换角色/换版本：旧探测结论不再代表新目标。
      runtimeVersion = undefined;
      petId = undefined;
      declared = {};
      checkedAt = 0;
      refreshDerived();
      notify({ type: "probe" });
    },

    async setConfig(input: PetConfigInput): Promise<void> {
      if (disposed) return;
      const next = normalizePetConfig({ ...config, ...input });
      const changed = next.endpoint !== config.endpoint
        || next.provider !== config.provider
        || next.mode !== config.mode
        || next.executablePath !== config.executablePath
        || next.profileId !== config.profileId;
      config = next;
      if (!changed) return;
      generation += 1;
      runtimeVersion = undefined;
      petId = undefined;
      declared = {};
      checkedAt = 0;
      if (enabled) connection = "connecting";
      refreshDerived();
      notify({ type: "probe" });
      if (enabled) {
        backoffIndex = 0;
        await probeOnce();
        startProbeLoop();
      }
    },

    profileSnapshot(): PetProfileV1 | null {
      return profile === null ? null : { ...profile };
    },

    config(): PetConfig {
      return { ...config };
    },

    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      enabled = false;
      generation += 1;
      stopProbeLoop();
      connection = "disabled";
      refreshDerived();
      listeners.clear();
      snapshotCache = buildSnapshot();
      try {
        await deps.adapter.dispose();
      } catch {
        // 释放失败只记诊断：dispose 必须幂等且不抛。
      }
      if (deps.process) {
        try {
          await deps.process.dispose();
        } catch {
          // 同上。
        }
      }
    },
  };
}

/** 供消费方判断「这份能力能不能用来发命令」，避免各处重复写三选一。 */
export function capabilityIsUsable(value: Capability | undefined): boolean {
  return capabilityAllows(value);
}
