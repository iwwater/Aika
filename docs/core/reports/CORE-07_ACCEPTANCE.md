# CORE-07 验收报告 · 端口一致性与实现可替换性收口

对应 SPEC：[CORE-07_PORT_SWAPPABILITY.md](../specs/CORE-07_PORT_SWAPPABILITY.md)。
本阶段**没有新增任何端口接口、没有新增任何生产实现、没有改任何消费侧代码**。新增的只有两份矩阵支撑文件：

- `aika-crossplatform/src/app/swapMatrix.ts` —— 矩阵驱动（不 import vitest，不是生产代码路径）
- `aika-crossplatform/src/app/ports.swapMatrix.test.ts` —— 七个端口 × 各自实现的替换矩阵

## 前置状态（如实记录）

SPEC 的前置是「CORE-06 通过，且 CORE-02-G / CORE-03-H / CORE-03-I / CORE-05-G 均已 PASS」。

- CORE-06：PASS。
- CORE-02-G / CORE-03-H / CORE-03-I：PASS。
- **CORE-05-G：整体 BLOCKED**（输入侧 PASS，输出侧缺第二实现，见 [CORE-05 报告](CORE-05_ACCEPTANCE.md)）。

处置：不降低门槛，不把 BLOCKED 说成 PASS。输出侧（`SpeechOutputEngine`）在矩阵中单独标 BLOCKED，其余六个端口正常执行并给出证据。

## 逐条 AC 结论

### CORE-07-A 用例包一致性 —— PASS（六个端口）＋ BLOCKED（输出侧）

| 端口 | 真实实现数 | 同一份用例包 | 证据文件 | 结果 |
| --- | --- | --- | --- | --- |
| AikaStorage | 2（sqlite / localStorage） | 是 | `storage.conformance.test.ts` | PASS（28 测试） |
| SecretStore | 2（明文回退 / DPAPI） | 是 | `secretStore.conformance.test.ts` | PASS（14 测试） |
| MemoryV2Store | 2（sqlite / localStorage） | 是 | `memoryStore.conformance.test.ts` | PASS（8 测试） |
| ContextSource | 1 真实 ＋ 1 确定性替身 | 是 | `contextSource.conformance.test.ts` | PASS（6 测试），证据弱，见 E |
| RuntimeProvider | 1 适配器 × 4 协议 | 是 | `provider.conformance.test.ts` | PASS（20 测试） |
| SpeechInputEngine | 2（webSpeech / whisper-local） | 是 | `speechInput.conformance.test.ts` | PASS（15 测试） |
| SpeechOutputEngine | 1（webSpeech） | 是（只有一个对象可比） | `speechOutput.conformance.test.ts` | PASS（5 测试），**缺第二实现 → BLOCKED** |

`unsupported` 声明与实际行为的一致性由各用例包内置的正反双向断言保证（如 storage 的 `memoryV2`/`deleteSummaries`、memory 的 `searchIds`），本阶段未新增此类断言。

### CORE-07-B 替换矩阵 —— PASS（六个端口）＋ BLOCKED（输出侧）

命令与退出码：

```
npx vitest run src/app/ports.swapMatrix.test.ts
→ Test Files 1 passed (1) / Tests 8 passed (8)，退出码 0
```

每一格 = 一份 `createAikaKernel({ hostPlugins, featurePlugins })` 装配；消费侧场景逐字相同、只拿 `AikaKernel`，按实现分支在结构上不可能（另有一条静态断言兜底）。结果：

- `AikaStorage`：sqlite vs localStorageStorage → 观察一致（顺序、内容、设置往返）。
- `SecretStore`：明文回退 vs fake DPAPI → 观察一致（存/读/删）。
- `MemoryV2Store`：sqlite vs localMemoryStore → 观察一致（检索命中；`searchIds` 差异由 repository 兜住）。
- `ContextSource`：真实 memorySource vs 确定性替身 → 观察一致（同一条确认记忆进上下文，无降级）。
- `RuntimeProvider`：4 种协议 → 观察一致（累计增量、唯一终包、无错误事件）。
- `SpeechInputEngine`：webSpeech vs whisper-local → 观察一致（同一段最终文本）。
- `SpeechOutputEngine`：只有 webSpeech 一格，场景本身可跑通，**无可比对象 → BLOCKED**。矩阵里留了一条提醒断言：第二实现一旦加入会失败，届时应补两实现一致性断言。

### CORE-07-C 消费侧零改动 —— PASS

证据（切换前基线 34 个已改动文件）：

1. 记录 `git diff --name-only` 基线（34 个文件）。
2. 把 `selectHostPlugins` 临时从「按平台选择」改为「固定桌面宿主实现」（一次真实的实现切换）。
3. 再次 `git diff --name-only`，与基线做集合比较：

