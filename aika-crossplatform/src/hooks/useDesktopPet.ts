import { useCallback, useEffect, useMemo, useState } from "react";
import { useOptionalService, useService } from "../app/kernelContext";
import { isTauriHost } from "../app/hosts/detect";
import { DesktopPetServiceToken } from "../services/desktopPet/contracts";
import { PresentationLifecycleToken } from "../services/desktopPet/lifecycle";
import type { PetCapabilityMap, PetConfig, PetConfigInput, PetConnection } from "../services/desktopPet/contracts";
import { validatePetProfile, type PetProfileV1 } from "../services/desktopPet/profile";
import { createDesktopPetSettings } from "../services/desktopPet/settings";
import { SettingsToken } from "../services/storage/tokens";
import { DesktopPetPresenterToken } from "../presentation/tokens";

/**
 * 主窗侧的外部桌宠设置与状态（PET-06）。
 *
 * 唯一桌宠出口是外部运行时；陪伴会话由主窗独立管理。
 *
 * 一条硬规则：**关着的时候零网络、零进程**。`testConnection()` 也只在启用后
 * 才真的发请求；关闭状态下如实返回 `disabled`，不偷偷探测。
 */

const CONNECTION_LABELS: Record<PetConnection, string> = {
  disabled: "未启用",
  connecting: "正在连接…",
  ready: "已连接",
  offline: "未连接",
  incompatible: "端口上的服务不是 OpenPet，或协议不兼容",
};

export interface DesktopPetState {
  /** 本宿主是否具备桌宠集成能力（桌面宿主才有）。 */
  available: boolean;
  enabled: boolean;
  connection: PetConnection;
  connectionLabel: string;
  stale: boolean;
  actions: string[];
  capabilities: PetCapabilityMap;
  config: PetConfig;
  /** profile 的 JSON 文本（用户可编辑；保存时校验）。 */
  profileText: string;
  profileError: string | null;
  busy: boolean;
  notice: string | null;
  error: string | null;
  enable(): Promise<void>;
  disable(): Promise<void>;
  saveConfig(patch: PetConfigInput): Promise<void>;
  setProfileText(text: string): void;
  saveProfile(): Promise<void>;
  testConnection(): Promise<void>;
  demo(text: string): Promise<void>;
  notifyAttention(): Promise<void>;
  /**
   * FE-31 差距，如实上报：外部桌宠**没有**点击/输入回传，
   * 因此陪伴会话、看屏幕聊聊、暂停/结束这些控制只在主窗里。
   */
  readonly petInputSupported: false;
}

