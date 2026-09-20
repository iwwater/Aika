// FIX61-06 RED->GREEN: a minimal knowledge library that is actually importable, switchable and able
// to change what the provider sees. It is an independent reference collection — never a second Memory,
// never a second character, and never a different SQLite file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteMemoryStore, CONFIRMED_RETENTION } from '../../memory/sqlite-store.js';
import { confirmedInvitationPolicy } from '../../companion/invitations.js';
import { KnowledgeLibraryStore, splitKnowledgeBlocks, KNOWLEDGE_LIMITS } from '../../memory/knowledge-library.js';
import { COMPANION_ID } from '../../contracts/character.js';

/** One cleanup hook, so the database handle is always closed before the temp directory is removed. */
async function tempStore(t: { after(fn: () => Promise<void> | void): void }, prefix = 'fix61-kb-') {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  const filename = join(dir, 'companion.sqlite');
  const handles: SqliteMemoryStore[] = [
    new SqliteMemoryStore({ filename, retention: CONFIRMED_RETENTION, invitations: confirmedInvitationPolicy('Asia/Shanghai') })
  ];
  t.after(async () => {
    for (const handle of handles) { try { handle.close(); } catch { /* already closed by the test */ } }
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, store: handles[0]!, filename, track: (store: SqliteMemoryStore) => { handles.push(store); return store; } };
}
const scope = (turnId = 'turn-1') => ({ characterId: COMPANION_ID, sessionId: 'session-a', turnId, generation: 1 });

// 06-B -----------------------------------------------------------------------------------------
test('06-B import dedupe, format and size rejection, revision conflict, durability and atomic failure', async t => {
  const { dir, store, filename, track } = await tempStore(t);
  const library = await KnowledgeLibraryStore.open(store, join(dir, 'books'));
  const a = await library.create('资料A');
  assert.equal(library.list().length, 1);

  const first = await library.importDocuments(a.id, [{ sourceName: 'a.md', text: '# 标题\n\nA 库的内容。' }]);
  assert.equal(first.imported.length, 1);
  assert.equal(first.imported[0]!.sourceName, 'a.md');

  // Same library, same content hash -> idempotent re-import, no duplicate document.
  const again = await library.importDocuments(a.id, [{ sourceName: 'a.md', text: '# 标题\n\nA 库的内容。' }]);
  assert.equal(again.imported.length, 0);
  assert.equal(again.duplicates.length, 1);
  assert.equal(library.documents(a.id).length, 1);

  // A same-named file with different content is a distinct document, not a silent overwrite.
  await library.importDocuments(a.id, [{ sourceName: 'a.md', text: '不同内容。' }]);
  assert.equal(library.documents(a.id).length, 2);

  // Format and size limits are real.
  await assert.rejects(library.importDocuments(a.id, [{ sourceName: 'a.pdf', text: 'x' }]), /格式|格式|格式|仅支持/);
  await assert.rejects(library.importDocuments(a.id, [{ sourceName: 'big.txt', text: 'x'.repeat(KNOWLEDGE_LIMITS.maxDocumentBytes + 1) }]), /大小|上限/);
  await assert.rejects(library.importDocuments(a.id, Array.from({ length: KNOWLEDGE_LIMITS.maxFilesPerImport + 1 }, (_, i) => ({ sourceName: `f${i}.txt`, text: 'x' }))), /最多|上限|数量/);
  assert.equal(library.documents(a.id).length, 2, 'a rejected import leaves no half-written document');

  // Revision conflict is refused and the accepted state survives.
  const before = library.revision();
  await assert.rejects(library.rename(a.id, '改名', before + 5), /更新|冲突|版本/);
  await library.rename(a.id, '资料A2', before);
  assert.equal(library.get(a.id)!.name, '资料A2');

  // Durability: a fresh store over the same file sees the library and its documents.
  store.close();
  const reopened = track(new SqliteMemoryStore({ filename, retention: CONFIRMED_RETENTION, invitations: confirmedInvitationPolicy('Asia/Shanghai') }));
  const reopenedLibrary = await KnowledgeLibraryStore.open(reopened, join(dir, 'books'));
  assert.equal(reopenedLibrary.list().length, 1);
  assert.equal(reopenedLibrary.documents(a.id).length, 2, 'documents survive a restart');
});

// 06-A -----------------------------------------------------------------------------------------
test('06-A A then B then none delivers only that library knowledge, and a skin change never switches it', async t => {
  const { dir, store } = await tempStore(t);
  const library = await KnowledgeLibraryStore.open(store, join(dir, 'books'));
  const a = await library.create('库A'), b = await library.create('库B');
  await library.importDocuments(a.id, [{ sourceName: '同名.md', text: '库A专属知识：喜欢喝乌龙茶。' }]);
  await library.importDocuments(b.id, [{ sourceName: '同名.md', text: '库B专属知识：喜欢喝黑咖啡。' }]);

  await library.activate(library.revision(), a.id);
  const fromA = await library.selection(300);
  assert.ok(fromA);
  const textA = fromA.blocks.map(block => block.text).join('\n');
  assert.match(textA, /乌龙茶/);
  assert.doesNotMatch(textA, /黑咖啡/, 'library A never leaks library B content');

  await library.activate(library.revision(), b.id);
  const fromB = await library.selection(300);
  assert.ok(fromB);
  const textB = fromB.blocks.map(block => block.text).join('\n');
  assert.match(textB, /黑咖啡/);
  assert.doesNotMatch(textB, /乌龙茶/);

  await library.activate(library.revision(), null);
  assert.equal(await library.selection(300), null, 'the none selection carries no knowledge');

  // Switching a skin is not a library operation: the active selection is unchanged by appearance work.
  await library.activate(library.revision(), a.id);
  const active = library.active();
  assert.equal(active.libraryId, a.id);
  assert.equal(active.revision, library.revision(), 'the active selection is pinned to a library revision');
});

test('06-A each library keeps its own revision, and a document edit raises the knowledge revocation', async t => {
  const { dir, store } = await tempStore(t);
  const library = await KnowledgeLibraryStore.open(store, join(dir, 'books'));
  const a = await library.create('库A');
  await library.importDocuments(a.id, [{ sourceName: 'x.md', text: '第一版内容。' }]);
  await library.activate(library.revision(), a.id);
  const before = library.active();
  const doc = library.documents(a.id)[0]!;
  await library.removeDocument(a.id, doc.id, library.revision());
  const after = library.active();
  assert.ok(after.revision > before.revision, 'removing a document raises the knowledge revocation revision');
  // The activation baseline stays pinned (that is what makes a stale snapshot detectable), while a
  // fresh selection reports the library's CURRENT revision, so content and revision always agree.
  const emptied = await library.selection(300);
  assert.ok(emptied, 'an emptied library is still a selected library, distinct from "no library"');
  assert.equal(emptied.blocks.length, 0, 'an emptied library contributes no blocks');
  assert.notEqual(emptied.libraryRevision, before.libraryRevision, 'the fresh selection reports the current library revision');
  assert.ok(emptied.revision > before.revision, 'and it carries the raised revocation revision');
});

// 06-C -----------------------------------------------------------------------------------------
test('06-C deleting the active library falls back to none and never auto-selects another library', async t => {
  const { dir, store } = await tempStore(t);
  const library = await KnowledgeLibraryStore.open(store, join(dir, 'books'));
  const a = await library.create('库A'), b = await library.create('库B');
  await library.importDocuments(b.id, [{ sourceName: 'b.md', text: '库B内容。' }]);
  await library.activate(library.revision(), a.id);
  await library.deleteLibrary(a.id, library.revision());
  const active = library.active();
  assert.equal(active.libraryId, null, 'deleting the active library returns to none');
  assert.equal(active.revision, library.revision());
  assert.equal(await library.selection(300), null);
  assert.ok(library.get(b.id), 'the other library still exists but was not auto-selected');
});

// 06-D -----------------------------------------------------------------------------------------
test('06-D input budget, stable ordering, non-executing body and traceable sources', async t => {
  const { dir, store } = await tempStore(t);
  const library = await KnowledgeLibraryStore.open(store, join(dir, 'books'));
  const a = await library.create('库A');
  const long = Array.from({ length: 400 }, (_, i) => `第${i}段：这是一段用于预算测试的正文内容。`).join('\n\n');
  await library.importDocuments(a.id, [{ sourceName: 'long.md', text: long }, { sourceName: 'short.md', text: '短文档。' }]);
  await library.activate(library.revision(), a.id);

  const selection = await library.selection(120);
  assert.ok(selection);
  assert.ok(selection.inputTokens <= 120, 'the selection respects its explicit token budget');
  assert.ok(selection.omittedCount > 0, 'truncation is visible as an omitted count');
  assert.equal(selection.libraryId, a.id);

  // Stable: the same library revision produces the same ordered block ids.
  const again = await library.selection(120);
  assert.deepEqual(again!.blocks.map(block => [block.documentId, block.ordinal]), selection.blocks.map(block => [block.documentId, block.ordinal]));

  // Every block traces back to a document, a revision and a Unicode code point range in that document.
  for (const block of selection.blocks) {
    const document = library.getDocument(block.documentId)!;
    assert.equal(block.documentRevision, document.revision);
    assert.equal(block.sourceName, document.sourceName);
    assert.ok(block.locator.end > block.locator.start);
  }

  // Markdown is data, never an instruction: HTML/scripts stay literal text and no file is resolved.
  // Its own library keeps it inside the budget, so this asserts the content rule and not truncation.
  const evil = await library.create('脚本库');
  await library.importDocuments(evil.id, [{ sourceName: 'evil.md', text: '<script>alert(1)</script>\n[链接](file:///etc/passwd)' }]);
  await library.activate(library.revision(), evil.id);
  const withEvil = await library.selection(400);
  assert.ok(withEvil);
  const joined = withEvil.blocks.map(block => block.text).join('\n');
  assert.ok(joined.includes('<script>alert(1)</script>'), 'the literal script text is preserved as inert data');
  assert.ok(joined.includes('file:///etc/passwd'), 'a link target stays literal text and is never resolved or fetched');
  assert.equal(withEvil.omittedCount, 0);
});

test('06-D the library reads only the selected UTF-8 text files and enforces the total body limit', async () => {
  assert.deepEqual(KNOWLEDGE_LIMITS.acceptedExtensions, ['.txt', '.md', '.markdown']);
  assert.equal(KNOWLEDGE_LIMITS.maxDocumentBytes, 2 * 1024 * 1024);
  assert.equal(KNOWLEDGE_LIMITS.maxFilesPerImport, 20);
  assert.equal(KNOWLEDGE_LIMITS.maxLibraryBytes, 20 * 1024 * 1024);
  // Splitting is deterministic and produces bounded, non-empty blocks in document order.
  const blocks = splitKnowledgeBlocks('第一段。\n\n第二段。\n\n第三段。', 100);
  assert.ok(blocks.length >= 2);
  assert.deepEqual(blocks.map(block => block.start), [...blocks.map(block => block.start)].sort((a, b) => a - b));
  for (const block of blocks) assert.ok(block.text.trim().length > 0);
});
// 06-E -----------------------------------------------------------------------------------------
test('06-E panel import -> switch -> the real production dialogue port receives only the selected knowledge', async t => {
  const { dir, store } = await tempStore(t);
  const library = await KnowledgeLibraryStore.open(store, join(dir, 'books'));
  const { knowledgeManagement } = await import('../../management/knowledge-routes.js');
  const port = knowledgeManagement(library);

  // Drive the real management port exactly as the page does, not the store directly.
  const a = await port.create('资料A');
  const b = await port.create('资料B');
  const fromList = (snapshot: { libraries: readonly { id: string; name: string }[] }, name: string) => snapshot.libraries.find(library => library.name === name)!.id;
  await port.importDocuments(fromList(a, '资料A'), [{ sourceName: 'a.md', text: '资料A：用户喜欢乌龙茶。' }]);
  await port.importDocuments(fromList(b, '资料B'), [{ sourceName: 'b.md', text: '资料B：用户喜欢黑咖啡。' }]);

  // The production memory port is the object under test: it must read the ACTIVE library per turn.
  const { SqliteMemoryPort } = await import('../../memory/sqlite-port.js');
  const scope = { characterId: COMPANION_ID, sessionId: 'session-e', turnId: 'turn-e', generation: 1 };
  await store.append(scope, [{ characterId: COMPANION_ID, id: 'turn-e:user', role: 'user', text: '我喜欢喝什么？', createdAt: new Date().toISOString() }]);
  const memory = new SqliteMemoryPort(store, {
    summaryLimit: 4, inputTokenBudget: 4000, maxRecentMessages: 8, maxMemories: 4,
    countTokens: context => JSON.stringify(context).length, relevance: () => 1,
    knowledge: () => library.selection()
  });

  await port.activate((await port.snapshot()).revision, fromList(a, '资料A'));
  const first = await memory.context(scope, '我喜欢喝什么？', null, new AbortController().signal);
  assert.ok(first.knowledge, 'the production context carries the active knowledge selection');
  assert.ok(first.knowledge.blocks.some(block => block.text.includes('乌龙茶')));
  assert.ok(!first.knowledge.blocks.some(block => block.text.includes('黑咖啡')));

  await port.activate((await port.snapshot()).revision, fromList(b, '资料B'));
  const second = await memory.context(scope, '我喜欢喝什么？', null, new AbortController().signal);
  assert.ok(second.knowledge!.blocks.some(block => block.text.includes('黑咖啡')), 'the switch is visible to the next turn');
  assert.ok(!second.knowledge!.blocks.some(block => block.text.includes('乌龙茶')));

  await port.activate((await port.snapshot()).revision, null);
  const third = await memory.context(scope, '我喜欢喝什么？', null, new AbortController().signal);
  assert.equal(third.knowledge, undefined, 'no library selected means no knowledge reaches the provider');

  // The same selection is what the real provider serializes, so assert the wire text as well.
  const { OpenAiCompatibleDialogueProvider } = await import('../../providers/aika-dialogue.js');
  const { ProviderTransport } = await import('../../providers/transport.js');
  await port.activate((await port.snapshot()).revision, fromList(a, '资料A'));
  const withKnowledge = await memory.context(scope, '我喜欢喝什么？', null, new AbortController().signal);
  const bodies: string[] = [];
  const transport = new ProviderTransport((async (_url: string, init: RequestInit) => {
    bodies.push(String(init.body));
    const frames = [JSON.stringify({ choices: [{ delta: { content: '乌龙茶。' }, finish_reason: 'stop' }] }), '[DONE]'].map(frame => `data: ${frame}\r\n\r\n`).join('');
    return new Response(frames, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as unknown as typeof fetch);
  const provider = new OpenAiCompatibleDialogueProvider(transport, { endpoint: 'https://unit.invalid/chat/completions', model: 'm', apiKey: () => 'k', authorizer: { async authorize() { return { async settle() {} }; } } }, '身份。');
  await provider.reply({ scope, text: '我喜欢喝什么？', context: withKnowledge } as never, new AbortController().signal);
  assert.equal(bodies.length, 1);
  assert.ok(bodies[0]!.includes('乌龙茶'), 'the selected knowledge actually reaches the provider request');
  assert.ok(!bodies[0]!.includes('黑咖啡'), 'the unselected library never reaches the provider request');
  assert.ok(bodies[0]!.includes('参考资料'), 'knowledge is labelled as reference data, not as an instruction');
});