```
=== 切换后新增的改动文件（相对基线）===
=> aika-crossplatform/src/app/hosts/index.ts
=== 该切换自身的 diff ===
-  return isTauriHost() ? tauriHostPlugins(options) : browserHostPlugins(options);
+  return tauriHostPlugins(options);
```

新增改动**只有宿主插件选择文件一个**，消费侧文件 0 改动；切换即还原，基线恢复 34 个文件。

### CORE-07-D 用例包不可稀释 —— PASS

对 7 个端口各改坏一条真实行为（每端口 1 处、共 7 处），一次性跑全部用例包：

```
npx vitest run <7 份 conformance.test.ts>
→ Test Files 7 failed (7) / Tests 12 failed | 84 passed (96)，退出码 0
```

| 端口 | 被改坏的实现 | 改坏的行为 | 失败的用例 |
| --- | --- | --- | --- |
| AikaStorage | localStorageStorage | appendMessage 不去重 | 「同一个 id 再写是替换」 |
| SecretStore | insecureSecretStore | 缺失键返回 "" | 「没存过的名字返回 null」 |
| MemoryV2Store | localMemoryStore | load 复用缓存对象 | 快照独立性 |
| RuntimeProvider | providerAdapter | 错误码改成 PROVIDER_ERROR | 「统一错误码」（4 协议全红） |
| ContextSource | memorySource | precision 恒为 unknown | 「确认记忆标 confirmed」 |
| SpeechInputEngine | webSpeechInput | onFinal 文本置空 | 终包文本断言 |
| SpeechOutputEngine | webSpeechOutput | 空文本分支多报 onStart | 「空白文本不发声」 |

全部改回后复跑（连同矩阵）：`Test Files 8 passed (8) / Tests 104 passed (104)`，退出码 0。

### CORE-07-E 结论如实 —— 见下表

| 端口 | 真实实现 | 跑同一份用例包 | 切换实现需要改的文件 |
| --- | --- | --- | --- |
| AikaStorage | 2 | 是 | 宿主插件选择（`app/hosts/index.ts` 或测试宿主入参） |
| SecretStore | 2 | 是 | 同上 |
| MemoryV2Store | 2 | 是 | 宿主插件选择（经 storage 的 memoryV2 能力） |
| ContextSource | **1 真实 ＋ 1 测试替身** | 是 | 能力插件选择（memoryPlugin vs 提供 ContextSourcesToken 的插件） |
| RuntimeProvider | 1 适配器 × 4 协议 | 是 | 供应商配置（config.protocol），不是插件选择 |
| SpeechInputEngine | 2 | 是 | 能力插件入参（voicePlugin 的 createInputEngine） |
| SpeechOutputEngine | **1** | 是 | **无可切换对象（BLOCKED）** |

- `ContextSource` 的第二格是确定性替身，**可替换性证据弱**，不与其他端口混为一谈。
- `RuntimeProvider` 的 4 种协议是同一适配器内的分支，证明的是「协议无关于消费侧」，不是「4 个独立实现可互换」。
- `SpeechOutputEngine` 只有 1 个真实实现，SPEC 指定的 `cloudTtsOutput` 随丢失的 `stash@{0}` 不存在。

### CORE-07-F 边界如实 —— 声明

本模块用例包证明的是**行为契约可替换**，不证明性能、并发与持久性等价：SQLite 的事务性与 localStorage 的非原子性不是一回事；DPAPI 的加密强度与明文回退不是一回事；whisper 与 webSpeech 的识别质量与延迟不是一回事。全绿**不**意味着两个实现可以随意互换——切换仍然是一次产品决策，且依赖宿主真的具备对应能力。

## 定向测试与质量样本

```
npx vitest run src/app/ports.swapMatrix.test.ts …（27 个文件）→ 296 passed，退出码 0
npx tsc --noEmit -p tsconfig.json → 退出码 0
```

- 顺手修复了 3 处既有的 tsc 报错（与本阶段新增逻辑无关）：`provider.conformance.ts` 两处 `Array.prototype.at`（项目 lib 为 ES2020）与 `useCompanionSession.integration.test.ts` 一处 `as MemoryRecord` 直接断言（改为经 `unknown`）。行为无变化，对应用例复跑通过。
- 突变样本：真实生产实现（webSpeechInput、providerAdapter、memorySource、localMemoryStore、localStorageStorage、insecureSecretStore、webSpeechOutput），非测试桩。
- 不 mock 本模块被验收逻辑；假 DPAPI / 假识别器 / 假合成器只替代外部设备与传输层。

## 遗留与衔接

- **SpeechOutputEngine 第二实现缺失**：等 `cloudTtsOutput` 从历史提交找回后，补进 `speechOutput.conformance.test.ts` 与矩阵 `speechOutputCases()`，并把那条「提醒断言」替换成两实现一致性断言。
- INT-01/02 负责跨端口联动与真实设备验证，本阶段未跑全仓测试与产品打包。
