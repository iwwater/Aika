/**
 * core/document-parser.ts
 *
 * N082-04: Bounded local document parser.
 * Supports TXT, MD, text PDF, and DOCX without network access, macros, or code execution.
 * Enforces strict limits: max 20 MiB file, max 1 MiB UTF-8 extracted text, max 200 PDF pages,
 * bounded decompression to guard against zip bombs.
 */

import { inflateRawSync } from 'node:zlib';
import type { DerivedTextStatus } from '../contracts/companion-mode.js';

export interface DocumentParseLimits {
  readonly maxFileBytes?: number;        // 20 MiB
  readonly maxExtractedBytes?: number;   // 1 MiB
  readonly maxPdfPages?: number;         // 200 pages
  readonly maxZipDecompressedBytes?: number; // 32 MiB
}

export interface DocumentParseResult {
  readonly status: DerivedTextStatus;
  readonly text: string;
  readonly byteLength: number;
  readonly warnings: readonly string[];
}

function truncateUtf8Safe(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;
  let end = maxBytes;
  // If buf[end] is a continuation byte (10xxxxxx), walk back
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) {
    end--;
  }
  // Check if previous byte was an incomplete multibyte start
  if (end > 0 && end <= buf.length) {
    const lead = buf[end - 1]!;
    if ((lead & 0x80) !== 0) {
      let needed = 1;
      if ((lead & 0xe0) === 0xc0) needed = 2;
      else if ((lead & 0xf0) === 0xe0) needed = 3;
      else if ((lead & 0xf8) === 0xf0) needed = 4;
      if (end - 1 + needed > maxBytes) {
        end = end - 1;
      }
    }
  }
  return buf.subarray(0, end).toString('utf8');
}

export class DocumentParser {
  private readonly maxFileBytes: number;
  private readonly maxExtractedBytes: number;
  private readonly maxPdfPages: number;
  private readonly maxZipDecompressedBytes: number;

  constructor(limits: DocumentParseLimits = {}) {
    this.maxFileBytes = limits.maxFileBytes ?? 20 * 1024 * 1024;
    this.maxExtractedBytes = limits.maxExtractedBytes ?? 1024 * 1024; // 1 MiB
    this.maxPdfPages = limits.maxPdfPages ?? 200;
    this.maxZipDecompressedBytes = limits.maxZipDecompressedBytes ?? 32 * 1024 * 1024;
  }

  async parse(input: {
    readonly filename: string;
    readonly bytes: Uint8Array;
    readonly mimeType?: string | undefined;
    readonly signal?: AbortSignal | undefined;
  }): Promise<DocumentParseResult> {
    if (input.signal?.aborted) {
      return { status: 'cancelled', text: '', byteLength: 0, warnings: ['aborted'] };
    }

    if (!input.bytes || input.bytes.length === 0) {
      return { status: 'missing', text: '', byteLength: 0, warnings: ['empty_file'] };
    }

    if (input.bytes.length > this.maxFileBytes) {
      return { status: 'failed', text: '', byteLength: 0, warnings: ['file_too_large'] };
    }

    const lowerName = input.filename.toLowerCase();

    // 1. TXT & Markdown
    if (lowerName.endsWith('.txt') || lowerName.endsWith('.md')) {
      return this.#parseTextOrMarkdown(input.bytes);
    }

    // 2. DOCX (Word Document)
    if (lowerName.endsWith('.docx')) {
      return this.#parseDocx(input.bytes);
    }

    // 3. PDF Document
    if (lowerName.endsWith('.pdf')) {
      return this.#parsePdf(input.bytes);
    }

    return { status: 'unsupported', text: '', byteLength: 0, warnings: ['unsupported_extension'] };
  }

