import { useCallback, useEffect, useMemo } from "react";
import { useService } from "../app/kernelContext";
import {
  DEFAULT_VOICE_BACKEND,
  type VoiceBackendConfig,
  type VoiceInputLanguage,
  type VoicePresenter,
  type VoiceTurnHandler,
} from "../presentation/voicePresenter";
import { VoicePresenterToken } from "../presentation/tokens";
import type { VoiceTelemetrySink } from "../domain/voiceRuntime";
import { usePresenterSnapshot } from "./usePresenterSnapshot";

export type { VoicePhase } from "../presentation/voicePresenter";
export type { VoiceTurnHandler } from "../presentation/voicePresenter";

/**
 * 语音页适配器。
 *
 * CORE-04 之后这里只剩三件事：取 VoicePresenter、订阅快照、把用户操作转成命令。
 * 引擎选择、打断链路、字幕与计时器都在 `presentation/voicePresenter.ts`，因此本
 * 文件不得 import `services/` 实现模块。
 */
export function useVoiceConversation(
  onTranscript: VoiceTurnHandler,
  /** 下一轮该用哪个识别语言。只有 Web Speech 会用到；本地 Whisper 自己判。 */
  resolveLanguage: () => VoiceInputLanguage = () => "ja-JP",
  backend: VoiceBackendConfig = DEFAULT_VOICE_BACKEND,
  telemetry: VoiceTelemetrySink = () => undefined,
) {
  const presenter: VoicePresenter = useService(VoicePresenterToken);
  const snapshot = usePresenterSnapshot(presenter);

  // 回调每轮更新；只改字段，不重启任何引擎。
  useEffect(() => {
    presenter.configure({ onTranscript, resolveLanguage, telemetry });
    presenter.setBackend(backend);
  });

  // 卸载时释放本轮引擎与计时器；Presenter 由内核持有，重开仍然可用。
  useEffect(() => () => presenter.close(), [presenter]);

  const open = useCallback(() => presenter.open(), [presenter]);
  const close = useCallback(() => presenter.close(), [presenter]);
  const interruptAndListen = useCallback(
    (reason?: "barge-in" | "button", audioStartAt?: number) => presenter.interruptAndListen(reason, audioStartAt),
    [presenter],
  );
  const sendNow = useCallback(() => presenter.sendNow(), [presenter]);
  const clearPending = useCallback(() => presenter.clearPending(), [presenter]);

  return useMemo(() => ({
    ...snapshot,
    open,
    close,
    interruptAndListen,
    sendNow,
    clearPending,
    diagnostics: presenter.diagnostics(),
    exportDiagnostics: () => presenter.exportDiagnostics(),
  }), [snapshot, presenter, open, close, interruptAndListen, sendNow, clearPending]);
}
