# NEXT-02 验收报告 · Aika 身份与配置

- 执行：goal worker（2026-09-19）。SPEC：[NEXT-02](../specs/NEXT-02.md)。需求：N06-R03。
- 状态：**AUTO_PASS**。
- 基线：`ddaea30`（NEXT-01 后）；本 SPEC 产出：`management/aika-profile.ts`、`core/next-namespace.ts`、`desktop/electron/main.mjs` 一行接线、10 个新契约用例（合计 28）。

## 1. 实际范围

完成：AikaProfile 类型/校验/默认身份/启动安全回退、AikaProfileStore 持久化（原子写+修订冲突+schemaVersion 明确报错）、ProviderConfig 存取（仅 credentialRef/credentialConfigured，凭据正文被拒绝）、Prompt 单次注入走 `SqliteMemoryStore.setPrompt`（上游唯一系统上下文位）、Next 数据命名空间 `%APPDATA%/AikaNext`（main.mjs 实际接线）。
未做：不重写 UI（管理页接线在 NEXT-07）；不改 Memory 策略；Key 真实写入 SecretStore（ManagedCredentialStore）在 NEXT-03 接适配器时使用——本步只保证"Key 不进普通 JSON"的存储边界。

## 2. 共享文件变化

| 文件 | 变化 | 影响 |
| --- | --- | --- |
| `desktop/electron/main.mjs` | userData 由硬编码 `%APPDATA%/AAAAGENT/<mode>` 改为 `nextUserDataDir(appData, mode)`（= `%APPDATA%/AikaNext/<mode>`）；仅此一行 + 1 条 import | 冒烟实跑通过（WINDOWS_SMOKE_OK），偏好写入新目录；上游无其他消费者 |
| `package.json`/`tools/run-tests.mjs` | 无新变化（沿用 NEXT-01 的 next 组） | — |

## 3. 命令与退出码（cwd `windows/code/desktop-pet/`）

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `npx tsc -p tsconfig.json --noEmit`（实现前） | 1 | **RED 证据**：`Cannot find module '../../management/aika-profile.js'`、`Cannot find module '../../core/next-namespace.js'` |
| `npm run test:next`（实现后第 1 遍） | 0 | 28 tests / 28 pass（18 既有 + 10 新增） |
| `npm run test:next`（第 2 遍） | 0 | 28/28；剥离耗时后两遍输出逐行一致 |
| `npm run test:windows:ui` | 0 | `WINDOWS_SMOKE_OK`；冒烟后 `%APPDATA%/AikaNext` 实际生成，`AAAAGENT` 目录不存在 |

TDD 修正记录：3 个用例首版断言失败（中文报错与正则不匹配、`app.setName('AAAAGENT')` 误伤检查、编译后相对路径深度），均为测试自身问题；生产实现未回退语义。

## 4. 逐 AC

| ID | 结论 | 证据 |
| --- | --- | --- |
| 02-A | **PASS** | `fallbackAikaProfile(undefined)`→默认身份（displayName `Aika`，prompt=上游 DEFAULT）；`AikaProfileStore.save→reopen→loadProfile` 字段一致；编辑后的 prompt 应用到全新 SqliteMemoryStore 后 `store.prompt` 逐字一致；`schemaVersion:2` 在 save 与 load 双向抛 `ManagementError`（消息含 schemaVersion 与实际值 2） |
| 02-B | **PASS** | `applyAikaProfile` 只经 `store.setPrompt`（characters 表+context_cache 失效，`promptSnapshot` 验证）；装配侧 `SqliteMemoryPort` 每轮从 `store.prompt()` 取唯一值（上游原样）；空/白 systemPrompt、null、缺字段均 `fallback` 到默认身份，启动不破坏（用例断言 doesNotThrow+prompt 仍为默认） |
| 02-C | **PASS** | `nextUserDataRoot`=`%APPDATA%/AikaNext`，与 `legacyUserDataRoot`（AAAAGENT）不同且非嵌套；哨兵用例：Legacy 目录预置 sentinel 文件后 Next 写自己的树，sentinel 字节不变；main.mjs 接线有源码契约用例守护；真实冒烟后 APPDATA 只新增 `AikaNext` |
| 02-D | **PASS** | `validateAikaProviderConfigs` 拒绝含 `apiKey/api_key/key/credentialFile` 字段的配置；落盘 JSON 无 `sk-` 子串、仅含 `credentialRef`+布尔 `credentialConfigured`；协议白名单 openai-compatible/gemini（anthropic 被拒） |
| 02-E | **PASS** | 修订冲突：stale expectedRevision 抛 `ManagementError('version_conflict')`，不覆盖；敌意路径（目录当文件）在 `open` 即抛 EISDIR，失败可见不误报成功；上游配置回归：`default` 组 563/563（NEXT-01 已证 runner 无回归）+ 本次冒烟 |

## 5. 已知限制与待办

1. Profile/Provider 配置的管理 UI 与 HTTP 路由在 NEXT-07 接线；本步提供存储与校验 API。
2. `credentialRef` 目前指向上游 ManagedCredentialStore 约定（NEXT-03 适配器实现时验证取钥路径）；gemini 协议的凭据登记格式同上。
3. 后端数据文件（PET_DATABASE）命名沿用环境变量注入，`AikaNext` 命名空间已由桌面端真实隔离；启动器默认值在 NEXT-07 定稿。