export function useDesktopPet(): DesktopPetState {
  const service = useOptionalService(DesktopPetServiceToken);
  const lifecycle = useOptionalService(PresentationLifecycleToken);
  const presenter = useOptionalService(DesktopPetPresenterToken);
  const settings = useService(SettingsToken);
  const store = useMemo(() => createDesktopPetSettings(settings), [settings]);

  const [view, setView] = useState<{
    enabled: boolean;
    connection: PetConnection;
    stale: boolean;
    actions: string[];
    capabilities: PetCapabilityMap;
  }>({
    enabled: false,
    connection: "disabled",
    stale: true,
    actions: [],
    capabilities: {
      say: "unknown", action: "unknown", emotion: "unknown", event: "unknown",
      interactionEvents: "unknown", audio: "unknown", lipSync: "unknown",
    },
  });
  const [config, setConfig] = useState<PetConfig | null>(null);
  const [profileText, setProfileState] = useState("");
  const [profileError, setProfileError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 桥接订阅 Runtime 事件；关闭窗口/卸载时解绑，不留下会自动冒出来的指令。
  useEffect(() => {
    if (!presenter) return;
    presenter.start();
    setView(presenter.snapshot());
    const unsubscribe = presenter.subscribe((next) => setView(next));
    return () => {
      unsubscribe();
      presenter.dispose();
    };
  }, [presenter]);

  useEffect(() => {
    void (async () => {
      try {
        const stored = await store.read();
        setConfig(stored.config);
        setProfileState(stored.profile ? JSON.stringify(stored.profile, null, 2) : "");
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    })();
  }, [store]);

  const run = useCallback(async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }, []);

  return {
    available: isTauriHost() && service !== null,
    enabled: view.enabled,
    connection: view.connection,
    connectionLabel: CONNECTION_LABELS[view.connection],
    stale: view.stale,
    actions: view.actions,
    capabilities: view.capabilities,
    config: config ?? {
      schemaVersion: 1, enabled: false, provider: "openpet",
      endpoint: "http://127.0.0.1:17321", mode: "attach",
      executablePath: null, startWithAiki: false, stopOwnedOnExit: false,
      autoRestart: false, profileId: null,
    },
    profileText,
    profileError,
    busy,
    notice,
    error,
    petInputSupported: false,

    async enable() {
      if (!service || !config) return;
      await run(async () => {
        // 先落库再启用：中途失败时开关状态与磁盘一致，不会出现「界面开着、重启就关」。
        const next = { ...config, enabled: true };
        await store.writeConfig(next);
        await service.setConfig(next);
        setConfig(next);
        if (lifecycle) await lifecycle.start();
        else await service.enable();
        setNotice("已启用。桌宠未启动时请先启动它，再点「测试连接」。");
      });
    },

    async disable() {
      if (!service || !config) return;
      await run(async () => {
        if (lifecycle) await lifecycle.stop();
        else await service.disable();
        const next = { ...config, enabled: false };
        await store.writeConfig(next);
        await service.setConfig(next);
        setConfig(next);
        setNotice("已关闭桌宠集成。主窗聊天、语音与陪伴入口不受影响。");
      });
    },

    async saveConfig(patch) {
      if (!service || !config) return;
      await run(async () => {
        const next = { ...config, ...patch };
        await store.writeConfig(next);       // 非法地址在这里抛错，不会静默回退
        await service.setConfig(next);
        setConfig(next);
        setNotice("配置已保存。改地址或端口后，OpenPet 自身需要重启才生效。");
      });
    },

    setProfileText(text) {
      setProfileState(text);
      setProfileError(null);
    },

    async saveProfile() {
      if (!service) return;
      await run(async () => {
        const trimmed = profileText.trim();
        if (!trimmed) {
          await store.writeProfile(null);
          service.setProfile(null);
          setProfileError(null);
          setNotice("已清空 profile：桌宠只会显示文字与事件，不会做任何动作。");
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          setProfileError("profile 不是合法 JSON。");
          return;
        }
        const profile: PetProfileV1 | null = validatePetProfile(parsed);
        if (!profile) {
          // 一个坏键会让**整份** profile 失效，所以必须把约束写在这里：
          // 否则用户只会看到「结构不合法」，而真正的原因（比如键里带空格或大写）
          // 藏在某个角落里，能力静默变成 unknown、桌宠毫无反应。
          setProfileError(
            "profile 结构不合法。需要 schemaVersion/provider/release/petId/source/actions/emotions；" +
            "actions 与 emotions 的键必须以小写字母开头、只含 a-z 0-9 - _（例如 gentle_smile 是合法的）；" +
            "值是上游 animationId。",
          );
          return;
        }
        await store.writeProfile(profile);
        service.setProfile(profile);
        setProfileError(null);
        setNotice("profile 已保存，动作与情绪按它映射。");
      });
    },

    async testConnection() {
      if (!presenter) return;
      await run(async () => {
        const status = await presenter.testConnection();
        setNotice(status ? `连接状态：${CONNECTION_LABELS[status.connection]}` : "没有可测试的桌宠集成。");
      });
    },

    async demo(text) {
      if (!presenter) return;
      await run(async () => {
        const result = await presenter.demo(text);
        setNotice(result ? `演示发送结果：${result.outcome}${result.code ? `（${result.code}）` : ""}` : "没有可用的桌宠集成。");
      });
    },

    async notifyAttention() {
      presenter?.notifyAttention();
      setNotice("已发送一条「需要你确认」提示。");
    },
  };
}
