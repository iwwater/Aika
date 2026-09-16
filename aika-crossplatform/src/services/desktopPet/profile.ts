import {
  PET_CAPABILITY_NAMES,
  isPetEvent,
  reportedRuntimeVersion,
  type Capability,
  type PetCapabilityMap,
  type PetCapabilityName,
  type PetConnection,
  type PetEvent,
  type PetProductInfo,
  type PetProfileLike,
  type PetProviderId,
} from "./contracts";

/**
 * 兼容 profile。
 *
 * profile 是 **Aiki 的映射配置**，不是新的 Pet Package 格式：它记录「锁定了哪个
 * 上游版本、当前角色、哪些语义名有已验证的 animationId」。上游没有通用
 * capabilities 端点时，动作能力只能来自这里——而且必须是人工核对过的，
 * 不能靠乱发动作去猜。
 *
 * 版本与角色任一不匹配即失效：宁可不发动作，也不要发一个「大概是对的动作」。
 */

export interface PetProfileV1 extends PetProfileLike {
  schemaVersion: 1;
  provider: PetProviderId;
  /** 上游锁定版本（tag 或 commit）；与 status 报的版本不符即失效。 */
  release: string;
  /** 角色 id；上游切换角色后旧映射立刻作废。 */
  petId: string;
  /** 映射来源：上游 status 提供 = upstream，人工核对 = manual。 */
  source: "upstream" | "manual";
  /** Aiki 语义动作名 → 上游 animationId。 */
  actions: Record<string, string>;
  /** 情绪（mood） → 上游 animationId。 */
  emotions: Record<string, string>;
  /** 展示语义事件 → 上游 event type（缺省表示同名直传）。 */
  events: Partial<Record<PetEvent, string>>;
}

/**
 * 语义名白名单约束：小写字母开头，只允许小写字母、数字、连字符**与下划线**。
 *
 * 下划线是必须的：Aiki 自己的 `MOODS` 里就有 `gentle_smile`。早期版本不允许
 * 下划线，后果是灾难性的且完全静默——用户在 profile 里写一个 `gentle_smile`，
 * 整份 profile 校验失败 → 能力全 unknown → **一条命令都发不出去**，而界面、
 * 日志、上游响应里没有任何迹象。PET-07 的真机核对就是撞在这个上面。
 *
 * 仍然拒绝路径/命令行形状：没有斜杠、点、冒号、空白与大写。
 */
const SEMANTIC_NAME = /^[a-z][a-z0-9_-]{0,47}$/;
/** 供应商 id 约束：不接收含分隔符、空白或控制字符的值。 */
const PROVIDER_ID = /^[A-Za-z0-9._:-]{1,96}$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStringMap(raw: unknown, keyValidator: (value: string) => boolean): Record<string, string> | null {
  if (raw === undefined) return {};
  if (!isPlainObject(raw)) return null;
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!keyValidator(key)) return null;
    if (!PROVIDER_ID.test(key)) return null;
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (!trimmed || !PROVIDER_ID.test(trimmed)) return null;
    result[key] = trimmed;
  }
  return result;
}

function readEventMap(raw: unknown): Partial<Record<PetEvent, string>> | null {
  if (raw === undefined) return {};
  if (!isPlainObject(raw)) return null;
  const result: Partial<Record<PetEvent, string>> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!isPetEvent(key)) return null;
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (!trimmed || !PROVIDER_ID.test(trimmed)) return null;
    result[key] = trimmed;
  }
  return result;
}

/**
 * 校验并归一化 profile。
 *
 * 校验失败返回 null 而不是抛错：损坏的配置等价于「没有 profile」——动作能力
 * 降为 unknown，聊天与文本照常。为一份坏配置让整个接入层起不来是本末倒置。
 */
export function validatePetProfile(raw: unknown): PetProfileV1 | null {
  if (!isPlainObject(raw)) return null;
  if (raw.schemaVersion !== 1) return null;
  const provider = raw.provider;
  if (provider !== "openpet" && provider !== "nyadeskpet") return null;
  const release = typeof raw.release === "string" ? raw.release.trim() : "";
  if (!release || !PROVIDER_ID.test(release)) return null;
  const petId = typeof raw.petId === "string" ? raw.petId.trim() : "";
  if (!petId || !PROVIDER_ID.test(petId)) return null;
  const source = raw.source;
  if (source !== "upstream" && source !== "manual") return null;
  // 语义名（键）与供应商 id（值）分别校验：键是我们自己的词汇表，值是上游的值。
  const actions = readStringMap(raw.actions, (key) => SEMANTIC_NAME.test(key));
  if (!actions) return null;
  const emotions = readStringMap(raw.emotions, (key) => SEMANTIC_NAME.test(key));
  if (!emotions) return null;
  const events = readEventMap(raw.events);
  if (!events) return null;
  return { schemaVersion: 1, provider, release, petId, source, actions, emotions, events };
}

