// N07-01: Source snapshot and chunking implementation.
// Provides deterministic Unicode code-point chunking, stable block IDs, locators, and content hashing.
import { createHash } from 'node:crypto';
import type {
  SourceBlock,
  SourceBlockLocator,
  SourceImportInput,
  SourceLimits,
  SourceSnapshot,
} from '../contracts/character-pack.js';
import {
  CharacterPackError,
  DEFAULT_SOURCE_LIMITS,
} from '../contracts/character-pack.js';

export const codePointLength = (value: string): number => [...value].length;

export const sha256 = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');

const extensionOf = (name: string): string => {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot).toLowerCase();
};

interface RawParagraph {
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly chapter?: string | undefined;
  readonly line: number;
}

/**
 * Parses raw text into paragraphs separated by blank lines (\n\s*\n),
 * extracting code-point boundaries, line numbers, and markdown chapter headings.
 */
function extractParagraphs(fullText: string): readonly RawParagraph[] {
  const points = [...fullText];
  const paragraphs: RawParagraph[] = [];
  const boundary = /\n\s*\n/g;
  let match: RegExpExecArray | null;
  let from = 0;
  let currentChapter: string | undefined;

  const getLineNumber = (charOffset: number): number => {
    let line = 1;
    for (let i = 0; i < charOffset && i < points.length; i++) {
      if (points[i] === '\n') line++;
    }
    return line;
  };

  const checkChapterHeading = (paraText: string): string | undefined => {
    const trimmed = paraText.trim();
    const headingMatch = /^(?:#{1,3}\s+|第[0-9一二三四五六七八九十百千]+[章卷回节篇]\s*)(.+)$/m.exec(trimmed);
    if (headingMatch && headingMatch[1]) {
      return headingMatch[1].trim().slice(0, 80);
    }
    return undefined;
  };

  const isPureHeading = (str: string): boolean =>
    /^(?:#{1,6}\s+|第[0-9一二三四五六七八九十百千]+[章卷回节篇]\s*)[^\r\n]+$/.test(str.trim());

  while ((match = boundary.exec(fullText)) !== null) {
    const end = match.index;
    if (end > from) {
      const sliceStr = fullText.slice(from, end);
      const startCp = codePointLength(fullText.slice(0, from));
      const endCp = codePointLength(fullText.slice(0, end));
      const ch = checkChapterHeading(sliceStr);
      if (ch) currentChapter = ch;
      if (!isPureHeading(sliceStr)) {
        paragraphs.push({
          text: sliceStr,
          start: startCp,
          end: endCp,
          chapter: currentChapter,
          line: getLineNumber(startCp),
        });
      }
    }
    from = match.index + match[0].length;
  }

  if (from < fullText.length) {
    const sliceStr = fullText.slice(from);
    const startCp = codePointLength(fullText.slice(0, from));
    const endCp = points.length;
    const ch = checkChapterHeading(sliceStr);
    if (ch) currentChapter = ch;
    if (!isPureHeading(sliceStr)) {
      paragraphs.push({
        text: sliceStr,
        start: startCp,
        end: endCp,
        chapter: currentChapter,
        line: getLineNumber(startCp),
      });
    }
  }

  return paragraphs.length > 0
    ? paragraphs
    : [{
        text: fullText,
        start: 0,
        end: points.length,
        line: 1,
      }];
}

/**
 * Splits text deterministically into bounded source blocks.
 * Uses paragraph boundaries first, then subdivides paragraphs longer than maxCodePoints.
 * Offsets are Unicode code point positions in original source text.
 */
export function splitSourceBlocks(
  text: string,
  sourceId: string,
  maxCodePoints: number = DEFAULT_SOURCE_LIMITS.maxBlockCodePoints,
): readonly SourceBlock[] {
  const points = [...text];
  const paragraphs = extractParagraphs(text);
  const blocks: SourceBlock[] = [];
  let ordinal = 0;

  for (const para of paragraphs) {
    let start = para.start;
    while (start < para.end) {
      const end = Math.min(start + maxCodePoints, para.end);
      const chunk = points.slice(start, end).join('').trim();
      if (chunk.length > 0) {
        const locator: SourceBlockLocator = Object.freeze({
          start,
          end,
          ...(para.chapter ? { chapter: para.chapter } : {}),
          line: para.line,
        });

        blocks.push(
          Object.freeze({
            id: `${sourceId}:b${ordinal + 1}`,
            sourceId,
            ordinal,
            text: chunk,
            blockHash: sha256(chunk),
            locator,
          }),
        );
        ordinal++;
      }
      start = end;
    }
  }

  return Object.freeze(blocks);
}

/**
 * Validates a single import file input against format and size constraints.
 */
export function validateSourceInput(
  input: SourceImportInput,
  limits: SourceLimits = DEFAULT_SOURCE_LIMITS,
): { readonly sourceName: string; readonly byteLength: number; readonly contentHash: string } {
  const name = typeof input.sourceName === 'string' ? input.sourceName.trim() : '';
  if (!name || name.includes('/') || name.includes('\\') || name.includes('\0')) {
    throw new CharacterPackError('invalid_request', `文件名 "${input.sourceName}" 无效，不可包含路径分隔符或空字符。`);
  }

  const ext = extensionOf(name);
  if (!limits.acceptedExtensions.includes(ext)) {
    throw new CharacterPackError(
      'invalid_request',
      `不支持的文件扩展名 "${ext}"，仅支持 ${limits.acceptedExtensions.join(' / ')}。`,
    );
  }

  if (typeof input.text !== 'string') {
    throw new CharacterPackError('invalid_request', `文件 "${name}" 正文必须为字符串。`);
  }

  const byteLength = Buffer.byteLength(input.text, 'utf8');
  if (byteLength === 0) {
    throw new CharacterPackError('invalid_request', `文件 "${name}" 为空文件。`);
  }

  if (byteLength > limits.maxDocumentBytes) {
    throw new CharacterPackError(
      'source_limit_exceeded',
      `文件 "${name}" 大小（${byteLength} 字节）超出上限（${limits.maxDocumentBytes} 字节）。`,
    );
  }

  return Object.freeze({
    sourceName: name,
    byteLength,
    contentHash: sha256(input.text),
  });
}

/**
 * Creates an in-memory SourceSnapshot from verified input without database operations.
 */
export function createSourceSnapshot(
  sourceId: string,
  characterId: string,
  input: SourceImportInput,
  createdAt: string = new Date().toISOString(),
  limits: SourceLimits = DEFAULT_SOURCE_LIMITS,
): SourceSnapshot {
  const meta = validateSourceInput(input, limits);
  const blocks = splitSourceBlocks(input.text, sourceId, limits.maxBlockCodePoints);

  return Object.freeze({
    id: sourceId,
    characterId,
    sourceName: meta.sourceName,
    contentHash: meta.contentHash,
    byteLength: meta.byteLength,
    createdAt,
    blocks,
  });
}
