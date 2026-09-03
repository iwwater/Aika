/**
 * 回复分句。
 *
 * 两个用处，都在 DEVELOPMENT_PLAN 的 M3：
 * 1. 第一句先合成先播，不等整段文本和音频生成完毕。
 * 2. 逐句决定朗读音色。她一句话里中日英混着说时，整段用一个音色念就成了另一个人——
 *    「うん、我知道。」用日语音色念中文，那一层温度就没了。
 *
 * 分句只看标点，不做语法分析：本地能算准的部分就在这儿，算不准的交给模型。
 */

const HARD_TERMINATORS = new Set(["。", "．", "！", "？", "!", "?", "\n"]);
const SOFT_TERMINATORS = new Set(["、", "，", ",", "；", ";", "：", ":", "…"]);
const CLOSERS = new Set(["」", "』", "\"", "'", "）", ")", "】", "》", "〉", "”", "’"]);

/**
 * 实字少于这个数的片段并回相邻句：单独念一个「ね。」比不分句更糟。
 * 数的是实字不是字符数——「おかえり。」是四个字，是一句完整的话，不能被并掉。
 */
export const MIN_SENTENCE_LENGTH = 3;
/** 长于这个长度的片段在读点处再切，否则第一句迟迟开不了口。 */
export const MAX_SENTENCE_LENGTH = 60;

function compactLength(text: string): number {
  return text.replace(/\s+/g, "").length;
}

/** 判断一句是不是短到不值得单独念时，标点不算数。 */
function contentLength(text: string): number {
  return text.replace(/[\s\p{P}\p{S}]/gu, "").length;
}

/** 朗读前先去掉 Markdown 记号：模型偶尔会加，念出来是杂音。 */
function clean(text: string): string {
  return (text ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[*_#`>]/g, "")
    .trim();
}

/** 英文句点要避开小数：「3.5」中间不能断。 */
function isHardTerminator(text: string, index: number): boolean {
  const char = text[index];
  if (char === ".") {
    const previous = text[index - 1];
    const next = text[index + 1];
    return !(/\d/.test(previous ?? "") && /\d/.test(next ?? ""));
  }
  return HARD_TERMINATORS.has(char);
}

function splitOnHardTerminators(text: string): string[] {
  const chunks: string[] = [];
  let current = "";

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (!isHardTerminator(text, index)) {
      current += char;
      continue;
    }
    // 连着的终止符和右引号跟着上一句走：「本当に！？」不该被拆成三段。
    current += char === "\n" ? "" : char;
    while (index + 1 < text.length
      && (CLOSERS.has(text[index + 1]) || (isHardTerminator(text, index + 1) && text[index + 1] !== "\n"))) {
      index += 1;
      current += text[index];
    }
    if (current.trim()) chunks.push(current.trim());
    current = "";
  }

  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

function splitLongChunk(chunk: string): string[] {
  if (compactLength(chunk) <= MAX_SENTENCE_LENGTH) return [chunk];

  const parts: string[] = [];
  let current = "";
  for (const char of chunk) {
    current += char;
    const enough = compactLength(current) >= MAX_SENTENCE_LENGTH / 2;
    if (SOFT_TERMINATORS.has(char) && enough) {
      parts.push(current.trim());
      current = "";
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function mergeShortChunks(chunks: string[]): string[] {
  const merged: string[] = [];
  for (const chunk of chunks) {
    const previous = merged[merged.length - 1];
    if (previous !== undefined && contentLength(previous) < MIN_SENTENCE_LENGTH) {
      merged[merged.length - 1] = joinChunks(previous, chunk);
      continue;
    }
    merged.push(chunk);
  }
  // 末尾那句太短时并回上一句：它后面没有能承接的内容了。
  while (merged.length > 1 && contentLength(merged[merged.length - 1]) < MIN_SENTENCE_LENGTH) {
    const tail = merged.pop() as string;
    merged[merged.length - 1] = joinChunks(merged[merged.length - 1], tail);
  }
  return merged;
}

function joinChunks(left: string, right: string): string {
  return /[A-Za-z0-9]$/.test(left) && /^[A-Za-z0-9]/.test(right) ? `${left} ${right}` : left + right;
}

/** 把一段回复切成可以逐句合成的句子。空文本返回空数组，调用方据此跳过朗读。 */
export function splitIntoSentences(text: string): string[] {
  const cleaned = clean(text);
  if (!cleaned) return [];
  const chunks = splitOnHardTerminators(cleaned).flatMap(splitLongChunk);
  return mergeShortChunks(chunks).filter((chunk) => chunk.length > 0);
}

/**
 * 最后一个句末标点之后的位置。它之前的内容不会再变，之后的可能还没写完。
 * 流式播放靠这个决定「哪一截可以现在就念」。找不到时返回 0。
 */
export function settledBoundary(text: string): number {
  for (let index = text.length - 1; index >= 0; index -= 1) {
    if (!isHardTerminator(text, index)) continue;
    // 连着的终止符和右引号算在这一句里：「本当に！？」不能停在中间。
    let end = index + 1;
    while (end < text.length && (CLOSERS.has(text[end]) || isHardTerminator(text, end))) end += 1;
    return end;
  }
  return 0;
}

export interface SentenceEmitter {
  /**
   * 喂入到目前为止的全部文本，返回这一次新确定下来、可以立刻去合成的句子。
   * `finished` 为真时把剩下的全部交出来。
   */
  push(text: string, finished: boolean): string[];
}

/**
 * 流式分句。
 *
 * 模型边生成边吐字，问题是「最后那一截到底写完没有」。规则只有两条：
 * 1. 只交出最后一个句末标点之前的内容，之后的可能还在写；
 * 2. 交出去的最后一句如果太短，留着等下一批一起——单独念一个「ね。」比慢半秒更糟。
 *
 * 消费位置按原文下标推进，不按清理后的长度，否则去掉 Markdown 记号会让偏移漂移。
 */
export function createSentenceEmitter(): SentenceEmitter {
  let consumed = 0;
  let carry = "";

  return {
    push(text, finished) {
      const boundary = finished ? text.length : settledBoundary(text);
      const addition = boundary > consumed ? text.slice(consumed, boundary) : "";
      if (!addition && !finished) return [];
      consumed = Math.max(consumed, boundary);

      const parts = splitIntoSentences(carry + addition);
      carry = "";
      if (!parts.length) return [];
      if (finished) return parts;

      const last = parts[parts.length - 1];
      if (contentLength(last) < MIN_SENTENCE_LENGTH) {
        carry = last;
        return parts.slice(0, -1);
      }
      return parts;
    },
  };
}
