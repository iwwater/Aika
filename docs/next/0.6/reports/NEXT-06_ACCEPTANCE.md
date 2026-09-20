# NEXT-06 验收报告 · 基础语音与无人值守回放

- 执行：goal worker（2026-09-20）。SPEC：[NEXT-06](../specs/NEXT-06.md)。需求：N06-R07。
- 状态：**AUTO_PASS**（06-A/B/C/D/G 于 2026-09-20 逻辑收口时 PASS；06-E/06-F 真实回放已于同日用户授权后恢复并通过，见 §6；§5.1 的 BLOCKED 状态由 §6 取代）。
- 基线：`c943aea`（NEXT-05 后）。产出：`core/speech-bridge.ts`（NextSpeechInput / NextSpeechOutput / VoiceTurnBridge / splitSentences），10 个语音契约用例（总计 63）。上游生产代码本轮零改动。

## 1. 实际范围

- 输入：AsrSegment 聚合——segmentId 去重、index 按音频序合并、空段跳过、全空不提交；`stop()` 每输入会话至多一次 turnReady 并经 TurnPort 提交；迟到段丢弃；`startNewInput()` 开新会话；`cancel()` 丢弃不提交。
- 输出：流式分句（`splitSentences`，尾句保留）→ 逐句合成（乱序完成）→ 严格句序播放（一次一句，后句在前句结算前不入播）；`endTurn` 后队列与在途全结算才 `drained`（恰一次，带 delivered/failed 计数）；`stop` 中止在途（AbortController+playback.stop）、丢弃队列、发 `stopped`、不发 drained；停止后迟到播放回调被过滤。
- 打断：`VoiceTurnBridge.interrupt()` 单一入口 = TurnPort.cancel + 输出 stop；新输入不被清除。
- 失败：合成失败（按句 onError）与播放失败（play 拒绝统一报告，error 事件不双计）可见；drained 明确区分 delivered/failed，不把失败队列当全部已听到。
- 集成（06-G）：文本桥接端到端 submit→reply→分句→合成→播放→Timeline（AikaTimelineRecorder 落库 userMessage+assistantTerminal）；`terminal:completed`（生成终态）先于 `drained`（交付完成），二者分离。

## 2. 命令与退出码（cwd `windows/code/desktop-pet/`）

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `npm run test:next`（实现后） | 0 | 63 tests / 63 pass（53→63） |
| `npm run test:next`（第 2 遍） | 0 | 63/63；剥离耗时后两遍逐行一致 |
| `node --test --test-concurrency=1 dist/tests/memory/*.test.js dist/tests/providers/*.test.js` | 0 | 563/563 上游回归 |

TDD 修正记录：断言与等待时序问题 4 处（取消断言须在 abort 生效后；挂起播放下只启动首句属正确语义；drain 需稳定化循环等待播放结算；集成用例须等轮次终态再断言）——均为测试侧修正，桥接实现语义未回退。

## 3. 逐 AC

| ID | 结论 | 证据 |
| --- | --- | --- |
| 06-A | **PASS** | 乱序 index 合并为 '你好，，世界'；同 segmentId 去重；空段跳过、全空不提交；stop 幂等 turnReady 恰一次；迟到段与新会话语义用例齐 |
| 06-B | **PASS** | 首句合成被门控时第二句先完成合成，播放仍 s1→s2（句序保持）；无标点尾句保留；endTurn 后 drained 恰一次含计数；空队列 endTurn 立即 drain 且幂等 |
| 06-C | **PASS** | 门控回复下 interrupt 使在途轮 cancelled（终态事件验证）、无音频输出；第二轮音频挂起时 interrupt 触发 stopped 且挂起播放被释放；旧 scope 迟到 ended 回调不产生任何新事件；第三次输入正常 |
| 06-D | **PASS** | 合成失败按句 onError 恰一次；播放失败经 play 拒绝报告恰一次；drained={delivered:1,failed:1}/{0,1} 明确区分；不伪报全部已听到 |
| 06-E | **BLOCKED** | 真实 ASR 依赖 whisper.cpp b5130 工具链（`E:/Work/toolchains/whisper-b5130`，所在盘当前不存在；官方包/模型 SHA256 与恢复步骤登记于 CORPUS_MANIFEST §4）。静音负例判定与 hash 留档在恢复后执行；不虚构转写结果 |
| 06-F | **BLOCKED** | 上游仅付费云 TTS（qwen/minimax，无已授权凭据）；候选免费路径（Windows SAPI、sherpa-onnx TTS）未验证。可解码音频证据在 NEXT-06 收口前需用户授权凭据或选定免费后端；fixture 层只证明接口调用（本报告已区分） |
| 06-G | **PASS** | 06-G 集成用例：桥接→TurnPort→生产 Pipeline→分句→TTS→播放→Timeline 全链自动化；生成终态与交付 drained 顺序断言；Timeline 恰两条事件（userMessage/assistantTerminal） |

## 4. 与 Legacy 行为语料的对应

- 句子队列/停止语义 ↔ Legacy `speechQueue.test.ts`/`speechOutput.conformance.test.ts`（句序、停止探针）→ 06-B/06-C/D 用例按同一行为重写于 Next 端口（blob hash 见 CORPUS_MANIFEST §2）。
- 输入乱序/取消 ↔ Legacy `speechInput.conformance.test.ts` → 06-A/06-C。
- Legacy 的 Web Speech 引擎细节（web 输出引擎）不在上游 Runtime 复用范围；上游 TTS/播放端口由 fake 驱动，真实合成见 06-F 处置。

