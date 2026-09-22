// N07-05: bounded, explainable ContextSource adapter for the continuity package.
// It composes the immutable Character Pack and pair-scoped User Soul/Wiki/relationship data. The
// adapter never calls a model and never becomes a second Dialogue pipeline.
import type { PairingScope, ContinuitySnapshot } from '../contracts/character-pack.js';
import type { ContinuityContextRequest, ContinuityContextResult, ContinuityContextSegment, ContinuityContextSource, ContinuityContextSourceAdapter } from '../contracts/continuity-context.js';
import { factSegment } from '../contracts/continuity-context.js';
import type { ContinuityMemorySnapshot } from '../contracts/continuity-memory.js';
import type { ContinuityMemoryStore } from './continuity-memory-store.js';
import { ContinuityMemoryError } from './continuity-memory-store.js';
import type { ContinuityReadPort } from '../contracts/character-pack.js';

interface Ranked { segment: ContinuityContextSegment; priority: number; overlap: number; order: number }
const PRIORITY: Readonly<Record<ContinuityContextSource, number>> = Object.freeze({ character_soul: 100, relationship: 90, user_soul: 85, canon_timeline: 70, user_wiki: 60, companion_timeline: 50 });
const codePoints = (value: string): number => [...value].length;
const estimateTokens = (value: string): number => Math.ceil(codePoints(value) / 4) + 4;
const terms = (value: string): readonly string[] => [...new Set((value.toLocaleLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []))];
const overlap = (query: readonly string[], text: string): number => { const set = new Set(terms(text)); return query.reduce((sum, term) => sum + (set.has(term) ? 1 : 0), 0); };
const normalize = (value: string): string => value.replace(/\s+/g, ' ').trim().toLocaleLowerCase();

function segment(source: ContinuityContextSource, key: string, text: string, evidenceIds: readonly string[], reason: string): ContinuityContextSegment {
  return Object.freeze({ key, source, text, evidenceIds: Object.freeze([...evidenceIds]), tokens: estimateTokens(text), selected: false, reason });
}

export class ContinuityContextComposer implements ContinuityContextSourceAdapter {
  constructor(private readonly continuity: ContinuityReadPort, private readonly memory: ContinuityMemoryStore) {}

  async compose(request: ContinuityContextRequest): Promise<ContinuityContextResult> {
    if (!Number.isSafeInteger(request.tokenBudget) || request.tokenBudget <= 0) throw new ContinuityMemoryError('invalid_request', 'Context token budget 无效。');
    if (typeof request.query !== 'string' || request.query.length > 16_000) throw new ContinuityMemoryError('invalid_request', 'Context query 无效。');
    const [continuity, memory] = await Promise.all([
      this.continuity.getSnapshot(request.pairing, { cutoffPoint: request.cutoffPoint, maxCanonEvents: request.maxCanonEvents ?? 50, maxCompanionEvents: request.maxCompanionEvents ?? 50 }),
      Promise.resolve(this.memory.snapshot(request.pairing, request.now === undefined ? {} : { now: request.now })),
    ]);
    const all: Ranked[] = [];
    let order = 0;
    const pack = continuity.activePack;
    if (pack) {
      const soul = [pack.name, pack.soul, ...(pack.styleHints ?? [])].filter(Boolean).join('\n');
      all.push({ segment: segment('character_soul', `pack:${pack.id}:soul`, soul, pack.sourceIds, '活动 Character Soul 核心'), priority: PRIORITY.character_soul, overlap: overlap(terms(request.query), soul), order: order++ });
      for (const event of continuity.canonTimeline) {
        const text = event.chapter ? `${event.chapter}：${event.summary}` : event.summary;
        all.push({ segment: segment('canon_timeline', `canon:${event.eventId}`, text, event.evidenceIds, event.awareness === 'unknown' ? '原作事件但角色未知；仅在显式允许时召回' : '截止点内的原作事件'), priority: PRIORITY.canon_timeline, overlap: overlap(terms(request.query), text), order: order++ });
      }
    }
    for (const fact of memory.relationship) { const item = factSegment('relationship', fact, estimateTokens); all.push({ segment: item, priority: PRIORITY.relationship, overlap: overlap(terms(request.query), item.text), order: order++ }); }
    for (const fact of memory.soul) { const item = factSegment('user_soul', fact, estimateTokens); all.push({ segment: item, priority: PRIORITY.user_soul, overlap: overlap(terms(request.query), item.text), order: order++ }); }
    for (const fact of memory.wiki) { const item = factSegment('user_wiki', fact, estimateTokens); all.push({ segment: item, priority: PRIORITY.user_wiki, overlap: overlap(terms(request.query), item.text), order: order++ }); }
    for (const event of continuity.companionTimeline) {
      const text = `用户：${event.userText}\n角色：${event.assistantText}`;
      all.push({ segment: segment('companion_timeline', `companion:${event.eventId}`, text, event.sourceIds ?? [], '当前配对的共同经历'), priority: PRIORITY.companion_timeline, overlap: overlap(terms(request.query), text), order: order++ });
    }

    const seen = new Set<string>();
    const unique = all.map(item => {
      const key = normalize(item.segment.text);
      if (seen.has(key)) return { ...item, duplicate: true };
      seen.add(key); return { ...item, duplicate: false };
    });
    const ranked = unique.filter(item => !item.duplicate).sort((a, b) => b.priority - a.priority || b.overlap - a.overlap || a.order - b.order);
    let used = 0;
    const selected: ContinuityContextSegment[] = [], omitted: ContinuityContextSegment[] = [];
    const selectedKeys = new Set<string>();
    for (const item of ranked) {
      if (used + item.segment.tokens <= request.tokenBudget) {
        used += item.segment.tokens; selectedKeys.add(item.segment.key);
        selected.push(Object.freeze({ ...item.segment, selected: true }));
      } else omitted.push(Object.freeze({ ...item.segment, reason: '超出本轮 Context 预算' }));
    }
    for (const item of unique.filter(item => item.duplicate)) omitted.push(Object.freeze({ ...item.segment, reason: '与更高优先级条目重复' }));
    const render = selected.map(item => {
      const label = item.source === 'character_soul' ? '角色底色' : item.source === 'relationship' ? '关系适应' : item.source === 'user_soul' ? '用户稳定偏好' : item.source === 'canon_timeline' ? '原作时间线' : item.source === 'user_wiki' ? '用户资料' : '共同经历';
      return `【${label}】\n${item.text}`;
    }).join('\n\n');
    return Object.freeze({ pairing: Object.freeze({ ...request.pairing }), revision: `${continuity.packRevision}:${memory.revision}`, text: render, segments: Object.freeze(unique.map(item => item.segment)), selected: Object.freeze(selected), omitted: Object.freeze(omitted), continuity, memory });
  }

  async assertCurrent(result: ContinuityContextResult): Promise<void> {
    const currentMemory = this.memory.snapshot(result.pairing);
    if (currentMemory.revision !== result.memory.revision) throw new ContinuityMemoryError('version_conflict', '连续性 Context 已失效。');
    const snapshot = await this.continuity.getSnapshot(result.pairing);
    if (snapshot.packRevision !== result.continuity.packRevision) throw new ContinuityMemoryError('version_conflict', '角色包 Context 已失效。');
  }
}

export { ContinuityContextComposer as ContinuityContextSourceAdapterImpl };
