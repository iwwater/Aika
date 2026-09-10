# CORE-02 验收报告 · 宿主插件与组合根

- 模块 / 小阶段 / SPEC 版本：CORE / CORE-02 / [specs/CORE-02_HOST_COMPOSITION.md](../specs/CORE-02_HOST_COMPOSITION.md)
- 基础 commit：`bc15a2b`
- 状态：**PASS**
- 真实依赖 / fake 依赖：存储用真实实现（localStorage stub + `node:sqlite` 真引擎）；DPAPI、Tauri 通知、plugin-http、Rust remote 用注入的假端口；无网络、无设备。

## 命令与退出码

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `npx vitest run src/app src/services/storage src/services/notification src/kernel` | 0 | 12 文件 / 120 测试 |
| `npx vitest run`（全仓） | 0 | 51 文件 / 541 通过 + 1 skipped |
| `npx tsc --noEmit`（全仓） | 0 | 无错误 |

本次改动触及 storage / http / remote / notification 四个**共享**模块，消费方横跨 hooks、voice、memory，按 [测试规则](../../modules/TESTING.md)「共享接口变化优先运行受影响的契约测试」，受影响面已经接近全仓，因此直接跑了一次全量作为回归证据。**全量通过不代表集成通过**：真实 Tauri 装配仍属 INT-01。

新增测试：`composition.test.ts` 9 · `storage.conformance.test.ts` 26 · `secretStore.conformance.test.ts` 14 · `settingsStore.test.ts` 9 · `notifier.test.ts` 5 · 内核门禁 +1（共 7）。

## 逐条 AC

| AC | 证据 | 结果 |
| --- | --- | --- |
| CORE-02-A | `composition.test.ts`：测试宿主装配后 storage/secrets/settings/notifier/clock/timers 六个端口全部解析成功；`RemoteHostToken` 在未装远程插件时 `has()` 为 false、`tryResolve()` 为 null，装了才有；`tauriHostPlugins()` 含 `host.remote`、`browserHostPlugins()` 不含，其余六个插件两边都有 | PASS |
| CORE-02-B | 全仓回归通过，`storageCompatibility.test.ts`、`sqliteStorage.test.ts`、`messagePersistence.test.ts` 均在新装配下通过；`migrateLegacy` 逻辑逐字未动，仍由 `MIGRATION_FLAG` 保证只跑一次，只是从 `openStorage` 内部提出来交给宿主插件调用 | PASS |
| CORE-02-C | `architecture.test.ts` 新增「平台判断只出现在宿主目录里」：全仓生产代码 `__TAURI_INTERNALS__` 仅存在于 `src/app/hosts/detect.ts`。改造前有 **6 处**（storage/index、secretStore、http、providerClient、remote/bridge、useCompanionSession），现为 1 处 | PASS |
| CORE-02-D | 未引入任何能力总表：无 `HostCapabilities`，无跨模块 token 桶文件；token 分别定义在 `services/storage/tokens.ts`、`services/http/tokens.ts`、`services/remote/tokens.ts`、`services/time/tokens.ts`、`services/notification/notifier.ts`。CORE-01-C/D 的内核扫描重跑仍通过 | PASS |
| CORE-02-E | `notifier.test.ts` 5 例：无通知能力返回 false；有权限发出去；无权限现场申请；用户拒绝返回 false 且不发；权限查询/申请/发送三条路径各自抛错时全部被吞并返回 false。`Notifier.notify` 永不抛，调用方不再需要 try/catch | PASS |
| CORE-02-F | `settingsStore.test.ts` 9 例：`SETTING_KEYS` 每个键读写往返；坏 JSON、normalize 抛错均回落默认值，且 `setSetting` **零调用**（不写回坏值）；布尔只认 `true`/`false` 字面量；空串与缺失都回落；写入失败向上传播 | PASS |
| CORE-02-G | `storage.conformance.test.ts`：13 条契约用例 × 2 个实现 = 26 通过；`secretStore.conformance.test.ts`：6 条 × 2 个实现 + 2 条实现特有 = 14 通过。用例包只断言契约层面可观测的行为，**不含一条 SQL 语句或 localStorage 键名断言** | PASS |

## 端口可替换性的第一份实证

| 端口 | 被测实现 | 是否同一份用例 |
| --- | --- | --- |
| `AikaStorage` | `localStorageStorage`（localStorage stub）、`sqliteStorage`（`node:sqlite` 真引擎，生产 SQL 一字未改） | 是，13 条 |
| `SecretStore` | `createInsecureSecretStore`、`createDesktopSecretStore`（假 DPAPI） | 是，6 条 |

