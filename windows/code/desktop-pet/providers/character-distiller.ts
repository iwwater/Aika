// N07-01 / N07-02: Formal CharacterDistiller implementation.
// Integrates with ProviderTransport and 0.65 ResolvedBinding architecture,
// supports AbortSignal cancellation, verifies evidence citations against real source blocks,
// enforces cutoffPoint boundaries, distinguishes explicit/inferred/disputed fact statuses,
// and persists results (validated or rejected) without polluting active packs.

import { randomUUID } from 'node:crypto';
import type { TurnScope } from '../contracts/index.js';
import type {
  CharacterPackDraft,
  CharacterPackDraftPayload,
  CharacterSourceProvider,
  CharacterSourceRef,
  DistillInput,
  DraftValidationResult,
  SourceBlock,
  SourceSnapshot,
} from '../contracts/character-pack.js';
import { CharacterPackError } from '../contracts/character-pack.js';
import type { CallAuthorizer, EndpointConfig } from './transport.js';
import { parseModelJson, ProviderTransport } from './transport.js';
import type { CharacterPackDraftStore } from '../memory/character-pack-store.js';
import {
  computeCutoffAllowedBlockIds,
  validateDraftEvidence,
} from '../memory/character-pack-validator.js';
import { CompositeCharacterSourceProvider } from '../memory/character-source-provider.js';
import { createSourceSnapshot } from '../memory/character-pack-source.js';
import { checkAbort } from '../media/scope.js';
import type { ResolvedBinding } from '../contracts/provider-source.js';
import type { SecretStore } from '../contracts/plugin.js';

export type DistillerConfigInput =
  | EndpointConfig
  | {
      readonly binding: ResolvedBinding;
      readonly endpoint?: string | undefined;
      readonly apiKey?: string | (() => string) | undefined;
      readonly keyResolver?: ((ref: string) => string) | undefined;
      readonly authorizer?: CallAuthorizer | undefined;
    };

export function resolveDistillerConfig(input: DistillerConfigInput): EndpointConfig {
  if ('binding' in input) {
    const { binding, endpoint, apiKey, keyResolver, authorizer } = input;
    const ep =
      (typeof binding.effectiveParameters['endpoint'] === 'string'
        ? (binding.effectiveParameters['endpoint'] as string)
        : undefined) ??
      endpoint ??
      '';

    if (!ep) {
      throw new CharacterPackError(
        'invalid_request',
        `ResolvedBinding "${binding.bindingId}" 缺少有效的 endpoint。`,
      );
    }

    const model = binding.nativeModelId ?? '';
    if (!model) {
      throw new CharacterPackError(
        'invalid_request',
        `ResolvedBinding "${binding.bindingId}" 缺少 nativeModelId。`,
      );
    }

    const apiKeyFn = (): string => {
      if (typeof apiKey === 'function') return apiKey();
      if (typeof apiKey === 'string') return apiKey;
      if (binding.credentialRef && keyResolver) {
        return keyResolver(binding.credentialRef);
      }
      return '';
    };

    const defaultAuthorizer: CallAuthorizer = {
      async authorize() {
        return { async settle() {} };
      },
    };

    return {
      endpoint: ep,
      model,
      apiKey: apiKeyFn,
      authorizer: authorizer ?? defaultAuthorizer,
    };
  }

  return input;
}

export interface CharacterDistillerOptions {
  readonly transport?: ProviderTransport | undefined;
  readonly store?: CharacterPackDraftStore | undefined;
  /** If true, throws CharacterPackError on rejected draft instead of returning it. Defaults to false. */
  readonly throwOnRejectedDraft?: boolean | undefined;
}

export class CharacterDistiller {
  private readonly config: EndpointConfig;
  private readonly transport: ProviderTransport;
  private readonly store?: CharacterPackDraftStore | undefined;
  private readonly throwOnRejectedDraft: boolean;

  constructor(
    configInput: DistillerConfigInput,
    options: CharacterDistillerOptions = {},
  ) {
    this.config = resolveDistillerConfig(configInput);
    this.transport = options.transport ?? new ProviderTransport();
    this.store = options.store;
    this.throwOnRejectedDraft = options.throwOnRejectedDraft ?? false;
  }

