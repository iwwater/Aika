/**
 * K65-01 (D4): the frozen capability vocabulary of 0.65 API v1.
 *
 * `capabilityId` is an OPEN namespace plus a REQUIRED MINIMUM SET. Third-party adapters may declare
 * new ids; the host never silently accepts an id a caller did not declare a dependency on
 * (CONTRACTS.md §2 "服务定位不接受未声明依赖").
 *
 * This vocabulary is deliberately NOT the seven-value union of `ProviderCapabilities.capabilities`
 * (contracts/index.ts). K65-00 D6 measured that declaration at zero consumers; the two vocabularies
 * have no semantic relationship and must not be reconciled by a later step without the frozen-change
 * process of SPEC.md §3.
 *
 * This module imports nothing. That is a delivery requirement, not an accident: these four contract
 * modules are emitted verbatim as the standalone SDK artifact (K65-01 §1 "发布可被包工程单独引用的最小
 * SDK 产物"), so an import of a host-private path here would break every package project that compiles
 * against the SDK alone. The mapping from a capability id to the legacy seven-slot vocabulary lives in
 * `plugins/legacy-slot.ts` on the host side, where it can name `ProviderSlot` without dragging the host
 * contract tree into the SDK.
 */

export const CAPABILITY_CONTRACT_VERSION = '1.0.0' as const;

/** The six categories K65-01 L21 requires the minimum set to cover. */
export type CapabilityCategory =
  | 'dialogue'
  | 'context_source'
  | 'input'
  | 'output'
  | 'presentation'
  | 'background_lifecycle';

/**
 * The Chinese category names from K65-01 L21, so a report or a management screen can name the
 * category the spec named without inventing a second vocabulary.
 */
export const CAPABILITY_CATEGORY_LABELS: Readonly<Record<CapabilityCategory, string>> = {
  dialogue: '文字对话',
  context_source: 'Context 来源',
  input: '输入',
  output: '输出',
  presentation: '展示',
  background_lifecycle: '后台生命周期',
};

/**
 * Required minimum set, one entry per category at least. A package that ships none of these is not a
 * capability package; it may still be a normal product package (K65-01 §1).
 */
export const REQUIRED_CAPABILITY_IDS = {
  dialogue: ['llm.chat'],
  context_source: ['context.source'],
  input: ['input.capture', 'stt.transcribe'],
  output: ['tts.synthesize', 'audio.playback'],
  presentation: ['presentation.render'],
  background_lifecycle: ['background.lifecycle'],
} as const satisfies Readonly<Record<CapabilityCategory, readonly string[]>>;

export type RequiredCapabilityId = (typeof REQUIRED_CAPABILITY_IDS)[CapabilityCategory][number];
/** Open namespace: the required ids above, plus any adapter-declared `a.b` style id. */
export type CapabilityId = RequiredCapabilityId | (string & {});

/** Lower-case dotted segments, at most four of them; no whitespace, no path characters. */
export const CAPABILITY_ID_PATTERN = /^[a-z][a-z0-9_]{0,31}(?:\.[a-z][a-z0-9_]{0,31}){0,3}$/;
export const isCapabilityId = (value: unknown): value is CapabilityId =>
  typeof value === 'string' && value.length <= 96 && CAPABILITY_ID_PATTERN.test(value);

/** Category of a required id; `null` for a third-party extension id, which declares its own category. */
export function requiredCapabilityCategory(id: string): CapabilityCategory | null {
  for (const category of Object.keys(REQUIRED_CAPABILITY_IDS) as CapabilityCategory[]) {
    if ((REQUIRED_CAPABILITY_IDS[category] as readonly string[]).includes(id)) return category;
  }
  return null;
}

export const CAPABILITY_CATEGORIES: readonly CapabilityCategory[] = [
  'dialogue', 'context_source', 'input', 'output', 'presentation', 'background_lifecycle',
];

/**
 * Side-effect class of a capability. CONTRACTS.md §3 forbids automatically retrying a side-effecting
 * operation after a timeout; `SIDE_EFFECT_RETRY_ALLOWED` below is the machine-readable form of that.
 * The categories are ordered from harmless to visibly/physically consequential.
 */
export type SideEffectCategory =
  | 'none'
  | 'local_read'
  | 'local_write'
  | 'network_egress'
  | 'device_capture'
  | 'user_visible_output'
  | 'process_lifecycle';

export const SIDE_EFFECT_CATEGORIES: readonly SideEffectCategory[] = [
  'none', 'local_read', 'local_write', 'network_egress', 'device_capture', 'user_visible_output', 'process_lifecycle',
];

/** Only a capability that cannot change anything outside the process may be retried automatically. */
export const SIDE_EFFECT_RETRY_ALLOWED: Readonly<Record<SideEffectCategory, boolean>> = {
  none: true,
  local_read: true,
  local_write: false,
  network_egress: false,
  device_capture: false,
  user_visible_output: false,
  process_lifecycle: false,
};

/** A single declared input or output slot of a capability. */
export interface CapabilityField {
  readonly name: string;
  readonly type: 'string' | 'number' | 'boolean' | 'object' | 'array' | 'bytes' | 'stream' | 'scope';
  readonly required: boolean;
  readonly description: string;
}

export type CapabilityExecution = 'unary' | 'streaming';

/**
 * What an adapter claims it can provide. Declared capabilities are claims, not evidence: the
 * effective capability of a call is the intersection of the adapter, the selected model profile and
 * the binding (PROVIDERS.md §3), and `unknown` never means supported.
 */
