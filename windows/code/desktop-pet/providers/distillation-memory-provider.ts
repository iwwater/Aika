// N075-01/R3: formal distillation memory provider.
// This replaces the experimental direct-SQL distillation from tools/real-backend.mjs with a formal
// MemoryTurnProvider implementation. Its output is a validated MemoryTurnPlan that commits strictly
// through SqliteLifecycleState.commitTurn() — with proper versioning, source graph lineage to the user
// message, FTS search triggers, and memory_turn_outcomes. It NEVER executes direct SQL INSERTs.

import { randomUUID } from 'node:crypto';
import type { MemoryChange, MemoryOperation } from '../contracts/index.js';
import type { MemoryTurnInput, MemoryTurnPlan, MemoryTurnProvider } from '../contracts/memory-lifecycle.js';
import { checkAbort } from '../media/scope.js';
import { EndpointConfig, ProviderTransport } from './transport.js';

export interface DistillationResult {
  hasMemory: boolean;
  fact?: string;
  category?: string;
}

export class DistillationMemoryTurnProvider implements MemoryTurnProvider {
  constructor(
    private readonly config: EndpointConfig,
    private readonly transport = new ProviderTransport(),
  ) {}

  async plan(input: MemoryTurnInput, signal: AbortSignal): Promise<MemoryTurnPlan> {
    checkAbort(signal);

    // 1. Locate current user utterance
    const currentSource = input.sources.find(s => s.id === input.currentMessageId);
    const userText = currentSource?.text?.trim()
      ?? input.messages.find(m => m.id === input.currentMessageId)?.text?.trim()
      ?? '';

    // If there is no user text to distill, return an empty unchanged plan immediately
    if (!userText) {
      return {
        scope: input.scope,
        request: 'none',
        changes: [],
        suppressSources: [],
        clarification: null,
        reason: 'no_user_input',
      };
    }

    // Recent assistant text if available
    const recentAssistant = input.messages.filter(m => m.role === 'assistant').at(-1)?.text?.trim();

    // 2. Distillation prompt (migrated from real-backend.mjs, strictly preserving criteria)
    const distillPrompt = `你是一个严谨的AI桌面伴侣记忆提炼器。请分析以下这一轮用户与Aika的对话，判断用户是否透露了关于自己的长期稳定事实、姓名身份、生活习惯、个人喜好或重大经历。
【对话内容】
用户：${userText}
${recentAssistant ? `Aika：${recentAssistant}\n` : ''}
【提炼准则】
1. 如果用户透露了值得长期记住的新事实（例如名字身份、习惯爱好、生日日程、重要目标等），提取1条精炼客观的事实陈述（主语必须是“用户”，如：“用户平时喜欢喝无糖乌龙茶”）。
2. 如果只是日常打招呼、闲聊、简单追问或无长期记忆价值的互动，判定为无新事实。
3. 请以严格的 JSON 格式输出，不要有 Markdown 代码块或额外文字：
若有新事实输出：{"hasMemory": true, "fact": "用户平时喜欢喝无糖乌龙茶", "category": "preference"}
若无新事实输出：{"hasMemory": false}`;

    const raw = await this.transport.request(
      this.config,
      input.scope,
      'memory_turn',
      {
        messages: [{ role: 'user', content: distillPrompt }],
        temperature: 0.1,
      },
      signal,
    );
    checkAbort(signal);

    let parsed: DistillationResult | null = null;
    try {
      const rawText = this.extractRawContent(raw);
      const cleaned = rawText.replace(/```json/g, '').replace(/```/g, '').trim();
      parsed = JSON.parse(cleaned) as DistillationResult;
    } catch {
      // Malformed model response gracefully yields no changes without crashing turn
      return {
        scope: input.scope,
        request: 'none',
        changes: [],
        suppressSources: [],
        clarification: null,
        reason: 'malformed_distillation_output',
      };
    }

    if (parsed?.hasMemory && typeof parsed.fact === 'string' && parsed.fact.trim()) {
      const fact = parsed.fact.trim();

      // Check if identical fact is already present in relevantMemories or active sources
      const alreadyKnown = input.relevantMemories.some(m => m.text.trim() === fact)
        || input.sources.some(s => s.kind === 'memory' && s.text?.trim() === fact);

      if (alreadyKnown) {
        return {
          scope: input.scope,
          request: 'none',
          changes: [],
          suppressSources: [],
          clarification: null,
          reason: 'fact_already_known',
        };
      }

      // Generate formal MemoryTurnPlan adding the new memory with strict lineage to currentMessageId
      const memId = `mem-auto-${randomUUID().slice(0, 8)}`;
      const operation: MemoryOperation = {
        type: 'add',
        id: memId,
        text: fact,
        sourceIds: [input.currentMessageId],
      };

      const change: MemoryChange = {
        scope: input.scope,
        operation,
        operationId: `distill-op-${randomUUID().slice(0, 8)}`,
        reason: 'automatic_distillation',
        createdAt: new Date().toISOString(),
      };

      return {
        scope: input.scope,
        request: 'none',
        changes: [change],
        suppressSources: [],
        clarification: null,
        reason: 'distilled_fact',
      };
    }

    return {
      scope: input.scope,
      request: 'none',
      changes: [],
      suppressSources: [],
      clarification: null,
      reason: 'no_fact_distilled',
    };
  }

  private extractRawContent(raw: unknown): string {
    if (!raw || typeof raw !== 'object') return '';
    const record = raw as Record<string, unknown>;
    if (Array.isArray(record.choices) && record.choices.length > 0) {
      const choice = record.choices[0] as Record<string, unknown>;
      const message = choice?.message as Record<string, unknown>;
      if (typeof message?.content === 'string') return message.content;
    }
    if (typeof record.text === 'string') return record.text;
    return '';
  }
}