## 5. 已知限制与待办

1. 06-E/06-F BLOCKED：按 RPD「必需真实门槛未跑不得 AUTO_PASS」——本 SPEC 的 06-E/06-F 两项单列 BLOCKED；SPEC 总状态因此标注为「AUTO_PASS（真实路径 BLOCKED 已登记）」，NEXT-08 收口时必须复核，未恢复则版本不得宣称语音真实链路完成。
2. 唤醒（wake）、Live2D 表现、音色克隆不在范围（未动）。
3. 上游 QwenTtsProvider 的计费字符口径与 `splitSpeech` 长文分段在接入真实云 TTS 时复用；本步的 `splitSentences` 只负责句级切分。
4. 麦克风现场输入、扬声器真实停止、听感全部留给 NEXT-09 人工验收；本步不声称声学体验通过。

## 6. 真实回放收口（2026-09-20 补充，用户授权后执行）

用户明确批准三条路径：whisper.cpp 工具链重新下载、免费本地真实 TTS（Windows SAPI）、复用旧库 DeepSeek 凭据。三项均在当日实跑通过，06-E/06-F 由 BLOCKED 转 PASS。

### 06-E 真实 ASR（PASS）

- 工具链恢复：`F:/AIVoice/toolchains/whisper-b5130`（原 E: 盘缺失）。官方资产 SHA256 与登记一致：`whisper-bin-x64.zip` = `f9ec6c52…f3c` ✓，`ggml-base.bin` = `60ed5bc3…2efe` ✓（来源见 CORPUS_MANIFEST §4）。
- 固定样本 `jfk.wav`（官方 b5130 tag）SHA256 `59dfb9a4acb36fe2a2affc14bacbee2920ff435cb13cc314a08c13f66ba7860e`；静音负例（16kHz/mono/16-bit 数字静音）参考文件 SHA256 `20eaebffe1816e0ffa6f7f854f5ef4ea80d5349faaf0ce1fec1b713e7fde58fa`。
- 服务：`Release/whisper-server.exe -m models/ggml-base.bin --host 127.0.0.1 --port 8080 -l auto -t 6 -ng`，`GET /` 探活 200。
- 真实回放（`tests/next/real/realAsr.test.ts`）：jfk.wav → `POST /inference`（language=auto / temperature=0 / no_context=true）→ 原始转写与冻结参考逐字一致（"And so my fellow Americans, ask not what your country can do for you, ask what you can do for your country."）→ 经生产 NextSpeechInput 合并提交 → NextTurnPort accepted → terminal completed（恰一次）。静音 → 服务端返回 `[BLANK_AUDIO]` → 按 Legacy 规则清洗（stripMarkers/幻听清单，移植自 `whisperClient.ts@30269c6`，blob `eb13848c52e67592f6adfa77f7ed08460a5aa4f0`）后为空 → 0 次提交、0 事件。真实部分=识别服务+输入适配+轮次链；harness 部分=multipart 构造与清洗移植（测试内注明）。

### 06-F 真实 TTS（PASS）

- 生产适配：`providers/sapi-tts.ts`（SapiTtsProvider）——Windows SAPI（System.Speech）本地合成，无凭据、无网络；文本经临时文件传入规避引号/长度问题；输出 16kHz/16-bit/mono PCM WAV 经 `inspectPcmWav` 校验后入 MediaStore。`tests/next/sapiTts.test.ts` 5 个契约用例（注入 execute 双替身）。
- 真实回放（`tests/next/real/realTts.test.ts`）：固定文本「你好，我是Aika，今天天气不错。」+ 固定音色 `Microsoft Huihui Desktop`（zh-CN）→ 138,286 字节可解码 WAV，`durationMs=4320`（>0），`synchronization='none'` 如实标注。
- 修复记录：本机 System.Speech 的 `SpeechAudioFormatInfo` 无静态工厂方法（MethodNotFound），改用构造函数 `new SpeechAudioFormatInfo(16000, Sixteen, Mono)`；测试与脚本同步修正。

### 08-D 前置：真实 LLM（PASS，DeepSeek）

- 凭据：`/models` 实测本 key 有效且 `deepseek-flash` 为有效模型名（旧库 .env 配置原样可用）；凭据仅存 gitignored `windows/code/desktop-pet/.next-real.local.json` 与环境变量，不入库、不入报告。
- 真实回放（`tests/next/real/realLlm.test.ts`）：单轮固定问答（返回非空、终态唯一、authorizer settle=success、Timeline userMessage+assistantTerminal 各一）；两轮上下文探针（turn-A 报出代号，turn-B 问代号，真实回复含「北斗七号」且请求上下文 recent 实含 turn-A 消息）。双替身已标注：CallAuthorizer=记录器（付费授权为用户明示批准）、memory plan=noPlan。

### 收口命令与退出码（cwd `windows/code/desktop-pet/`，2026-09-20 实跑）

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `npm run test:next` | 0 | 78 tests / 78 pass（70→78：+5 SAPI 契约、+3 全链集成） |
| `npm run test:next`（第 2 遍） | 0 | 78/78；剥离耗时后两遍逐行一致（diff 空） |
| `PET_NEXT_REAL=1 npm run test:next:real` | 0 | 5 tests / 5 pass（真实 ASR ×2、真实 LLM ×2、真实 TTS ×1） |