`SecretStore` 此前是「一个实现两条路」——`inTauri()` 分叉写在对象内部，谁都替换不了它，也无法各自验证。拆成两个工厂之后它才真正有两个被测对象。

为了让**生产代码**在真实 SQLite 上跑，`createSqliteStorage` 增加了一个可选的 `SqlExecutor` 参数（生产不传，走 plugin-sql）。SQL、表结构与迁移逻辑一字未改。

## 门禁的突变验证

| 探针 | 触发的失败 |
| --- | --- |
| `src/services/__probeSniff.ts` 内写 `"__TAURI_INTERNALS__" in globalThis` | 「平台判断只出现在宿主目录里」失败，指名 `services/__probeSniff.ts` |
| 在 harness 里谎称 `unsupported: ["deleteSummaries"]`（实际支持） | 「deleteSummaries：声明不支持就必须真的不在」失败 |

第二条尤其关键：它证明 `unsupported` 是**会被验证的声明**，不是可以随手写来跳过用例的开关——这是端口一致性用例包不被稀释的核心机制。删除探针后复跑全绿。

## 执行中发现并修正的两处 SPEC 缺陷

1. **组合根与宿主插件不能放 `src/kernel/`。** SPEC 原文写的是 `src/kernel/hosts/` 与 `src/kernel/composition.ts`，但宿主插件必须 import `services/` 的具体实现，会直接撞上 CORE-01-C「内核不得 import 业务模块」的扫描。已改到 `src/app/` 下：内核保持零业务依赖，CORE-01-C 不需要放宽一个字。同步更新了 ARCHITECTURE 的分层图与 CORE-03/05 里的同类路径。
2. **CORE-02-C 的覆盖面比 SPEC 负责范围大。** 平台嗅探还有两处在 `services/http.ts` 与 `providerClient.ts`（同一段代码重复了两遍），不收掉这条 AC 就过不了。处理方式是把 `http.ts` 提升为目录（`from "../http"` 的既有导入路径不变），加 `FetchToken` 与桌面实现，`providerClient` 删掉自己那份私有副本改为 import——**没有改动任何函数签名**，因此没有波及 LLM/STT 模块。

## 一个必须记下的回归风险及其处理

过渡转发的默认值是浏览器实现（不再嗅探平台）。这意味着**如果组合根没跑，桌面端会静默用 localStorage**——记忆全写错地方且毫无报错。两处处理：

- `main.tsx` 改为先 `createAikaKernel()` 再挂载 React；装配失败也照常渲染，白屏什么都告诉不了用户。
- 装配失败时 `installFailedStorageOpener` 让 `openStorage()` **抛出带原因的错误**，而不是回落到浏览器实现。改造前 `createSqliteStorage` 失败会被 Hook 显示成 `storageError`，这个行为原样保住了，有 `composition.test.ts` 的「装配失败时存储故障看得见」一例守着。

## 共享接口 / 集成

- 共享接口变化：`services/storage`（新增 `openDesktopStorage`/`openBrowserStorage`/`migrateLegacy`/install\* ，`openStorage` 转为过渡转发）、`services/storage/secretStore`（拆成两个工厂 + 过渡转发）、`services/http`（升为目录，新增 `FetchToken`）、`services/remote/bridge`（新增 `RemoteHost` 接口与 `createTauriRemoteHost`，具名导出转为过渡转发）、新增 `services/notification`、`services/time`。
- 受影响消费者：`useCompanionSession`（通知改走 `Notifier`）、`useRemoteAccess`、`whisperClient`、`providerClient`。全部通过既有测试验证，无签名变更。
- 集成待测项：**真实 Tauri 宿主的装配未执行**（DPAPI、plugin-sql、plugin-http、Rust remote 全部用假端口验证的是接线逻辑，不是接入本身），归 INT-01。桌面打包与安装回归归 INT-03。

## 其他

- 场景文本是实际模型输出还是 fixture：不适用，本阶段无模型调用。
- DEFERRED：真实 Tauri 装配验证（INT-01）；`activeFetch`/`secretStore`/`openStorage`/`remoteAvailable` 四个过渡转发的删除（CORE-06）。
- 执行者自测结论：CORE-02 七条 AC 全部 PASS。平台嗅探从 6 处收敛到 1 处，存储与密钥两个端口各有两个真实实现跑同一份用例包。
- 原任务证据审阅结论：待审阅。
- 下一小阶段：[CORE-03](../specs/CORE-03_RUNTIME_SERVICE.md) Runtime 服务化与编排单一化——本模块的风险集中点。
