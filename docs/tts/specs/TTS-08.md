# TTS-08 · 独立语音演示网关职责拆分

状态：已执行并验收（2026-09-21，[验收报告](../reports/TTS-08_ACCEPTANCE.md)）；
运行说明见 [DEMO_GATEWAY_RUNBOOK.md](../DEMO_GATEWAY_RUNBOOK.md)。日期：2026-09-21。
来源：用户要求优化2026-09-20新增代码；[优化入口](../../VOICE_RESEARCH_OPTIMIZATION.md)。
归属：语音演示工具，由 TTS 线负责交付；这是跨 STT/LLM/TTS 的既有 Demo 编排整理，不扩张 [TTS PRD](../PRD.md) 的正式模块职责，不等同 TTS-07 应用接入或 INT-02 联调。

## 现状与目标

`E:/Work/Chat_model/GPT-SoVITS/tools/tts_probe/chat_gateway.py` 当前946行，混合音频门禁、Whisper调用、语言纠偏、留存、内嵌页面、对话编排、持久化和HTTP。`_has_kana` 重复定义，废弃仲裁路线注释与现行算法并存。

目标：保留可启动的现有入口及对外行为，把真正独立的职责分开，让网关可在不启动模型、不读取密钥的条件下测试。没有行数KPI，不因拆文件制造框架。

## 文件所有权

工作根：`E:/Work/Chat_model/GPT-SoVITS/`。仅允许：

- `tools/tts_probe/chat_gateway.py`：保留 CLI、服务装配和路由入口。
- `tools/tts_probe/dialogue_chat.py`：仅为复用接口和可测试性作必要调整；保留 CLI、现有 mood→style、提示词和解析行为。
- 新增 `tools/tts_probe/gateway_stt.py`：Whisper传输、音频门禁、文本清理和语言纠偏；`gateway_session.py`：会话串行编排、历史存取；`gateway_artifacts.py`：既有音频留存。若一处很小、无独立职责，不必单独拆文件，报告说明即可。
- 新增 `tools/tts_probe/web/chat.html`（从 PAGE 原样提取，CSS/JS可先保留单文件）以及该工具目录内的定向测试。
- 所有文档写回 Aika 仓库 `docs/tts/`，报告为 `reports/TTS-08_ACCEPTANCE.md`，运行说明为 `DEMO_GATEWAY_RUNBOOK.md`。

不动 `aika_tts_server.py`、GPT-SoVITS 上游、模型权重、voice配置、真实 session/录音、任何密钥文件、Whisper部署或 `aika-crossplatform/`。主工程 voice contracts 保持不变。

## 必须先冻结的行为

开工从当时实际源码提取 route/响应 fixture，不以旧注释为准。保存基线文件哈希及测试输入，以下行为纳入生产代码特征测试：

| 边界 | 保持内容 |
| --- | --- |
| 启动 | 原 chat_gateway.py 与 dialogue_chat.py 命令仍可用；默认 loopback/端口不变；任意 cwd 都能找到提取后的页面 |
| 页面 | `/`、`/index.html` 可用；麦克风开关、能量条、文本发送、转写纠错、音频播放及清空入口保持 |
| STT | `/api/stt` 原始WAV输入；普通 text、low_energy/rms、non_speech/speech_ratio 及错误响应形状不变 |
| 对话 | `/api/chat` message输入；reply/mood/style/audio/llm_ms/synth_ms 字段和当前降级分支不变 |
| 状态 | `/api/health`、`/api/reset` 的字段、状态码和清空行为不变；健康检查不泄露密钥 |
| 语义 | mood/style 映射、日语优先策略、提示词、幻听规则、门禁阈值、预卷与静音时长不改 |
| 历史 | 已有历史列表格式与写入时机保持；测试仅用临时目录，不读写用户真实会话 |

识别清理可能误删词首、历史坏文件处理等功能修复不与结构重构混做；若特征测试暴露问题，记录输入、现象与影响，另立范围后修，不顺手改变行为。

## 实现约束

1. 只保留一份 `_has_kana`；确认调用与测试后移除确实未使用的旧仲裁辅助函数/常量，更新过期注释。不得把不同职责的相似逻辑机械合并。
2. 将现有 HTTP 调用、时钟和历史目录通过少量函数参数或构造参数注入；不建 DI 容器、插件框架、事件总线或统一模型SDK。
3. import 模块不得启动服务器、读取/解密凭证、请求外网或加载 VAD/模型。真实装配仅在原启动路径执行；测试 fake 替换外部调用，实际文本规则和编排照常运行。
4. 保留会话锁的串行语义及 reset 行为。测试先后两轮历史一致、不出现用户消息串轮；错误后的下一轮仍可处理。不要将此解释为新增多用户会话功能。
5. 抽出页面只处理资源位置与加载；不复制另一个新页面继续维护旧 PAGE。录制脚本如读取原页面函数/路由，应验证其依赖仍存在，不重录或重做视频。
6. 鉴权与密钥处理保持现有边界，不以测试为由读取真实 secrets；基线 fixture 使用固定假文本与假音频，不把真实聊天语料提交。

## 验收条件

| AC | 证据 |
| --- | --- |
| A | 拆分前建立并运行生产行为特征测试；拆分后相同 fixture 的 STT门禁/纠偏、mood映射、对话错误分支输出一致，非稳定时间字段单独验证 |
| B | 两个旧 CLI 的 help/参数解析可用；从不同 cwd 启动 fake依赖网关能返回页面；模块 import 无密钥、模型、网络副作用 |
| C | 真实HTTP处理器 + fake Whisper/LLM/TTS 覆盖正常对话、空输入、上游失败、低能量/非语音分支、reset；形状和状态码保持基线 |
| D | 临时历史目录下两轮对话顺序正确；并发请求仍串行；失败释放锁，reset后新轮不带旧历史；用户真实文件哈希不变或从未访问 |
| E | 真实浏览器 + fake依赖完成发送、结果/音频展示、清空；录音用受控音频/假麦克风，纠错路径可操作。未经验证的实际麦克风、扬声器音质维持 NOT RUN |
| F | `_has_kana` 单一定义；旧 PAGE 不再复制保留；新模块职责和依赖图能在报告中简述；原录制工具依赖的页面/接口仍兼容 |

## 测试与交付

使用现有 GPTSoVits Python 运行工具目录下新增的 `test_gateway_*.py`，报告写清实际 cwd、命令与退出码。只重跑受影响工具测试，不运行真实 DeepSeek、Whisper、TTS，不重启当前生产服务、不占GPU；不修改sidecar因此不要求重跑其全套测试。

浏览器检查使用独立测试端口和fake外部依赖。若无法提供合成麦克风，相关AC分项标 NOT RUN，不能用直接执行页面函数替代用户交互证据。

报告分别列出两个仓库的文档/代码文件与基线，不自动提交。此项通过仅表示演示工具保行为重构完成，不代表识别质量、全链路延迟、人工听音或TTS-06-F已通过。
