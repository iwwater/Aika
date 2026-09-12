/**
 * ContextAssembler。
 *
 * 纯装配层：不认 React、不发网络请求、不读存储。它拿到已归一化的历史和
 * 若干可选上下文源，产出有预算约束的 AgentContext 与一份降级 trace。
 *
 * 两条硬规则：
 * 1. 单个源慢或炸了只影响它自己：并行读取、各自限时、失败降级为「缺失原因」，
 *    绝不能把错误文本当成上下文塞给模型。
 * 2. 预算不够时先裁可裁剪的部分；连必需内容都放不进去就显式抛 CONTEXT_TOO_LARGE，
 *    绝不静默删掉角色设定或模式约束。
 */

import { toCompanionTurns, type ChatMessage } from "../../domain/conversation";
import {
  buildContextClock, estimateTokens, estimateValueTokens, sanitizeRetrievedText,
  type AgentContext, type ContextAssemblyResult, type ContextBudget, type ContextDropReason,
  type ContextSection, type ContextSnippet, type DroppedSource,
} from "../../domain/context";
import type { RelationshipState } from "../../domain/relationship";
import type { CharacterSoul, ModeConfig, UserSoul } from "../../domain/soul";

/** 只读 scope：来源可据此过滤（知识解锁阶段/角色/模式）；缺失时来源自行决定降级。 */
export interface ContextSourceScope {
  characterId?: string;
  stage?: "new" | "familiar" | "close";
  mode?: string;
}

export interface ContextSourceInput {
  query: string;
  now: number;
  signal: AbortSignal;
  /** 由 AssembleInput 透传；来源不得读全局可变状态或用 query 覆盖解锁级别。 */
  scope?: ContextSourceScope;
}

/** 一个可选上下文源。真实 Memory/RAG/环境由 LLM-04/05 实现，本阶段只消费接口。 */
export interface ContextSource {
  readonly id: string;
  readonly section: ContextSection;
  load(input: ContextSourceInput): Promise<readonly ContextSnippet[]>;
}

/** 计时器端口：注入后才好假时钟测超时，不用真的等 300ms。 */
export interface TimerPort {
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface AssembleInput {
  query: string;
  now: number;
  timeZone?: string;
  characterSoul: CharacterSoul;
  userSoul?: UserSoul | null;
  relationship: RelationshipState;
  mode: ModeConfig;
  /** 已经归一化过的历史，顺序为旧→新。 */
  history: readonly ChatMessage[];
  summary?: string | null;
  signal?: AbortSignal;
}

export const DEFAULT_SOURCE_TIMEOUT_MS = 300;

export const DEFAULT_CONTEXT_BUDGET: ContextBudget = {
  inputLimit: 6000,
  outputReserve: 800,
  safetyReserve: 400,
};

/** 必需内容放不进预算时的显式失败。调用方应当报错，而不是继续发请求。 */
export class ContextTooLargeError extends Error {
  readonly code: string;
  readonly requiredTokens: number;
  readonly availableTokens: number;

  constructor(requiredTokens: number, availableTokens: number) {
    super(`上下文必需内容超出预算：需要约 ${requiredTokens} tokens，可用 ${availableTokens} tokens`);
    this.name = "ContextTooLargeError";
    this.code = "CONTEXT_TOO_LARGE";
    this.requiredTokens = requiredTokens;
    this.availableTokens = availableTokens;
  }
}

/** AgentContext 的字段名与源所属 section 的映射，trace 里统一用 section 名。 */
const SECTION_OF_FIELD: Record<"memories" | "knowledge" | "environment", ContextSection> = {
  memories: "memory",
  knowledge: "knowledge",
  environment: "environment",
};

interface SourceOutcome {
  source: string;
  section: ContextSection;
  snippets: ContextSnippet[];
  drop: DroppedSource | null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 带超时地读一个源。
 *
 * 超时后给该源的 signal 发 abort：读取本身要么已经完成（结果作废），
 * 要么被中止，不会继续占着下一轮的配额。源的 rejection 必须接住，
 * 否则一个失败的 RAG 会把整轮对话带崩。
 */
async function loadSource(
  source: ContextSource,
  input: ContextSourceInput,
  timeoutMs: number,
  timers: TimerPort,
): Promise<SourceOutcome> {
  // 已经取消的轮次不再等任何源：读取当下就结束，连计时器都不必起。
  if (input.signal.aborted) {
    return {
      source: source.id,
      section: source.section,
      snippets: [],
      drop: { source: source.id, section: source.section, reason: "cancelled" },
    };
  }

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  input.signal.addEventListener("abort", onAbort, { once: true });
  if (input.signal.aborted) controller.abort();

  let timer: unknown = null;
  let timedOut = false;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = timers.setTimeout(() => {
      timedOut = true;
      controller.abort();
      resolve("timeout");
    }, timeoutMs);
  });

