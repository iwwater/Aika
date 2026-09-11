# CORE-05-G 输出侧补齐 · 变更记录

2026-09-11。这份**不是验收报告**——逐条 AC 的证据在 [CORE-05 验收报告](CORE-05_ACCEPTANCE.md) 与 [CORE-07 验收报告](CORE-07_ACCEPTANCE.md) 里。这里只回答一个问题：**这一轮到底动了哪些文件、每个文件动了什么、为什么。**

范围：解除 CORE-05-G 输出侧与 CORE-07 输出格的 BLOCKED。基线 `9295a6c`，三个提交：

| 提交 | 内容 |
| --- | --- |
| `ba078c4` | feat(core)：取回第二个 `SpeechOutputEngine`，13 个文件 |
| `56553ad` | docs：解除 BLOCKED 并更正事实判断，11 个文件 |
| `638003e` | fix(core)：缓存键分隔符改用转义，1 个文件 |

## 一、起点：原判断是错的

前一轮报告写「`stash@{0}` 不存在、无法取回」。**`stash@{0}`（`6d8a487`）一直在**，`cloudTtsOutput` 在它的第三个父提交 `dee8f4b`（未跟踪文件）里。`git stash show` 只列已跟踪改动，所以第一次没查到：

```
git log --all -S"cloudTts" --oneline   → dee8f4b untracked files on master: fdb735b …
git ls-tree -r --name-only dee8f4b     → …/voice/{cloudTtsOutput,outputEngine,speakable}.ts
```

取回方式与 [端口一致性增量计划](../CONFORMANCE_PLAN.md) 第六节的意图一致：**没有 `git stash branch`，没有 pop，stash 未 drop**。stash 里同时还有 Live2D 流水线脚本、AIRI 移植笔记、`App.tsx` / `useVoiceConversation` 的 UI 改动等与本阶段无关的东西，整包落地会把无关改动混进提交。只取语音输出这一组。

## 二、生产代码（`ba078c4` + `638003e`）

### 新增

| 文件 | 来源 | 内容与改动 |
| --- | --- | --- |
| `services/voice/speakable.ts` | `dee8f4b` 原文 | 两个引擎共用的「送去合成前的清洗」。原来是 `webSpeechOutput` 里的私有副本；两条链路各清各的话，同一句话换个引擎念出来的内容会不一样 |
| `services/voice/cloudTtsOutput.ts` | `dee8f4b` ＋ 两处改动 | 云端合成，OpenAI 兼容 `POST /audio/speech`；含语速夹取、缓存键、预取（上限 4 段）、代际丢弃迟到结果。**改动 1**：`synthesize` / `createCloudTtsOutput` / `testCloudTts` 增加可注入的 `send: HttpFetch`，默认仍是 `activeFetch`。**改动 2**（`638003e`）：缓存键分隔符由字面 NUL 字节改为 `const SEPARATOR = "\u0000"` |
| `services/voice/outputEngine.ts` | `dee8f4b` ＋ 同一处注入改动 | `auto / cloud-tts / system` 的选择与降级，结构对齐 `inputEngine.ts`。**不探测**：识别那边 `probe()` 几乎免费，合成的「探测」就是合成一次、要花钱，所以只检查配置填全没填全 |
| `services/voice/cloudTtsOutput.test.ts` | `dee8f4b` 原文 | 16 条实现级单测：语速夹取与取整、缓存键、请求体、错误正文带出、空音频当失败 |
| `services/voice/outputEngine.test.ts` | `dee8f4b` 原文 | 8 条：默认系统合成、点名要云端却没配好必须标 degraded、auto 没配好不算降级 |

### 修改

