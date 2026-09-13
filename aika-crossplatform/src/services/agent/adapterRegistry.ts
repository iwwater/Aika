/**
 * Adapter 注册表（AGT-04）：Codex 与 Claude 双适配器独立配置。
 *
 * - 每个 adapter 一份独立 manifest 与**独立认证槽**：把 Anthropic 普通 API 的
 *   已配置 key 当成「适配器已登录」是错误——认证按 adapter 隔离。
 * - 选择适配器不改变会话/权限语义：两者都走同一 AgentAdapter 协议面与
 *   RT-03 权限运行时。
 * - 一个适配器不可用不影响另一个；实例失败不触发自动切换另一收费 Agent。
 */

import {
  probeStartup, validateAdapterManifest,
  type AgentAdapterManifestV1, type StartupProbe,
} from "./adapterManifest";

/** 各适配器独立认证槽：互不可替代。 */
export interface AdapterAuthSlot {
  adapterId: string;
  /** 已完成适配器自身登录（非 LLM API key）。 */
  loggedIn: boolean;
}

export interface AdapterRegistry {
  list(): readonly AgentAdapterManifestV1[];
  select(adapterId: string): { ok: true; manifest: AgentAdapterManifestV1 } | { ok: false; reason: "unknown-adapter" };
  probe(adapterId: string, runVersionCommand: (executablePath: string, args: readonly string[]) => Promise<{ exitCode: number | null; stdout: string }>): Promise<StartupProbe>;
  authSlot(adapterId: string): AdapterAuthSlot | null;
  markLogin(adapterId: string): void;
  /** 实例失败不自动切换：调用方显式重选。 */
  isolateFailure(adapterId: string): { affected: string[]; unaffected: string[] };
}

export function createAdapterRegistry(
  manifests: readonly AgentAdapterManifestV1[],
  initialAuth: Readonly<Record<string, boolean>> = {},
): AdapterRegistry {
  const manifestsById = new Map<string, AgentAdapterManifestV1>();
  for (const manifest of manifests) manifestsById.set(manifest.adapterId, manifest);
  const loggedIn = new Map<string, boolean>(Object.entries(initialAuth));

  return {
    list: () => [...manifestsById.values()],

    select(adapterId) {
      const manifest = manifestsById.get(adapterId);
      if (!manifest) return { ok: false, reason: "unknown-adapter" };
      const validation = validateAdapterManifest(manifest);
      if (!validation.ok) return { ok: false, reason: "unknown-adapter" };
      return { ok: true, manifest };
    },

    probe(adapterId, runVersionCommand) {
      const manifest = manifestsById.get(adapterId);
      if (!manifest) return Promise.resolve({ installed: false, reason: "not-installed" });
      return probeStartup({ manifest, runVersionCommand });
    },

    authSlot(adapterId) {
      const manifest = manifestsById.get(adapterId);
      if (!manifest) return null;
      return { adapterId, loggedIn: loggedIn.get(adapterId) ?? false };
    },

    markLogin(adapterId) {
      loggedIn.set(adapterId, true);
    },

    isolateFailure(adapterId) {
      const affected = manifestsById.get(adapterId) ? [adapterId] : [];
      const unaffected = [...manifestsById.keys()].filter((id) => !affected.includes(id));
      return { affected, unaffected };
    },
  };
}
