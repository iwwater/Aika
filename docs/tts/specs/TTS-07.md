# TTS-07 · Aika 本地声线应用接入与端到端真机验收

状态：READY（应用接入可自动验收 A~E；端到端真机项 F 为条件执行）。
需求来源：[本地声线接入方案](../further/PLAN_AIKA_LOCAL_VOICE.md) P2/P3；上游 sidecar 契约见 [TTS-06 验收报告](../reports/TTS-06_ACCEPTANCE.md)。执行规则：[安全执行计划](../../GOAL_EXECUTION_PLAN.md)。

## 前置与范围

- 前置：TTS-06 sidecar 已交付（`aika_tts_server.py` 16 测试全绿，A~E AUTO_PASS），对外契约已冻结：`GET /health` / `GET /styles` / `POST /synthesize`（`{"text","style","speed"}` → `audio/wav`；400/500 → `{"error": 可读信息}`；回落时带 `x-aika-style-fallback: 1` 头）。
- 本 SPEC 是「自训声线」研究贡献主体的最后一块拼图：把已测通的 sidecar 接进实时对话链路，并实测端到端延迟。它是 TTS-06 报告「待联调项」的第 2、3 条。
- 修改范围：仅 aika-crossplatform 前端 + `voice.json` 格式。不改 sidecar（除非报告单列并说明兼容性）、不动 speechQueue 的分句/打断/预取核心逻辑、不动上游 GPT-SoVITS。
- 非目标：P0 重训（M1，依赖素材）、7 mood 参考音频库完整化（M4）、主观评价（M5）、打包分发（P4）、Qwen3-TTS 对照（M2）。语言守卫只做「ja-JP 才走本地」，不做中英自训声线（三语单模型是 M4/P4 的数据缺口）。

## 行为与接口

### 应用侧改动

| 文件 | 改动 |
| --- | --- |
| `services/voice/contracts.ts` | `VoiceEngineKind` 新增 `"aika-local"`（现为 `"web-speech" | "whisper-local" | "style-bert-vits2" | "cloud-tts"`；原预留 `"style-bert-vits2"` 改名或并列新增，执行时选一并登记）；`SpeechOutputRequest` 加 `style?: Mood` |
| `services/voice/speechQueue.ts` | `requestFor` 把 mood 写进 `style`（一行透传）；分句/打断/预取逻辑不动 |
| `services/voice/aikaLocalTtsOutput.ts`（新） | 镜像 `cloudTtsOutput`：`generation` 打断语义、缓存键含 style、`prefetch` 复用队列预取、响应 Blob 为 wav；调 sidecar `POST /synthesize`，取 `audio/wav` |
| `services/voice/outputEngine.ts` | `VoiceOutput` 加 `"aika-local"`；配置 = endpoint + voiceId；选择/降级/`note` 逻辑照抄 cloud-tts 分支（`auto` 在 aika-local 可用且配置完整时选中） |
| `services/voice/outputSettings.ts` + 设置页 | 链路选项加「Aika 本地声线」、endpoint 输入、试听按钮（TTS-04 模式）；probe 校验 `/health` schema（字段集恒定，参考 voicebox `routes/health.py`） |
| `voice.json`（角色包格式） | `engine: "aika-local"`；styles 为 mood→(参考音频, 参考文本) 映射；`CHARACTER_PACK.md` 同步修订 |

### mood → style 映射（7 vs 6 的缺口）

`domain/mood.ts` 7 个 mood：`neutral / gentle_smile / happy / shy / surprised / thinking / concerned`。
sidecar `aika_voice.json` 现有 6 情绪参考：温柔 / 安心 / 亲密 / 嘲讽 / 毒舌 / 恳求。

本 SPEC 须定义**明确的 mood→style 映射表**（含缺失 mood 的默认回落），落进 voice.json 或前端常量，验收时逐 mood 覆盖。初版可 3 情绪启动（`neutral / gentle_smile / happy`），其余 mood 回落最近情绪，素材补齐再扩展（M4）。

