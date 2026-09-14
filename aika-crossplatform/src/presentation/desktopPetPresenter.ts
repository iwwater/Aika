import {
  PET_DEFAULT_DEADLINE_MS,
  PET_MAX_TTL_MS,
  skipped,
  type DesktopPetService,
  type DesktopPetSnapshot,
  type PetCapabilityMap,
  type PetConnection,
  type PetResult,
  type PetStatus,
} from "../services/desktopPet/contracts";
import {
  createPetCommandBuffer,
  type PetCommandBuffer,
  type PetCommandBufferDiagnostics,
  type PetQueuedCommand,
} from "../services/desktopPet/commandBuffer";
import {
  activityCommand,
  attentionCommand,
  finalReplyCommands,
  settlementCommands,
  thinkingCommand,
  type PetCommandSpec,
} from "../services/desktopPet/eventMapping";
import type { PetProfileV1 } from "../services/desktopPet/profile";
import type { Clock } from "../services/time/tokens";

/**
 * 桌宠展示桥接（PET-04）。
 *
 * 职责：把**公开展示事件**投影成桌宠命令，交给有界发送器，再把 Service 状态
 * 投影成界面用的快照。它**不**感知屏幕、**不**调用 Agent、**不**发明第二套
 * 对话编排——轮次顺序与终态只由 `CompanionRuntime` 决定。
 *
 * 刻意不 import `services/runtime/companionRuntime`：单 Runtime facade 门禁
 * 不允许，而且也不需要——这里声明一份**结构更窄**的输入形状，宿主装配时把
 * 真实 Runtime 的 `subscribe` 直接传进来即可（结构化类型天然兼容）。
 */

/** 只声明我们真的会读的字段；比 `RuntimeEvent` 更窄。 */
export interface DesktopPetRuntimeEvent {
  turnId: string;
  seq: number;
  type: string;
  state?: string;
  reply?: {
    replyText?: string;
    mood?: string;
    motion?: string;
    expression?: string;
  };
  text?: string;
  code?: string;
}

export interface DesktopPetRuntimePort {
  subscribe(listener: (event: DesktopPetRuntimeEvent) => void): () => void;
}

export interface DesktopPetView {
  /** 宿主是否有桌宠能力（无 Service 时为 false，界面隐藏入口）。 */
  available: boolean;
  enabled: boolean;
  connection: PetConnection;
  stale: boolean;
  capabilities: PetCapabilityMap;
  actions: string[];
  checkedAt: number;
  generation: number;
}

export interface DesktopPetPresenterDeps {
  /** 宿主没有桌宠能力时为 null：Presenter 仍然存在，只是永远 available=false。 */
  service: DesktopPetService | null;
  runtime: DesktopPetRuntimePort | null;
  clock: Clock;
  profile?: () => PetProfileV1 | null;
  buffer?: PetCommandBuffer;
  onDiagnostic?: (event: { type: string; command?: string; outcome?: string; code?: string }) => void;
}

export interface DesktopPetPresenter {
  available(): boolean;
  start(): void;
  /** 只解绑订阅与清空待发；**不**释放 Service（那是装配层的所有权）。 */
  dispose(): void;
  snapshot(): DesktopPetView;
  subscribe(listener: (view: DesktopPetView) => void): () => void;
  /** 「测试连接」：启用状态才发真实请求；关闭状态如实返回 disabled，不偷偷探测。 */
  testConnection(): Promise<PetStatus | null>;
  /**
   * 受控显式入口：现有 Runtime 没有工具/审阅语义的公开事件，
   * 因此只能由明确的调用方触发，绝不根据文本猜「她是不是在调工具」。
   */
  notifyActivity(kind: "tool-running" | "reviewing"): void;
  notifyAttention(): void;
  /** 用户手动演示：不附假 turnId，一次一条，直接走 Service 拿真实结果。 */
  demo(text: string): Promise<PetResult | null>;
  bufferDiagnostics(): PetCommandBufferDiagnostics;
}