  const loading = (async (): Promise<ContextSnippet[]> => {
    const snippets = await source.load({ ...input, signal: controller.signal });
    if (!Array.isArray(snippets)) return [];
    // 净化在装配时就做：任何消费者拿到的 context 都不该带指令形状的文本。
    return snippets
      .filter((snippet) => snippet && typeof snippet.content === "string")
      .map((snippet) => ({
        ...snippet,
        content: sanitizeRetrievedText(snippet.content),
        source: snippet.source || source.id,
      }))
      .filter((snippet) => snippet.content.length > 0);
  })();

  try {
    const result = await Promise.race([loading, timeout]);
    if (result === "timeout") {
      // 迟到的结果作废：它已经不属于这一轮的上下文了。
      void loading.catch(() => undefined);
      return {
        source: source.id,
        section: source.section,
        snippets: [],
        drop: { source: source.id, section: source.section, reason: "timeout" as ContextDropReason, detail: `${timeoutMs}ms` },
      };
    }
    void loading.catch(() => undefined);
    return { source: source.id, section: source.section, snippets: result, drop: null };
  } catch (error) {
    if (timedOut) {
      return {
        source: source.id,
        section: source.section,
        snippets: [],
        drop: { source: source.id, section: source.section, reason: "timeout", detail: `${timeoutMs}ms` },
      };
    }
    if (controller.signal.aborted && !timedOut) {
      return {
        source: source.id,
        section: source.section,
        snippets: [],
        drop: { source: source.id, section: source.section, reason: "cancelled" },
      };
    }
    // 只记原因：错误文本绝不进提示词，否则一次检索报错会变成她嘴里的话。
    return {
      source: source.id,
      section: source.section,
      snippets: [],
      drop: { source: source.id, section: source.section, reason: "error", detail: messageOf(error) },
    };
  } finally {
    if (timer !== null) timers.clearTimeout(timer);
    input.signal.removeEventListener("abort", onAbort);
  }
}

/** 必需块的估算：角色设定、模式、关系、时钟、用户画像与本轮问题。 */
function requiredTokensOf(input: AssembleInput, clock: AgentContext["clock"]): number {
  return estimateValueTokens(input.characterSoul)
    + estimateValueTokens(input.mode)
    + estimateValueTokens(input.relationship)
    + estimateValueTokens(clock)
    + estimateValueTokens(input.userSoul ?? null)
    + estimateTokens(input.query);
}

export interface ContextAssembler {
  assemble(input: AssembleInput): Promise<ContextAssemblyResult>;
  readonly budget: ContextBudget;
}

export interface ContextAssemblerOptions {
  sources?: readonly ContextSource[];
  budget?: Partial<ContextBudget>;
  /** 每个源的读取时限，默认 300ms。 */
  sourceTimeoutMs?: number;
  timers?: TimerPort;
  /** 提示词里保留原文的最近轮数，超出部分交给摘要。 */
  recentTurnLimit?: number;
}

