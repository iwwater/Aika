import type { HttpFetch } from "../../services/http";
import type { AikaPlugin } from "../../kernel";
import { createInputEngine } from "../../services/voice/inputEngine";
import { createMicActivityMonitor } from "../../services/voice/micActivity";
import {
  createOutputEngine, DEFAULT_VOICE_OUTPUT, type VoiceOutputConfig,
} from "../../services/voice/outputEngine";
import { createSpeechQueue } from "../../services/voice/speechQueue";
import { SpeechEnginesToken, type SpeechEngines } from "../../services/voice/tokens";

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

/**
 * 默认装配。
 *
 * 输出引擎和输入引擎一样经各自的选择函数决定，而不是写死一个实现：
 * `DEFAULT_VOICE_OUTPUT.output` 是 `"system"`，所以不传参数时装出来的还是
 * `webSpeechOutput`，行为一个字不变；换成云端合成只需要在这里传一份配置进去。
 *
 * `speed` 交给队列而不是引擎：「慢一点」是对她说的，两条链路都得听懂。
 *
 * 还没接上的一环：`createOutputEngine` 返回的 `note` / `degraded` 在这里被丢掉了。
 * 目前没有让用户选云端合成的入口，所以还不会发生「悄悄降级」；等设置页接上时，
 * 这两个值必须一路送到界面，降级要当错误显示。
 */
export function defaultSpeechEngines(
  output: VoiceOutputConfig = DEFAULT_VOICE_OUTPUT,
  send?: HttpFetch,
): SpeechEngines {
  const resolved = createOutputEngine(output, send);
  return {
    createInputEngine,
    outputEngine: resolved.engine,
    createQueue: (engine) => createSpeechQueue(engine, { speed: output.speed }),
    createMonitor: () => createMicActivityMonitor(),
  };
}