/**
 * Authentication a capability requires. Defaults to `none` when absent, which is the correct default
 * for a local engine: PROVIDERS.md §3 forbids forcing a cloud key onto a source that has none.
 */
export type CapabilityAuth = 'none' | 'credentialRef';

export interface CapabilityDeclaration {
  readonly capabilityId: CapabilityId;
  readonly category: CapabilityCategory;
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly contractVersion: string;
  /** Parameter names this adapter accepts for this capability. An undeclared name is refused. */
  readonly parameters: readonly string[];
  readonly execution: readonly CapabilityExecution[];
  readonly inputs: readonly CapabilityField[];
  readonly outputs: readonly CapabilityField[];
  readonly sideEffect: SideEffectCategory;
  /**
   * `none` for a local engine with no key; `credentialRef` for a remote API. K65-00 §00-E documented
   * the seven separate places the 0.61 credential chain requires a key, so the declaration has to be
   * able to say "this one does not need one" instead of inheriting a cloud-shaped requirement.
   */
  readonly auth?: CapabilityAuth;
}

/**
 * Parameter vocabulary of the required minimum set. Used to type-check authoring helpers and to
 * document the per-capability schemas PROVIDERS.md §3 demands instead of one universal parameter bag.
 * The authoritative set for a concrete call is the adapter's `CapabilityDeclaration.parameters`.
 */
export const CAPABILITY_PARAMETERS: Readonly<Record<RequiredCapabilityId, readonly string[]>> = {
  'llm.chat': ['temperature', 'maxOutputTokens', 'contextWindow', 'structuredOutput', 'tools', 'thinking', 'language'],
  'context.source': ['maxItems', 'budgetTokens', 'scope', 'dedupe', 'minScore'],
  'input.capture': ['maxImages', 'maxDurationMs', 'sampleRate', 'wakeKeyword'],
  'stt.transcribe': ['language', 'streaming', 'sampleRate', 'punctuation', 'modelType'],
  'tts.synthesize': ['voiceId', 'sampleRate', 'encoding', 'speed', 'streaming', 'language'],
  'audio.playback': ['deviceId', 'synchronization', 'volume', 'bufferMs'],
  'presentation.render': ['presetId', 'maxFps', 'transparent', 'scale'],
  'background.lifecycle': ['pollIntervalMs', 'startPolicy', 'watchdogMs', 'idleStopMs'],
};

/**
 * Concrete parameter types per capability. `ParameterSchema.type` validation in the multi-source
 * layer is driven by this table, so a `number`-typed parameter (e.g. `temperature`) is refused a
 * string value instead of being silently coerced. An extension capability id has no entry here and
 * gets no host-side type checking — the adapter's own `CapabilitySchema` is then the only authority,
 * which is why an extension must declare its parameters explicitly.
 */
export const CAPABILITY_PARAMETER_TYPES: Readonly<Record<RequiredCapabilityId, Readonly<Record<string, 'string' | 'number' | 'integer' | 'boolean' | 'enum' | 'string[]'>>>> = {
  'llm.chat': {
    temperature: 'number', maxOutputTokens: 'integer', contextWindow: 'integer',
    structuredOutput: 'boolean', tools: 'boolean', thinking: 'boolean', language: 'string',
  },
  'context.source': {
    maxItems: 'integer', budgetTokens: 'integer', scope: 'string', dedupe: 'boolean', minScore: 'number',
  },
  'input.capture': {
    maxImages: 'integer', maxDurationMs: 'integer', sampleRate: 'integer', wakeKeyword: 'string',
  },
  'stt.transcribe': {
    language: 'string', streaming: 'boolean', sampleRate: 'integer', punctuation: 'boolean', modelType: 'enum',
  },
  'tts.synthesize': {
    voiceId: 'string', sampleRate: 'integer', encoding: 'enum', speed: 'number', streaming: 'boolean', language: 'string',
  },
  'audio.playback': {
    deviceId: 'string', synchronization: 'enum', volume: 'number', bufferMs: 'integer',
  },
  'presentation.render': {
    presetId: 'string', maxFps: 'integer', transparent: 'boolean', scale: 'number',
  },
  'background.lifecycle': {
    pollIntervalMs: 'integer', startPolicy: 'enum', watchdogMs: 'integer', idleStopMs: 'integer',
  },
};

/** Parameter names the host rejects for a required capability because they belong to another capability. */
export const UNSUPPORTED_PARAMETER_EXAMPLES = {
  /** A request-body field of a remote chat API; a local engine has no such parameter. */
  arbitraryBodyField: 'frequency_penalty',
  /** A cloud-only voice identity; never portable to a local engine (PROVIDERS.md §3). */
  foreignVoiceId: 'longanfengyue',
} as const;

/** The legacy seven-slot vocabulary a required capability id corresponds to; `null` for extensions. */
export const LEGACY_SLOT_BY_CAPABILITY: Readonly<Partial<Record<RequiredCapabilityId, LegacyProviderSlot>>> = {
  'llm.chat': 'dialogue',
  'stt.transcribe': 'asr',
  'tts.synthesize': 'tts',
  'context.source': 'summary',
  'input.capture': 'perception',
};

/**
 * Structural copy of the seven-slot vocabulary (`contracts/management.ts` `ProviderSlot`, mirrored
 * literally in `management/settings.ts:9` and `management/aika-profile.ts:13`). Declared here as a
 * plain string union so the SDK stays import-free; the host-side authoritative type is not replaced,
 * and `plugins/legacy-slot.ts` asserts the two stay identical.
 */
export type LegacyProviderSlot = 'asr' | 'dialogue' | 'memory_turn' | 'summary' | 'perception' | 'tts' | 'admission';
