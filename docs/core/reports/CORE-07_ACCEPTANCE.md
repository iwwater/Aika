# CORE-07 验收报告 · 端口一致性与实现可替换性收口

对应 SPEC：[CORE-07_PORT_SWAPPABILITY.md](../specs/CORE-07_PORT_SWAPPABILITY.md)。
**首次执行**没有新增任何端口接口、没有新增任何生产实现、没有改任何消费侧代码。新增的只有两份矩阵支撑文件：

- `aika-crossplatform/src/app/swapMatrix.ts` —— 矩阵驱动（不 import vitest，不是生产代码路径）
- `aika-crossplatform/src/app/ports.swapMatrix.test.ts` —— 七个端口 × 各自实现的替换矩阵

**2026-09-11 的补齐执行**（逐文件清单见 [CORE-05-G 输出侧变更记录](CORE-05G_OUTPUT_CHANGE_RECORD.md)）关闭了输出侧那条 BLOCKED，这次动了生产代码——取回第二个输出实现是解除阻塞的唯一办法，不动就只能一直挂着。改动范围如实列出：新增 `services/voice/{speakable,cloudTtsOutput,outputEngine}.ts`；`contracts.ts` 追加 `"cloud-tts"` 与可选 `prefetch?`；`speechQueue.ts` 追加可选 `speed` 与预取；`webSpeechOutput.ts` 改用共用的 `speakableText`；`app/plugins/voicePlugin.ts` 的 `defaultSpeechEngines` 改为经 `createOutputEngine` 选择（默认仍是系统合成，不传参时行为一个字不变）。消费侧（`presentationPlugin` / `VoicePresenter` / Hook / `App.tsx`）零改动。

## 前置状态（如实记录）

SPEC 的前置是「CORE-06 通过，且 CORE-02-G / CORE-03-H / CORE-03-I / CORE-05-G 均已 PASS」。

- CORE-06：PASS。
- CORE-02-G / CORE-03-H / CORE-03-I：PASS。
- CORE-05-G：**首次执行时输出侧 BLOCKED，2026-09-11 解除，现整体 PASS**（见 [CORE-05 报告](CORE-05_ACCEPTANCE.md) 的补记）。

**本报告分两次执行，两次都如实保留：**

| | 首次（CORE-07 原始执行） | 补齐（2026-09-11） |
| --- | --- | --- |
| `SpeechOutputEngine` 真实实现 | 1（webSpeech） | 2（webSpeech / cloudTts） |
| 矩阵行数 | 7 端口，输出侧 BLOCKED | 7 端口全部有可比对象 |
| 用例包 | 输出侧 5 测试（单实现） | 输出侧 12 测试（同一份 × 2 实现） |

首次执行的处置是「不降低门槛，不把 BLOCKED 说成 PASS」，那次的结论仍然成立；下面各 AC 用**删除线之外的方式**并列两次结果，不抹掉第一次的记录。

## 逐条 AC 结论

### CORE-07-A 用例包一致性 —— PASS（七个端口）

| 端口 | 真实实现数 | 同一份用例包 | 证据文件 | 结果 |
| --- | --- | --- | --- | --- |
| AikaStorage | 2（sqlite / localStorage） | 是 | `storage.conformance.test.ts` | PASS（28 测试） |
| SecretStore | 2（明文回退 / DPAPI） | 是 | `secretStore.conformance.test.ts` | PASS（14 测试） |
| MemoryV2Store | 2（sqlite / localStorage） | 是 | `memoryStore.conformance.test.ts` | PASS（8 测试） |
| ContextSource | 1 真实 ＋ 1 确定性替身 | 是 | `contextSource.conformance.test.ts` | PASS（6 测试），证据弱，见 E |
| RuntimeProvider | 1 适配器 × 4 协议 | 是 | `provider.conformance.test.ts` | PASS（20 测试） |
| SpeechInputEngine | 2（webSpeech / whisper-local） | 是 | `speechInput.conformance.test.ts` | PASS（15 测试） |
| SpeechOutputEngine | 2（webSpeech / cloudTts） | 是 | `speechOutput.conformance.test.ts` | PASS（12 测试 = 6 × 2）｜首次执行时为 1 实现 5 测试、BLOCKED |

`unsupported` 声明与实际行为的一致性由各用例包内置的正反双向断言保证（如 storage 的 `memoryV2`/`deleteSummaries`、memory 的 `searchIds`），本阶段未新增此类断言。

