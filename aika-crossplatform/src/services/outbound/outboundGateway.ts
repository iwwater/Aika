/**
 * Outbound Gateway（FE-14）：远程协议内核与受控消息投影。
 *
 * 职责边界：
 * - Runtime 事件 → 白名单投影帧（reply 由 generated 投影；status 只剩 code/state/
 *   requestId；error.message 永不外发）。
 * - turnId → 授权目标映射：未映射轮次不外发；映射在提交时登记、TTL 到期清理。
 * - 命令：submit/ping。submit 按 主体+conversation+messageId 去重（TTL 内重放零
 *   重复提交），进入统一 facade（mode 取会话已保存配置）；跨身份提交/取消他人
 *   轮次一律拒绝。ping 回应原连接。
 * - trace 四门：本地采集开 + 远程外发开 + 主体授权 + 显式订阅。默认远程正文关，
 *   本地 includeText 开不连带授权。
 * - 缓冲有数量/字节上限：慢消费者丢帧并计数；消费确认不确定时不自动重投 submit。
 */

import {
  OUTBOUND_SCHEMA_VERSION, OUTBOUND_TEXT_MAX_CODEPOINTS,
  type AuthenticatedCommand, type AuthorizedTarget, type OutboundCursor,
  type OutboundFrameV1, type RemoteDisplayAction, type RemoteReplyV1,
} from "./contracts";
import type { RuntimeEvent } from "../runtime/companionRuntime";

/** 会话已保存的编排配置（不读全局可变值）。 */
export interface ConversationConfig {
  mode: { mode: string };
}

export interface OutboundRuntimePort {
  /** 统一 facade 的提交；scope 语义与 RT-02 一致。 */
  submit(request: {
    text: string;
    source: "text";
    conversation?: { conversationId: string; principalId: string };
    mode?: { mode: string };
  }): {
    turnId: string;
    done: Promise<{ state: string }>;
  };
  cancel(turnId: string, scope?: { conversationId: string }): void;
}

export interface OutboundTraceGates {
  /** 本地 Trace 采集开关。 */
  localTraceEnabled: boolean;
  /** 远程外发总开关（独立于本地 includeText）。 */
  remoteOutboundEnabled: boolean;
  /** 远程正文开关：默认关；本地 includeText 不连带开启。 */
  remoteTextEnabled: boolean;
  /** 主体授权名单：不在名单内的订阅者拿不到任何 trace 帧。 */
  authorizedPrincipals?: readonly string[];
}

export interface OutboundGatewayOptions {
  gatewayEpoch: string;
  runtime: OutboundRuntimePort;
  /** 会话已保存配置；未登记的会话用默认 mode。 */
  configForConversation?: (conversationId: string) => { mode: { mode: string } } | null;
  maxBufferFrames?: number;
  maxBufferBytes?: number;
  bufferTtlMs?: number;
  dedupeTtlMs?: number;
  clock?: () => number;
  idFactory?: () => string;
}

export interface CommandVerdict {
  accepted: boolean;
  reason?: "invalid-body" | "unsupported-version" | "unsupported-type" | "empty-text" | "text-too-long"
    | "unauthorized" | "duplicate" | "internal";
  turnId?: string;
  requestId?: string;
  pong?: boolean;
}

export interface OutboundGateway {
  /** transport 接入：返回退订（FE-14-G conformance 用）。 */
  attachTransport(transport: {
    publish(target: AuthorizedTarget, frame: OutboundFrameV1): void;
    onCommand(handler: (input: AuthenticatedCommand) => void): () => void;
  }): () => void;
  /** 提交时登记 turnId → 授权目标（映射是外发的唯一依据）。 */
  registerTarget(turnId: string, target: AuthorizedTarget): void;
  /** Runtime 事件入口（组合根用 runtime.subscribe 接进来）。 */
  handleRuntimeEvent(event: RuntimeEvent): void;
  handleCommand(command: AuthenticatedCommand): Promise<CommandVerdict>;
  /** trace 四门开关（组合根每次设置变化时刷新）。 */
  setTraceGates(gates: OutboundTraceGates): void;
  /** 显式订阅某会话的 trace 投影；返回退订。 */
  subscribeTrace(target: AuthorizedTarget): () => void;
  /** 四门全开才外发的 trace 投影入口（入参须已脱敏）。 */
  publishTraceProjection(input: { conversationId: string; event: { kind: string; turnId: string; seq: number; at: number } }): void;
  traceGateState(): OutboundTraceGates;
  diagnostics(): { droppedFrames: number; duplicateCommands: number };
}

interface ConnectionBuffer {
  frames: OutboundFrameV1[];
  bytes: number;
  droppedFrames: number;
}

