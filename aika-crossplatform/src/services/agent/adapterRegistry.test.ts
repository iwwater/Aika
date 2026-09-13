import { describe, expect, it } from "vitest";
import type { AgentAdapterManifestV1 } from "./adapterManifest";
import { createAdapterRegistry } from "./adapterRegistry";

function manifest(adapterId: string, overrides: Partial<AgentAdapterManifestV1> = {}): AgentAdapterManifestV1 {
  return {
    schemaVersion: 1,
    adapterId,
    displayName: adapterId,
    version: "1.0.0",
    executablePath: `C:\\tools\\${adapterId}\\cli.exe`,
    startupArgs: ["--stdio"],
    supportedHosts: ["win32"],
    authMethod: "oauth",
    permissionMode: "deny-writes",
    capabilities: ["prompt"],
    ...overrides,
  };
}

const CODEX = manifest("codex");
const CLAUDE = manifest("claude", {
  displayName: "Claude Code",
  authMethod: "api-key",
  executablePath: "C:\\tools\\claude\\cli.exe",
});

describe("适配器注册表（AGT-04）", () => {
  it("认证隔离：Anthropic 普通 API 配置不等于 Claude 适配器已登录（AGT-04-B）", () => {
    // 初始 auth：codex 已登录，claude 未登录（即使用户配了 Anthropic API key）。
    const registry = createAdapterRegistry([CODEX, CLAUDE], { codex: true });
    expect(registry.authSlot("codex")).toEqual({ adapterId: "codex", loggedIn: true });
    expect(registry.authSlot("claude")).toEqual({ adapterId: "claude", loggedIn: false });
    // markLogin 只作用于目标 adapter。
    registry.markLogin("claude");
    expect(registry.authSlot("claude")?.loggedIn).toBe(true);
    expect(registry.authSlot("codex")?.loggedIn).toBe(true);
  });

  it("选择适配器不改变会话/权限语义（AGT-04-C）", () => {
    const registry = createAdapterRegistry([CODEX, CLAUDE]);
    const codex = registry.select("codex");
    const claude = registry.select("claude");
    expect(codex.ok && claude.ok).toBe(true);
    // 同一 permissionMode 语义：都走 RT-03，不允许 adapter 私改权限。
    expect((codex as { manifest: AgentAdapterManifestV1 }).manifest.permissionMode)
      .toBe((claude as { manifest: AgentAdapterManifestV1 }).manifest.permissionMode);
    // 协议面相同：同为 prompt capability。
    expect((codex as { manifest: AgentAdapterManifestV1 }).manifest.capabilities)
      .toEqual((claude as { manifest: AgentAdapterManifestV1 }).manifest.capabilities);
  });

  it("失败隔离：一个适配器不可用不影响另一个（AGT-04-D）", () => {
    const registry = createAdapterRegistry([CODEX, CLAUDE]);
    const isolation = registry.isolateFailure("codex");
    expect(isolation).toEqual({ affected: ["codex"], unaffected: ["claude"] });
    // claude 的探测与选择照常可用。
    expect(registry.select("claude").ok).toBe(true);
  });

  it("未知适配器拒绝；坏 manifest 不进注册表语义", async () => {
    const registry = createAdapterRegistry([CODEX, manifest("bad", { version: "latest" })]);
    expect(registry.select("bad")).toEqual({ ok: false, reason: "unknown-adapter" });
    const probe = await registry.probe("bad", async () => ({ exitCode: 0, stdout: "x" }));
    expect(probe).toMatchObject({ installed: false, reason: "probe-failed" });
    expect(registry.authSlot("nonexistent")).toBeNull();
  });
});