const defaultTimers: TimerPort = {
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * 按预算裁剪。
 *
 * 顺序固定：最近对话（新的优先）→ 摘要 → 记忆 → 知识 → 环境。
 * 装配结果必须与输入顺序、来源顺序无关，同样的输入永远得到同样的输出。
 */
function trimToBudget(
  draft: Omit<AgentContext, "recentConversation" | "summary" | "memories" | "knowledge" | "environment">,
  pieces: {
    recentConversation: AgentContext["recentConversation"];
    summary: string | null;
    memories: ContextSnippet[];
    knowledge: ContextSnippet[];
    environment: ContextSnippet[];
  },
  budget: ContextBudget,
  requiredTokens: number,
): { context: AgentContext; estimatedTokens: number; droppedSources: DroppedSource[] } {
  const available = Math.max(0, budget.inputLimit - budget.outputReserve - budget.safetyReserve);
  if (requiredTokens > available) throw new ContextTooLargeError(requiredTokens, available);

  let remaining = available - requiredTokens;
  const droppedSources: DroppedSource[] = [];

  const recentConversation: AgentContext["recentConversation"] = [];
  for (let index = pieces.recentConversation.length - 1; index >= 0; index -= 1) {
    const turn = pieces.recentConversation[index];
    const cost = estimateTokens(turn.text);
    if (cost > remaining) {
      droppedSources.push({
        source: "history",
        section: "history",
        reason: "trimmed",
        detail: `${index + 1} 条更早的对话因预算被裁掉`,
      });
      break;
    }
    remaining -= cost;
    recentConversation.unshift(turn);
  }

  let summary: string | null = null;
  if (pieces.summary) {
    const cost = estimateTokens(pieces.summary);
    if (cost <= remaining) {
      remaining -= cost;
      summary = pieces.summary;
    } else {
      droppedSources.push({ source: "summary", section: "summary", reason: "trimmed" });
    }
  }

  const kept = {
    memories: [] as ContextSnippet[],
    knowledge: [] as ContextSnippet[],
    environment: [] as ContextSnippet[],
  };
  for (const section of ["memories", "knowledge", "environment"] as const) {
    for (const snippet of pieces[section]) {
      const cost = estimateTokens(snippet.content);
      if (cost > remaining) {
        droppedSources.push({
          source: snippet.source,
          section: SECTION_OF_FIELD[section],
          reason: "trimmed",
          detail: "超出剩余预算",
        });
        continue;
      }
      remaining -= cost;
      kept[section].push(snippet);
    }
  }

  return {
    context: {
      ...draft,
      recentConversation,
      summary,
      memories: kept.memories,
      knowledge: kept.knowledge,
      environment: kept.environment,
    },
    estimatedTokens: available - remaining,
    droppedSources,
  };
}

export function createContextAssembler(options: ContextAssemblerOptions = {}): ContextAssembler {
  const budget: ContextBudget = { ...DEFAULT_CONTEXT_BUDGET, ...options.budget };
  const sources = options.sources ? [...options.sources] : [];
  const sourceTimeoutMs = options.sourceTimeoutMs ?? DEFAULT_SOURCE_TIMEOUT_MS;
  const timers = options.timers ?? defaultTimers;
  const recentTurnLimit = options.recentTurnLimit ?? 16;

  return {
    budget,
    async assemble(input: AssembleInput): Promise<ContextAssemblyResult> {
      const clock = buildContextClock(input.now, input.timeZone ?? "Asia/Shanghai");
      const signal = input.signal ?? new AbortController().signal;

      const outcomes = await Promise.all(
        sources.map((source) => loadSource(source, {
          query: input.query,
          now: input.now,
          signal,
          scope: {
            characterId: input.characterSoul.id,
            stage: input.relationship.stage,
            mode: input.mode.mode,
          },
        }, sourceTimeoutMs, timers)),
      );

      const droppedSources: DroppedSource[] = [];
      const bySection: Record<ContextSection, ContextSnippet[]> = {
        memory: [], knowledge: [], environment: [],
      };
      for (const outcome of outcomes) {
        if (outcome.drop) {
          droppedSources.push(outcome.drop);
          continue;
        }
        // 同一 section 内保持源的顺序，保证同一输入得到同一结果。
        bySection[outcome.section].push(...outcome.snippets);
      }

      const draft = {
        schemaVersion: 1 as const,
        query: input.query,
        clock,
        characterSoul: input.characterSoul,
        userSoul: input.userSoul ?? null,
        relationship: input.relationship,
        mode: input.mode,
      };

      const requiredTokens = requiredTokensOf(input, clock);
      const result = trimToBudget(
        draft,
        {
          recentConversation: toCompanionTurns(input.history).slice(-recentTurnLimit),
          summary: input.summary ?? null,
          memories: bySection.memory,
          knowledge: bySection.knowledge,
          environment: bySection.environment,
        },
        budget,
        requiredTokens,
      );

      return {
        context: result.context,
        budget,
        estimatedTokens: result.estimatedTokens,
        droppedSources: [...droppedSources, ...result.droppedSources],
      };
    },
  };
}
