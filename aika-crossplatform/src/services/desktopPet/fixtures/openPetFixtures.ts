import type { PetHttpResponse } from "../openPetProtocol";

/**
 * OpenPet 响应 fixture（PET-03）。
 *
 * 这些形状来自 PET-01 的**文档/源码级**核对（`docs/frontend/reports/PET-01_PROTOCOL.md`）：
 * 上游 CLI 只做 `json.loads` 后原样包装，实际字段确认到的只有 `port` 与
 * `activePet.id`。因此 fixture 只覆盖**我们真的会解析**的形状，不编造未验证字段。
 *
 * 仍未实机核对（PET-07）：`/api/status` 是否含版本与动作清单。带 `version`/`actions`
 * 的用例是「上游若提供就解析」的前向兼容分支，不是对现有字段的断言。
 */

export interface OpenPetFixtureCase {
  name: string;
  /** 期望的判定类型。 */
  expect: "accepted" | "rejected" | "incompatible" | "protocol_error";
  response: PetHttpResponse;
}

export function jsonResponse(status: number, payload: unknown): PetHttpResponse {
  return { status, bodyText: JSON.stringify(payload) };
}

/** 带角色的最小成功快照（PET-01 已确认字段）。 */
export const OK_STATUS: PetHttpResponse = jsonResponse(200, {
  port: 17321,
  activePet: { id: "nia" },
});

/** 上游若提供版本与动作清单（未实证，前向兼容分支）。 */
export const OK_STATUS_WITH_VERSION: PetHttpResponse = jsonResponse(200, {
  port: 17321,
  activePet: { id: "nia" },
  version: "0.1.6",
  actions: ["waving", "jumping"],
});

/** POST 成功响应：只知道它是合法 JSON 对象。 */
export const OK_POST: PetHttpResponse = jsonResponse(200, { activePet: { id: "nia" } });

/**
 * 实机 `/api/status` 的真实响应形状（v0.1.6，值已裁剪）。
 *
 * 这一条比任何推测都重要：它证明成功响应里**没有 `ok`、没有 `version`、也没有
 * `actions` 清单**，只有 `port` 与 `activePet.id` 是我们能用的字段。
 */
export const DEVICE_STATUS_SNAPSHOT: PetHttpResponse = jsonResponse(200, {
  activePet: {
    id: "nia",
    displayName: "Nia",
    description: "…",
    imported: false,
    sourceName: null,
    sourceUrl: null,
    spritesheetPath: "spritesheet.webp",
    spritesheetUrl: "/pets/nia/spritesheet.webp",
  },
  apiBaseUrl: "http://127.0.0.1:17321",
  apiError: null,
  apiListening: true,
  apiRestartRequired: false,
  bubbleText: null,
  configuredListenAddress: "127.0.0.1",
  configuredPort: 17321,
  lastAction: null,
  listenAddress: "127.0.0.1",
  petCatalog: [],
  petStorage: { preset: "codex-custom", customDir: null, activeDir: "…", appDataDir: "…", codexDir: "…" },
  petVisible: true,
  port: 17321,
  recentEvents: [],
  settings: { activePetId: "nia", clickAction: "waving", clickActionPool: ["waving"], eventBubbleTtlMs: 4000, language: "en" },
  startedAtMs: 1789384498470,
});

/**
 * PetShell（fork）的 `/api/status` 形状（MVP-08 实机核对）。
 *
 * 与上游的差别**只有新增字段**：`product` 报真实身份、`capabilities` 报单实例与
 * 协议退出。四端点语义、快照字段、错误体一律未变——所以旧 fixture 继续有效，
 * 这条只是让「同一协议、不同实现」在测试里有据可依。
 */
export const PETSHELL_STATUS_SNAPSHOT: PetHttpResponse = jsonResponse(200, {
  activePet: { id: "nia", displayName: "Nia", imported: false, spritesheetPath: "spritesheet.webp" },
  apiBaseUrl: "http://127.0.0.1:17321",
  apiError: null,
  apiListening: true,
  apiRestartRequired: false,
  bubbleText: null,
  capabilities: {
    singleInstance: true,
    instanceOwner: true,
    shutdown: {
      endpoint: "/api/shutdown",
      version: 1,
      auth: "bearer-token",
      available: true,
      reason: null,
    },
  },
  configuredListenAddress: "127.0.0.1",
  configuredPort: 17321,
  lastAction: null,
  listenAddress: "127.0.0.1",
  petCatalog: [],
  petVisible: true,
  port: 17321,
  product: { name: "PetShell", version: "0.6.0", upstream: "OpenPet v0.1.6 (GPL-3.0-or-later)" },
  recentEvents: [],
  startedAtMs: 1789384498470,
});

/** 同一实例**没有**配置退出令牌时的形状：能力仍在，但不可用。 */
export const PETSHELL_STATUS_NO_EXIT_TOKEN: PetHttpResponse = jsonResponse(200, {
  activePet: { id: "nia" },
  capabilities: {
    singleInstance: true,
    instanceOwner: true,
    shutdown: {
      endpoint: "/api/shutdown",
      version: 1,
      auth: "bearer-token",
      available: false,
      reason: "PET_SHELL_EXIT_TOKEN was not provided at launch",
    },
  },
  port: 17321,
  product: { name: "PetShell", version: "0.6.0", upstream: "OpenPet v0.1.6 (GPL-3.0-or-later)" },
});

