import type { Live2dActionEntry } from "./manifest";

/**
 * 首版外观目录（MVP-11）。
 *
 * 首版冻结的做法是**整模型切换**：一套外观 = 一个 Cubism 模型。同模型部件换装
 * 未采用，因此不存在「部件/参数契约」需要登记；把普通 renderer 切换说成换装是
 * 不被允许的，所以这里只有这一个含义。
 *
 * `actions` 是我们**声明**的映射，其语义由人工选定；renderer 加载后只用 manifest
 * 校验它**存在**（group 存在且 index 在范围内 / 表情名在清单里）。存在性与语义
 * 适配是两件事，本表只保证前者——报告里如实写明，不把它说成「已核对表现正确」。
 */

export const LIVE2D_APPEARANCE_IDS = ["hiyori", "mao"] as const;
export type Live2dAppearanceId = (typeof LIVE2D_APPEARANCE_IDS)[number];

export interface Live2dAppearance {
  id: Live2dAppearanceId;
  displayName: string;
  /** manifest 文件名，位于 `/live2d/models/<id>/`。 */
  manifest: string;
  /** 相对于「整模型铺满可视框」的额外缩放，用来补偿模型自带的留白。 */
  fitScale: number;
  actions: Record<string, Live2dActionEntry>;
}

export const LIVE2D_ASSETS_BASE = "/live2d";
export const LIVE2D_CORE_SCRIPT = `${LIVE2D_ASSETS_BASE}/core/live2dcubismcore.min.js`;

export const LIVE2D_APPEARANCES: readonly Live2dAppearance[] = [
  {
    id: "hiyori",
    displayName: "Hiyori",
    manifest: "Hiyori.model3.json",
    fitScale: 1,
    // Hiyori 的 manifest：Idle 有 9 段（index 0-8），TapBody 有 1 段（index 0），无表情。
    actions: {
      idle: { kind: "motion", group: "Idle", index: 0 },
      waiting: { kind: "motion", group: "Idle", index: 1 },
      jumping: { kind: "motion", group: "Idle", index: 2 },
      running: { kind: "motion", group: "Idle", index: 3 },
      review: { kind: "motion", group: "Idle", index: 4 },
      failed: { kind: "motion", group: "Idle", index: 5 },
      waving: { kind: "motion", group: "TapBody", index: 0 },
    },
  },
  {
    id: "mao",
    displayName: "Mao",
    manifest: "Mao.model3.json",
    // Mao 的 bounds 含大片留白（17730 单位高，实际角色只占其中一部分），按 bounds
    // 贴合会明显偏小。这个系数是**人眼校准**的取景参数，不是测量值。
    fitScale: 1.8,
    // Mao 的 manifest：Idle 有 2 段（0-1），TapBody 有 6 段（0-5），表情 exp_01-exp_08。
    // `failed` 走表情，用来证明表情路径同样受校验、同样会确定降级。
    actions: {
      idle: { kind: "motion", group: "Idle", index: 0 },
      waiting: { kind: "motion", group: "Idle", index: 1 },
      waving: { kind: "motion", group: "TapBody", index: 0 },
      jumping: { kind: "motion", group: "TapBody", index: 1 },
      running: { kind: "motion", group: "TapBody", index: 2 },
      review: { kind: "motion", group: "TapBody", index: 3 },
      failed: { kind: "expression", name: "exp_02" },
    },
  },
];

export function isLive2dAppearanceId(value: unknown): value is Live2dAppearanceId {
  return typeof value === "string" && (LIVE2D_APPEARANCE_IDS as readonly string[]).includes(value);
}

export function getLive2dAppearance(id: unknown): Live2dAppearance | null {
  if (!isLive2dAppearanceId(id)) return null;
  return LIVE2D_APPEARANCES.find((appearance) => appearance.id === id) ?? null;
}

/** manifest 的完整 URL；模型自身引用的贴图相对该 URL 解析。 */
export function live2dManifestUrl(appearance: Live2dAppearance): string {
  return `${LIVE2D_ASSETS_BASE}/models/${appearance.id}/${appearance.manifest}`;
}

/** 供菜单使用的选项列表；顺序即目录顺序。 */
export function live2dAppearanceOptions(): readonly { id: string; label: string }[] {
  return LIVE2D_APPEARANCES.map((appearance) => ({
    id: appearance.id,
    label: appearance.displayName,
  }));
}
