/**
 * 语言判定。
 * 起点是 Android `domain/LanguageDetector.kt`，2026-09-03 从中日两种扩到中日英三种。
 *
 * 用途有两个，都不需要用户参与：
 * 1. 这一轮语音识别该用哪个引擎语言；
 * 2. 她这句回复该用哪个音色朗读。
 *
 * 和 Android 版的差异：原版把纯拉丁字母判成 mixed，这里判成 en。
 */

import type { VoiceInputLanguage } from "../services/voice/contracts";

export type DetectedLanguage = "ja" | "zh" | "en" | "unknown";

const KANA = /[\u3040-\u30ff]/;
const HAN = /[\u4e00-\u9fff]/;
const LATIN = /[A-Za-z]/;

const LANGUAGE_TAGS: Record<Exclude<DetectedLanguage, "unknown">, VoiceInputLanguage> = {
  ja: "ja-JP",
  zh: "zh-CN",
  en: "en-US",
};

/**
 * 按文字系统判断主体语言。
 *
 * 顺序有讲究：假名只有日语用，所以最先判；汉字在没有假名时才能算中文；
 * 拉丁字母最后判，否则「今日はbusy」会被算成英语。
 */
export function detectLanguage(text: string): DetectedLanguage {
  if (KANA.test(text)) return "ja";
  if (HAN.test(text)) return "zh";
  if (LATIN.test(text)) return "en";
  return "unknown";
}

/** 把判定结果换成引擎能用的语言码；判不出时用回退值。 */
export function toLanguageTag(
  detected: DetectedLanguage,
  fallback: VoiceInputLanguage = "ja-JP",
): VoiceInputLanguage {
  return detected === "unknown" ? fallback : LANGUAGE_TAGS[detected];
}

/**
 * 选下一轮的识别语言。
 *
 * Web Speech 一次只能给一个语言码，做不到一句话里中日英混说——那要等 M3 的本地 Whisper。
 * 在那之前的折中：跟着用户最近实际说的语言走，默认日语。
 * 用户换一种语言说，下一轮就跟过去，全程不需要点任何按钮。
 */
export function preferredRecognitionLanguage(
  recentUserTexts: readonly string[],
  fallback: VoiceInputLanguage = "ja-JP",
): VoiceInputLanguage {
  for (let index = recentUserTexts.length - 1; index >= 0; index -= 1) {
    const detected = detectLanguage(recentUserTexts[index]);
    if (detected !== "unknown") return LANGUAGE_TAGS[detected];
  }
  return fallback;
}

/** 选朗读音色的语言。她用哪种语言说的，就用哪种语言念。 */
export function speechLanguageFor(text: string, fallback: VoiceInputLanguage = "ja-JP"): VoiceInputLanguage {
  return toLanguageTag(detectLanguage(text), fallback);
}