/** 协议退出错误体（逐字取自 MVP-08 真机核对）。 */
export const PETSHELL_401_TOKEN_REQUIRED: PetHttpResponse = {
  status: 401,
  bodyText: '{"error":"exit token required","ok":false}',
};
export const PETSHELL_401_TOKEN_REJECTED: PetHttpResponse = {
  status: 401,
  bodyText: '{"error":"exit token rejected","ok":false}',
};
export const PETSHELL_403_NOT_AVAILABLE: PetHttpResponse = {
  status: 403,
  bodyText: '{"error":"PET_SHELL_EXIT_TOKEN was not provided at launch","ok":false}',
};
export const PETSHELL_503_ALREADY_EXITING: PetHttpResponse = {
  status: 503,
  bodyText: '{"error":"shutdown already in progress","ok":false}',
};
export const PETSHELL_200_EXITING: PetHttpResponse = jsonResponse(200, {
  ok: true,
  shuttingDown: true,
  endpoint: "/api/shutdown",
});

/** 实机错误响应：`{"error":…,"ok":false}`（v0.1.6，逐字取自 PET-01_PROTOCOL §2.3）。 */
export const DEVICE_400_BLANK_ANIMATION: PetHttpResponse = {
  status: 400,
  bodyText: '{"error":"animationId is required","ok":false}',
};
export const DEVICE_400_BAD_JSON: PetHttpResponse = {
  status: 400,
  bodyText: '{"error":"invalid JSON: key must be a string at line 1 column 2","ok":false}',
};
export const DEVICE_400_BAD_TTL: PetHttpResponse = {
  status: 400,
  bodyText: '{"error":"invalid JSON: invalid type: string \\"abc\\", expected u64 at line 1 column 25","ok":false}',
};
export const DEVICE_400_UNKNOWN_EVENT: PetHttpResponse = {
  status: 400,
  bodyText: '{"error":"invalid JSON: unknown variant `not-a-real-event`, expected one of `thinking`, `tool-running`, `reviewing`, `success`, `failure`, `attention` at line 1 column 26","ok":false}',
};
export const DEVICE_404_ROUTE: PetHttpResponse = {
  status: 404,
  bodyText: '{"error":"route not found","ok":false}',
};

export const RESPONSE_FIXTURES: readonly OpenPetFixtureCase[] = [
  { name: "status 成功", expect: "accepted", response: OK_STATUS },
  { name: "say/action/event 成功", expect: "accepted", response: OK_POST },
  { name: "实机 status 快照", expect: "accepted", response: DEVICE_STATUS_SNAPSHOT },
  { name: "含未实证的版本与动作字段", expect: "accepted", response: OK_STATUS_WITH_VERSION },
  // 上游未定义错误体 schema，但若它明确说 ok=false，我们没有理由当成功。
  { name: "200 但 ok=false", expect: "rejected", response: jsonResponse(200, { ok: false, error: "animationId is required" }) },
  { name: "200 但响应体是数组", expect: "protocol_error", response: jsonResponse(200, []) },
  { name: "200 但响应体是 HTML", expect: "protocol_error", response: { status: 200, bodyText: "<html><body>not openpet</body></html>" } },
  { name: "200 但响应体为空", expect: "protocol_error", response: { status: 200, bodyText: "" } },
  { name: "200 但 JSON 截断", expect: "protocol_error", response: { status: 200, bodyText: '{"activePet":{"id":"nia"' } },
  // 实机：404 = route not found；405/415 同类（协议变了）。
  { name: "404 端点不存在（实机形状）", expect: "incompatible", response: DEVICE_404_ROUTE },
  { name: "405 方法不对", expect: "incompatible", response: { status: 405, bodyText: "Method Not Allowed" } },
  { name: "415 媒体类型不对", expect: "incompatible", response: { status: 415, bodyText: "Unsupported Media Type" } },
  // 实机：400 是「请求体不合法」，协议本身是通的 → rejected/invalid_input。
  { name: "400 空 animationId（实机形状）", expect: "rejected", response: DEVICE_400_BLANK_ANIMATION },
  { name: "400 坏 JSON（实机形状）", expect: "rejected", response: DEVICE_400_BAD_JSON },
  { name: "400 ttlMs 类型不对（实机形状）", expect: "rejected", response: DEVICE_400_BAD_TTL },
  { name: "400 未知 event 变体（实机形状）", expect: "rejected", response: DEVICE_400_UNKNOWN_EVENT },
  { name: "302 重定向（我们禁用了重定向）", expect: "incompatible", response: { status: 302, bodyText: "" } },
  { name: "500 上游内部错误", expect: "rejected", response: { status: 500, bodyText: '{"error":"boom"}' } },
  { name: "403 明确拒绝", expect: "rejected", response: { status: 403, bodyText: "forbidden" } },
  { name: "503 暂时不可用", expect: "rejected", response: { status: 503, bodyText: "unavailable" } },
];