#### 情绪缺口：三无/cold 临时映射（2026-09-20 决策）

用户听音确认缺一个「三无」（cold，無感情：淡々とした口調、句尾平稳下坠、几乎不用语气词）——`mood.ts` 7 标签与 6 参考音频均无对应。**本 SPEC 阶段不新增参考音频**，临时映射：**三无/cold → 「安心」**，并标注「安心 = 有温度的平 ≠ 三无的无温度的平」。真三无参考音频在 M4 情绪扩库时作为第 7 个 style 加入，届时回填本映射表。此临时映射只发生在 style 层，不新增 mood 标签（避免碰前端 domain）。

### 语言守卫

`speechQueue` 逐句按 `domain/language.ts` 的 `speechLanguageFor` 判定，MVP 仅 `ja-JP` 走 aika-local，其余（中/英）回原链路——避免中英句子误入日语音色。

### 试听与 probe

- 试听：设置页「试听」按钮对真实 sidecar 发一次 `/synthesize`（固定测试句 + 默认 style），返回音频可播放；失败给可读错误。本地试听不花钱但占 GPU，仍手点触发（照 TTS-04 模式）。
- probe：设置页 probe 校验 `/health` schema（`status`/`model_loaded`/`styles_ready`/`error` 字段集恒定）；schema 不符或服务非 aika sidecar 时报可读错误，**不误认他人服务**（voicebox `routes/health.py` 借鉴）。

## 验收条件

| AC | 要求 |
| --- | --- |
| TTS-07-A | `aikaLocalTtsOutput` 通过 `services/voice/speechOutput.conformance` 契约用例包（照 cloudTtsOutput 修法补用例包）：start/end 事件、stop 调用、错误可见、generation 打断语义 |
| TTS-07-B | 输出引擎选择：`auto` 在 aika-local 可用且配置完整时选中；endpoint 不可达/配置不全时降级到 system/cloud-tts，`note`/`degraded` 一路送到界面（点名本地却配置不全时降级当错误显示，不悄悄降级） |
| TTS-07-C | style 贯通：`requestFor` 把 mood 写进 `style`；aikaLocalTtsOutput 的请求体含正确 style；7 mood 全部命中映射表（含回落，回落带 `x-aika-style-fallback` 语义可观察） |
| TTS-07-D | probe：设置页 probe 校验 `/health` schema；schema 不符或非 sidecar 服务时报可读错误，不误认 |
| TTS-07-E | 试听：设置页「试听」对 fake sidecar 响应返回可播放音频；失败路径给可读错误 |
| TTS-07-F | 端到端真机（条件执行，TTS-06-F + 本 SPEC 前端链路）：首句出声 <1.5s（模型预热）；句间 <0.5s（预取生效）；打断 <0.3s（generation 丢弃迟到回调）；无词级重复（人工听音）；mood 切换=换参考音频（情绪迁移生效） |

## 验证与交付

A~E 用 vitest + fake sidecar 响应（HttpFetch 替身，不真起 Python 进程）定向验证：fake 只替换 HTTP 传输与 sidecar 返回，队列/引擎选择/style 透传/probe 校验走生产代码。F 为真机项，条件不满足记 NOT RUN，不得由 fixture 冒充延迟/听音结果。

报告路径：`../reports/TTS-07_ACCEPTANCE.md`，含：改动清单、测试命令及退出码、逐 AC 证据、mood→style 映射表、与 [共享契约](../../modules/CONTRACTS.md) 的影响（`SpeechOutputRequest` 加 `style` 字段属新增，需在契约表登记）、待 P0 重训项（权重路径更新）。仅 A~E 全过可写 AUTO_PASS；FAIL 不得改 NOT RUN 推进依赖；不自动提交或推送。F 实测延迟进报告并同步 PLAN 第十节 M3。
