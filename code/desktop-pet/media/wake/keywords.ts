import { pinyin } from 'pinyin-pro';
/** Chinese KWS model uses initial + tone-marked final, not numeric pinyin syllables. */
export function keywordTokens(keyword: string, tokenFile: string): string {
  if (!/^[\p{Script=Han}]{2,12}$/u.test(keyword)) throw Error('Wake name requires 2–12 Chinese characters');
  const syllables = pinyin(keyword, { type: 'array', toneType: 'symbol' });
  if (keyword.startsWith('乐正')) syllables[0] = 'yuè';
  const vocabulary = new Set(tokenFile.trim().split(/\r?\n/).map(line => line.split(/\s+/)[0]));
  const tokens: string[] = [];
  for (const syllable of syllables) {
    const initial = /^(zh|ch|sh|[bpmfdtnlgkhjqxrzcsyw])/.exec(syllable)?.[0] ?? '';
    for (const token of [initial, syllable.slice(initial.length)].filter(Boolean)) {
      if (!vocabulary.has(token)) throw Error('Wake pronunciation unavailable in local model');
      tokens.push(token);
    }
  }
  return tokens.join(' ') + ' @' + keyword;
}
