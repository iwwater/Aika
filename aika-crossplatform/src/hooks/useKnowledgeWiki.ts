import { useCallback, useEffect, useState } from "react";
import { useOptionalService, useService } from "../app/kernelContext";
import { KnowledgeWikiToken } from "../services/knowledge/wiki";
import type { KnowledgeDocumentSummary } from "../services/knowledge/knowledgeIndex";
import type { KnowledgeStage, KnowledgeType } from "../domain/knowledge";
import { SETTING_KEYS } from "../services/storage/contracts";
import { SettingsToken } from "../services/storage/tokens";

export interface KnowledgeWikiDraft {
  title: string;
  markdown: string;
  type: KnowledgeType;
  unlockStage: KnowledgeStage;
}

/**
 * 知识库（Wiki）管理入口（MVP-06 AC-B）。
 *
 * 管理面与检索开关是两件事：这里能看/写/删条目；「条目会不会进 prompt」由
 * `knowledge.enabled` / `memory.enabled` 两个开关单独控制（也在本入口里切换）。
 */
export function useKnowledgeWiki() {
  const wiki = useOptionalService(KnowledgeWikiToken);
  const settings = useService(SettingsToken);
  const [entries, setEntries] = useState<KnowledgeDocumentSummary[]>([]);
  const [statusText, setStatusText] = useState("");
  const [draft, setDraft] = useState<KnowledgeWikiDraft>({
    title: "", markdown: "", type: "character", unlockStage: "new",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [memoryOn, setMemoryOn] = useState(true);
  const [knowledgeOn, setKnowledgeOn] = useState(true);

  const refresh = useCallback(async () => {
    if (!wiki) return;
    try {
      const [list, status] = await Promise.all([wiki.list(), wiki.status()]);
      setEntries([...list]);
      setStatusText(`${status.documents} 个条目 · FTS ${status.fts ? "可用" : "降级为全文打分"}`);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [wiki]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    void (async () => {
      if (!settings) return;
      setMemoryOn(await settings.getBoolean(SETTING_KEYS.memoryEnabled, true));
      setKnowledgeOn(await settings.getBoolean(SETTING_KEYS.knowledgeEnabled, true));
    })();
  }, [settings]);

  const toggle = useCallback(async (which: "memory" | "knowledge", value: boolean) => {
    if (!settings) return;
    await settings.setBoolean(
      which === "memory" ? SETTING_KEYS.memoryEnabled : SETTING_KEYS.knowledgeEnabled,
      value,
    );
    if (which === "memory") setMemoryOn(value);
    else setKnowledgeOn(value);
  }, [settings]);

  const save = useCallback(async () => {
    if (!wiki || !draft.title.trim() || !draft.markdown.trim()) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const saved = await wiki.save(draft);
      setNotice(saved.updated
        ? `已保存（v${saved.version}）。同名保存=编辑，版本递增。`
        : "内容与当前版本一致，未产生新版本。");
      setDraft({ title: "", markdown: "", type: draft.type, unlockStage: draft.unlockStage });
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }, [wiki, draft, refresh]);

  const remove = useCallback(async (id: string) => {
    if (!wiki) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await wiki.remove(id);
      setNotice("已删除。");
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }, [wiki, refresh]);

  return {
    available: wiki !== null,
    entries, statusText, draft, setDraft, busy, error, notice,
    memoryOn, knowledgeOn, toggle,
    save, remove, refresh,
  };
}
