import type { SpeechInputEngine } from "./contracts";
import { createWebSpeechInputEngine } from "./webSpeechInput";
import { createWhisperClient, DEFAULT_WHISPER_ENDPOINT } from "./whisperClient";
import { createWhisperInputEngine } from "./whisperInput";

/**
 * 选哪条识别链路。
 *
 * 本地 Whisper 是终局，Web Speech 只是它没就绪时的退路。但退路必须是**看得见的**：
 * 用户明确选了本地却连不上服务时，宁可报错也不要悄悄降级——
 * 悄悄降级的结果是他以为混说识别已经修好了，实际上还在用一次只认一种语言的引擎。
 */

export type VoiceBackend = "auto" | "whisper-local" | "web-speech";

export interface VoiceBackendConfig {
  backend: VoiceBackend;
  whisperEndpoint: string;
}

export const DEFAULT_VOICE_BACKEND: VoiceBackendConfig = {
  backend: "auto",
  whisperEndpoint: DEFAULT_WHISPER_ENDPOINT,
};

export interface ResolvedInputEngine {
  engine: SpeechInputEngine;
  /** 给界面显示的一句话，说明这一轮实际走的是哪条链路。 */
  note: string;
  /** 用户点名要本地，但服务连不上。界面要把这个当错误显示，不能只当提示。 */
  degraded: boolean;
}

function webSpeech(note: string, degraded = false): ResolvedInputEngine {
  return { engine: createWebSpeechInputEngine(), note, degraded };
}

function whisper(config: VoiceBackendConfig): ResolvedInputEngine {
  return {
    engine: createWhisperInputEngine({ endpoint: () => config.whisperEndpoint }),
    note: `本地识别：Silero VAD + Whisper（${config.whisperEndpoint}）`,
    degraded: false,
  };
}

export async function createInputEngine(config: VoiceBackendConfig): Promise<ResolvedInputEngine> {
  if (config.backend === "web-speech") {
    return webSpeech("系统语音识别：一次只能认一种语言，混说识别不准");
  }

  const alive = await createWhisperClient(() => config.whisperEndpoint).probe();

  if (config.backend === "whisper-local") {
    if (alive) return whisper(config);
    return webSpeech(
      `连不上本地识别服务 ${config.whisperEndpoint}，这次退回系统语音识别，混说仍然认不准`,
      true,
    );
  }

  return alive ? whisper(config) : webSpeech("系统语音识别：本地服务没开，混说识别不准");
}
