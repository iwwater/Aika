/**
 * Knowledge 索引与检索服务（LLM-05）。
 *
 * 存储走注入的 SqlExecutor（生产 = sqliteStorage 暴露的连接；测试 = node:sqlite
 * 临时库）。文档/分块带 active 标记：导入在事务内先写 staging（active=0）、再
 * 切换激活，任何一步失败整体回滚——上个可用版本原样保留。FTS5（trigram）只做
 * 候选召回；排序、阈值与打分统一走 domain/knowledge 的 BM25，FTS 不可用或
 * MATCH 异常时降级为全量打分（本地小语料），并带显式 degraded 原因。
 */

import {
  bm25Scores,
  isPureHiragana,
  buildMatchExpression,
  chunkParsedDocument,
  documentIdentityKey,
  isKnowledgeType,
  isStageUnlocked,
  KNOWLEDGE_IMPORT_LIMITS,
  KNOWLEDGE_MIN_SCORE,
  modesForDocument,
  normalizeScore,
  normalizeKnowledgeText,
  parseJsonDocument,
  parseMarkdownDocument,
  tokenize,
  type KnowledgeDocument,
  type KnowledgeChunk,
  type KnowledgeHit,
  type KnowledgeQuery,
  type KnowledgeRetrieval,
  type KnowledgeStage,
  type KnowledgeType,
} from "../../domain/knowledge";
import { estimateTokens } from "../../domain/context";
import type { ModeId } from "../../domain/soul";
import type { SqlExecutor } from "../memory/sqliteMemoryStore";

export const KNOWLEDGE_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS knowledge_documents (
     id TEXT PRIMARY KEY,
     source_path TEXT NOT NULL,
     content_hash TEXT NOT NULL,
     version INTEGER NOT NULL,
     character_id TEXT NOT NULL,
     type TEXT NOT NULL,
     tags TEXT NOT NULL,
     unlock_stage TEXT NOT NULL,
     allowed_modes TEXT NOT NULL,
     active INTEGER NOT NULL DEFAULT 0,
     updated_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS knowledge_chunks (
     id TEXT PRIMARY KEY,
     document_id TEXT NOT NULL,
     section TEXT NOT NULL,
     text TEXT NOT NULL,
     order_index INTEGER NOT NULL,
     active INTEGER NOT NULL DEFAULT 0
   )`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5 (
     id UNINDEXED,
     content,
     tokenize = 'trigram'
   )`,
] as const;

/** 只读明确选中的文本资源；读不到/超限就在导入时报错，不扫描目录。 */
export interface KnowledgeFileReader {
  read(path: string): Promise<string>;
}

export interface KnowledgeImportEntry {
  path: string;
  characterId: string;
  type: KnowledgeType;
  tags?: readonly string[];
  unlockStage: KnowledgeStage;
  allowedModes?: readonly ModeId[];
}

export interface KnowledgeIndex {
  importDocuments(entries: readonly KnowledgeImportEntry[]): Promise<{ updated: number; skipped: number }>;
  /** 用户直接在 Wiki 里写的正文：与文件导入同一条解析/切块/版本路径，只是不经过文件读取。 */
  importContent(entries: readonly KnowledgeContentEntry[]): Promise<{ updated: number; skipped: number }>;
  /** 全部激活条目（Wiki 列表用），按更新时间倒序。 */
  listDocuments(): Promise<readonly KnowledgeDocumentSummary[]>;
  removeDocument(id: string): Promise<void>;
  retrieve(query: KnowledgeQuery): Promise<KnowledgeRetrieval>;
  /** 诊断：当前 revision（缓存键的一部分）与 FTS 可用性。 */
  status(): { revision: number; fts: boolean };
}

/** 用户直接在 Wiki 里写的条目：跳过文件读取，其余与文件导入完全一致。 */
export interface KnowledgeContentEntry extends KnowledgeImportEntry {
  content: string;
}