interface TurnState {
  hadReplyText: boolean;
}

/** 单轮状态表的硬上限：防止极端情况下（终态事件丢失）无限增长。 */
const MAX_TRACKED_TURNS = 32;

/** 阅读节奏：文本气泡的存活基数与每字增量。 */
const TEXT_TTL_BASE_MS = 4_000;
const TEXT_TTL_PER_CHAR_MS = 120;

/**
 * 一条命令该活多久。
 *
 * `PET_DEFAULT_DEADLINE_MS` 是**发送**的等待上限，不是气泡该显示多久。早期版本
 * 把这两个概念用了同一个数，结果是一整句话的气泡只存在 4 秒：用户还没读完就消失，
 * 反馈读起来就是「她好像没回应」——真机核对时这一点让结论悬了很久。
 *
 * 文本按阅读节奏给时间（4 秒起，每字 120ms），上限由 `PET_MAX_TTL_MS` 兜住；
 * 其余命令（thinking 短句、动作、情绪）保持默认值，免得一直占着屏幕。
 */
export function ttlForSpec(spec: PetCommandSpec): number {
  if (spec.kind !== "say" || typeof spec.text !== "string" || spec.text.length === 0) {
    return PET_DEFAULT_DEADLINE_MS;
  }
  const reading = TEXT_TTL_BASE_MS + spec.text.length * TEXT_TTL_PER_CHAR_MS;
  return Math.min(Math.max(reading, PET_DEFAULT_DEADLINE_MS), PET_MAX_TTL_MS);
}

