import type { Clock } from "../time/tokens";
import {
  PET_MAX_TTL_MS,
  PET_MIN_TTL_MS,
  skipped,
  type DesktopPetAdapter,
  type PetCapabilityMap,
  type PetConnection,
  type PetContext,
  type PetEvent,
  type PetProductInfo,
  type PetProviderId,
  type PetResult,
  type PetShutdownCapability,
  type PetStatus,
} from "./contracts";
import {
  assertLoopbackBase,
  buildActionRequest,
  buildEventRequest,
  buildRequest,
  buildSayRequest,
  buildShutdownRequest,
  parseOpenPetResponse,
  PetHttpFailure,
  toPostResult,
  type PetHttpPort,
  type PetHttpRequest,
} from "./openPetProtocol";
import {
  resolveActionId,
  resolveEmotionId,
  resolveEventType,
  type PetProfileV1,
} from "./profile";

/**
 * OpenPet HTTP adapter（PET-03）。
 *
 * 只做三件事：把归一化命令翻成上游请求体、把响应翻成 `PetResult`、把连接
 * 状态翻成 `PetStatus`。它不做重试、不做排队、不做事件映射——那些分别在
 * PET-04 的发送器与映射表里；它也不认识 React、Tauri 或任何 UI。
 *
 * 三条刻意的边界：
 * 1. **端点来自固定表**，不是拼出来的 URL；页面拿不到「请求任意地址」的能力。
 * 2. **profile 才决定动作 id**；没有映射就不发请求，不靠乱发动作猜能力。
 * 3. **连接失败与超时严格区分**：前者判 `failed`（确定没送到），后者判 `unknown`
 *    （可能已经送到，所以绝不自动重试）。
 */

export interface OpenPetAdapterDeps {
  http: PetHttpPort;
  clock: Clock;
  /**
   * 归一化的地址，或它的 getter。
   *
   * 传 getter 是因为用户可以在设置里改端口——adapter 是长生命周期对象，
   * 不该在改地址时被整体重建。**构造期仍会校验一次**：配错的地址要在装配时
   * 就报出来，而不是等第一次发送才炸。
   */
  endpoint: string | (() => string);
  /** profile 是活配置：运行期换角色/换版本时按最新值取。 */
  profile?: () => PetProfileV1 | null;
  provider?: PetProviderId;
}

export interface OpenPetAdapter extends DesktopPetAdapter {
  /** 最近一次探测到的上游版本（未提供时为 undefined）。 */
  runtimeVersion(): string | undefined;
  /** 最近一次探测到的角色 id。 */
  currentPetId(): string | undefined;
  /** 最近一次探测到的运行时真实身份；旧运行时为 undefined。 */
  product(): PetProductInfo | undefined;
  /** 最近一次探测到的协议退出能力；缺字段一律为 undefined（等同不可用）。 */
  shutdownCapability(): PetShutdownCapability | undefined;
  /** 协议退出：能力不可用时直接跳过，不发请求。 */
  requestExit(token: string, context: PetContext): Promise<PetResult>;
}

/**
 * OpenPet 协议本身声明具备的能力。
 *
 * `action`/`say`/`event` 是上游确实存在的端点；`emotion` 走 action 表达，所以
 * 它是不是 `mapped` 由 profile 决定，而不是这里。点击回传、音频与口型上游没有
 * ——这条断言来自 PET-01 的端点清单，不是猜的。
 */
const DECLARED_CAPABILITIES: PetCapabilityMap = {
  say: "native",
  action: "native",
  emotion: "unsupported",
  event: "native",
  interactionEvents: "unsupported",
  audio: "unsupported",
  lipSync: "unsupported",
};