  #parseTextOrMarkdown(bytes: Uint8Array): DocumentParseResult {
    try {
      const decoder = new TextDecoder('utf-8', { fatal: false });
      let text = decoder.decode(bytes);
      const textBytes = Buffer.byteLength(text, 'utf8');
      const warnings: string[] = [];

      if (textBytes > this.maxExtractedBytes) {
        text = truncateUtf8Safe(text, this.maxExtractedBytes);
        warnings.push('text_truncated_to_limit');
      }

      return {
        status: 'ok',
        text,
        byteLength: Buffer.byteLength(text, 'utf8'),
        warnings,
      };
    } catch {
      return { status: 'failed', text: '', byteLength: 0, warnings: ['decode_error'] };
    }
  }

  #parseDocx(bytes: Uint8Array): DocumentParseResult {
    // DOCX is a ZIP file containing word/document.xml
    try {
      const xml = this.#extractZipEntry(bytes, 'word/document.xml');
      if (!xml) {
        return { status: 'unsupported', text: '', byteLength: 0, warnings: ['no_word_document_xml'] };
      }

      // Check for macros (disallowed)
      if (this.#hasZipEntry(bytes, 'vbaProject.bin')) {
        return { status: 'unsupported', text: '', byteLength: 0, warnings: ['macros_disallowed'] };
      }

      // Strip XML tags and clean whitespace
      const text = xml
        .replace(/<w:p.*?>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/\n\s*\n/g, '\n')
        .trim();

      const warnings: string[] = [];
      let finalText = text;
      let finalBytes = Buffer.byteLength(finalText, 'utf8');
      if (finalBytes > this.maxExtractedBytes) {
        finalText = truncateUtf8Safe(finalText, this.maxExtractedBytes);
        finalBytes = Buffer.byteLength(finalText, 'utf8');
        warnings.push('text_truncated_to_limit');
      }

      return {
        status: 'ok',
        text: finalText,
        byteLength: finalBytes,
        warnings,
      };
    } catch {
      return { status: 'failed', text: '', byteLength: 0, warnings: ['corrupted_docx'] };
    }
  }

  #parsePdf(bytes: Uint8Array): DocumentParseResult {
    try {
      const str = Buffer.from(bytes).toString('latin1');
      if (!str.startsWith('%PDF-')) {
        return { status: 'failed', text: '', byteLength: 0, warnings: ['invalid_pdf_header'] };
      }

      // Simple page count heuristic
      const pageMatches = str.match(/\/Type\s*\/Page[^s]/g) ?? [];
      if (pageMatches.length > this.maxPdfPages) {
        return { status: 'failed', text: '', byteLength: 0, warnings: ['exceeds_max_pdf_pages'] };
      }

      // Extract text objects inside BT ... ET
      const textChunks: string[] = [];
      const btRegex = /BT[\s\S]*?ET/g;
      let match: RegExpExecArray | null = null;

      while ((match = btRegex.exec(str)) !== null) {
        const block = match[0];
        // Extract literal strings: (text) Tj or [(t)(e)(x)(t)] TJ
        const tjRegex = /\(([^)]+)\)\s*Tj/g;
        let tjMatch: RegExpExecArray | null = null;
        while ((tjMatch = tjRegex.exec(block)) !== null) {
          textChunks.push(tjMatch[1]!);
        }
      }

      if (textChunks.length === 0) {
        // Scanned or non-text PDF
        return { status: 'unsupported', text: '', byteLength: 0, warnings: ['scanned_or_no_text_layer'] };
      }

      let text = textChunks.join(' ');
      const warnings: string[] = [];
      let finalBytes = Buffer.byteLength(text, 'utf8');
      if (finalBytes > this.maxExtractedBytes) {
        text = truncateUtf8Safe(text, this.maxExtractedBytes);
        finalBytes = Buffer.byteLength(text, 'utf8');
        warnings.push('text_truncated_to_limit');
      }

      return {
        status: 'ok',
        text,
        byteLength: finalBytes,
        warnings,
      };
    } catch {
      return { status: 'failed', text: '', byteLength: 0, warnings: ['corrupted_pdf'] };
    }
  }

  /** Minimal zero-dependency ZIP entry extraction with decompression size protection. */
  #extractZipEntry(bytes: Uint8Array, targetEntry: string): string | null {
    const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 0;

    while (offset < buf.length - 30) {
      if (buf.readUInt32LE(offset) !== 0x04034b50) break; // Local file header signature

      const compression = buf.readUInt16LE(offset + 8);
      const compressedSize = buf.readUInt32LE(offset + 18);
      const uncompressedSize = buf.readUInt32LE(offset + 22);
      const fileNameLen = buf.readUInt16LE(offset + 26);
      const extraLen = buf.readUInt16LE(offset + 28);

      const fileName = buf.subarray(offset + 30, offset + 30 + fileNameLen).toString('utf8');
      const dataOffset = offset + 30 + fileNameLen + extraLen;

      if (fileName === targetEntry) {
        // Zip bomb protection
        if (uncompressedSize > this.maxZipDecompressedBytes) {
          throw new Error('zip_bomb_detected');
        }

        const data = buf.subarray(dataOffset, dataOffset + compressedSize);
        if (compression === 0) {
          return data.toString('utf8');
        }
        if (compression === 8) { // Deflate
          const decompressed = inflateRawSync(data);
          return decompressed.toString('utf8');
        }
        return null;
      }

      offset = dataOffset + compressedSize;
    }
    return null;
  }

  #hasZipEntry(bytes: Uint8Array, targetEntry: string): boolean {
    const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 0;

    while (offset < buf.length - 30) {
      if (buf.readUInt32LE(offset) !== 0x04034b50) break;
      const compressedSize = buf.readUInt32LE(offset + 18);
      const fileNameLen = buf.readUInt16LE(offset + 26);
      const extraLen = buf.readUInt16LE(offset + 28);
      const fileName = buf.subarray(offset + 30, offset + 30 + fileNameLen).toString('utf8');
      if (fileName === targetEntry) return true;
      offset = offset + 30 + fileNameLen + extraLen + compressedSize;
    }
    return false;
  }
}
