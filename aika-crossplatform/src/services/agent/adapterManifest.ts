/**
 * Adapter manifest 与启动探测（AGT-03）。
 *
 * 产出**版本化** adapter manifest：可执行路径/固定版本、启动参数、支持宿主、
 * 认证方式、权限模式、capabilities。用户选择已安装的适配器——
 * **不在运行时自动 npx latest 或全局安装**。
 *
 * canary 临时仓库：只读/拒绝写测试用「文件哈希不变」作为该负例的证据——
 * 它只证明这一个负例，**不证明全系统沙箱**（需结合宿主限制与命令审计）。
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const ADAPTER_MANIFEST_SCHEMA_VERSION = 1;

export type AdapterPermissionMode = "deny-writes" | "ask" | "allow";
export type AdapterAuthMethod = "none" | "api-key" | "oauth";

export interface AgentAdapterManifestV1 {
  schemaVersion: 1;
  adapterId: string;
  displayName: string;
  /** 固定版本号；"latest"/"*" 不合法。 */
  version: string;
  executablePath: string;
  startupArgs: readonly string[];
  supportedHosts: readonly string[];
  authMethod: AdapterAuthMethod;
  permissionMode: AdapterPermissionMode;
  capabilities: readonly string[];
  /** 不支持的能力与原因（明确 unsupported 而非静默缺失）。 */
  unsupported?: Record<string, string>;
}

export interface ManifestValidation {
  ok: boolean;
  reason?: "schema-version" | "version-not-pinned" | "unknown-permission-mode" | "unknown-auth-method" | "empty-adapter-id";
}

const KNOWN_CAPABILITIES = ["prompt", "chat", "session-resume"];

export function validateAdapterManifest(manifest: AgentAdapterManifestV1): ManifestValidation {
  if (manifest.schemaVersion !== ADAPTER_MANIFEST_SCHEMA_VERSION) return { ok: false, reason: "schema-version" };
  if (!manifest.adapterId?.trim()) return { ok: false, reason: "empty-adapter-id" };
  if (!manifest.version || manifest.version === "latest" || manifest.version === "*") {
    return { ok: false, reason: "version-not-pinned" };
  }
  if (!["deny-writes", "ask", "allow"].includes(manifest.permissionMode)) {
    return { ok: false, reason: "unknown-permission-mode" };
  }
  if (!["none", "api-key", "oauth"].includes(manifest.authMethod)) {
    return { ok: false, reason: "unknown-auth-method" };
  }
  for (const capability of manifest.capabilities) {
    if (!KNOWN_CAPABILITIES.includes(capability)) return { ok: false, reason: "unknown-permission-mode" };
  }
  return { ok: true };
}

/** 启动探测：可执行文件存在 + 版本命令退出码由注入 runner 提供（不自动安装）。 */
export interface StartupProbe {
  installed: boolean;
  version?: string;
  exitCode?: number | null;
  reason?: "not-installed" | "probe-failed";
}

export interface StartupProbeOptions {
  manifest: AgentAdapterManifestV1;
  /** 注入执行：返回 (exitCode, stdout)。测试用 fake；真实宿主接子进程。 */
  runVersionCommand: (executablePath: string, args: readonly string[]) => Promise<{ exitCode: number | null; stdout: string }>;
}

export async function probeStartup(options: StartupProbeOptions): Promise<StartupProbe> {
  const validation = validateAdapterManifest(options.manifest);
  if (!validation.ok) return { installed: false, reason: "probe-failed" };
  try {
    const { exitCode, stdout } = await options.runVersionCommand(
      options.manifest.executablePath,
      ["--version"],
    );
    if (exitCode !== 0) {
      return { installed: false, exitCode, reason: exitCode === null ? "not-installed" : "probe-failed" };
    }
    return { installed: true, version: stdout.trim().split("\n")[0], exitCode };
  } catch {
    return { installed: false, reason: "not-installed" };
  }
}

/** canary 临时仓库：建/读哈希/清理。真实 adapter 的只读负例在这里取证。 */
export interface CanaryRepo {
  root: string;
  canaryFile: string;
  canaryHash(): string;
  dispose(): void;
}

export function createCanaryRepo(): CanaryRepo {
  const root = join(tmpdir(), `aika-canary-${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(root, { recursive: true });
  const canaryFile = join(root, "canary.txt");
  writeFileSync(canaryFile, "canary-do-not-touch");
  return {
    root,
    canaryFile,
    canaryHash: () => (existsSync(canaryFile) ? createHash("sha256").update(readFileSync(canaryFile)).digest("hex") : "deleted"),
    dispose: () => {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // 清理失败不影响断言（临时目录）。
      }
    },
  };
}
