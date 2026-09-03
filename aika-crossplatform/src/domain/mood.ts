/**
 * 她这一轮的语气。
 *
 * **是她自己标的，不是我们事后猜的。** 拿一个分类器去猜她刚写完的那句话，
 * 是在猜一个本来就有答案的东西，还要多一次请求的延迟和费用。
 *
 * 词表就是 `output/live2d/runtime-presets/expressions/` 里那七个文件名，
 * 一个字不多不少——M4 导入模型时标签直接对得上，不需要再来一层映射表。
 * `docs/COMFYUI_LIVE2D_WORKFLOW.md` 那条「模型回复应只输出受控情绪标签，
 * 不能让语言模型直接写任意 Cubism 参数」说的就是这件事。
 *
 * 消费者按到位的顺序：今天是朗读语气（Web Speech 的 rate/pitch），
 * M4 是 Live2D 表情与动作，M5 是自训声线的 style（`voice.json` 的 styles 已经留好）。
 */

export const MOODS = [
  "neutral",
  "gentle_smile",
  "happy",
  "shy",
  "surprised",
  "thinking",
  "concerned",
] as const;

export type Mood = (typeof MOODS)[number];

export const DEFAULT_MOOD: Mood = "neutral";

export function isMood(value: unknown): value is Mood {
  return typeof value === "string" && (MOODS as readonly string[]).includes(value);
}

/** 认不出来就当 neutral：标签是给表情和语气用的，不该因为一个错字丢掉整轮回复。 */
export function normalizeMood(value: unknown): Mood {
  const trimmed = typeof value === "string" ? value.trim().toLowerCase() : "";
  return isMood(trimmed) ? trimmed : DEFAULT_MOOD;
}

export interface SpeechTone {
  rate: number;
  pitch: number;
}

/** 基线。原来写死在 speechQueue 里的那两个数，现在是 neutral 的取值。 */
const BASE_TONE: SpeechTone = { rate: 1.03, pitch: 1.08 };

/**
 * 语气 → 朗读参数。
 *
 * 幅度刻意小。Web Speech 的 rate/pitch 是很粗的旋钮，调大了不像情绪，
 * 像另一个人——而「换语言不能换成另一个人」这条约束在这里同样成立。
 * 真正的情绪表达要等 M5 的自训声线，这里只是让语气不是一条直线。
 */
const TONES: Record<Mood, SpeechTone> = {
  neutral: BASE_TONE,
  gentle_smile: { rate: 1.0, pitch: 1.1 },
  happy: { rate: 1.09, pitch: 1.14 },
  shy: { rate: 0.97, pitch: 1.06 },
  surprised: { rate: 1.12, pitch: 1.16 },
  thinking: { rate: 0.95, pitch: 1.04 },
  concerned: { rate: 0.94, pitch: 1.02 },
};

export function speechToneFor(mood: Mood | undefined): SpeechTone {
  return TONES[mood ?? DEFAULT_MOOD] ?? BASE_TONE;
}

/**
 * 提示词里的语气规则。
 *
 * 每个标签都给了「什么时候」，因为只列七个英文单词她会往 happy 上偏——
 * 那会让每一轮都显得过分热情，正是反模板句那五条要挡的东西。
 */
export const MOOD_RULES = [
  "每条回复都标一个语气，只能从这七个里选，不要自造：",
  "- neutral：平常说话，大多数时候就是这个。",
  "- gentle_smile：温和、放松，替对方高兴但不夸张。",
  "- happy：真的开心，语气会扬起来。别滥用——每句都开心就不是开心了。",
  "- shy：被夸、被戳中心事、说了不好意思的话。",
  "- surprised：真的没想到。仅限意外，不用来表示热情。",
  "- thinking：在想、在斟酌、还没想好。",
  "- concerned：对方状态不好，你在担心。不要因此变得沉重或索取。",
  "语气标的是你说这句话时的状态，不是对方的心情。",
].join("\n");
