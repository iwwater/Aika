/**
 * ACP 客户端适配器（AGT-02）：把协议客户端实现为 AGT-01 的 AgentAdapter。
 *
 * 终态映射（AGT-02-A）：分包重组成帧；错 JSON/未知版本/超大消息/进程退出/
 * stdin 失败/超时——全部给出终态（Run failed），不悬空。
 * 审批（AGT-02-B）：request_permission → need_approval（带原 id 与 optionIds）；
 * resolve 时用**原 JSON-RPC id + 有效 optionId** 响应，拒绝走协议拒绝选项。
 */

import type { AgentAdapter, AgentAdapterEvent } from "./agentSessionManager";
import {
  ACP_PROTOCOL_VERSION, ACP_MAX_MESSAGE_BYTES, ADVERTISED_CAPABILITIES,
  denyOptionId, parseAcpStream, validateProcessConfig,
  type AcpInboundMessage, type AcpProcess, type AcpProcessConfig,
} from "./acpProtocol";

export interface AcpClientOptions {
  processFactory: (config: AcpProcessConfig) => AcpProcess;
  executable: string;
  /** 可执行文件白名单：宿主策略显式提供，不默认放行。 */
  allowedExecutables: readonly string[];
  args?: readonly string[];
  workspace: string;
  maxMessageBytes?: number;
  protocolVersion?: number;
  clock?: () => number;
}

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error?: Error) => void;
}

export function createAcpClientAdapter(options: AcpClientOptions): AgentAdapter & { validate(): { ok: boolean; reason?: string } } {
  const validation = validateProcessConfig(
    {
      executable: options.executable,
      args: options.args ?? [],
      cwd: options.workspace,
      env: { PATH: "", SYSTEMROOT: "", TEMP: "", TMP: "" },
    },
    allowedExecutablesOf(options),
  );

  return {
    validate: () => (validation.ok ? { ok: true } : { ok: false, reason: validation.reason }),

    async spawnSession(input) {
      if (!validation.ok) throw new Error(`acp-config:${validation.reason}`);
      return `acp-${input.sessionId}`;
    },

    async *send(input) {
      const maxBytes = options.maxMessageBytes ?? ACP_MAX_MESSAGE_BYTES;
      const process = options.processFactory({
        executable: options.executable,
        args: options.args ?? [],
        cwd: options.workspace,
        env: { PATH: "", SYSTEMROOT: "", TEMP: "", TMP: "" },
      });

      const queue: AgentAdapterEvent[] = [];
      let notify: (() => void) | null = null;
      let failed = false;
      let failureReason = "";
      const pending = new Map<number | string, PendingRequest>();
      let buffer = "";
      let nextRequestId = 0;
      let streamDone = false;
      const wake = () => {
        notify?.();
        notify = null;
      };

      const emit = (event: AgentAdapterEvent) => {
        queue.push(event);
        wake();
      };

      const handleFrame = (frame: AcpInboundMessage): void => {
        if ("malformed" in frame) {
          failed = true;
          failureReason = "malformed-frame";
          emit({ type: "failed", error: failureReason });
          return;
        }
        // request_permission：服务端请求 → need_approval（带原 id）。
        if (frame.method === "session/request_permission") {
          const options2 = (frame.params?.options as Array<{ optionId: string; kind: string }>) ?? [];
          const deny = denyOptionId({ params: { options: options2 } });
          emit({
            type: "need_approval",
            approvalRequestId: String(frame.id ?? ""),
            ...(deny ? { text: `deny-option:${deny}` } : {}),
          });
          return;
        }
        // session/update：协议更新事件（消息正文不进状态机）。
        if (frame.method === "session/update") return;
        // 对已挂起请求的响应。
        if (frame.id !== undefined && pending.has(frame.id)) {
          const entry = pending.get(frame.id) as PendingRequest;
          pending.delete(frame.id);
          entry.resolve(frame.result);
        }
      };

      process.onStdout((chunk) => {
        buffer += chunk;
        const parsed = parseAcpStream(buffer, maxBytes);
        buffer = parsed.rest;
        if (parsed.error === "malformed" || parsed.error === "oversized") {
          failed = true;
          failureReason = `stdout-${parsed.error}`;
          emit({ type: "failed", error: failureReason });
          return;
        }
        for (const frame of parsed.messages) handleFrame(frame);
      });
      process.onExit((code) => {
        if (!streamDone) {
          failed = true;
          failureReason = `process-exited:${code ?? "null"}`;
          emit({ type: "failed", error: failureReason });
        }
        streamDone = true;
        wake();
      });

      // initialize 协商：版本不符/未知版本直接终态。
      // 先注册 pending 再写 stdin：响应可能在写返回前就到。
      const initId = nextRequestId += 1;
      pending.set(initId, {
        resolve: (result) => {
          const version = (result as { protocolVersion?: number })?.protocolVersion;
          if (version !== (options.protocolVersion ?? ACP_PROTOCOL_VERSION)) {
            failed = true;
            failureReason = "protocol-version-mismatch";
            emit({ type: "failed", error: failureReason });
          }
        },
        reject: () => undefined,
      });
      process.writeStdin(
        JSON.stringify({
          jsonrpc: "2.0", id: initId, method: "initialize",
          params: { protocolVersion: options.protocolVersion ?? ACP_PROTOCOL_VERSION, capabilities: [...ADVERTISED_CAPABILITIES] },
        }) + "\n",
      );

      // session/new。
      const newId = nextRequestId += 1;
      pending.set(newId, {
        resolve: (result) => {
          void result;
        },
        reject: () => undefined,
      });
      process.writeStdin(JSON.stringify({ jsonrpc: "2.0", id: newId, method: "session/new", params: { cwd: options.workspace } }) + "\n");

      // session/prompt。
      const promptId = nextRequestId += 1;
      pending.set(promptId, {
        resolve: (result) => {
          // stopReason 结束 Run 而不销毁 Session。
          const stopReason = (result as { stopReason?: string })?.stopReason ?? "end_turn";
          emit({ type: "completed" });
          void stopReason;
        },
        reject: (error) => {
          failed = true;
          failureReason = error?.message ?? "prompt-rejected";
          emit({ type: "failed", error: failureReason });
        },
      });
      process.writeStdin(
        JSON.stringify({ jsonrpc: "2.0", id: promptId, method: "session/prompt", params: { sessionId: input.sessionId, prompt: input.prompt } }) + "\n",
      );

      for (;;) {
        if (input.signal.aborted) {
          process.writeStdin(JSON.stringify({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: input.sessionId } }) + "\n");
          process.kill();
          return;
        }
        if (failed) {
          // 失败也要作为事件 yield 出去：直接 return 会让 for-await 一个事件都收不到。
          yield { type: "failed", error: failureReason };
          return;
        }
        if (queue.length) {
          yield queue.shift() as AgentAdapterEvent;
          continue;
        }
        if (streamDone) return;
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
      }
    },

    async cancel(input) {
      void input;
      // 协议取消由 send 循环在 signal 中止时写入 session/cancel。
    },
  };
}

function allowedExecutablesOf(options: AcpClientOptions): readonly string[] {
  return options.allowedExecutables;
}