| 文件 | 改了什么 | 兼容性 |
| --- | --- | --- |
| `services/voice/contracts.ts` | `VoiceEngineKind` 增加 `"cloud-tts"`；`SpeechOutputEngine` 增加可选 `prefetch?()`；`language` / `rate` / `pitch` 补上「哪条链路认哪个字段」的说明 | 追加，v1 语义不变。HEAD 已有的 `turnId` 保留 |
| `services/voice/speechQueue.ts` | 抽出 `requestFor(text)`，让预取与真正播放用**同一处**参数（否则走网络的引擎会按两个键各发一次请求）；念第 n 句时预取第 n+1 句；`enqueue` 里补一次预取（流式下 `pump` 会因 `running` 直接返回）；新增可选 `speed` 基线语速，乘在语气之上 | `speed` 不设时等于 1，`rate` 计算结果与此前逐字相同。HEAD 已有的 `turnId` / `SpeechQueueDrainResult` 保留 |
| `services/voice/webSpeechOutput.ts` | 私有 `speakableText` 改为 import 共用的那份 | 行为相同 |
| `app/plugins/voicePlugin.ts` | `defaultSpeechEngines()` 由写死 `webSpeechOutput` 改为经 `createOutputEngine(output, send)` 选择；增加两个可选入参（输出配置、`HttpFetch`）；`createQueue` 传入 `speed` | 默认 `DEFAULT_VOICE_OUTPUT.output = "system"`，不传参时装出来的仍是 `webSpeechOutput`，**生产装配行为不变** |

**消费侧零改动**：`presentationPlugin`、`VoicePresenter`、Hook、`App.tsx` 一行没动。

### 为什么加「可注入的 `send`」

`cloudTtsOutput` 原文走 `activeFetch`（与 `whisperClient` / `providerClient` 同一条出口）。但用例包与替换矩阵按 [计划](../CONFORMANCE_PLAN.md) 的约定**不依赖过渡转发**（矩阵用 `installLegacyPorts: false` 装配）。留成参数后，两处直接注入假出口，生产路径的默认值不变。

### 为什么改掉那个 NUL 字节

`requestKey` 原文用一个**字面 NUL** 当分隔符（用意正当：它不可能出现在地址、模型名、音色或正文里，键不会撞）。代价是 git 把这个 `.ts` 识别成二进制——`ba078c4` 里它就是以 `Bin 0 -> 10227 bytes` 进去的，没有 diff、不做换行规范化，审阅时看不到改了什么。改成转义写法后运行期字符串完全相同，`requestKey` 的 5 条用例原样通过，后续 diff 恢复为文本。

## 三、测试（`ba078c4`）

| 文件 | 改了什么 |
| --- | --- |
| `services/voice/speechOutput.conformance.ts` | 用例包：探针方法改为可 await；错误断言由「消息逐字相等」改为「报一次且消息里说得出原因」；新增「预取不改变播放行为」一条 |
| `services/voice/speechOutput.conformance.test.ts` | 由 1 个实现 5 测试变为 **2 个真实实现同跑一份、12 测试**。新增 cloudTts harness（假 `HttpFetch` ＋ 假 `Audio`），并断言两个实现对 `prefetch` 的声明不同是契约允许的 |
| `services/voice/speechQueue.test.ts` | 新增「预取下一句」6 条、「基线语速」3 条 |
| `app/ports.swapMatrix.test.ts` | 输出行由 1 格变 2 格；当初留的「提醒断言」按约定换成真正的两实现一致性断言；**新增一条装配身份断言** |

### 用例包那两处改动，为什么不是放宽门槛

1. **探针改为可 await**：系统合成的回调同步就到，云端要等一次往返再等 `audio.play()`。用例包写成同步的话，云端那一格只能靠在实现里塞一条同步分支过关——那是让用例包迁就实现。
2. **错误断言改为「报一次且说得出原因」**：系统合成能拿到的只有 `event.error` 一个词，原样透传就是全部信息；云端知道是哪个地址、对面回了什么状态码，把这些拼进消息是**更有用**的行为。逐字相等会逼云端删掉诊断信息才能过。

### 为什么输出行比别的多一条断言

输出侧的选择函数**自带一条降级路径**：`createOutputEngine` 在配置不全时会安静退回系统合成。真降级了的话两格装的其实是同一个实现，一致性断言照样全绿，而那是一行没有意义的矩阵。新增的断言只读契约字段 `kind`（不按实现分支）：

```
→ ["web-speech", "cloud-tts"]
```

