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
 * 选朗读音色的语言。她用哪种语言说的，就用哪种语言念。
 *
 * 日语专用字形优先于 `detectLanguage`（STT-04）：`電話が鳴った` 这种没有假名的句子
 * 原本会被判成中文，用中文音色念日语汉字。拿不到日语证据时行为与改动前一致，
 * 所以中文句子的音色选择不受影响。
 */
export function speechLanguageFor(text: string, fallback: VoiceInputLanguage = "ja-JP"): VoiceInputLanguage {
  if (recognitionSignal(text) === "ja") return "ja-JP";
  return toLanguageTag(detectLanguage(text), fallback);
}

/**
 * 识别语言的**证据**判定（STT-04）。
 *
 * 与 `detectLanguage` 并列而不是替换它：那一个做的是文本分类，「无假名有汉字算中文」
 * 对分类是对的；但把同一条规则用来选下一段的识别语言，会织成一个单向闩——
 *
 * 1. 没有假名的日语（`元気`、`今日`、`大丈夫`）被判成中文；
 * 2. 下一段用 zh-CN 听；
 * 3. 中文引擎听日语，吐出来的**一定是纯汉字、一定没有假名**；
 * 4. 第 3 步的输出又满足第 1 步 → 回到第 2 步。
 *
 * 所以这里只回答「有没有确凿证据」，判不出就说判不出（`none`），由调用方保持原样，
 * 而不是硬选一个。漏判的代价是「不切换」，误判的代价是「锁死」，两者不对等。
 */
export type RecognitionSignal = "ja" | "zh" | "en" | "none";

/**
 * 只有日语在用的字形：假名、日语新字体、国字，以及简体中文不使用的旧字形。
 *
 * 这是白名单不是全集：收不全就只是少一次证据，不会误判。之所以把 `時` `電` `間`
 * 这类繁体字形也算日语证据——本应用的中文识别只有 zh-CN 一档，它的输出永远是简体，
 * 所以在这里出现的繁体字形只可能来自日语。
 */
const JA_ONLY = /[぀-ヿ々〆ヶ]|[気円図駅読売実経験検査桜様県沢辺働峠込畑丼楽薬鉄転対発変収続総増単戦帰歩悪両緒間時電話伝価軍農決応漢語認識報頭買給結級紅約練組織終]/;

/** 只有简体中文在用的字形。同样是白名单，同样收不全就当没证据。 */
const ZH_ONLY = /[气圆图站读卖实经验检樱样县泽边乐药铁转对发变收续总增单战归步恶两绪间时电话这说让过还东车马门见关个们么问题现请谢觉爱书长产亲传价兴军农决应汉语认识报头买给结级红约练组织终]/;

/**
 * 这段文本能不能确定语言。
 *
 * 顺序：日语专用字形 → 简体专用字形 → 纯拉丁 → 判不出。汉字本身不作数，
 * 因为中日共用的那部分汉字正是自锁闭环的入口。
 */
export function recognitionSignal(text: string): RecognitionSignal {
  if (JA_ONLY.test(text)) return "ja";
  if (ZH_ONLY.test(text)) return "zh";
  if (LATIN.test(text) && !HAN.test(text)) return "en";
  return "none";
}

/** 一条可用来推断识别语言的历史输入。 */
export interface RecognitionInput {
  text: string;
  /** 这句是识别出来的还是打出来的。识别结果受当时引擎语言限制，打字不受。 */
  fromVoice: boolean;
}

/**
 * 选下一段的识别语言。
 *
 * 两条规则，都是为了不让「引擎自己的输出」把自己锁住：
 *
 * 1. **有语音历史就只看语音历史**。打字的内容不参与——用键盘敲一句中文不该让
 *    下一句日语被按中文听，而这恰恰是最常见的触发路径。一条语音历史都没有时
 *    才回头看打字的内容，好让第一段就有个合理起点。
 * 2. **判不出就保持原样**，用 `current` 而不是重新挑一个。
 */
export function nextRecognitionLanguage(
  voiceInputs: readonly RecognitionInput[],
  typedTexts: readonly string[],
  current: VoiceInputLanguage = "ja-JP",
): VoiceInputLanguage {
  const spoken = voiceInputs.filter((input) => input.fromVoice);
  const pool = spoken.length > 0 ? spoken.map((input) => input.text) : typedTexts;
  for (let index = pool.length - 1; index >= 0; index -= 1) {
    const signal = recognitionSignal(pool[index]);
    if (signal !== "none") return LANGUAGE_TAGS[signal];
  }
  return current;
}