export function createDesktopPetPresenter(deps: DesktopPetPresenterDeps): DesktopPetPresenter {
  const listeners = new Set<(view: DesktopPetView) => void>();
  const turnStates = new Map<string, TurnState>();
  /**
   * 已经作废的轮次。
   *
   * 光靠「清掉待发」不够：旧轮**迟到**的 `generated`/`settled` 会重新入队，
   * 那正是「旧轮不得覆盖新轮」要挡的东西。所以把作废的轮次记下来，之后它的
   * 任何事件都不再产生命令。有界是因为终态事件理论上可能永远不来。
   */
  const closedTurns = new Map<string, true>();
  let activeTurnId: string | null = null;
  let manualSeq = 0;
  let started = false;
  let unsubscribeRuntime: (() => void) | null = null;
  let unsubscribeService: (() => void) | null = null;

  function buildView(): DesktopPetView {
    const snapshot: DesktopPetSnapshot | null = deps.service?.snapshot() ?? null;
    return {
      available: deps.service !== null,
      enabled: snapshot?.enabled ?? false,
      connection: snapshot?.connection ?? "disabled",
      stale: snapshot?.stale ?? true,
      capabilities: snapshot?.capabilities ?? emptyCapabilities(),
      actions: snapshot?.actions ?? [],
      checkedAt: snapshot?.checkedAt ?? 0,
      generation: snapshot?.generation ?? 0,
    };
  }

  let viewCache: DesktopPetView = buildView();

  function notify(): void {
    viewCache = buildView();
    for (const listener of [...listeners]) {
      try {
        listener(viewCache);
      } catch {
        // 单个订阅者抛错不影响其它订阅者（React 卸载竞态）。
      }
    }
  }

  /**
   * profile 是**活配置**：默认直接问 Service 要，而不是在装配期抄一份。
   *
   * 抄一份的后果很具体：设置里换了角色/版本之后，桥接还在按旧映射判断「这个
   * mood 有没有映射」，于是要么少发一个本来能发的动作，要么发一个已经不成立的。
   * 显式注入的 `deps.profile` 仍然优先（测试与特殊宿主用）。
   */
  const readProfile = deps.profile ?? (() => deps.service?.profileSnapshot() ?? null);

  function profile(): PetProfileV1 | null {
    return readProfile();
  }

  const buffer: PetCommandBuffer = deps.buffer ?? createPetCommandBuffer({
    clock: deps.clock,
    currentGeneration: () => deps.service?.snapshot().generation ?? -1,
    isEnabled: () => deps.service?.isEnabled() ?? false,
    send: (command) => sendCommand(command),
  });

  async function sendCommand(command: PetQueuedCommand): Promise<PetResult> {
    const service = deps.service;
    if (!service) return skipped("disabled");
    // 队列表里的剩余寿命就是气泡还该显示多久：命令入队时已按文本长度定过 TTL。
    const remaining = command.expiresAt - deps.clock.now();
    const options = {
      ...(command.runtimeTurnId !== undefined ? { runtimeTurnId: command.runtimeTurnId } : {}),
      ...(remaining > 0 ? { ttlMs: remaining } : {}),
    };
    let result: PetResult;
    switch (command.kind) {
      case "say":
        result = await service.say(command.text ?? "", options);
        break;
      case "action":
        result = command.name ? await service.action(command.name, options) : skipped("invalid_input");
        break;
      case "emotion":
        result = command.name ? await service.emotion(command.name, options) : skipped("invalid_input");
        break;
      case "event":
        result = command.event
          ? await service.event(command.event, command.message, options)
          : skipped("invalid_input");
        break;
    }
    // 诊断只带类别、结果与代码，不带正文——日志里不该出现她说的话。
    deps.onDiagnostic?.({
      type: "command",
      command: command.kind,
      outcome: result.outcome,
      ...(result.code !== undefined ? { code: result.code } : {}),
    });
    return result;
  }

  function enqueueSpec(
    spec: PetCommandSpec,
    turnId: string | null,
    dedupeKey: string,
  ): void {
    const service = deps.service;
    if (!service) return;
    const command: PetQueuedCommand = {
      dedupeKey,
      kind: spec.kind,
      intermediate: spec.intermediate,
      generation: service.snapshot().generation,
      expiresAt: deps.clock.now() + ttlForSpec(spec),
      ...(turnId !== null ? { runtimeTurnId: turnId } : {}),
      ...(spec.text !== undefined ? { text: spec.text } : {}),
      ...(spec.name !== undefined ? { name: spec.name } : {}),
      ...(spec.event !== undefined ? { event: spec.event } : {}),
      ...(spec.message !== undefined ? { message: spec.message } : {}),
    };
    buffer.enqueue(command);
  }

  function trackTurn(turnId: string): TurnState {
    const existing = turnStates.get(turnId);
    if (existing) return existing;
    if (turnStates.size >= MAX_TRACKED_TURNS) {
      const oldest = turnStates.keys().next();
      if (!oldest.done) turnStates.delete(oldest.value);
    }
    const created: TurnState = { hadReplyText: false };
    turnStates.set(turnId, created);
    return created;
  }

  function closeTurn(turnId: string): void {
    closedTurns.set(turnId, true);
    while (closedTurns.size > MAX_TRACKED_TURNS) {
      const oldest = closedTurns.keys().next();
      if (oldest.done) break;
      closedTurns.delete(oldest.value);
    }
  }

  function beginTurn(turnId: string): void {
    // 换轮：上一轮如果还没结束，它的待发任务全部作废（Runtime 已把它取消了）。
    if (activeTurnId !== null && activeTurnId !== turnId) {
      closeTurn(activeTurnId);
      buffer.cancelTurn(activeTurnId);
      turnStates.delete(activeTurnId);
    }
    activeTurnId = turnId;
    trackTurn(turnId);
    enqueueSpec(thinkingCommand(), turnId, `${turnId}:thinking`);
  }

  function onGenerated(turnId: string, reply: DesktopPetRuntimeEvent["reply"]): void {
    // 已作废轮次的迟到结果：不产生任何新命令。
    if (closedTurns.has(turnId)) return;
    const state = trackTurn(turnId);
    const view = {
      replyText: typeof reply?.replyText === "string" ? reply.replyText : "",
      mood: typeof reply?.mood === "string" ? reply.mood : "",
      ...(typeof reply?.motion === "string" ? { motion: reply.motion } : {}),
      ...(typeof reply?.expression === "string" ? { expression: reply.expression } : {}),
    };
    if (view.replyText.trim()) state.hadReplyText = true;
    // 生成完成 = 这一轮的中间态使命结束，先清掉还没发出去的 thinking。
    buffer.completeTurn(turnId);
    for (const spec of finalReplyCommands(view, profile())) {
      enqueueSpec(spec, turnId, `${turnId}:${spec.dedupeSuffix}`);
    }
  }

  function onSettled(turnId: string, state: string): void {
    const turn = turnStates.get(turnId);
    buffer.completeTurn(turnId);
    if (state === "cancelled") {
      // 取消是本地撤销：清掉该轮待发，不虚构上游 cancelled 事件。
      closeTurn(turnId);
      buffer.cancelTurn(turnId);
    } else if (!closedTurns.has(turnId)) {
      for (const spec of settlementCommands({
        state: state === "failed" ? "failed" : "completed",
        hadReplyText: turn?.hadReplyText ?? false,
      })) {
        enqueueSpec(spec, turnId, `${turnId}:${spec.dedupeSuffix}`);
      }
      closeTurn(turnId);
    }
    turnStates.delete(turnId);
    if (activeTurnId === turnId) activeTurnId = null;
  }

  function onRuntimeEvent(event: DesktopPetRuntimeEvent): void {
    switch (event.type) {
      case "state":
        if (event.state === "generating") beginTurn(event.turnId);
        return;
      case "generated":
        onGenerated(event.turnId, event.reply);
        return;
      case "settled":
        onSettled(event.turnId, event.state ?? "completed");
        return;
      default:
        // replyDelta：不按 token 发气泡。error：终态由 settled 表达，避免双发。
        return;
    }
  }

  return {
    available(): boolean {
      return deps.service !== null;
    },

    start(): void {
      if (started) return;
      started = true;
      if (deps.runtime) {
        unsubscribeRuntime = deps.runtime.subscribe(onRuntimeEvent);
      }
      if (deps.service) {
        unsubscribeService = deps.service.subscribe(() => notify());
      }
      notify();
    },

    dispose(): void {
      if (!started) return;
      started = false;
      unsubscribeRuntime?.();
      unsubscribeRuntime = null;
      unsubscribeService?.();
      unsubscribeService = null;
      // 关掉桥接不该留下会自己冒出来的指令，也不该顺手关掉用户的桌宠。
      buffer.cancelAll();
      turnStates.clear();
      closedTurns.clear();
      activeTurnId = null;
      listeners.clear();
    },

    snapshot(): DesktopPetView {
      return viewCache;
    },

    subscribe(listener: (view: DesktopPetView) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    async testConnection(): Promise<PetStatus | null> {
      if (!deps.service) return null;
      const status = await deps.service.status();
      notify();
      return status;
    },

    notifyActivity(kind): void {
      manualSeq += 1;
      enqueueSpec(activityCommand(kind), null, `${kind}:manual:${manualSeq}`);
    },

    notifyAttention(): void {
      manualSeq += 1;
      enqueueSpec(attentionCommand(), null, `attention:manual:${manualSeq}`);
    },

    async demo(text: string): Promise<PetResult | null> {
      const service = deps.service;
      if (!service) return null;
      // 手动演示直接走 Service：用户就在等这一条，不该先去排队。
      // 不附假 turnId —— 它本来就不是某一轮对话。
      return service.say(text);
    },

    bufferDiagnostics(): PetCommandBufferDiagnostics {
      return buffer.diagnostics();
    },
  };
}

function emptyCapabilities(): PetCapabilityMap {
  return {
    say: "unknown", action: "unknown", emotion: "unknown", event: "unknown",
    interactionEvents: "unknown", audio: "unknown", lipSync: "unknown",
  };
}
