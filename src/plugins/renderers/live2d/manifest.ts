/**
 * Cubism `.model3.json` reading and action validation (MVP-11).
 *
 * Why this module exists: PET-07 的实机核对证明，引擎对**不存在的 motion group /
 * index 不抛错**——它静默受理，然后什么都不播。所以「未知动作有确定降级、不假装
 * 播放」只能靠我们自己对照 manifest 校验，不能把异常当信号。
 *
 * 这里只做纯函数：解析 manifest、把声明映射解析成可播放项。它不认识 PixiJS、
 * 不认识 DOM，因此可以在单测里用 fixture 覆盖全部分支。
 */

export interface Live2dManifestInfo {
  /** motion group 名 → 该组的 motion 数量（index 必须小于它）。 */
  motionGroups: Record<string, number>;
  /** 模型声明的表情名。 */
  expressions: string[];
  hitAreas: string[];
  lipSyncParameters: string[];
}

/** 声明映射的一项：要么是一段 motion，要么是一个表情。 */
export type Live2dActionEntry =
  | { kind: "motion"; group: string; index: number }
  | { kind: "expression"; name: string };

export type ResolvedLive2dAction =
  | { kind: "motion"; group: string; index: number }
  | { kind: "expression"; name: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim() !== "");
}

/**
 * 解析 manifest。
 *
 * 校验失败返回 null 而不是抛错：一份坏模型等价于「没有可用映射」，动作能力降级、
 * 其余表现照常，而不是让整个 renderer 起不来。
 */
export function parseLive2dManifest(raw: unknown): Live2dManifestInfo | null {
  if (!isPlainObject(raw)) return null;
  // Cubism 3/4/5 的 manifest 都是 Version 3。
  if (raw.Version !== 3) return null;
  const refs = raw.FileReferences;
  if (!isPlainObject(refs)) return null;

  const motionGroups: Record<string, number> = {};
  if (isPlainObject(refs.Motions)) {
    for (const [group, list] of Object.entries(refs.Motions)) {
      if (Array.isArray(list)) motionGroups[group] = list.length;
    }
  }

  const expressions: string[] = [];
  if (Array.isArray(refs.Expressions)) {
    for (const entry of refs.Expressions) {
      if (isPlainObject(entry) && typeof entry.Name === "string" && entry.Name.trim() !== "") {
        expressions.push(entry.Name.trim());
      }
    }
  }

  const hitAreas: string[] = [];
  if (Array.isArray(raw.HitAreas)) {
    for (const entry of raw.HitAreas) {
      if (isPlainObject(entry) && typeof entry.Name === "string" && entry.Name.trim() !== "") {
        hitAreas.push(entry.Name.trim());
      }
    }
  }

  let lipSyncParameters: string[] = [];
  if (Array.isArray(raw.Groups)) {
    for (const entry of raw.Groups) {
      if (isPlainObject(entry) && entry.Name === "LipSync") {
        lipSyncParameters = readStringArray(entry.Ids);
      }
    }
  }

  return { motionGroups, expressions, hitAreas, lipSyncParameters };
}

/**
 * 把声明映射解析成**确认可播放**的项；不可播放返回 null。
 *
 * 这是「不假装播放」的唯一判定点：调用方拿到 null 就必须返回 false，
 * 不许退化成「反正引擎不报错，先发出去」。
 */
export function resolveLive2dAction(
  entry: Live2dActionEntry | undefined,
  manifest: Live2dManifestInfo | null,
): ResolvedLive2dAction | null {
  if (!entry || !manifest) return null;

  if (entry.kind === "motion") {
    const count = manifest.motionGroups[entry.group];
    if (typeof count !== "number") return null;
    if (!Number.isInteger(entry.index) || entry.index < 0 || entry.index >= count) return null;
    return { kind: "motion", group: entry.group, index: entry.index };
  }

  if (!manifest.expressions.includes(entry.name)) return null;
  return { kind: "expression", name: entry.name };
}

/** 该模型实际能播的动作 id（已按 manifest 校验）。用于能力声明与诊断。 */
export function playableActionIds(
  actions: Record<string, Live2dActionEntry>,
  manifest: Live2dManifestInfo | null,
): string[] {
  return Object.keys(actions)
    .filter((id) => resolveLive2dAction(actions[id], manifest) !== null)
    .sort();
}