### CORE-07-B 替换矩阵 —— PASS（七个端口）

命令与退出码：

```
首次：npx vitest run src/app/ports.swapMatrix.test.ts
→ Test Files 1 passed (1) / Tests 8 passed (8)，退出码 0

补齐（2026-09-11）：npx vitest run src/app/ports.swapMatrix.test.ts
→ Test Files 1 passed (1) / Tests 9 passed (9)，退出码 0
```

每一格 = 一份 `createAikaKernel({ hostPlugins, featurePlugins })` 装配；消费侧场景逐字相同、只拿 `AikaKernel`，按实现分支在结构上不可能（另有一条静态断言兜底）。结果：

- `AikaStorage`：sqlite vs localStorageStorage → 观察一致（顺序、内容、设置往返）。
- `SecretStore`：明文回退 vs fake DPAPI → 观察一致（存/读/删）。
- `MemoryV2Store`：sqlite vs localMemoryStore → 观察一致（检索命中；`searchIds` 差异由 repository 兜住）。
- `ContextSource`：真实 memorySource vs 确定性替身 → 观察一致（同一条确认记忆进上下文，无降级）。
- `RuntimeProvider`：4 种协议 → 观察一致（累计增量、唯一终包、无错误事件）。
- `SpeechInputEngine`：webSpeech vs whisper-local → 观察一致（同一段最终文本）。
- `SpeechOutputEngine`：webSpeechOutput vs cloudTtsOutput → 观察一致（`{ starts: 1, ends: 1, available: true }`）。首次执行时这一格只有一个实现、标 BLOCKED，并留了一条「第二实现一旦加入就会失败」的提醒断言；补齐时那条提醒断言已按当初说的换成真正的两实现一致性断言，不是把期望值改大。

输出侧这一行比别的多一条断言，理由要说清楚：**输出侧的选择函数自带一条降级路径**——`createOutputEngine` 在配置不全时会安静地退回系统合成。真降级了的话，两格装的其实是同一个实现，一致性断言照样全绿，而那是一行没有意义的矩阵。所以加了一条只读契约字段 `kind`（不按实现分支）的装配身份断言：

```
SpeechOutputEngine：两格装的确实是两个不同的实现，不是都退回了系统合成
→ ["web-speech", "cloud-tts"]
```

突变验证这条断言不是摆设：把云端那一格的 `apiKey` 改空（触发选择函数的降级路径）后，它报 `expected [ 'web-speech', 'web-speech' ] to deeply equal [ 'web-speech', 'cloud-tts' ]`，退出码 1。

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

补齐时对**输出引擎**又做了一次同样的实验（基线 13 个已改动文件）：把 `defaultSpeechEngines` 的默认输出配置从系统合成换成云端合成。

```
=== 切换后新增的改动文件（相对基线）===
（无输出 —— 0 个新增改动文件）
=== 该切换自身的 diff ===
-  output: VoiceOutputConfig = DEFAULT_VOICE_OUTPUT,
+  output: VoiceOutputConfig = { ...DEFAULT_VOICE_OUTPUT, output: "cloud-tts", apiKey: "sk-switch-experiment" },
```

**一个文件、一行**，且那个文件本来就是能力插件的装配点；消费侧（`presentationPlugin` → `VoicePresenter` → `speechQueue`）零改动。切换即还原，基线恢复 13 个文件。

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

补齐时对新进来的第二实现单独做了突变（同样是真实生产实现，不是测试桩）：

| 被改坏的实现 | 改坏的行为 | 失败的用例 | 结果 |
| --- | --- | --- | --- |
| cloudTtsOutput | 空文本不再报 `onEnd` | 「空白或纯记号文本不发声」（cloudTts 那一遍） | 1 failed / 11 passed |
| cloudTtsOutput | `onStart` 多报一次 | 用例包两条 ＋ **矩阵的两实现一致性断言**（`starts: 2` vs `starts: 1`） | 3 failed / 17 passed |
| （矩阵装配）云端那一格 `apiKey` 改空 | 选择函数悄悄降级回系统合成 | 「两格装的确实是两个不同的实现」 | 2 failed / 7 passed |