export function createOutboundGateway(options: OutboundGatewayOptions): OutboundGateway {
  const clock = options.clock ?? (() => Date.now());
  const maxBufferFrames = options.maxBufferFrames ?? 200;
  const maxBufferBytes = options.maxBufferBytes ?? 512 * 1024;
  const bufferTtlMs = options.bufferTtlMs ?? 5 * 60_000;
  const dedupeTtlMs = options.dedupeTtlMs ?? 10 * 60_000;

  let seq = 0;
  const registrations = new Map<string, { target: AuthorizedTarget; registeredAt: number }>();
  const buffers = new Map<string, ConnectionBuffer>();
  const transports: Array<{ publish(target: AuthorizedTarget, frame: OutboundFrameV1): void }> = [];
  const dedupe = new Map<string, number>();
  const traceSubscriptions = new Map<string, AuthorizedTarget>();
  let traceGates: OutboundTraceGates = { localTraceEnabled: false, remoteOutboundEnabled: false, remoteTextEnabled: false };
  let duplicateCommands = 0;

  function nextCursor(): OutboundCursor {
    seq += 1;
    return { gatewayEpoch: options.gatewayEpoch, seq };
  }

  function publishToTarget(target: AuthorizedTarget, build: (cursor: OutboundCursor) => OutboundFrameV1): void {
    const frame = build(nextCursor());
    const bufferKey = `${target.connectionId}:${target.conversationId}`;
    let buffer = buffers.get(bufferKey);
    if (!buffer) {
      buffer = { frames: [], bytes: 0, droppedFrames: 0 };
      buffers.set(bufferKey, buffer);
    }
    buffer.frames.push(frame);
    buffer.bytes += JSON.stringify(frame).length;
    // 慢消费者限额：丢最旧的帧并计数；gap 由传输分页元信息表达，不谎称连续。
    while (buffer.frames.length > maxBufferFrames || buffer.bytes > maxBufferBytes) {
      const dropped = buffer.frames.shift();
      buffer.bytes -= dropped ? JSON.stringify(dropped).length : 0;
      buffer.droppedFrames += 1;
    }
    for (const transport of transports) transport.publish(target, frame);
  }

  function expireMappings(now: number): void {
    for (const [turnId, registration] of registrations) {
      if (now - registration.registeredAt > bufferTtlMs) registrations.delete(turnId);
    }
    for (const [key, at] of dedupe) {
      if (now - at > dedupeTtlMs) dedupe.delete(key);
    }
  }

  /** reply 白名单投影：memoryCandidates/内部数据在这里就消失；动作只留类型。 */
  function projectReply(reply: {
    replyText?: string;
    translation?: string | null;
    mood?: string;
    actions?: readonly { type: string; payload?: unknown }[];
    memoryCandidates?: unknown;
  }): RemoteReplyV1 {
    const actions: RemoteDisplayAction[] = (reply.actions ?? [])
      .filter((action) => action.type === "sticker")
      .map((action) => ({ type: action.type }));
    return {
      replyText: reply.replyText ?? "",
      translation: reply.translation ?? null,
      mood: reply.mood ?? "neutral",
      actions,
    };
  }

  return {
    attachTransport(transport) {
      transports.push(transport);
      return () => {
        const index = transports.indexOf(transport);
        if (index >= 0) transports.splice(index, 1);
      };
    },

    registerTarget(turnId, target) {
      registrations.set(turnId, { target, registeredAt: clock() });
    },

    handleRuntimeEvent(event) {
      expireMappings(clock());
      const registration = registrations.get(event.turnId);
      // 未映射轮次不外发（FE-14-A/B）。
      if (!registration) return;
      const target = registration.target;

      if (event.type === "generated") {
        publishToTarget(target, (cursor) => ({
          schemaVersion: OUTBOUND_SCHEMA_VERSION,
          cursor,
          turnId: event.turnId,
          conversationId: target.conversationId,
          payload: { channel: "reply", reply: projectReply(event.reply) },
        }));
        return;
      }
      if (event.type === "state") {
        publishToTarget(target, (cursor) => ({
          schemaVersion: OUTBOUND_SCHEMA_VERSION,
          cursor,
          turnId: event.turnId,
          conversationId: target.conversationId,
          payload: { channel: "status", status: { code: "turn-state", state: event.state } },
        }));
        return;
      }
      if (event.type === "settled") {
        publishToTarget(target, (cursor) => ({
          schemaVersion: OUTBOUND_SCHEMA_VERSION,
          cursor,
          turnId: event.turnId,
          conversationId: target.conversationId,
          payload: { channel: "status", status: { code: "settled", state: event.state } },
        }));
        return;
      }
      if (event.type === "error") {
        // 白名单：只有 code 与可重试性，message 绝不外发。
        publishToTarget(target, (cursor) => ({
          schemaVersion: OUTBOUND_SCHEMA_VERSION,
          cursor,
          turnId: event.turnId,
          conversationId: target.conversationId,
          payload: { channel: "status", status: { code: event.code, state: event.retryable ? "retryable" : "fatal" } },
        }));
      }
      // replyDelta 不外发：远程第一版只收整句，不与整句投影重复。
    },

    async handleCommand(command) {
      // 安全授权端口缺失时不接入命令（FE-14-F）：principal 缺失即拒绝。
      if (!command.principal?.principalId?.trim() || !command.conversationId?.trim()) {
        return { accepted: false, reason: "unauthorized" };
      }
      const body = parseCommand(command.raw);
      if (!body.ok) return { accepted: false, reason: body.reason };

      if (body.command.type === "ping") {
        const requestId = body.command.requestId;
        const target: AuthorizedTarget = {
          connectionId: command.connectionId,
          conversationId: command.conversationId,
          principalId: command.principal.principalId,
        };
        // ping 回应原连接。
        publishToTarget(target, (cursor) => ({
          schemaVersion: OUTBOUND_SCHEMA_VERSION,
          cursor,
          conversationId: command.conversationId,
          payload: { channel: "status", status: { code: "pong", requestId } },
        }));
        return { accepted: true, pong: true, requestId };
      }

      // submit：按 主体+conversation+messageId 去重（TTL 内重放零重复提交）。
      const dedupeKey = `${command.principal.principalId}:${command.conversationId}:${body.command.messageId}`;
      if (dedupe.has(dedupeKey)) {
        duplicateCommands += 1;
        return { accepted: false, reason: "duplicate" };
      }
      dedupe.set(dedupeKey, clock());

      const config = options.configForConversation?.(command.conversationId) ?? null;
      const handle = options.runtime.submit({
        text: body.command.text,
        source: "text",
        conversation: { conversationId: command.conversationId, principalId: command.principal.principalId },
        mode: config?.mode ?? { mode: "companion" },
      });
      // 提交时登记映射：这轮只发给这个目标。
      this.registerTarget(handle.turnId, {
        connectionId: command.connectionId,
        conversationId: command.conversationId,
        principalId: command.principal.principalId,
      });
      return { accepted: true, turnId: handle.turnId };
    },

    setTraceGates(gates) {
      traceGates = { ...gates };
    },

    subscribeTrace(target) {
      const key = `${target.connectionId}:${target.conversationId}:${target.principalId}`;
      traceSubscriptions.set(key, target);
      return () => {
        traceSubscriptions.delete(key);
      };
    },

    /**
     * trace 投影入口（FE-14-E）：四门全开才外发——
     * 本地采集开 + 远程外发开 + 主体授权 + 显式订阅。
     * 入参必须是已经统一脱敏函数处理过的投影；远程正文默认关，
     * 本地 includeText 开不连带授权（v1 的投影根本不带正文）。
     */
    publishTraceProjection(input: { conversationId: string; event: { kind: string; turnId: string; seq: number; at: number } }): void {
      if (!traceGates.localTraceEnabled || !traceGates.remoteOutboundEnabled) return;
      for (const target of traceSubscriptions.values()) {
        if (target.conversationId !== input.conversationId) continue;
        if (traceGates.authorizedPrincipals && !traceGates.authorizedPrincipals.includes(target.principalId)) continue;
        publishToTarget(target, (cursor) => ({
          schemaVersion: OUTBOUND_SCHEMA_VERSION,
          cursor,
          turnId: input.event.turnId,
          conversationId: target.conversationId,
          payload: { channel: "trace", trace: { ...input.event } },
        }));
      }
    },

    traceGateState: () => ({ ...traceGates }),

    diagnostics: () => {
      let droppedFrames = 0;
      for (const buffer of buffers.values()) droppedFrames += buffer.droppedFrames;
      return { droppedFrames, duplicateCommands };
    },
  };
}

