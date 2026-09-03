/**
 * 把「正在念的这一句」定位回字幕原文。
 *
 * FIELD_TEST_NOTES 修复顺序第 4 条的后一半：字幕已经逐句长出来了，
 * 但整条一起亮着，看不出她读到哪儿。
 *
 * 定位不能直接用 indexOf：送去合成的句子经过 domain/sentences.ts 清洗过——
 * Markdown 记号被去掉、首尾空白被裁掉、并短句时还可能在两个英文词之间补一个空格。
 * 所以两边都按「忽略空白与 Markdown 记号」归一化之后再找，再把下标映射回原文。
 */

/** 与 sentences.ts 的 clean() 去掉的是同一批字符，加上全部空白。 */
const IGNORED = /[\s*_#`>]/;

interface Normalized {
  text: string;
  /** normalized[i] 在原文中的下标。 */
  map: number[];
}

function normalize(text: string): Normalized {
  let normalized = "";
  const map: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (IGNORED.test(char)) continue;
    normalized += char;
    map.push(index);
  }
  return { text: normalized, map };
}

export interface CaptionRange {
  start: number;
  end: number;
}

/**
 * 在 `text` 里找出 `sentence` 占的原文区间，找不到时返回 null。
 *
 * `from` 是原文下标形式的搜索起点：同一段回复里出现两句一模一样的话时
 * （「うん。」「うん。」），第二句要亮在第二处，不能倒回去亮第一处。
 */
export function locateSentence(text: string, sentence: string, from = 0): CaptionRange | null {
  const target = normalize(sentence ?? "");
  if (!target.text) return null;

  const source = normalize(text ?? "");
  // 搜索起点也要换算到归一化坐标：原文里的空白不占归一化的位置。
  let offset = 0;
  while (offset < source.map.length && source.map[offset] < from) offset += 1;

  const at = source.text.indexOf(target.text, offset);
  if (at < 0) return null;
  return { start: source.map[at], end: source.map[at + target.text.length - 1] + 1 };
}

export interface CaptionParts {
  before: string;
  match: string;
  after: string;
}

/** 渲染用：把字幕切成「已念过的、正在念的、还没念的」三截。 */
export function splitCaption(text: string, range: CaptionRange | null): CaptionParts {
  if (!range || range.start >= range.end || range.end > text.length) {
    return { before: text, match: "", after: "" };
  }
  return {
    before: text.slice(0, range.start),
    match: text.slice(range.start, range.end),
    after: text.slice(range.end),
  };
}