第二条是关键证据：它说明矩阵那一行不是「两边各跑各的都绿」，而是真的在比对两个实现的可见行为——改坏其中一个，一致性断言立刻红。

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
| SpeechOutputEngine | 2 | 是 | 能力插件入参（`defaultSpeechEngines` 的输出配置，一行） |

- `ContextSource` 的第二格是确定性替身，**可替换性证据弱**，不与其他端口混为一谈。
- `RuntimeProvider` 的 4 种协议是同一适配器内的分支，证明的是「协议无关于消费侧」，不是「4 个独立实现可互换」。
- `SpeechOutputEngine`（更正）：首次执行时报告写「`cloudTtsOutput` 随丢失的 `stash@{0}` 不存在」，**这个事实判断是错的**。`stash@{0}` 一直在，`cloudTtsOutput` 在它的未跟踪文件提交 `dee8f4b` 里；`git stash show` 只列已跟踪改动，所以第一次没查到。补齐时只取回语音输出这一组（其余留在 stash 原样不动，stash 未 drop），详见 [CORE-05 报告](CORE-05_ACCEPTANCE.md) 的补记。现在它有 2 个真实实现。

### CORE-07-F 边界如实 —— 声明

本模块用例包证明的是**行为契约可替换**，不证明性能、并发与持久性等价：SQLite 的事务性与 localStorage 的非原子性不是一回事；DPAPI 的加密强度与明文回退不是一回事；whisper 与 webSpeech 的识别质量与延迟不是一回事；系统合成不花钱不出网、云端合成每句一次往返且每句都计费，音色与语速能力也不一样。全绿**不**意味着两个实现可以随意互换——切换仍然是一次产品决策，且依赖宿主真的具备对应能力。

输出侧要额外说明两条：**没有向任何云服务发过真实请求**，`cloudTtsOutput` 的全部证据都走假 `HttpFetch` 与假 `Audio`，真实音质、延迟与计费是 NOT RUN；**也还没有让用户选云端合成的入口**，`createOutputEngine` 的 `note` / `degraded` 目前在 `defaultSpeechEngines` 里被丢掉，设置页接上时降级必须当错误显示。这两条属于 TTS 模块，不在 CORE 范围内。

## 定向测试与质量样本

```
首次：npx vitest run src/app/ports.swapMatrix.test.ts …（27 个文件）→ 296 passed，退出码 0
      npx tsc --noEmit -p tsconfig.json → 退出码 0

补齐（2026-09-11）：
npx vitest run src/services/voice src/app src/presentation src/kernel src/hooks
→ Test Files 21 passed (21) / Tests 245 passed (245)，退出码 0
npx tsc --noEmit -p tsconfig.json → 退出码 0
```

- 顺手修复了 3 处既有的 tsc 报错（与本阶段新增逻辑无关）：`provider.conformance.ts` 两处 `Array.prototype.at`（项目 lib 为 ES2020）与 `useCompanionSession.integration.test.ts` 一处 `as MemoryRecord` 直接断言（改为经 `unknown`）。行为无变化，对应用例复跑通过。
- 突变样本：真实生产实现（webSpeechInput、providerAdapter、memorySource、localMemoryStore、localStorageStorage、insecureSecretStore、webSpeechOutput，补齐时加上 cloudTtsOutput），非测试桩。
- 不 mock 本模块被验收逻辑；假 DPAPI / 假识别器 / 假合成器只替代外部设备与传输层。

## 遗留与衔接

- ~~SpeechOutputEngine 第二实现缺失~~ **已于 2026-09-11 关闭**：`cloudTtsOutput` 已从 `stash@{0}` 的未跟踪提交 `dee8f4b` 取回并进入 `speechOutput.conformance.test.ts` 与矩阵 `speechOutputCases()`；当初留的「提醒断言」按约定换成了两实现一致性断言，另加一条装配身份断言防止选择函数悄悄降级。
- **仍然存在的弱项**：`ContextSource` 只有 1 个真实实现 ＋ 1 个确定性替身，可替换性证据弱于其他端口；`RuntimeProvider` 的 4 格是同一适配器的协议分支，不是 4 个独立实现。这两条在本阶段没有变化。
- **交给 TTS 模块**：云端合成的用户入口与降级提示（`note` / `degraded` 目前被丢弃）、一次真实云服务试听（音质、延迟、计费）。
- INT-01/02 负责跨端口联动与真实设备验证，本阶段未跑全仓测试与产品打包。
