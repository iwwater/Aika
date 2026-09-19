// Deliberately narrow formatting repair, not an emotion or factual classifier.
// Unknown/ambiguous prose stays intact; the request policy is the primary boundary.
const action = /^(?:轻轻|微微|缓缓)?(?:托腮|托着腮|脸红|歪头|歪了歪头|点头|点了点头|摇头|摇了摇头|眨眼|眨了眨眼|眨眨眼|微笑|轻笑|笑了笑|叹气|叹了口气|挥手|挥了挥手)$/u;

// Match quoted/code regions first, so action-shaped text inside them is never edited.
// An unfinished code fence or Chinese quote is also preserved through the end.
const tokens = new RegExp([
  '(`{3,}|~{3,})[\\s\\S]*?(?:\\1|(?![\\s\\S]))', '(`+)[\\s\\S]*?(?:\\2|(?![\\s\\S]))',
  '“[^”]*(?:”|(?![\\s\\S]))', '「[^」]*(?:」|(?![\\s\\S]))', '『[^』]*(?:』|(?![\\s\\S]))',
  '"(?:\\\\.|[^"\\\\\\n])*"', "(?<![\\p{L}\\p{N}])'(?:\\\\.|[^'\\\\\\n])*'",
  '^[ \\t]*>[^\\n]*',
  '（[^（）\\n]{1,80}）', '\\([^()\\n]{1,80}\\)',
  '(?<!\\*)\\*\\*[^*\\n]{1,80}\\*\\*(?!\\*)', '(?<!\\*)\\*[^*\\n]{1,80}\\*(?!\\*)',
].join('|'), 'gmu');

function actionBody(token: string): string | undefined {
  if (token.startsWith('（') || token.startsWith('(')) return token.slice(1, -1);
  if (token.startsWith('**')) return token.slice(2, -2);
  if (token.startsWith('*')) return token.slice(1, -1);
  return undefined;
}

function requestsLiteralOrFiction(message: string): boolean {
  return message.split(/[。！？!?；;\n]/u).some(clause => {
    // A negative request such as “不要编故事/不要输出（托腮）” is not an exemption.
    if (/(?:不要|别|不许|禁止|不能|不用|无需|拒绝)/u.test(clause)) return false;
    return /(?:写|讲|编|创作)[^，,]{0,24}(?:故事|小说|剧本|童话)/u.test(clause)
      || /(?:逐字|原样|照着|一字不改)[^，,]{0,12}(?:朗读|读出|复述|说|输出)/u.test(clause)
      || /(?:朗读|读出|复述)[^，,]{0,12}(?:原文|下面|以下|这段)/u.test(clause)
      || /(?:解释|讨论|分析|说明)[^，,]{0,24}(?:旁白|舞台|写法|符号|括号)/u.test(clause);
  });
}

/** Return the one text consumed by storage, display and speech. Remove only standalone,
 * recognized stage asides outside protected content. Never truncate the reply, invent
 * an expression/gesture, infer truth from keywords, or issue a retry. */
export function normalizeSpokenText(text: string, currentMessage: string): string {
  if (!text.trim()) throw new Error('Model returned an empty reply');
  if (requestsLiteralOrFiction(currentMessage)) return text;
  let output = '', cursor = 0, removed = false;
  for (const match of text.matchAll(tokens)) {
    const start = match.index!, token = match[0], end = start + token.length;
    output += text.slice(cursor, start);
    const body = actionBody(token);
    // Conversational pauses also delimit stage asides, including waves, commas
    // and semicolons. A colon stays ambiguous (often introduces a literal example).
    const atBoundary = /^[ \t\r\n]*$/u.test(output) || /[。！？!?…\n，,；;~～][ \t\r]*$/u.test(output);
    // “（托腮）是舞台说明” and narrative “她（托腮）…” are ordinary content.
    // A modal alone is not a definition: “（托腮）可以一起看看…” is still an aside.
    const following = text.slice(end).trimStart();
    const introducedAsContent = /(?:比如|例如|示例|例子|原文|写成|写的是|说的是|指的是|提到|用到)[，,；;~～\s]*$/u.test(output);
    const usedAsContent = introducedAsContent || /^(?:是|指的是|表示|这个|这种|意味着|作为|她|他)/u.test(following)
      || /^(?:(?:会|能|可以|通常)(?:更|稍微)?(?:让人|使人|帮助|有助于|缓解|表达|传达)|有助于|让人|使人)/u.test(following);
    const isStage = body !== undefined && body.split(/[，,、]/u).every(part => action.test(part.trim()));
    if (isStage && atBoundary && !usedAsContent) removed = true;
    else output += token;
    cursor = end;
  }
  output += text.slice(cursor);
  const spoken = removed ? output.trim() : text;
  if (!spoken.trim() || (removed && /^[\s\p{P}~～]*$/u.test(spoken))) throw new Error('Model returned an empty spoken reply: 没有可朗读话语');
  return spoken;
}
