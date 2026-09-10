/**
 * 流式回复的增量解析。
 *
 * 她的回复是结构化的 `{replyText, translation}`，同时兼容旧的
 * `{japanese_text, chinese_translation}`。流式时到手的是一段还没闭合的 JSON。
 * canonical `replyText` 出现后可以在 JSON 写完之前把正文已到手的部分取出来。
 * 如果旧 `japanese_text` 先到，则暂存到对象完整，以免后到 canonical 时正文回退；
 * 这是兼容旧协议付出的首句延迟代价。
 *
 * 容错方向和 parseCompanionReply 一致：拿不到结构就把整段当正文，宁可音色判错，
 * 也不要让一轮对话卡在解析上。
 */

import { normalizeMood, type Mood } from "./mood";

export interface PartialReply {
  japaneseText: string;
  chineseTranslation: string;
  /** 她这一轮的语气。字段还没到手时是 neutral。 */
  mood: Mood;
  /** 选中的正文字符串闭合了没有。没闭合说明最后一句可能还在写。 */
  japaneseComplete: boolean;
}

const ESCAPES: Record<string, string> = {
  n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", "\"": "\"", "\\": "\\", "/": "/",
};

interface ScannedString {
  value: string;
  closed: boolean;
  /** 原始文本中结束引号之后的位置；未闭合时为当前缓冲区末尾。 */
  end: number;
}

interface TopLevelField {
  /** null 表示字段存在但不是 JSON string，不能回退到旧字段。 */
  value: ScannedString | null;
}

/** 从开引号处读一个 JSON 字符串。读到一半就断了也要把已有内容交出去。 */
function readJsonString(text: string, openQuote: number): ScannedString {
  let value = "";
  let index = openQuote + 1;

  while (index < text.length) {
    const char = text[index];

    if (char === "\\") {
      const escaped = text[index + 1];
      // 转义符还没吐完，这一截先不算数，下一批会重新读。
      if (escaped === undefined) return { value, closed: false, end: text.length };
      if (escaped === "u") {
        const hex = text.slice(index + 2, index + 6);
        if (hex.length < 4 || !/^[0-9a-fA-F]{4}$/.test(hex)) {
          return { value, closed: false, end: text.length };
        }
        const codeUnit = parseInt(hex, 16);
        // JSON Unicode 代理对可能跨网络 chunk。高代理暂不发出，等低代理
        // 到达后一次性追加，避免下游先看到孤立 surrogate 再看到完整 emoji。
        if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
          const nextSlash = text[index + 6];
          const nextEscape = text[index + 7];
          if (nextSlash === undefined || (nextSlash === "\\" && nextEscape === undefined)) {
            return { value, closed: false, end: text.length };
          }
          if (nextSlash === "\\" && nextEscape === "u") {
            const lowHex = text.slice(index + 8, index + 12);
            if (lowHex.length < 4) return { value, closed: false, end: text.length };
            if (/^[0-9a-fA-F]{4}$/.test(lowHex)) {
              const low = parseInt(lowHex, 16);
              if (low >= 0xdc00 && low <= 0xdfff) {
                value += String.fromCharCode(codeUnit, low);
                index += 12;
                continue;
              }
            }
          }
        }
        value += String.fromCharCode(codeUnit);
        index += 6;
        continue;
      }
      value += ESCAPES[escaped] ?? escaped;
      index += 2;
      continue;
    }

    if (char === "\"") return { value, closed: true, end: index + 1 };

    value += char;
    index += 1;
  }

  return { value, closed: false, end: text.length };
}

function skipWhitespace(text: string, index: number): number {
  while (index < text.length && /\s/.test(text[index])) index += 1;
  return index;
}

/**
 * 只读取 JSON object 第一层字段。
 *
 * 不能用 indexOf：memory/action 的嵌套对象也可能含有 replyText，误认后会
 * 把内部资料当正文。扫描器只做增量所需的词法工作，不承担最终 JSON 校验。
 */
function readTopLevelField(text: string, key: string): TopLevelField | null {
  const objectStart = text.indexOf("{");
  if (objectStart < 0) return null;

  let depth = 0;
  let index = objectStart;
  while (index < text.length) {
    const char = text[index];
    if (char === "\"") {
      const token = readJsonString(text, index);
      if (!token.closed) return null;
      if (depth === 1) {
        const colon = skipWhitespace(text, token.end);
        if (text[colon] === ":" && token.value === key) {
          const valueStart = skipWhitespace(text, colon + 1);
          return text[valueStart] === "\""
            ? { value: readJsonString(text, valueStart) }
            : { value: null };
        }
      }
      index = token.end;
      continue;
    }
    if (char === "{" || char === "[") depth += 1;
    else if (char === "}" || char === "]") depth = Math.max(0, depth - 1);
    index += 1;
  }
  return null;
}

function isCompleteObject(text: string): boolean {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return false;
  try {
    const value = JSON.parse(text.slice(start, end + 1));
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
  } catch {
    return false;
  }
}

/** 去掉模型偶尔加的代码围栏。流式时结尾的围栏还没来，只处理开头。 */
function stripLeadingFence(text: string): string {
  return text.replace(/^\s*```(?:json)?\s*/i, "");
}

/**
 * 解析到目前为止收到的内容。
 * 还看不出是 JSON 时整段当正文——有些协议不支持结构化输出，模型会直接吐文本。
 */
export function parsePartialReply(raw: string): PartialReply {
  const text = stripLeadingFence(raw ?? "");
  const trimmed = text.trim();
  if (!trimmed) {
    return { japaneseText: "", chineseTranslation: "", mood: normalizeMood(null), japaneseComplete: false };
  }

  if (!trimmed.startsWith("{")) {
    return { japaneseText: trimmed, chineseTranslation: "", mood: normalizeMood(null), japaneseComplete: false };
  }

  const canonicalJapanese = readTopLevelField(text, "replyText");
  const legacyJapanese = readTopLevelField(text, "reply_text")
    ?? readTopLevelField(text, "japanese_text");
  // canonical replyText 一旦出现就锁定；如果旧字段先到，先缓冲到完整 JSON，
  // 防止下一片出现 canonical 后正文从旧值回退/跳变。
  const japanese = canonicalJapanese
    ? canonicalJapanese.value
    : isCompleteObject(text) ? legacyJapanese?.value ?? null : null;

  const canonicalChinese = readTopLevelField(text, "translation");
  const legacyChinese = readTopLevelField(text, "chinese_translation");
  const chinese = canonicalChinese
    ? canonicalChinese.value
    : isCompleteObject(text) ? legacyChinese?.value ?? null : null;

  // 只认闭合了的语气：吐到一半的 "hap" 归一化会变成 neutral，随后又跳回 happy。
  // mood 存在但不是 string 时也不回退 emotion。
  const moodField = readTopLevelField(text, "mood");
  const legacyMood = readTopLevelField(text, "emotion");
  const mood = moodField ?? legacyMood;

  return {
    japaneseText: japanese?.closed ? japanese.value : japanese?.value ?? "",
    chineseTranslation: chinese?.closed ? chinese.value : "",
    mood: normalizeMood(mood?.value?.closed ? mood.value.value : null),
    japaneseComplete: japanese?.closed ?? false,
  };
}
