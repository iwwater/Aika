/**
 * 送去合成之前的最后一道清洗。
 *
 * 分句已经在 domain/sentences.ts 做完，这里只清掉念出来是杂音的记号。
 * **不能按换行截断**：那样多行回复会被悄悄念掉一半。
 *
 * 放在单独一个文件里是因为两个引擎都要用它。系统合成和云端合成如果各清各的，
 * 两条链路读到的文本就会不一样——同一句话换个引擎念出来的内容不同，
 * 是那种很久之后才会被发现的 bug。
 */
export function speakableText(text: string): string {
  return text.replace(/\s*\n+\s*/g, " ").replace(/[*_#>`]/g, "").trim();
}
