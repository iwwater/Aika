import { createCloudTtsOutput, DEFAULT_CLOUD_TTS, type CloudTtsConfig } from "./cloudTtsOutput";
import type { HttpFetch } from "../http";
import type { SpeechOutputEngine } from "./contracts";
import { webSpeechOutput } from "./webSpeechOutput";

/**
 * 选哪条合成链路。
 *
 * 结构照着 `inputEngine.ts`：那边已经把这件事想清楚了，两条链路不该长成两套写法。
 *
 * **一个区别：这里不探测。** 识别那边可以 `probe()` 一下本地服务活没活，几乎免费；
 * 语音合成的「探测」就是合成一次，要花钱。所以这里只检查配置填全了没有，
 * 真正的连通性由设置页那个用户主动点的「试听」来验——花钱的事得他自己按。
 *
 * 代价要说清楚：配置填全了不等于 Key 是对的。Key 错的时候每一句都会失败，
 * 表现是她一声不吭。所以 `useVoiceConversation` 必须把合成失败显示出来，
 * 不能像原来那样吞掉——无声无息地少说一句比报错更糟。
 */

export type VoiceOutput = "auto" | "cloud-tts" | "system";

export interface VoiceOutputConfig extends CloudTtsConfig {
  output: VoiceOutput;
}

/**
 * 默认走系统合成。
 *
 * 云端合成每一句都要花钱，不能因为用户碰巧填过 Key 就自己开起来。
 * 填完配置之后还要再把这个开关拨过去，这一步是故意留的。
 */
export const DEFAULT_VOICE_OUTPUT: VoiceOutputConfig = {
  ...DEFAULT_CLOUD_TTS,
  output: "system",
};

export interface ResolvedOutputEngine {
  engine: SpeechOutputEngine;
  /** 实际生效的链路：自动降级后 UI 显示的「当前引擎」以它为准（TTS-04）。 */
  actual: "system" | "cloud-tts";
  /** 给界面显示的一句话，说明这一轮实际用的是哪条链路。 */
  note: string;
  /** 用户点名要云端，但配置不全。界面要把它当错误显示，不能只当提示。 */
  degraded: boolean;
}

/** 配置还差什么。返回空串表示填全了。纯函数，好测。 */
export function missingCloudTtsField(config: CloudTtsConfig): string {
  if (!config.baseUrl.trim()) return "API 地址";
  if (!config.model.trim()) return "模型名称";
  if (!config.voice.trim()) return "音色";
  if (!config.apiKey.trim()) return "API Key";
  return "";
}

const SYSTEM_NOTE = "系统语音合成：语速能调，音色取决于 Windows 里装了哪些语音包。";

function system(note: string, degraded = false): ResolvedOutputEngine {
  return { engine: webSpeechOutput, actual: "system", note, degraded };
}

export function createOutputEngine(config: VoiceOutputConfig, send?: HttpFetch): ResolvedOutputEngine {
  if (config.output === "system") return system(SYSTEM_NOTE);

  const missing = missingCloudTtsField(config);

  if (config.output === "cloud-tts") {
    if (!missing) return cloud(config, send);
    return system(`云端语音合成还差${missing}，这次用系统语音合成。`, true);
  }

  // auto：配好了就用云端，没配好安静地用系统合成——用户没点名要，不算降级。
  return missing ? system(`${SYSTEM_NOTE}云端合成还差${missing}。`) : cloud(config, send);
}

function cloud(config: VoiceOutputConfig, send?: HttpFetch): ResolvedOutputEngine {
  return {
    engine: createCloudTtsOutput(() => config, send),
    actual: "cloud-tts",
    note: `云端语音合成：${config.model} · ${config.voice} · 语速 ${config.speed}`,
    degraded: false,
  };
}
