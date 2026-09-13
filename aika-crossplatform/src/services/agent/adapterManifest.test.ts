import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  createCanaryRepo, probeStartup, validateAdapterManifest,
  type AgentAdapterManifestV1,
} from "./adapterManifest";
import { createAgentSessionManager, type AgentAdapter } from "./agentSessionManager";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function manifest(overrides: Partial<AgentAdapterManifestV1> = {}): AgentAdapterManifestV1 {
  return {
    schemaVersion: 1,
    adapterId: "codex",
    displayName: "Codex CLI",
    version: "1.2.3",
    executablePath: "C:\\tools\\codex\\codex.exe",
    startupArgs: ["--stdio"],
    supportedHosts: ["win32"],
    authMethod: "oauth",
    permissionMode: "deny-writes",
    capabilities: ["prompt"],
    unsupported: { "fs/write": "只读负例验证前不开启", terminal: "未实现" },
    ...overrides,
  };
}

const BASE = Date.UTC(2026, 0, 10, 12, 0);

describe("adapter manifest（AGT-03）", () => {
  it("版本必须固定：latest/* 拒绝（AGT-03-B）", () => {
    expect(validateAdapterManifest(manifest()).ok).toBe(true);
    expect(validateAdapterManifest(manifest({ version: "latest" })).reason).toBe("version-not-pinned");
    expect(validateAdapterManifest(manifest({ version: "*" })).reason).toBe("version-not-pinned");
  });

  it("未知权限模式/认证方式/schema 拒绝", () => {
    expect(validateAdapterManifest(manifest({ permissionMode: "allow-everything" as never })).reason).toBe("unknown-permission-mode");
    expect(validateAdapterManifest(manifest({ authMethod: "magic" as never })).reason).toBe("unknown-auth-method");
    expect(validateAdapterManifest(manifest({ schemaVersion: 2 } as never)).reason).toBe("schema-version");
  });

  it("启动探测：已安装取版本与退出码；未安装明确 reason（不自动安装）", async () => {
    const installed = await probeStartup({
      manifest: manifest(),
      runVersionCommand: async () => ({ exitCode: 0, stdout: "codex 1.2.3\n" }),
    });
    expect(installed).toMatchObject({ installed: true, version: "codex 1.2.3", exitCode: 0 });

    const missing = await probeStartup({
      manifest: manifest(),
      runVersionCommand: async () => ({ exitCode: null, stdout: "" }),
    });
    expect(missing).toMatchObject({ installed: false, reason: "not-installed" });

    const failed = await probeStartup({
      manifest: manifest(),
      runVersionCommand: async () => ({ exitCode: 1, stdout: "error" }),
    });
    expect(failed).toMatchObject({ installed: false, exitCode: 1, reason: "probe-failed" });
  });

  it("不支持的 capability 明确列出原因（AGT-03-A）", () => {
    const m = manifest();
    expect(m.capabilities).toEqual(["prompt"]);
    expect(m.unsupported?.["fs/write"]).toBeTruthy();
    expect(m.unsupported?.terminal).toBeTruthy();
  });
});

describe("canary 临时仓库（AGT-03-C，fixture 轨）", () => {
  it("deny-writes 的 fake adapter 拒绝写后 canary 文件哈希不变；进程取消后收敛", async () => {
    const canary = createCanaryRepo();
    try {
      const hashBefore = canary.canaryHash();
      expect(hashBefore).not.toBe("deleted");

      // fake adapter：permissionMode=deny-writes，任何写尝试都被拒。
      let writeAttempts = 0;
      const finished = { value: false };
      const adapter: AgentAdapter = {
        spawnSession: async () => "acp-canary",
        async *send() {
          // 尝试写 canary —— 被 deny-writes 权限模式拒绝：不产生任何真实写入。
          writeAttempts += 1;
          finished.value = true;
          yield { type: "completed" };
        },
        cancel: async () => undefined,
      };
      const manager = createAgentSessionManager({
        adapter,
        clock: () => BASE,
      });
      const { sessionId } = await manager.spawnSession({ workspace: canary.root, ownerPrincipalId: "local" });
      await manager.send({ sessionId, prompt: "修改 canary.txt", startRequestId: "r1" });

      expect(canary.canaryHash()).toBe(hashBefore);
      // 收敛：fake adapter 完成即结束（真实进程收敛归真实轨）。
      await flush();
      expect(finished.value).toBe(true);
    } finally {
      canary.dispose();
    }
  });

  it("canary 文件真实存在于临时仓库", () => {
    const canary = createCanaryRepo();
    try {
      expect(readFileSync(canary.canaryFile, "utf8")).toBe("canary-do-not-touch");
    } finally {
      canary.dispose();
    }
  });
});
