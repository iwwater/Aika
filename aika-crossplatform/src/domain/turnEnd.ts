/**
 * 回合边界判定：用户到底说完了没有。
 *
 * FIELD_TEST_NOTES 的 P0——用户在一句话中间停顿、犹豫、换气时，Web Speech 直接结束
 * 识别并提交，形成「愛花抢话」。修法不是把识别调迟钝，而是把「识别出一段文字」和
 * 「这一轮说完了」拆成两件事：识别结果先攒进缓冲区，尾静音够长、且这段话语义上像
 * 收尾了，才真的发给模型。
 *
 * 这里只做纯判断，不持有计时器——计时器在 hooks/useVoiceConversation。
 * 这样「20 轮不因一次短停顿拆成两次请求」那条验收能写成单元测试，不用真等 1.35 秒。
 *
 * 与识别引擎无关：M3 换成本地 Whisper + Silero VAD 之后，变的只是静音时长从哪儿来，
 * 下面这套语义规则原样留用。
 */

export interface TurnEndSettings {
  /** 基准尾静音。方案定的是 1.2～1.5 秒起调，再按实测调。 */
  baseSilenceMs: number;
  /** 语义明显收尾时用的短值。 */
  settledSilenceMs: number;
  /** 明显没说完时用的长值。 */
  unsettledSilenceMs: number;
  /** 兜底上限：再怎么犹豫也不能无限等下去。 */
  maxSilenceMs: number;
}

export const DEFAULT_TURN_END_SETTINGS: TurnEndSettings = {
  baseSilenceMs: 1350,
  settledSilenceMs: 1150,
  unsettledSilenceMs: 2400,
  maxSilenceMs: 4000,
};

export type EndpointHint = "settled" | "unsettled" | "neutral";

/** 说到一半的标志：填充词、连接词。命中就多等一会儿。 */
const UNSETTLED_TAIL_CJK =
  /(えーと|えっと|えと|あのー|あの|その|なんか|うーん|んー|まあ|まぁ|でも|だから|けど|けれど|そして|それで|つまり|たぶん|那个|这个|就是|然后|所以|但是|不过|而且|因为|嗯|呃)$/;

/** 英语的填充词要挑词边界，否则「also」会被当成以「so」结尾。 */
const UNSETTLED_TAIL_LATIN =
  /(?:^|[\s,])(um|uh+|er+|like|so|and|but|because|well|i mean|you know)$/i;

const TRAILING_SOFT_PUNCTUATION = /[、，,;；:：…]$/;
const CLOSING_QUOTES = /["'」』）)】》〉”’]+$/;

const SETTLED_TAIL_JA =
  /(です|ます|ました|でした|ください|ありがとう|だよ|だね|かな|よね|でしょ|でしょう|[ぁ-んァ-ヴー一-龥](よ|ね|わ|か|な|の|ぞ|ぜ))$/;
const SETTLED_TAIL_ZH = /(了|吧|呢|吗|嘛|哦|啦)$/;

/** 判断长度只算实字，空格不算——「a b」不该被当成三个字。 */
function compactLength(text: string): number {
  return text.replace(/\s+/g, "").length;
}

function endsWithFinalPunctuation(text: string): boolean {
  const tail = text.replace(CLOSING_QUOTES, "");
  if (/[。．！？!?]$/.test(tail)) return true;
  // 英文句点要避开小数和缩写：「3.5」不是句尾。
  return /\.$/.test(tail) && !/\d\.$/.test(tail);
}

/**
 * 这段话听上去收尾了没有。
 *
 * 顺序有讲究：先看「明显没说完」的证据，再看「明显说完了」的。
 * 「今日はね、」既有终助词又有读点，它是没说完。
 */
export function endpointHint(text: string): EndpointHint {
  const trimmed = text.trim();
  if (!trimmed) return "unsettled";
  if (endsWithFinalPunctuation(trimmed)) return "settled";
  if (TRAILING_SOFT_PUNCTUATION.test(trimmed)) return "unsettled";
  if (UNSETTLED_TAIL_CJK.test(trimmed) || UNSETTLED_TAIL_LATIN.test(trimmed)) return "unsettled";
  // 太短的片段更像刚起个头，不像一轮说完了。多等一秒的代价，远小于抢话。
  if (compactLength(trimmed) <= 2) return "unsettled";
  if (SETTLED_TAIL_JA.test(trimmed) || SETTLED_TAIL_ZH.test(trimmed)) return "settled";
  return "neutral";
}

/** 这段话该等多久的尾静音。 */
export function silenceBudgetMs(
  text: string,
  settings: TurnEndSettings = DEFAULT_TURN_END_SETTINGS,
): number {
  const hint = endpointHint(text);
  const budget = hint === "settled" ? settings.settledSilenceMs
    : hint === "unsettled" ? settings.unsettledSilenceMs
      : settings.baseSilenceMs;
  return Math.min(budget, settings.maxSilenceMs);
}

/** 现在能提交这一轮了吗。缓冲区为空时永远不提交——静音本身不是一轮。 */
export function shouldSubmit(
  text: string,
  silentForMs: number,
  settings: TurnEndSettings = DEFAULT_TURN_END_SETTINGS,
): boolean {
  if (!text.trim()) return false;
  if (silentForMs >= settings.maxSilenceMs) return true;
  return silentForMs >= silenceBudgetMs(text, settings);
}

const LATIN_EDGE = /[A-Za-z0-9]$/;
const LATIN_HEAD = /^[A-Za-z0-9]/;

/**
 * 把识别引擎陆续给出的片段接成一轮。
 * 中日文之间不加空格，英文单词之间要加——「I was」和「今日は」的拼法不一样。
 */
export function mergeFragment(buffer: string, fragment: string): string {
  const left = buffer.trim();
  const right = fragment.trim();
  if (!left) return right;
  if (!right) return left;
  return LATIN_EDGE.test(left) && LATIN_HEAD.test(right) ? `${left} ${right}` : left + right;
}
