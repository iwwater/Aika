import type { ExpressionIntent } from './index.js';

/** Assistant expression for rendering; these labels are not perception evidence about the user. */
export const PRESENTATION_EMOTIONS = ['neutral', 'happy', 'sad', 'warm', 'angry', 'surprised'] as const;
export const PRESENTATION_GESTURES = ['heart', 'comfort', 'hold_star', 'lean'] as const;
export const PRESENTATION_PRESET_IDS = ['exp-zzz','exp-qianqing','exp-tushe','exp-kuku','exp-shoupengxing','exp-wuxiongkou','exp-wuyu','exp-xingxingyan','exp-bixin','exp-aixinyan','exp-shengqi','exp-baiyan','exp-xuanyun','exp-qidao','exp-lianhong','exp-lianhei','exp-heiyan'] as const;
export interface PresentationIntent extends ExpressionIntent {
  readonly emotion: typeof PRESENTATION_EMOTIONS[number];
  readonly gesture: typeof PRESENTATION_GESTURES[number] | null;
}

const emotions: Readonly<Record<string, PresentationIntent['emotion']>> = {
  neutral: 'neutral', calm: 'neutral', 中性: 'neutral', 平静: 'neutral', 自然: 'neutral',
  happy: 'happy', joyful: 'happy', excited: 'happy', admiration: 'happy', admiring: 'happy',
  开心: 'happy', 高兴: 'happy', 快乐: 'happy', 兴奋: 'happy', 欣赏: 'happy', 赞赏: 'happy',
  sad: 'sad', sadness: 'sad', 悲伤: 'sad', 难过: 'sad', 伤心: 'sad',
  warm: 'warm', tender: 'warm', comforting: 'warm', 温柔: 'warm', 温暖: 'warm', 安慰: 'warm', 关切: 'warm',
  angry: 'angry', 生气: 'angry', 愤怒: 'angry',
  surprised: 'surprised', 惊讶: 'surprised', 惊喜: 'surprised',
};
const gestures: Readonly<Record<string, NonNullable<PresentationIntent['gesture']>>> = {
  heart: 'heart', 比心: 'heart', comfort: 'comfort', hand_on_chest: 'comfort', 捂胸口: 'comfort',
  hold_star: 'hold_star', 手捧星: 'hold_star', lean: 'lean', nod: 'lean', 前倾: 'lean',
};
/** Unknown labels affect only rendering. Preserve reply text and TTS delivery; never invent a gesture. */
export function normalizePresentationIntent(expression: ExpressionIntent): PresentationIntent {
  const emotion = expression.emotion.trim().toLowerCase();
  const gesture = expression.gesture?.trim().toLowerCase() ?? '';
  return {
    emotion: Object.hasOwn(emotions, emotion) ? emotions[emotion]! : 'neutral',
    gesture: Object.hasOwn(gestures, gesture) ? gestures[gesture]! : null,
    ...(expression.presetId === undefined ? {} : { presetId: PRESENTATION_PRESET_IDS.includes(expression.presetId as never) ? expression.presetId : null }),
    intensity: Number.isFinite(expression.intensity) ? Math.max(0, Math.min(1, expression.intensity)) : 0,
    delivery: expression.delivery,
  };
}