/** Wiki 列表条目：文档元数据 + 块数与更新时间。 */
export interface KnowledgeDocumentSummary extends KnowledgeDocument {
  updatedAt: number;
  chunks: number;
}

export interface KnowledgeIndexOptions {
  db: SqlExecutor;
  readFile?: KnowledgeFileReader;
  now?: () => number;
}

interface DocumentRow {
  id: string;
  source_path: string;
  content_hash: string;
  version: number;
  character_id: string;
  type: string;
  tags: string;
  unlock_stage: string;
  allowed_modes: string;
  active: number;
}

interface ChunkRow {
  id: string;
  document_id: string;
  section: string;
  text: string;
  order_index: number;
}

function parseJsonArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

async function withTransaction<T>(db: SqlExecutor, work: () => Promise<T>): Promise<T> {
  await db.execute("BEGIN IMMEDIATE");
  try {
    const result = await work();
    await db.execute("COMMIT");
    return result;
  } catch (error) {
    try {
      await db.execute("ROLLBACK");
    } catch {
      // 回滚失败时连接已不可用；原错误更有诊断价值。
    }
    throw error;
  }
}

function parseDocumentFile(path: string, raw: string) {
  if (raw.length > KNOWLEDGE_IMPORT_LIMITS.maxFileChars) {
    throw new Error(`知识文件超出大小上限：${path}`);
  }
  return path.toLowerCase().endsWith(".json")
    ? parseJsonDocument(path, raw)
    : parseMarkdownDocument(path, raw);
}

