import { asksCurrentEmployment, isEmploymentCandidate } from './retrieval.js';

/** Fixed, inspectable lexical rules; no candidate-relative normalization or model inference. */
export const CUE_RULE_VERSION = 'keywords-1';
const stopWords = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'i', 'you', 'my', 'your', 'it', 'and', 'or', 'to', 'of', 'what', 'where']);
const hanStops = /(?:怎么样|叫什么|名字|名叫|叫|用户|什么|怎么|哪里|哪儿|现在|目前|当前|记得|记住|告诉|可以|请问|一下|来着|我们|你们|他们|她们|这个|那个|哪些|是否|有没有|我|你|他|她|它|的|了|着|过|是|有|在|把|被|和|与|及|或|这|那|哪|吗|呢|吧|啊|呀|得|地|个|只|件|请|也|都|就|很|再|还|要)/gu;
const normalize = (text: string) => text.normalize('NFKC').toLowerCase();
export function meaningfulKeywords(query: string): readonly string[] {
  const tokens = new Set<string>();
  for (const run of normalize(query).match(/\p{Script=Han}+|[\p{L}\p{N}]+/gu) ?? []) {
    if (/^\p{Script=Han}+$/u.test(run)) {
      for (const part of run.split(hanStops).filter(Boolean)) {
        const chars = [...part];
        if (chars.length <= 2) tokens.add(part);
        else for (let i = 0; i + 1 < chars.length; i++) tokens.add(chars.slice(i, i + 2).join(''));
      }
    } else if (!stopWords.has(run)) tokens.add(run);
  }
  return [...tokens].sort();
}
export interface CueResult {
  readonly ruleVersion: typeof CUE_RULE_VERSION;
  readonly keywords: readonly string[];
  readonly matchedKeywords: readonly string[];
  readonly coverage: number;
  readonly phrase: boolean;
  readonly relation: 'current_employment' | null;
  readonly score: number;
}
export function scoreCue(query: string, text: string): CueResult {
  const keywords = meaningfulKeywords(query), normalized = normalize(text);
  const matchedKeywords = keywords.filter(token => normalized.includes(token));
  const coverage = keywords.length ? matchedKeywords.length / keywords.length : 0;
  const phrase = keywords.length > 0 && normalized.includes(normalize(query).trim());
  const relation = asksCurrentEmployment(query) && isEmploymentCandidate(text) ? 'current_employment' : null;
  return { ruleVersion: CUE_RULE_VERSION, keywords, matchedKeywords, coverage, phrase, relation,
    score: Math.max(phrase ? 1 : coverage, relation ? 0.8 : 0) };
}
