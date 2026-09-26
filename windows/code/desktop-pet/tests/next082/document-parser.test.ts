/**
 * tests/next082/document-parser.test.ts
 *
 * N082-04: 下载目录新稳定文件接收、有界本地文档解析(TXT/MD/PDF/DOCX)与双通道折叠测试。
 *
 * AC-08204-1: 目录监控基线排除旧文件、忽略未完成临时下载后缀、稳定期后触发候选
 * AC-08204-2: TXT/MD/PDF/DOCX 本地解析、单文档 1 MiB 截断与异常格式防护
 * AC-08204-3: 取消信号 (signal) 中止解析，空文件与超限文件安全状态返回
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { DownloadDirectorySource } from '../../core/download-directory-source.js';
import { DocumentParser } from '../../core/document-parser.js';
import type { SourceGrant } from '../../contracts/companion-mode.js';
import { productionPairing } from '../../contracts/character-pack.js';

const pairing = productionPairing('companion', 'inst-08204');

function fakeGrant(root: string): SourceGrant {
  return {
    schemaVersion: 1,
    grantId: 'grant-dl-1',
    revision: 1,
    pairing,
    kind: 'download_directory',
    scope: { canonicalRoot: root },
    purposes: ['receive', 'parse'],
    destination: 'local',
    profile: 'normal',
    state: 'active',
    grantedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  };
}

/** Synthesize a valid minimal in-memory DOCX (PKZip containing word/document.xml). */
function createFakeDocx(textContent: string): Uint8Array {
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>${textContent}</w:t></w:r></w:p>
  </w:body>
</w:document>`;
  const xmlBytes = Buffer.from(xml, 'utf8');
  const compressed = deflateRawSync(xmlBytes);

  const entryName = Buffer.from('word/document.xml', 'utf8');
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0); // Local file header signature
  header.writeUInt16LE(20, 4);        // Version needed
  header.writeUInt16LE(0, 6);         // Flags
  header.writeUInt16LE(8, 8);         // Deflate
  header.writeUInt16LE(0, 10);        // Mod time
  header.writeUInt16LE(0, 12);        // Mod date
  header.writeUInt32LE(0, 14);        // CRC32
  header.writeUInt32LE(compressed.length, 18);
  header.writeUInt32LE(xmlBytes.length, 22);
  header.writeUInt16LE(entryName.length, 26);
  header.writeUInt16LE(0, 28);

  return Buffer.concat([header, entryName, compressed]);
}

test('AC-08204-1: 目录监控基线排除旧文件、忽略未完成临时下载后缀、稳定期后触发候选', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aika-08204-dl-'));
  // 1. 启用前的基线旧文件
  writeFileSync(join(root, 'old-file.txt'), '旧文件，启用前已存在');

  const received: string[] = [];
  const source = new DownloadDirectorySource({
    fileStableIntervalMs: 50,
    sleep: ms => new Promise(r => setTimeout(r, ms)),
  });

  const lease = await source.start(fakeGrant(root), cand => {
    received.push(cand.displayName);
  });

  // 稍等以确认基线建立
  await new Promise(r => setTimeout(r, 100));
  assert.equal(received.length, 0, '启用前的旧文件绝对不得被触发');

  // 2. 写入未完成临时下载文件（.crdownload），不得触发
  writeFileSync(join(root, 'large-file.pdf.crdownload'), '正在下载的半成品');
  await new Promise(r => setTimeout(r, 100));
  assert.equal(received.length, 0, '未完成的临时下载后缀不得触发候选');

  // 3. 稳定写入合法的新文件（.md）
  writeFileSync(join(root, 'readme.md'), '# 新文档\n这是正文内容。');
  await new Promise(r => setTimeout(r, 200));

  assert.ok(received.includes('readme.md'), '完成稳定写入的新文件必须触发候选');

  await lease.close();
});

test('AC-08204-2: TXT/MD/PDF/DOCX 本地解析、单文档 1 MiB 截断与异常格式防护', async () => {
  const parser = new DocumentParser({
    maxExtractedBytes: 100, // 设定较小抽取上限测试有界截断
  });

  // 1. TXT / Markdown 解析与超限截断
  const txtBytes = Buffer.from('春眠不觉晓，处处闻啼鸟。'.repeat(10), 'utf8');
  const txtRes = await parser.parse({
    filename: 'poem.txt',
    bytes: txtBytes,
  });
  assert.equal(txtRes.status, 'ok');
  assert.ok(txtRes.byteLength <= 100, '提取文本必须严格遵守 100 字节上限');
  assert.ok(txtRes.byteLength > 90);
  assert.ok(txtRes.warnings.includes('text_truncated_to_limit'));

  // 2. DOCX 解析测试
  const docxBytes = createFakeDocx('这是来自Word文档的正文段落。');
  const docxRes = await parser.parse({
    filename: 'report.docx',
    bytes: docxBytes,
  });
  assert.equal(docxRes.status, 'ok');
  assert.ok(docxRes.text.includes('这是来自Word文档的正文段落。'));

  // 3. 文本 PDF 解析测试
  const fakePdf = `%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R >> endobj
4 0 obj
<< /Length 40 >>
stream
BT
/F1 12 Tf
(Hello Aika PDF Document) Tj
ET
endstream
endobj
%%EOF`;
  const pdfBytes = Buffer.from(fakePdf, 'latin1');
  const pdfRes = await parser.parse({
    filename: 'paper.pdf',
    bytes: pdfBytes,
  });
  assert.equal(pdfRes.status, 'ok');
  assert.ok(pdfRes.text.includes('Hello Aika PDF Document'));

  // 4. 不支持的扩展名测试
  const exeRes = await parser.parse({
    filename: 'setup.exe',
    bytes: Buffer.from([0x4d, 0x5a, 0x90, 0x00]),
  });
  assert.equal(exeRes.status, 'unsupported');
});

test('AC-08204-3: 取消信号 (signal) 中止解析，空文件与超限文件安全状态返回', async () => {
  const parser = new DocumentParser({
    maxFileBytes: 50, // 50 字节上限
  });

  // 1. 取消信号测试
  const controller = new AbortController();
  controller.abort();
  const cancelRes = await parser.parse({
    filename: 'test.md',
    bytes: Buffer.from('hello'),
    signal: controller.signal,
  });
  assert.equal(cancelRes.status, 'cancelled');

  // 2. 空文件测试
  const emptyRes = await parser.parse({
    filename: 'empty.txt',
    bytes: new Uint8Array(0),
  });
  assert.equal(emptyRes.status, 'missing');

  // 3. 物理文件超限测试
  const hugeRes = await parser.parse({
    filename: 'oversized.txt',
    bytes: Buffer.alloc(100),
  });
  assert.equal(hugeRes.status, 'failed');
  assert.ok(hugeRes.warnings.includes('file_too_large'));
});
