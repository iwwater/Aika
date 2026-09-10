import { useCallback, useEffect, useMemo } from "react";
import { useService } from "../app/kernelContext";
import type { CompanionPresenter } from "../presentation/companionPresenter";
import { CompanionPresenterToken } from "../presentation/tokens";
import type { VoiceBackendConfig } from "../presentation/voicePresenter";
import type { ModeConfig, ModeId } from "../domain/soul";
import type { ProactiveSettings } from "../domain/proactive";
import type { ProviderConfig } from "../domain/providers";
import { usePresenterSnapshot } from "./usePresenterSnapshot";

/**
 * 会话页适配器。
 *
 * CORE-04 之后这里**只剩三件事**：`useService` 取 Presenter、订阅它的快照、
 * 把用户操作转成 Presenter 命令。提示词拼装、Provider 调用、检索、落库全部在
 * `presentation/companionPresenter.ts`，因此本文件不得 import `services/` 实现模块，
 * 且行数受 architecture.test.ts 门禁限制。
 */
export function useCompanionSession() {
  const presenter = useService(CompanionPresenterToken);
  const snapshot = usePresenterSnapshot(presenter);

  // 幂等：StrictMode 双次挂载不会重复装载。
  useEffect(() => {
    void presenter.start();
  }, [presenter]);

  const send = useCallback<CompanionPresenter["send"]>(
    (...args) => presenter.send(...args),
    [presenter],
  );
  const setProvider = useCallback((next: ProviderConfig) => presenter.setProvider(next), [presenter]);
  const setProactive = useCallback((next: ProactiveSettings) => presenter.setProactive(next), [presenter]);
  const setMemoryExtractionEnabled = useCallback(
    (enabled: boolean) => presenter.setMemoryExtractionEnabled(enabled),
    [presenter],
  );
  const setVoiceBackend = useCallback((next: VoiceBackendConfig) => presenter.setVoiceBackend(next), [presenter]);
  const setModeConfig = useCallback((next: ModeConfig) => presenter.setModeConfig(next), [presenter]);
  const setMode = useCallback(
    (mode: ModeId) => presenter.setModeConfig({ ...presenter.getSnapshot().mode, mode }),
    [presenter],
  );
  const exitScenario = useCallback(() => presenter.exitScenario(), [presenter]);
  const confirmMemory = useCallback((id: string) => presenter.confirmMemory(id), [presenter]);
  const deleteMemory = useCallback((id: string) => presenter.deleteMemory(id), [presenter]);

  return useMemo(() => ({
    ...snapshot,
    modeConfig: snapshot.mode,
    send,
    setProvider,
    setProactive,
    setMemoryExtractionEnabled,
    setVoiceBackend,
    setModeConfig,
    setMode,
    exitScenario,
    confirmMemory,
    deleteMemory,
  }), [
    snapshot, send, setProvider, setProactive, setMemoryExtractionEnabled, setVoiceBackend,
    setModeConfig, setMode, exitScenario, confirmMemory, deleteMemory,
  ]);
}
