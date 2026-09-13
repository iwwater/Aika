import { describe, expect, it } from "vitest";
import type { AcpProcess } from "./acpProtocol";
import { parseAcpStream, validateProcessConfig, buildPermissionResponse, denyOptionId, ADVERTISED_CAPABILITIES } from "./acpProtocol";
import { createAcpClientAdapter } from "./acpClient";

const WS = "C:\\work\\aika";

/** fake ACP 进程：记录 stdin、允许测试注入 stdout/退出。 */
function makeFakeProcess(lines: string[], exitAfter?: number) {
  const stdin: string[] = [];
  const stdoutListeners: Array<(chunk: string) => void> = [];
  const exitListeners: Array<(code: number | null) => void> = [];
  const process: AcpProcess = {
    config: { executable: "agent.exe", args: [], cwd: WS, env: {} },
    writeStdin: (line) => {
      stdin.push(line);
      // initialize/session-new/session-prompt 的响应按序回。
      const index = stdin.length;
      if (index <= lines.length) {
        const chunk = lines[index - 1];
        if (chunk) {
          for (const listener of stdoutListeners) listener(chunk.endsWith("\n") ? chunk : `${chunk}\n`);
        }
      }
    },
    onStdout: (listener) => {
      stdoutListeners.push(listener);
    },
    onExit: (listener) => {
      exitListeners.push(listener);
      if (exitAfter !== undefined) {
        setTimeout(() => {
          for (const exit of exitListeners) exit(exitAfter);
        }, 0);
      }
    },
    kill: () => undefined,
  };
  return { process, stdin };
}

describe("ACP 协议帧解析（AGT-02-A）", () => {
  it("分包重组：跨 chunk 的行拼回完整帧", () => {
    const first = parseAcpStream('{"jsonrpc":"2.0","id":1,"res');
    expect(first.messages).toHaveLength(0);
    const second = parseAcpStream(first.rest + 'ult":{"ok":true}}\n');
    expect(second.messages).toHaveLength(1);
  });

  it("错 JSON → malformed；超大消息 → oversized", () => {
    expect(parseAcpStream("{not-json\n").error).toBe("malformed");
    expect(parseAcpStream(`x${"y".repeat(3 * 1024 * 1024)}\n`).error).toBe("oversized");
  });
});

describe("进程配置校验（AGT-02-C）", () => {
  it("可执行白名单/参数数组/cwd/环境最小化", () => {
    const good = validateProcessConfig(
      { executable: "agent.exe", args: ["--stdio"], cwd: WS, env: { PATH: "", TEMP: "" } },
      ["agent.exe"],
    );
    expect(good.ok).toBe(true);
    expect(validateProcessConfig(
      { executable: "other.exe", args: [], cwd: WS, env: {} },
      ["agent.exe"],
    ).reason).toBe("executable-not-allowed");
    expect(validateProcessConfig(
      // 禁止 shell 拼接：命令必须是单可执行 + 参数数组。
      { executable: "cmd.exe /c del", args: [], cwd: WS, env: {} },
      ["cmd.exe /c del"],
    ).ok).toBe(false);
    expect(validateProcessConfig(
      { executable: "agent.exe", args: "not-array" as unknown as string[], cwd: WS, env: {} },
      ["agent.exe"],
    ).reason).toBe("args-not-array");
    expect(validateProcessConfig(
      { executable: "agent.exe", args: [], cwd: "..\\escape", env: {} },
      ["agent.exe"],
    ).reason).toBe("cwd-invalid");
    expect(validateProcessConfig(
      { executable: "agent.exe", args: [], cwd: WS, env: { CUSTOM_SECRET: "1" } },
      ["agent.exe"],
    ).reason).toBe("env-not-minimal");
  });

  it("未实现 fs/terminal 能力不宣告", () => {
    // 宣告面只有 prompt：fs/terminal 能力未实现即不存在于协商里。
    expect(ADVERTISED_CAPABILITIES).not.toContain("fs");
    expect(ADVERTISED_CAPABILITIES).not.toContain("terminal");
  });
});