/** 命令体校验（FE-14-D）：版本/type/空串/超长/畸形。 */
export function parseCommand(raw: unknown):
  | { ok: true; command: { type: "ping"; requestId: string } | { type: "submit"; messageId: string; text: string } }
  | { ok: false; reason: "invalid-body" | "unsupported-version" | "unsupported-type" | "empty-text" | "text-too-long" } {
  if (!raw || typeof raw !== "object") return { ok: false, reason: "invalid-body" };
  const body = raw as Record<string, unknown>;
  if (body.schemaVersion !== 1) return { ok: false, reason: "unsupported-version" };
  if (body.type === "ping") {
    if (typeof body.requestId !== "string" || !body.requestId.trim()) return { ok: false, reason: "invalid-body" };
    return { ok: true, command: { type: "ping", requestId: body.requestId } };
  }
  if (body.type === "submit") {
    if (typeof body.messageId !== "string" || !body.messageId.trim()) return { ok: false, reason: "invalid-body" };
    if (typeof body.text !== "string" || !body.text.trim()) return { ok: false, reason: "empty-text" };
    // Unicode 码点上限：Array.from 按码点数。
    if (Array.from(body.text).length > OUTBOUND_TEXT_MAX_CODEPOINTS) return { ok: false, reason: "text-too-long" };
    return { ok: true, command: { type: "submit", messageId: body.messageId, text: body.text } };
  }
  return { ok: false, reason: "unsupported-type" };
}
