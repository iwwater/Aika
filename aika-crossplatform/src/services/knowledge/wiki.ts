import { token } from "../../kernel";
import type { KnowledgeStage, KnowledgeType } from "../../domain/knowledge";
import type { KnowledgeDocumentSummary, KnowledgeIndex } from "./knowledgeIndex";

/**
 * Wiki（知识库）的用户入口（MVP-06 AC-B）。
 *
 * 知识检索（`knowledgeSource`）与这份管理端口是**两个面**：前者决定「这条内容
 * 会不会进 prompt」（受 `knowledge.enabled` 与 scope 门禁），后者决定「用户能不能
 * 看到、编辑、删除自己写进来的条目」。管理面不受检索开关影响——关掉 RAG 不该
 * 把用户的条目藏起来。
 *
 * 条目身份 = `wiki://角色/标题`（`documentIdentityKey` 的输入），所以**同名保存
 * 就是编辑**（版本 +1），改名就是新条目；这是最小可用的编辑语义，不做就地改写。
 */

export interface KnowledgeWikiSaveInput {
  title: string;
  markdown: string;
  type: KnowledgeType;
  unlockStage: KnowledgeStage;
}

export interface KnowledgeWikiPort {
  status(): Promise<{ documents: number; fts: boolean; revision: number }>;
  list(): Promise<readonly KnowledgeDocumentSummary[]>;
  save(input: KnowledgeWikiSaveInput): Promise<{ id: string; version: number; updated: boolean }>;
  remove(id: string): Promise<void>;
}

export function createKnowledgeWiki(index: KnowledgeIndex, options: { characterId: string }): KnowledgeWikiPort {
  const characterId = options.characterId;
  const wikiPath = (title: string) => `wiki://${characterId}/${title.trim().toLowerCase()}`;

  return {
    async status() {
      const [status, documents] = await Promise.all([index.status(), index.listDocuments()]);
      return { documents: documents.length, fts: status.fts, revision: status.revision };
    },

    async list() {
      return index.listDocuments();
    },

    async save(input) {
      const title = input.title.trim();
      if (!title) throw new Error("Wiki 条目需要标题。");
      if (!input.markdown.trim()) throw new Error("Wiki 条目内容为空。");
      // 标题写进正文首行：切块/引用都按 markdown 解析，条目名不会在检索里丢掉。
      const content = `# ${title}\n\n${input.markdown.trim()}\n`;
      const path = wikiPath(title);
      const result = await index.importContent([
        { path, characterId, type: input.type, unlockStage: input.unlockStage, content },
      ]);
      // 把 id/version 带回给界面：编辑与新增在这里的差别只是 version 是否递增。
      const documents = await index.listDocuments();
      const saved = documents.find((document) => document.sourcePath === path);
      if (!saved) throw new Error("Wiki 条目保存后未能读回。");
      return { id: saved.id, version: saved.version, updated: result.updated > 0 };
    },

    async remove(id) {
      await index.removeDocument(id);
    },
  };
}

export const KnowledgeWikiToken = token<KnowledgeWikiPort>("knowledge.wiki");