describe("ACP 客户端终态映射（AGT-02-A）", () => {
  const validInit = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } });
  const validNew = JSON.stringify({ jsonrpc: "2.0", id: 2, result: { sessionId: "acp-s1" } });

  it("正常 prompt：stopReason 结束 Run（completed 事件）", async () => {
    const promptResponse = JSON.stringify({ jsonrpc: "2.0", id: 3, result: { stopReason: "end_turn" } });
    const { process, stdin } = makeFakeProcess([validInit, validNew, promptResponse]);
    const adapter = createAcpClientAdapter({ processFactory: () => process, executable: "agent.exe", allowedExecutables: ["agent.exe"], workspace: WS });
    const events: string[] = [];
    for await (const event of adapter.send({ sessionId: "s1", prompt: "p", signal: new AbortController().signal })) {
      events.push(event.type);
      if (event.type === "completed") break;
    }
    expect(events).toEqual(["completed"]);
    // session/prompt 已发；initialize 带协议版本。
    expect(stdin.length).toBe(3);
    expect(stdin[0]).toContain('"initialize"');
    expect(stdin[2]).toContain('"session/prompt"');
  });

  it("未知协议版本 → failed 终态", async () => {
    const badVersion = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 99 } });
    const { process } = makeFakeProcess([badVersion]);
    const adapter = createAcpClientAdapter({ processFactory: () => process, executable: "agent.exe", allowedExecutables: ["agent.exe"], workspace: WS });
    const events: string[] = [];
    for await (const event of adapter.send({ sessionId: "s1", prompt: "p", signal: new AbortController().signal })) {
      events.push(`${event.type}:${event.error ?? ""}`);
      if (event.type === "failed") break;
    }
    expect(events.some((entry) => entry.includes("protocol-version-mismatch"))).toBe(true);
  });

  it("错 JSON / 超大消息 → failed 终态（AGT-02-A）", async () => {
    const { process } = makeFakeProcess(["{broken-json\n"]);
    const adapter = createAcpClientAdapter({ processFactory: () => process, executable: "agent.exe", allowedExecutables: ["agent.exe"], workspace: WS });
    for await (const event of adapter.send({ sessionId: "s1", prompt: "p", signal: new AbortController().signal })) {
      if (event.type === "failed") {
        expect(event.error).toBe("stdout-malformed");
        break;
      }
    }

    const { process: bigProcess } = makeFakeProcess([`x${"y".repeat(3 * 1024 * 1024)}\n`]);
    const bigAdapter = createAcpClientAdapter({ processFactory: () => bigProcess, executable: "agent.exe", allowedExecutables: ["agent.exe"], workspace: WS });
    for await (const event of bigAdapter.send({ sessionId: "s1", prompt: "p", signal: new AbortController().signal })) {
      if (event.type === "failed") {
        expect(event.error).toBe("stdout-oversized");
        break;
      }
    }
  });

  it("进程退出 → failed 终态，不悬空（AGT-02-A）", async () => {
    const { process } = makeFakeProcess([], 0);
    const adapter = createAcpClientAdapter({ processFactory: () => process, executable: "agent.exe", allowedExecutables: ["agent.exe"], workspace: WS });
    for await (const event of adapter.send({ sessionId: "s1", prompt: "p", signal: new AbortController().signal })) {
      if (event.type === "failed") {
        expect(event.error).toContain("process-exited");
        break;
      }
    }
  });
});

describe("permission 映射（AGT-02-B）", () => {
  it("buildPermissionResponse 用原 id 与有效 optionId；无效 optionId 拒绝生成", () => {
    const request = {
      id: 7,
      params: { options: [{ optionId: "allow-once", kind: "allow_once" }, { optionId: "reject", kind: "reject" }] },
    };
    const allow = buildPermissionResponse(request, "allow-once");
    expect(allow).toContain('"id":7');
    expect(allow).toContain('"optionId":"allow-once"');
    expect(buildPermissionResponse(request, "fabricated")).toBeNull();
    // 拒绝走协议拒绝选项。
    expect(denyOptionId(request)).toBe("reject");
  });
});

describe("配置门（AGT-02-D 局部）", () => {
  it("adapter.validate 暴露白名单校验结果", () => {
    const { process } = makeFakeProcess([]);
    const adapter = createAcpClientAdapter({ processFactory: () => process, executable: "evil.exe", allowedExecutables: ["agent.exe"], workspace: WS });
    expect(adapter.validate()).toEqual({ ok: false, reason: "executable-not-allowed" });
  });
});