export function createOpenPetAdapter(deps: OpenPetAdapterDeps): OpenPetAdapter {
  const endpointValue = typeof deps.endpoint === "string" ? deps.endpoint : null;
  const endpointGetter = typeof deps.endpoint === "function" ? deps.endpoint : null;
  const readEndpoint = (): string => (endpointGetter ? endpointGetter() : endpointValue ?? "");
  // 装配期先验一次：非法地址在这里就该失败，而不是等到第一次发送。
  assertLoopbackBase(readEndpoint());
  const provider: PetProviderId = deps.provider ?? "openpet";
  const readProfile = deps.profile ?? (() => null);

  /** 每次发送前重新解析地址；运行期被改成非法值等于「传输层拦截」。 */
  function base(): string {
    try {
      return assertLoopbackBase(readEndpoint());
    } catch {
      throw new PetHttpFailure("blocked");
    }
  }

  let disposed = false;
  let lastPetId: string | undefined;
  let lastVersion: string | undefined;
  let lastProduct: PetProductInfo | undefined;
  let lastShutdown: PetShutdownCapability | undefined;
  const inFlight = new Set<AbortController>();

  function offline(connection: PetConnection): PetStatus {
    return {
      provider,
      connection,
      ...(lastVersion !== undefined ? { runtimeVersion: lastVersion } : {}),
      ...(lastProduct !== undefined ? { product: lastProduct } : {}),
      ...(lastShutdown !== undefined ? { shutdown: lastShutdown } : {}),
      ...(lastPetId !== undefined ? { petId: lastPetId } : {}),
      checkedAt: deps.clock.now(),
      stale: true,
      capabilities: { ...DECLARED_CAPABILITIES },
      actions: [],
    };
  }

  /**
   * 气泡该显示多久。
   *
   * 发送价值只看 `expiresAt`（不足 500ms 就不发）；显示时长优先用 Service 收口
   * 过的 `ttlMs`，没有才退回旧行为（等于剩余寿命）。两者分开之后，一句话的气泡
   * 不会再因为「发送期限是 4 秒」而只显示 4 秒。
   */
  function remainingTtl(context: PetContext): number | null {
    const now = deps.clock.now();
    const remaining = context.expiresAt - now;
    if (remaining < PET_MIN_TTL_MS) return null;
    const display = context.ttlMs ?? remaining;
    return Math.min(Math.max(display, PET_MIN_TTL_MS), PET_MAX_TTL_MS);
  }

  /**
   * 角色变了就不再用旧映射。
   *
   * 探测是每 10 秒一次，间隙里上游仍可能被换角色；这里用最近一次探测到的
   * `petId` 兜住大部分情况，真被拒了也只是一次失败——不会拿旧映射反复打。
   */
  function profileMatchesCurrentPet(profile: PetProfileV1 | null): profile is PetProfileV1 {
    if (!profile) return false;
    return lastPetId === undefined || lastPetId === profile.petId;
  }

  function transportFailure(error: unknown): PetResult {
    if (error instanceof PetHttpFailure) {
      switch (error.kind) {
        case "timeout": return { outcome: "unknown", code: "timeout" };
        case "connection": return { outcome: "failed", code: "offline" };
        case "aborted": return { outcome: "unknown", code: "cancelled" };
        case "too_large": return { outcome: "unknown", code: "protocol_error" };
        case "blocked": return { outcome: "failed", code: "unsupported" };
      }
    }
    // 未知异常：可能是序列化、也可能是 fake 端口写错。统一当无法证明受理。
    return { outcome: "unknown", code: "protocol_error" };
  }

  async function post(request: PetHttpRequest): Promise<PetResult> {
    if (disposed) return skipped("cancelled");
    const controller = new AbortController();
    inFlight.add(controller);
    try {
      const response = await deps.http.send({ ...request, signal: controller.signal });
      return toPostResult(parseOpenPetResponse(response.status, response.bodyText));
    } catch (error) {
      return transportFailure(error);
    } finally {
      inFlight.delete(controller);
    }
  }

  return {
    async status(): Promise<PetStatus> {
      if (disposed) return offline("disabled");
      try {
        const response = await deps.http.send(buildRequest(base(), "status"));
        const verdict = parseOpenPetResponse(response.status, response.bodyText);
        if (verdict.kind === "accepted") {
          lastPetId = verdict.snapshot?.petId ?? lastPetId;
          lastVersion = verdict.snapshot?.runtimeVersion ?? lastVersion;
          lastProduct = verdict.snapshot?.product ?? lastProduct;
          // 能力随每次探测刷新：实例重启后可能就没有退出令牌了，不能复用旧值。
          lastShutdown = verdict.snapshot?.shutdown ?? lastShutdown;
          return {
            provider,
            connection: "ready",
            ...(lastVersion !== undefined ? { runtimeVersion: lastVersion } : {}),
            ...(lastProduct !== undefined ? { product: lastProduct } : {}),
            ...(lastShutdown !== undefined ? { shutdown: lastShutdown } : {}),
            ...(lastPetId !== undefined ? { petId: lastPetId } : {}),
            checkedAt: deps.clock.now(),
            stale: false,
            capabilities: { ...DECLARED_CAPABILITIES },
            actions: verdict.snapshot?.actions ?? [],
          };
        }
        // 端点不认或响应读不懂 → 对面不是我们要的那个运行时。
        // 这一步很关键：接下来**不会**对这个端口发任何 POST。
        if (verdict.kind === "incompatible" || verdict.kind === "protocol_error") {
          return offline("incompatible");
        }
        return offline("offline");
      } catch (error) {
        if (error instanceof PetHttpFailure && error.kind === "blocked") return offline("incompatible");
        return offline("offline");
      }
    },

    async say(text: string, context: PetContext): Promise<PetResult> {
      const ttl = remainingTtl(context);
      if (ttl === null) return skipped("expired");
      return post(buildSayRequest(base(), text, ttl));
    },

    async action(name: string, context: PetContext): Promise<PetResult> {
      const profile = readProfile();
      const animationId = resolveActionId(profile, name);
      if (!animationId || !profileMatchesCurrentPet(profile)) return skipped("unsupported");
      const ttl = remainingTtl(context);
      if (ttl === null) return skipped("expired");
      return post(buildActionRequest(base(), animationId));
    },

    async emotion(name: string, context: PetContext): Promise<PetResult> {
      const profile = readProfile();
      const animationId = resolveEmotionId(profile, name);
      if (!animationId || !profileMatchesCurrentPet(profile)) return skipped("unsupported");
      const ttl = remainingTtl(context);
      if (ttl === null) return skipped("expired");
      // 上游没有「情绪」这个概念：情绪最终仍然是动作，映射到已核对的 animationId。
      return post(buildActionRequest(base(), animationId));
    },

    async event(type: PetEvent, message: string | undefined, context: PetContext): Promise<PetResult> {
      const ttl = remainingTtl(context);
      if (ttl === null) return skipped("expired");
      // profile 没登记该事件时用同名直传：上游的事件枚举与 Aiki 语义一致。
      const upstreamType = resolveEventType(readProfile(), type) ?? type;
      return post(buildEventRequest(base(), upstreamType, message, ttl));
    },

    async requestExit(token: string, context: PetContext): Promise<PetResult> {
      // 能力没被明确声明可用就不发：普通 attach 客户端没有退出权，试一下不是策略。
      if (!lastShutdown?.available) return skipped("unsupported");
      if (!token.trim()) return skipped("unsupported");
      const ttl = remainingTtl(context);
      if (ttl === null) return skipped("expired");
      return post(buildShutdownRequest(base(), token));
    },

    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      for (const controller of [...inFlight]) {
        try {
          controller.abort();
        } catch {
          // abort 不该抛；真抛了也不能让 dispose 失败。
        }
      }
      inFlight.clear();
    },

    runtimeVersion(): string | undefined {
      return lastVersion;
    },

    currentPetId(): string | undefined {
      return lastPetId;
    },

    product(): PetProductInfo | undefined {
      return lastProduct;
    },

    shutdownCapability(): PetShutdownCapability | undefined {
      return lastShutdown;
    },
  };
}