export function createKnowledgeIndex(options: KnowledgeIndexOptions): KnowledgeIndex {
  const db = options.db;
  const now = options.now ?? Date.now;

  let revision = 0;
  let ftsAvailable = false;
  let ensured = false;
  let importChain: Promise<unknown> = Promise.resolve();
  const cache = new Map<string, KnowledgeRetrieval>();

  function bumpRevision(): void {
    revision += 1;
    cache.clear();
  }

  async function ensureSchema(): Promise<void> {    if (ensured) return;
    for (const statement of KNOWLEDGE_SCHEMA) {
      if (statement.includes("VIRTUAL TABLE")) {
        try {
          await db.execute(statement);
          ftsAvailable = true;
        } catch {
          // FTS 建不出来只降级：检索走全量打分，功能不受影响（可见 degraded）。
          ftsAvailable = false;
        }
        continue;
      }
      await db.execute(statement);
    }
    ensured = true;
  }

  function hashString(text: string): number {
    let hash = 5381;
    for (let index = 0; index < text.length; index += 1) {
      hash = ((hash << 5) + hash + text.charCodeAt(index)) | 0;
    }
    return hash;
  }

  async function importOne(entry: KnowledgeImportEntry, raw: string): Promise<"updated" | "skipped"> {
    if (!entry.characterId || !isKnowledgeType(entry.type)) {
      throw new Error(`知识导入参数不完整：${entry.path}`);
    }
    const parsed = parseDocumentFile(entry.path, raw);
    const identity = documentIdentityKey({ sourcePath: entry.path, characterId: entry.characterId, type: entry.type });
    const id = `k-${Math.abs(hashString(identity)).toString(16)}`;

    const existingRows = await db.select<DocumentRow[]>(
      "SELECT * FROM knowledge_documents WHERE id = $1 AND active = 1",
      [id],
    );
    const existingList = Array.isArray(existingRows) ? existingRows : [];
    const existing = existingList[0];
    const tags = [...entry.tags ?? []];
    const allowedModes = entry.allowedModes ? [...entry.allowedModes] : null;
    const metadataUnchanged = existing
      && existing.content_hash === parsed.contentHash
      && existing.unlock_stage === entry.unlockStage
      && parseJsonArray(existing.tags).join("\u0000") === tags.join("\u0000")
      && parseJsonArray(existing.allowed_modes).join("\u0000") === (allowedModes ?? []).join("\u0000");
    if (existing && metadataUnchanged) return "skipped";

    const version = (existing?.version ?? 0) + 1;
    const chunks = chunkParsedDocument(parsed, id);
    if (chunks.length >= KNOWLEDGE_IMPORT_LIMITS.maxChunksPerDocument) {
      throw new Error(`知识文件切块数超上限：${entry.path}`);
    }

    // staging：全部以 active=0 写入；同事务内切换激活，失败整体回滚。
    // FTS 不做增量删改——事务末尾 rebuildFts 统一按激活行重建。
    await db.execute("DELETE FROM knowledge_chunks WHERE document_id = $1", [id]);
    await db.execute("DELETE FROM knowledge_documents WHERE id = $1", [id]);
    await db.execute(
      `INSERT INTO knowledge_documents
       (id, source_path, content_hash, version, character_id, type, tags, unlock_stage, allowed_modes, active, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 0, $10)`,
      [id, entry.path, parsed.contentHash, version, entry.characterId, entry.type,
        JSON.stringify(tags), entry.unlockStage, JSON.stringify(allowedModes ?? []), now()],
    );
    for (const chunk of chunks) {
      await db.execute(
        "INSERT INTO knowledge_chunks (id, document_id, section, text, order_index, active) VALUES ($1, $2, $3, $4, $5, 0)",
        [chunk.id, chunk.documentId, chunk.section, chunk.text, chunk.order],
      );
    }
    // 原子激活：只有本批文档翻 1，其他文档不动（“不删除未在本批出现的其他文档”）。
    await db.execute("UPDATE knowledge_documents SET active = 1 WHERE id = $1", [id]);
    await db.execute("UPDATE knowledge_chunks SET active = 1 WHERE document_id = $1", [id]);
    return "updated";
  }

  async function rebuildFts(): Promise<void> {
    if (!ftsAvailable) return;
    await db.execute("DELETE FROM knowledge_fts");
    const rows = await db.select<ChunkRow[]>(
      "SELECT id, text FROM knowledge_chunks WHERE active = 1",
    );
    for (const row of Array.isArray(rows) ? rows : []) {
      await db.execute("INSERT INTO knowledge_fts (id, content) VALUES ($1, $2)", [row.id, row.text]);
    }
  }

  function cacheKey(query: KnowledgeQuery, revisionValue: number): string {
    return [
      revisionValue, query.characterId, query.stage, query.mode,
      normalizeKnowledgeText(query.text.trim()), query.limit, query.tokenBudget,
    ].join("|");
  }

  async function loadVisibleDocs(characterId: string, stage: KnowledgeStage, mode: ModeId): Promise<KnowledgeDocument[]> {
    const rows = await db.select<DocumentRow[]>(
      "SELECT * FROM knowledge_documents WHERE active = 1 AND character_id = $1",
      [characterId],
    );
    const visible: KnowledgeDocument[] = [];
    for (const row of Array.isArray(rows) ? rows : []) {
      // 过滤在打分之前：stage 与 mode 不合格的文档根本不进入候选集。
      if (!isStageUnlocked(row.unlock_stage as KnowledgeStage, stage)) continue;
      const doc: KnowledgeDocument = {
        id: row.id,
        sourcePath: row.source_path,
        contentHash: row.content_hash,
        version: row.version,
        characterId: row.character_id,
        type: row.type as KnowledgeType,
        tags: parseJsonArray(row.tags),
        unlockStage: row.unlock_stage as KnowledgeStage,
        allowedModes: parseJsonArray(row.allowed_modes) as ModeId[],
      };
      if (!modesForDocument(doc).includes(mode)) continue;
      visible.push(doc);
    }
    return visible;
  }

  async function retrieveUncached(query: KnowledgeQuery): Promise<KnowledgeRetrieval> {
    const docs = await loadVisibleDocs(query.characterId, query.stage, query.mode);
    if (!docs.length) return { hits: [], degraded: null };
    const docIds = docs.map((doc) => doc.id);
    const placeholders = docIds.map((_, index) => `$${index + 1}`).join(",");
    const chunkRows = await db.select<ChunkRow[]>(
      `SELECT id, document_id, section, text, order_index FROM knowledge_chunks
       WHERE active = 1 AND document_id IN (${placeholders})`,
      docIds,
    );
    const allChunks = Array.isArray(chunkRows) ? chunkRows : [];

    const queryTokens = tokenize(query.text);
    const scoredDocs = allChunks.map((row) => {
      const tokens = tokenize(row.text);
      const counts = new Map<string, number>();
      for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
      return { id: row.id, counts, length: tokens.length };
    });
    const averageLength = scoredDocs.reduce((sum, doc) => sum + doc.length, 0) / Math.max(1, scoredDocs.length);

    let degraded: string | null = null;
    let candidates = scoredDocs;
    if (ftsAvailable) {
      const matchExpression = buildMatchExpression(queryTokens);
      if (matchExpression) {
        try {
          const rows = await db.select<Array<{ id: string }>>(
            `SELECT id FROM knowledge_fts WHERE knowledge_fts MATCH $1 LIMIT 500`,
            [matchExpression],
          );
          const candidateIds = new Set((Array.isArray(rows) ? rows : []).map((row) => row.id));
          candidates = scoredDocs.filter((doc) => candidateIds.has(doc.id));
          if (!candidates.length) candidates = scoredDocs;
        } catch (error) {
          // MATCH 异常绝不扩成全库命中：降级为受控的全量 BM25 打分（只返回真实命中）。
          degraded = `FTS 查询异常，已降级为全量打分：${error instanceof Error ? error.message : String(error)}`;
          candidates = scoredDocs;
        }
      } else {
        degraded = "查询词过短，未使用 FTS，已降级为全量打分";
      }
    } else {
      degraded = "FTS 不可用，已降级为全量打分";
    }

    const scores = bm25Scores(queryTokens, candidates, averageLength);
    const matchedTokensOf = (chunkId: string): string[] => {
      const doc = candidates.find((candidate) => candidate.id === chunkId);
      if (!doc) return [];
      return queryTokens.filter((token, index) => doc.counts.has(token) && queryTokens.indexOf(token) === index);
    };
    const docById = new Map(docs.map((doc) => [doc.id, doc]));
    const chunkById = new Map(allChunks.map((row): [string, KnowledgeChunk] => [row.id, {
      id: row.id,
      documentId: row.document_id,
      section: row.section,
      text: row.text,
      order: row.order_index,
    }]));
    const ranked = [...scores.entries()]
      .map(([chunkId, score]) => ({ chunkId, score, normalizedScore: normalizeScore(score) }))
      .filter((entry) => entry.normalizedScore >= KNOWLEDGE_MIN_SCORE)
      .sort((a, b) => b.score - a.score);

    const hits: KnowledgeHit[] = [];
    let usedTokens = 0;
    for (const entry of ranked) {
      if (hits.length >= query.limit) break;
      const chunk = chunkById.get(entry.chunkId);
      const document = chunk ? docById.get(chunk.documentId) : undefined;
      if (!chunk || !document) continue;
      // 可靠性闸门：至少一个**非纯假名** query token 命中。纯假名 bigram
      //（「って」「ます」）是功能词碎片，蹭到不算证据（LLM-05 冻结规则）。
      const matched = matchedTokensOf(entry.chunkId);
      const contentMatches = matched.filter((token) => !isPureHiragana(token));
      if (!contentMatches.length) continue;
      const textTokens = estimateTokens(chunk.text);
      if (usedTokens + textTokens > query.tokenBudget) continue;
      usedTokens += textTokens;
      hits.push({
        chunk,
        document,
        normalizedScore: entry.normalizedScore,
        citation: {
          documentId: document.id,
          chunkId: chunk.id,
          version: document.version,
          sourcePath: document.sourcePath,
        },
      });
    }
    return { hits, degraded };
  }

  return {
    async importDocuments(entries: readonly KnowledgeImportEntry[]): Promise<{ updated: number; skipped: number }> {
      if (entries.length > KNOWLEDGE_IMPORT_LIMITS.maxFiles) {
        throw new Error(`单次导入文件数超上限（${KNOWLEDGE_IMPORT_LIMITS.maxFiles}）`);
      }
      await ensureSchema();
      // 并发导入串行化：后到的等先到的提交，避免 staging 互相踩（AC-E）。
      const run = importChain.then(async () => {
        let updated = 0;
        let skipped = 0;
        const reader = options.readFile;
        if (!reader) throw new Error("未注入 KnowledgeFileReader，无法读取知识文件");
        await withTransaction(db, async () => {
          for (const entry of entries) {
            const raw = await reader.read(entry.path);
            const outcome = await importOne(entry, raw);
            if (outcome === "updated") updated += 1;
            else skipped += 1;
          }
          await rebuildFts();
        });
        if (updated) bumpRevision();
        return { updated, skipped };
      });
      importChain = run.catch(() => undefined);
      return run;
    },

    async importContent(entries: readonly KnowledgeContentEntry[]): Promise<{ updated: number; skipped: number }> {
      if (entries.length > KNOWLEDGE_IMPORT_LIMITS.maxFiles) {
        throw new Error(`单次导入条目数超上限（${KNOWLEDGE_IMPORT_LIMITS.maxFiles}）`);
      }
      await ensureSchema();
      // 与文件导入同一条串行化链：Wiki 保存和文件导入不会互相踩 staging。
      const run = importChain.then(async () => {
        let updated = 0;
        let skipped = 0;
        await withTransaction(db, async () => {
          for (const entry of entries) {
            const outcome = await importOne(entry, entry.content);
            if (outcome === "updated") updated += 1;
            else skipped += 1;
          }
          await rebuildFts();
        });
        if (updated) bumpRevision();
        return { updated, skipped };
      });
      importChain = run.catch(() => undefined);
      return run;
    },

    async listDocuments(): Promise<KnowledgeDocumentSummary[]> {
      await ensureSchema();
      const rows = await db.select<(DocumentRow & { chunk_count: number; updated_at: number })[]>(
        `SELECT d.*, d.updated_at AS updated_at,
                (SELECT COUNT(*) FROM knowledge_chunks c WHERE c.document_id = d.id AND c.active = 1) AS chunk_count
         FROM knowledge_documents d WHERE d.active = 1 ORDER BY d.updated_at DESC`,
        [],
      );
      return (Array.isArray(rows) ? rows : []).map((row) => ({
        id: row.id,
        sourcePath: row.source_path,
        contentHash: row.content_hash,
        version: row.version,
        characterId: row.character_id,
        type: row.type as KnowledgeType,
        tags: parseJsonArray(row.tags),
        unlockStage: row.unlock_stage as KnowledgeStage,
        allowedModes: parseJsonArray(row.allowed_modes) as ModeId[],
        updatedAt: row.updated_at,
        chunks: row.chunk_count,
      }));
    },

    async removeDocument(id: string): Promise<void> {
      await ensureSchema();
      await withTransaction(db, async () => {
        await db.execute("DELETE FROM knowledge_documents WHERE id = $1", [id]);
        await db.execute("DELETE FROM knowledge_chunks WHERE document_id = $1", [id]);
        // FTS 整表清掉重建：本地小语料下最不易漂移的删除路径。
        await db.execute("DELETE FROM knowledge_fts");
        await rebuildFts();
      });
      bumpRevision();
    },

    async retrieve(query: KnowledgeQuery): Promise<KnowledgeRetrieval> {
      await ensureSchema();
      const key = cacheKey(query, revision);
      const cached = cache.get(key);
      if (cached) return cached;
      const result = await retrieveUncached(query);
      if (cache.size > 50) cache.clear();
      cache.set(key, result);
      return result;
    },

    status() {
      return { revision, fts: ftsAvailable };
    },
  };
}
