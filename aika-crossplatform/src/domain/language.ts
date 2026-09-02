/**
 * 语言判定。
 * 直译自 Android `domain/LanguageDetector.kt`。
 *
 * 用途只有一个：替用户决定这一轮语音识别该用哪个引擎语言，
 * 不再让用户自己在「日语 / 中文」两个方向之间选。
 */

import type { VoiceInputLanguage } from "../services/voice/contracts";

export type DetectedLanguage = "ja" | "zh" | "mixed";

const KANA = /[\u3040-\u30ff]/;
const HAN = /[\u4e00-\u9fff]/;

/** 有假名就是日语；只有汉字算中文；两者都没有算混合。 */
export function detectLanguage(text: string): DetectedLanguage {
  if (KANA.test(text)) return "ja";
  if (HAN.test(text)) return "zh";
  return "mixed";
}

/**
 * 选下一轮的识别语言。
 *
 * Web Speech 一次只能给一个语言码，做不到真正的中日混说识别——那要等 M3 的本地 Whisper。
 * 在那之前的折中：跟着用户最近实际说的语言走，默认日语。
 * 用户连着说中文就切到中文，说回日语就切回来，全程不需要用户点任何按钮。
 */
export function preferredRecognitionLanguage(
  recentUserTexts: readonly string[],
  fallback: VoiceInputLanguage = "ja-JP",
): VoiceInputLanguage {
  for (let index = recentUserTexts.length - 1; index >= 0; index -= 1) {
    const detected = detectLanguage(recentUserTexts[index]);
    if (detected === "ja") return "ja-JP";
    if (detected === "zh") return "zh-CN";
  }
  return fallback;
}