  /**
   * Distills sources into a structured Character Pack draft.
   * Supports cooperative cancellation via signal, validates all evidence references,
   * validates cutoff boundaries, and persists the resulting draft.
   */
  async distill(
    input: DistillInput,
    signal: AbortSignal,
  ): Promise<CharacterPackDraft> {
    checkAbort(signal);

    const characterId = (input.characterId || '').trim();
    if (!characterId) {
      throw new CharacterPackError('invalid_request', 'characterId 不能为空。');
    }
    if (!Array.isArray(input.sources) || input.sources.length === 0) {
      throw new CharacterPackError('invalid_request', '提炼必须提供至少一个来源快照。');
    }

    const allBlocks: SourceBlock[] = [];
    for (const src of input.sources) {
      if (src && Array.isArray(src.blocks)) {
        allBlocks.push(...src.blocks);
      }
    }
    if (allBlocks.length === 0) {
      throw new CharacterPackError('invalid_request', '所有来源快照均无有效文本区块。');
    }

    const sourceText = allBlocks
      .map(b => `[${b.id}]\n${b.text}`)
      .join('\n\n');

    const validBlockIdsList = allBlocks.map(b => `"${b.id}"`).join(', ');

    // Calculate cutoff blocks if cutoffPoint is provided
    const allowedBlockIds = input.cutoffPoint
      ? computeCutoffAllowedBlockIds(input.sources, input.cutoffPoint)
      : undefined;

    const distillPrompt = [
      '你是 Aika 0.7 的 CharacterDistiller。只根据用户提供的资料输出一行严格 JSON，不要 Markdown、解释或推理过程。每个字符串最多 120 字。',
      '不得补写资料没有的原作事实；每个 canonFacts 项必须引用一个或多个真实存在的 evidenceIds。',
      `有效的 evidenceIds 只能逐字使用以下列表中存在的 ID：[${validBlockIdsList}]。严禁编造、猜测或越界引用。`,
      input.cutoffPoint
        ? `剧情截止点设定为："${input.cutoffPoint}"。严禁提取或包含该截止点之后发生的事件或事实。超出截止点的证据区块不能被引用。`
        : '',
      '明确区分事实类型：status 必须为 "explicit"（原文明示）、"inferred"（推断）或 "disputed"（存在争议）。',
      'schema: {"schemaVersion":"0.7-draft-1","character":{"name":string,"soul":string},"canonFacts":[{"id":string,"text":string,"status":"explicit"|"inferred"|"disputed","evidenceIds":string[]}],"gaps":string[]}',
      input.characterName ? `目标角色名称：${input.characterName}` : '',
      input.cutoffPoint ? `剧情截止点：${input.cutoffPoint}` : '',
      input.instructions ? `附加指示：${input.instructions}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    const scope: TurnScope = Object.freeze({
      characterId,
      sessionId: `distill-${randomUUID()}`,
      turnId: `distill-turn-${randomUUID()}`,
      generation: 0,
    });

    const messages = [
      { role: 'system', content: distillPrompt },
      { role: 'user', content: `资料区块如下：\n${sourceText}` },
    ];

    let draftPayload: CharacterPackDraftPayload | null = null;
    let rawText = '';
    let validationResult: DraftValidationResult;

    try {
      checkAbort(signal);

      const response = await this.transport.request(
        this.config,
        scope,
        'dialogue',
        {
          messages,
          stream: true,
          temperature: input.temperature ?? 0,
          max_tokens: input.maxTokens ?? 4096,
        },
        signal,
      );

      checkAbort(signal);

      if (typeof response.text !== 'string' || !response.text.trim()) {
        throw new Error('模型返回了空响应。');
      }

      rawText = response.text.trim();
      const parsed = parseModelJson(rawText);

      validationResult = validateDraftEvidence(parsed, input.sources, {
        cutoffPoint: input.cutoffPoint,
        allowedBlockIds,
      });

      if (validationResult.valid) {
        draftPayload = parsed as unknown as CharacterPackDraftPayload;
      } else {
        draftPayload = {
          schemaVersion: typeof parsed.schemaVersion === 'string' ? parsed.schemaVersion : '0.7-draft-1',
          character: (parsed.character && typeof parsed.character === 'object')
            ? (parsed.character as any)
            : { name: input.characterName || 'Unknown', soul: 'Unresolved' },
          canonFacts: Array.isArray(parsed.canonFacts) ? (parsed.canonFacts as any) : [],
          gaps: Array.isArray(parsed.gaps) ? (parsed.gaps as any) : ['模型输出校验未通过'],
          ...(input.workTitle !== undefined ? { workTitle: input.workTitle } : {}),
          ...(input.cutoffPoint !== undefined ? { cutoffPoint: input.cutoffPoint } : {}),
        };
      }
    } catch (err: unknown) {
      if (signal.aborted) {
        throw new CharacterPackError('aborted', '提炼操作已取消。');
      }

      const errorMessage = err instanceof Error ? err.message : String(err);
      validationResult = Object.freeze({
        valid: false,
        errors: Object.freeze([`提炼失败: ${errorMessage}`]),
        validatedAt: new Date().toISOString(),
      });

      draftPayload = {
        schemaVersion: '0.7-draft-1',
        character: { name: input.characterName || 'Unknown', soul: 'Distillation failed' },
        canonFacts: [],
        gaps: [`模型提炼异常: ${errorMessage}`],
        ...(input.workTitle !== undefined ? { workTitle: input.workTitle } : {}),
        ...(input.cutoffPoint !== undefined ? { cutoffPoint: input.cutoffPoint } : {}),
      };
    }

    const sourceIds = input.sources.map(s => s.id);
    const draftId = `cpd-${randomUUID()}`;
    const packVersion = `draft-${randomUUID()}`;
    const now = new Date().toISOString();

    if (this.store) {
      const saved = await this.store.saveDraft({
        draftId,
        characterId,
        packVersion,
        payload: draftPayload,
        sourceIds,
        validation: validationResult,
      });

      if (!validationResult.valid && this.throwOnRejectedDraft) {
        throw new CharacterPackError(
          'validation_failed',
          `草稿校验失败: ${validationResult.errors.join('; ')}`,
        );
      }

      return saved;
    }

    const inMemoryDraft: CharacterPackDraft = Object.freeze({
      id: draftId,
      characterId,
      packVersion,
      schemaVersion: draftPayload.schemaVersion,
      status: validationResult.valid ? 'validated' : 'rejected',
      payload: Object.freeze(draftPayload),
      sourceIds: Object.freeze(sourceIds),
      validation: validationResult,
      createdAt: now,
      updatedAt: now,
    });

    if (!validationResult.valid && this.throwOnRejectedDraft) {
      throw new CharacterPackError(
        'validation_failed',
        `草稿校验失败: ${validationResult.errors.join('; ')}`,
      );
    }

    return inMemoryDraft;
  }

  /**
   * High-level entry point: fetches source references via a CharacterSourceProvider,
   * imports them into the store (or builds snapshots in-memory), and executes distillation.
   */
  async distillFromSourceRefs(
    params: {
      readonly characterId: string;
      readonly characterName?: string | undefined;
      readonly sourceRefs: readonly CharacterSourceRef[];
      readonly sourceProvider?: CharacterSourceProvider | undefined;
      readonly cutoffPoint?: string | undefined;
      readonly workTitle?: string | undefined;
      readonly instructions?: string | undefined;
      readonly maxTokens?: number | undefined;
      readonly temperature?: number | undefined;
    },
    signal: AbortSignal,
  ): Promise<CharacterPackDraft> {
    checkAbort(signal);

    const provider = params.sourceProvider ?? new CompositeCharacterSourceProvider();
    const fetchedSources: { sourceName: string; text: string }[] = [];

    for (const ref of params.sourceRefs) {
      checkAbort(signal);
      const fetched = await provider.fetch(ref, signal);
      fetchedSources.push({ sourceName: fetched.sourceName, text: fetched.text });
    }

    let snapshots: readonly SourceSnapshot[];
    if (this.store) {
      const importResult = await this.store.importSources(params.characterId, fetchedSources);
      snapshots = importResult.snapshots;
    } else {
      snapshots = fetchedSources.map((f, i) =>
        createSourceSnapshot(`src-mem-${i + 1}`, params.characterId, f),
      );
    }

    return this.distill(
      {
        characterId: params.characterId,
        characterName: params.characterName,
        sources: snapshots,
        cutoffPoint: params.cutoffPoint,
        workTitle: params.workTitle,
        instructions: params.instructions,
        maxTokens: params.maxTokens,
        temperature: params.temperature,
      },
      signal,
    );
  }
}
