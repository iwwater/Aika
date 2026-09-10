import type { AikaPlugin } from "../../kernel";
import { createInputEngine } from "../../services/voice/inputEngine";
import { createMicActivityMonitor } from "../../services/voice/micActivity";
import { createSpeechQueue } from "../../services/voice/speechQueue";
import { SpeechEnginesToken, type SpeechEngines } from "../../services/voice/tokens";
import { webSpeechOutput } from "../../services/voice/webSpeechOutput";

/**
 * 语音能力插件。
 *
 * 它只做一件事：把「怎么造输入引擎、输出引擎、队列与打断监听」注册成服务，
 * 让 VoicePresenter 通过注入拿端口，而不是在 Hook/Presenter 里 `new`。
 *
 * 装配行为一字未改：`createInputEngine` 的 auto / whisper-local / web-speech 选择
 * 与降级提示、`createSpeechQueue` 的逐句队列与 stop 语义都还是原来那两份实现。
 *
 * 不声明硬依赖：麦克风权限是运行期的，不是装配期的。真没权限时 VoicePresenter
 * 会在 open() 里显示错误并停在语音页，不会阻断应用启动。
 */
export function voicePlugin(engines: SpeechEngines = defaultSpeechEngines()): AikaPlugin {
  return {
    id: "voice.engines",
    version: "1.0.0",
    provides: [SpeechEnginesToken],
    activate(context) {
      context.registrar.provide(SpeechEnginesToken, () => engines);
    },
  };
}

export function defaultSpeechEngines(): SpeechEngines {
  return {
    createInputEngine,
    outputEngine: webSpeechOutput,
    createQueue: (engine) => createSpeechQueue(engine),
    createMonitor: () => createMicActivityMonitor(),
  };
}