突变验证它不是摆设：把云端那格 `apiKey` 改空，它报 `expected [ 'web-speech', 'web-speech' ] to deeply equal [ 'web-speech', 'cloud-tts' ]`。

## 四、文档（`56553ad`）

| 文件 | 改了什么 |
| --- | --- |
| `core/reports/CORE-05_ACCEPTANCE.md` | G 由「输入 PASS / 输出 BLOCKED」改为整体 PASS；补记取回方式、用例包两处改动的理由、两条 cloudTts 突变证据；**更正**原先「`git stash list` 为空」的错误陈述 |
| `core/reports/CORE-07_ACCEPTANCE.md` | A/B/D/E 并列首次与补齐两次结果，不抹掉第一次的记录；补一次输出引擎的切换零改动实验；F 补上云端与系统合成在计费、音色、出网上的不等价 |
| `core/reports/CORE-06_ACCEPTANCE.md` | 清掉陈旧的 BLOCKED 后置项表述 |
| `core/CONFORMANCE_PLAN.md` | 端口表 `SpeechOutputEngine` 改为 2 个实现；第六节记录实际取回方式与计划的出入 |
| `core/SPEC.md`、`core/specs/CORE-05_PLUGIN_CAPABILITY.md` | 状态由 BLOCKED 改为 PASS，并写明原判断为何是错的 |
| `modules/CONTRACTS.md` | 登记「v1 之后的追加」：三处可选追加、兼容方式、受影响消费者、INT-01 检查项 |
| `modules/README.md`、`README.md`、`integration/SPEC.md` | 同步陈旧表述；联调项由「第二实现缺失」改为「云端无用户入口、真实试听未做」 |
| `tts/SPEC.md` | 登记待下发项（见下） |

## 五、命令与退出码

从 `aika-crossplatform/` 运行。按 [AGENTS.md](../../../AGENTS.md) 未跑全仓测试、未构建、未打包。

```text
npx tsc --noEmit -p tsconfig.json
→ 退出码 0

npx vitest run src/services/voice src/app src/presentation src/kernel src/hooks
→ Test Files 21 passed (21) / Tests 245 passed (245)，退出码 0
```

突变验证（临时改坏生产源码，验完即还原，未保留）：

| 突变 | 结果 |
| --- | --- |
| `cloudTtsOutput` 空文本不再报 `onEnd` | 1 failed / 11 passed |
| `cloudTtsOutput` 的 `onStart` 多报一次 | 3 failed / 17 passed（用例包 2 条 ＋ 矩阵一致性断言） |
| 矩阵云端格 `apiKey` 改空 | 2 failed / 7 passed（装配身份断言先红） |

切换零改动实验：把 `defaultSpeechEngines` 的默认输出配置换成云端合成 → **0 个新增改动文件**，该切换自身是**一个文件一行**。

## 六、没有做的事

- **没有向任何云服务发过请求**，没有用过任何 API Key。`cloudTtsOutput` 的全部证据走假 `HttpFetch` 与假 `Audio`；真实音质、延迟与计费是 **NOT RUN**。
- **没有加用户入口**。`createOutputEngine` 返回的 `note` / `degraded` 目前在 `defaultSpeechEngines` 里被丢掉。今天不会发生「悄悄降级」（没入口就选不中），但设置页接上时降级必须当错误显示。已登记在 [tts/SPEC.md](../../tts/SPEC.md) 的待下发项与 `CONTRACTS.md` 的 INT-01 检查项，**需要一份 TTS SPEC 才能做**，本轮没有自行新建 SPEC 编号。
- **没有动 stash 的其余部分**。Live2D 流水线、AIRI 笔记、UI 改动仍在 `stash@{0}` 里，待各自模块认领。
- **没有跑全仓测试、没有构建、没有 Tauri 打包**。
- 本轮没有改善 `ContextSource`（仍 1 真实 ＋ 1 替身，证据弱）与 `RuntimeProvider`（仍 1 适配器 × 4 协议）。

## 七、状态

自测通过，**待审阅**。模块通过不代表全流程通过；跨端口联动与真实设备仍归 INT-01/02。
