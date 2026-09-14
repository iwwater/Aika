import { useEffect, useState } from "react";
import { useOptionalService, useService } from "../app/kernelContext";
import { CompanionPresenterToken } from "../presentation/tokens";
import { createCompanionSessionController, type CompanionSessionController } from "../presentation/companionSessionController";
import { COMPANION_INTENT_SCHEMA } from "../presentation/companionIntent";
import { EnvironmentMonitorToken, ScreenContextSourceToken } from "../services/environment/contracts";
import { SCREEN_SOURCE_ID } from "../services/environment/screenSource";
import { SettingsToken } from "../services/storage/tokens";
import { SETTING_KEYS } from "../services/storage/contracts";
import { createSystemClock } from "../services/time/systemTime";

/**
 * 主窗拥有陪伴会话（FE-31），**是否安装或启用桌宠与它无关**：不装、不启用外部
 * 桌宠时，看屏幕聊聊、暂停读屏、结束陪伴照样在主窗里可用。
 *
 * 与旧 `usePetWindow` 的差别只有一点：它不再持有任何窗口。自研桌宠窗口在 MVP-03
 * 删除，外部桌宠的窗口归它自己的进程管，所以这里**不传** `view`——会话控制不该
 * 依赖某个窗口存在。
 *
 * 已知缺口（不在 MVP-03 范围，交给 MVP-04）：
 * `CompanionSessionController.onScreenChanged` 那条**自动路径**（画面变化 → 本地
 * OCR → 候选 → 统一主动频控 → 发送）目前没有生产触发源，只有测试直接调用它。
 * 基线版本同样没有调用者，所以这不是本轮引入的回归，但界面上的「主动陪伴」开关
 * 因此仍是超前描述——补触发源是 MVP-04「OCR 观察与陪伴闭环」的范围。
 */
export function useCompanionControls() {
  const companion = useService(CompanionPresenterToken);
  const settings = useService(SettingsToken);
  const monitor = useOptionalService(EnvironmentMonitorToken);
  const screenContext = useOptionalService(ScreenContextSourceToken);
  const [session, setSession] = useState<CompanionSessionController | null>(null);
  const [sessionView, setView] = useState<ReturnType<CompanionSessionController["getSnapshot"]> | null>(null);
  useEffect(() => {
    if (!monitor || !screenContext) return;
    const controller = createCompanionSessionController({
      screenContext,
      sensors: { async setScreenEnabled(enabled) {
        await monitor.setSourceEnabled(SCREEN_SOURCE_ID, enabled);
        await settings.setBoolean(SETTING_KEYS.environmentScreenEnabled, enabled);
      } },
      settings: {
        getString: (key) => settings.getRaw(key), setString: (key, value) => settings.setRaw(key, value),
        getBoolean: (key, fallback) => settings.getBoolean(key, fallback),
        setBoolean: (key, value) => settings.setBoolean(key, value),
      },
      submitUser: async ({ text }) => (await companion.send(text, "text")) !== null,
      submitProactive: () => companion.sendEnvironmentProactive(["screen-text"]),
      clock: createSystemClock(),
    });
    setSession(controller);
    const unsubscribe = controller.subscribe(() => setView(controller.getSnapshot()));
    void controller.start().then(() => setView(controller.getSnapshot())).catch(() => undefined);
    const unstate = monitor.onStateChange(() => {
      const screen = monitor.statuses().find((source) => source.sourceId === SCREEN_SOURCE_ID);
      if (screen && (screen.state === "off" || screen.state === "error" || screen.state === "denied")) controller.markStoppedExternally();
    });
    return () => { unsubscribe(); unstate(); controller.dispose(); };
  }, [companion, settings, monitor, screenContext]);
  return {
    session, sessionView,
    screenTalk: async () => {
      if (!session) return;
      await session.handleIntent({
        schemaVersion: COMPANION_INTENT_SCHEMA, requestId: crypto.randomUUID(),
        sessionEpoch: "main", kind: "screen_talk", text: null,
      }, "main");
    },
  };
}