export function semanticActionNames(profile: PetProfileV1 | null): string[] {
  return profile ? Object.keys(profile.actions).sort() : [];
}

/** 语义动作 → animationId。未登记即 null，调用方不得自行拼一个。 */
export function resolveActionId(profile: PetProfileV1 | null, semantic: string): string | null {
  if (!profile || !SEMANTIC_NAME.test(semantic)) return null;
  return profile.actions[semantic] ?? null;
}

/** 情绪 → animationId。协议没有 `/api/emotion`，情绪最终仍走 action。 */
export function resolveEmotionId(profile: PetProfileV1 | null, mood: string): string | null {
  if (!profile) return null;
  const key = mood.trim().toLowerCase();
  if (!SEMANTIC_NAME.test(key)) return null;
  return profile.emotions[key] ?? null;
}

/** 展示语义事件 → 上游 event type。没登记就用同名（`thinking` 等是 OpenPet 已有词）。 */
export function resolveEventType(profile: PetProfileV1 | null, event: PetEvent): string | null {
  if (!profile) return null;
  return profile.events[event] ?? event;
}

export function unknownCapabilities(): PetCapabilityMap {
  return capabilitiesOf("unknown");
}

export function capabilitiesOf(value: Capability): PetCapabilityMap {
  const result = {} as PetCapabilityMap;
  for (const name of PET_CAPABILITY_NAMES) result[name] = value;
  return result;
}

/** 0.5 的 OpenPet 协议里没有点击回传、音频与口型；只有它敢这么断言。 */
const OPENPET_MISSING: readonly PetCapabilityName[] = ["interactionEvents", "audio", "lipSync"];

export interface CapabilityInput {
  /** adapter 依据实际响应声明的能力；缺的键按 unknown。 */
  declared?: Partial<PetCapabilityMap>;
  profile: PetProfileV1 | null;
  connection: PetConnection;
  /**
   * 运行时自报的版本：优先上游 `version`，其次运行时真实版本（`product.version`）。
   * 缺失就不做版本判定。
   */
  runtimeVersion?: string;
  /** 运行时自报的真实身份；旧运行时没有这个字段。 */
  product?: PetProductInfo;
  /** 上游当前角色；与 profile 不符即失效动作映射。 */
  petId?: string;
  provider: PetProviderId;
}

/**
 * 能力 = 锁定的协议 profile ∩ 当前角色已验证映射 ∩ 当前连接状态。
 *
 * 任何一环缺失都降级为 `unknown` 或 `unsupported`，**绝不因为「上游大概支持」
 * 就宣称能力存在**。断线时不返回缓存值当成可用——Service 会用 `stale` 标注快照。
 */
export function deriveCapabilities(input: CapabilityInput): PetCapabilityMap {
  if (input.connection !== "ready") return unknownCapabilities();
  const declared = input.declared ?? {};
  const result = unknownCapabilities();
  for (const name of PET_CAPABILITY_NAMES) {
    result[name] = declared[name] ?? "unknown";
  }
  if (input.provider === "openpet") {
    for (const name of OPENPET_MISSING) result[name] = "unsupported";
  }
  const profile = input.profile;
  if (!profile) return unknownCapabilities();

  // 上报版本存在但与锁定版本不符 → 不猜动作（连 say 也退回 unknown：
  // 响应 schema 未实证，不能保证上游还认这个请求体）。
  //
  // 取值口径含运行时真实版本：PetShell 自报 0.6.0，就要求 profile 也锁 0.6.0。
  // 若只看上游 `version` 字段，一个改了实现却沿用旧 profile 的组合会被当成
  // 「兼容」放过去——那正是「能力必须绑定实际版本」要挡住的。
  const reportedVersion = reportedRuntimeVersion(input);
  if (reportedVersion !== undefined && reportedVersion !== profile.release) {
    return unknownCapabilities();
  }

  const petMatches = input.petId === undefined || input.petId === profile.petId;
  result.say = "native";
  result.event = Object.keys(profile.events).length ? "mapped" : "native";
  if (!petMatches) {
    result.action = "unknown";
    result.emotion = "unknown";
    return result;
  }
  result.action = Object.keys(profile.actions).length ? "mapped" : "unsupported";
  result.emotion = Object.keys(profile.emotions).length ? "mapped" : "unsupported";
  return result;
}

/** 能力是否允许发送（`unsupported`/`unknown` 都不发）。 */
export function capabilityAllows(value: Capability | undefined): boolean {
  return value === "native" || value === "mapped";
}
