import { splitCaptionLines, type CaptionRange } from "../domain/captionHighlight";

/**
 * 气泡正文。
 *
 * 正在朗读时把当前那一句亮出来，用的是字幕那套 locateSentence/splitCaption：
 * 范围为 null（定位失败）时整段都不亮——宁可没有高亮，也不要亮在错的位置上。
 */
export function MessageBody(props: { id: string; text: string; range: CaptionRange | null }) {
  return (
    <>
      {splitCaptionLines(props.text, props.range).map((line, index) => (
        <span key={`${props.id}-${index}`}>
          {line.before}
          {line.match && <mark className="speaking">{line.match}</mark>}
          {line.after}
        </span>
      ))}
    </>
  );
}
