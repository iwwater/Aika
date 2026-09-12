import { token } from "../../kernel";
import type { MicActivityMonitor } from "./micActivity";
import type { SpeechOutputEngine } from "./contracts";
import type { ResolvedInputEngine, VoiceBackendConfig } from "./inputEngine";
import type { ResolvedOutputEngine, VoiceOutput, VoiceOutputConfig } from "./outputEngine";
import type { SpeechQueue } from "./speechQueue";

/**
 * 输出侧的当前状态：用户选了什么、实际走的是哪条链路、为什么。
 * `degraded=true` 是错误（点名要云端却配不全），UI 必须持久可见，不能只当提示。
 */
export interface VoiceOutputStatus {
  selected: VoiceOutput;
  actual: "system" | "cloud-tts";
  note: string;
  degraded: boolean;
}

/**
 * 语音能力端口。
 *
 * 语音这条链路的装配不是「一个引擎实例」：输入引擎要按设置在三者之间选（auto /
 * whisper-local / web-speech）并如实报告降级，输出要经逐句队列，播放期间还要有
 * 独立的能量监听。所以插件注册的是一个**能力包**，与 `CompanionRuntime` 一样是普通
 * 服务；消费方（VoicePresenter）通过构造参数拿它，不再自己 `new`。
 *
 * 需要说明：ARCHITECTURE 的 token 表里写的是 `SpeechInputToken` / `SpeechOutputToken`
 * 两个引擎级 token（名称可调）。这里按实际消费面收敛成一个 `SpeechEnginesToken`，
 * 避免注册一个「不知道该选哪条链路」的静态引擎——选择逻辑必须在插件里，不在消费方。
 */
export interface SpeechEngines {
  /** auto / whisper-local / web-speech 的选择与回退语义保持在 inputEngine 内。 */
  createInputEngine(config: VoiceBackendConfig): Promise<ResolvedInputEngine>;
  /** 默认输出引擎；队列与 stop 语义由 speechQueue 提供。 */
  outputEngine: SpeechOutputEngine;
  /** 当前输出链路状态（TTS-04）：由 createOutputEngine 的 note/degraded 透出。 */
  output: VoiceOutputStatus;
  /** 设置变更后按新配置重建输出引擎；不探测、不发任何网络请求。 */
  resolveOutput(config: VoiceOutputConfig): ResolvedOutputEngine;
  createQueue(engine: SpeechOutputEngine): SpeechQueue;
  createMonitor(): MicActivityMonitor;
}

export const SpeechEnginesToken = token<SpeechEngines>("voice.engines");
