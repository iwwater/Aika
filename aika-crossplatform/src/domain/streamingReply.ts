/**
 * 流式回复的增量解析。
 *
 * 她的回复是结构化的 `{japanese_text, chinese_translation}`，流式时到手的是一段
 * 还没闭合的 JSON。要让第一句尽快出声，就得在 JSON 写完之前把 `japanese_text`
 * 已经到手的那部分取出来——不能等 `JSON.parse` 能跑通。
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
  /** japanese_text 那个字符串闭合了没有。没闭合说明最后一句可能还在写。 */
  japaneseComplete: boolean;
}

const ESCAPES: Record<string, string> = {
  n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", "\"": "\"", "\\": "\\", "/": "/",
};

interface ScannedString {
  value: string;
  closed: boolean;
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
      if (escaped === undefined) return { value, closed: false };
      if (escaped === "u") {
        const hex = text.slice(index + 2, index + 6);
        if (hex.length < 4) return { value, closed: false };
        value += String.fromCharCode(parseInt(hex, 16));
        index += 6;
        continue;
      }
      value += ESCAPES[escaped] ?? escaped;
      index += 2;
      continue;
    }

    if (char === "\"") return { value, closed: true };

    value += char;
    index += 1;
  }

  return { value, closed: false };
}

function readStringField(text: string, key: string): ScannedString | null {
  const marker = `"${key}"`;
  const keyIndex = text.indexOf(marker);
  if (keyIndex < 0) return null;

  let cursor = keyIndex + marker.length;
  while (cursor < text.length && (text[cursor] === " " || text[cursor] === ":" || text[cursor] === "\n" || text[cursor] === "\r" || text[cursor] === "\t")) {
    cursor += 1;
  }
  if (text[cursor] !== "\"") return null;
  return readJsonString(text, cursor);
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

  const japanese = readStringField(text, "japanese_text");
  const chinese = readStringField(text, "chinese_translation");
  // 只认闭合了的语气：吐到一半的 "hap" 归一化会变成 neutral，随后又跳回 happy。
  const mood = readStringField(text, "mood");

  return {
    japaneseText: japanese?.value ?? "",
    chineseTranslation: chinese?.closed ? chinese.value : "",
    mood: normalizeMood(mood?.closed ? mood.value : null),
    japaneseComplete: japanese?.closed ?? false,
  };
}
