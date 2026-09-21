# Aika 本地声线接入方案（情感模块实时对话语音）

> 状态：待评审。对应里程碑 M5「自训声线」（[DEVELOPMENT_PLAN.md](../../archive/DEVELOPMENT_PLAN.md)）。
> 前提：首版声线已训出（aika_jp_v1，GPT e5/e10/e15 + SoVITS e8，见 GPT-SoVITS 侧训练记录）；
> 应用侧预埋点全部就绪，本方案不引入新架构，只做「填空」。

## 一、一句话结论

把预留的第三个输出引擎填上：新增 `aikaLocalTtsOutput`（镜像现有 `cloudTtsOutput` 的写法），
指向一个常驻 Python sidecar（`aika_tts_server.py`，跑 GPT-SoVITS 推理）；
情绪用 `voice.json` 的 `styles` 映射到参考音频，由 sidecar 按 style 缓存 prompt，切换零成本。
句子流式、打断、预取全部复用现有 `speechQueue`，一行队列代码都不用改。

## 二、整体架构

```text
LLM 流式回复（mood 先到）
  → voicePresenter（setMood + 逐句 enqueue）
  → speechQueue（分句/打断/预取，现状不动）
  → SpeechOutputEngine（三选一，现有二 + 新增一）
      ├─ system      webSpeechOutput         现状
      ├─ cloud-tts   cloudTtsOutput          现状
      └─ aika-local  aikaLocalTtsOutput      新增
            └─ HTTP POST /synthesize ──▶ aika_tts_server.py（FastAPI + GPT-SoVITS）
                                          ├─ 启动即预载权重（B 组合：底模GPT + 自训SoVITS）
                                          ├─ 每 style 一份参考语义缓存（切情绪 ~0 成本）
                                          └─ 返回 WAV ─▶ <audio> 播放（generation 打断语义照抄 cloudTtsOutput）
```

## 三、为什么这样接（对齐既有决策，不推翻）

| 既有决策 | 出处 | 本方案怎么用 |
| --- | --- | --- |
| 本地重型模型一律外部进程，app 只存连接信息 | `whisperClient.ts`（whisper-server 先例）、`CHARACTER_PACK.md` voice.json「独立本地进程运行」 | sidecar 同模式：app 配置 endpoint + probe 健康检查，不内嵌 Python |
| `VoiceEngineKind` 已预留 `"style-bert-vits2"` | `contracts.ts` | 改名为 `"aika-local"`（选型已定 GPT-SoVITS，见 VOICE_WORKSHOP 2026-09-03 修订） |
| M5 = 自训声线的 style，`voice.json` 的 styles 已留好 | `domain/mood.ts` 注释 | `SpeechOutputRequest` 加 `style?: Mood`，`speechQueue.requestFor` 把 mood 带进去 |
| 七个情绪标签是 LLM 自己标的 | `domain/mood.ts` MOODS | 7 个 mood → 7 条参考音频（不足 7 条时映射到最近情绪，见风险表） |
| 逐句队列 + 打断 + 预取已实现并有契约测试 | `speechQueue.ts`、TTS-01/02 | 完全不动；本地引擎实现 `prefetch?` 即可白拿句间零静默 |
| 用户手点试听，不做自动探测（探测=花钱/占GPU） | `outputEngine.ts` 注释 | 设置页「试听」按钮照 TTS-04 模式，本地链路试听不花钱但占 GPU，仍手点 |

## 四、分阶段计划

### P0 数据补强与重训（1 天，明天）

当前 39 段素材过拟合（top_3_acc=100%，词级重复），先补数据再谈接入质量：

1. ASMR 资源批量切片 + Fun-ASR 转写；**ASR 成功 = 保留，耳语/呼吸/失败 = 丢弃**。
2. 目标 50~150 段干净素材（单段 2~12s）。
3. 超参数修正：`warmup_steps` 2000→150（现总步数 ~1110，lr 从没离开 warmup）；
   top_3_acc 到 ~90% 就停，不再训到 100%。
4. 产出：`aika_jp_v2` 权重；若时间不够，过渡期用 B 组合（底模 GPT + 自训 SoVITS）——已实测最稳。
5. 顺带按情绪分目录挑参考音频（VOICE_WORKSHOP 建议：普通/开心/温柔/关心等），为 styles 备料。

### P1 sidecar 服务（1~2 天）

新文件 `aika_tts_server.py`（放 GPT-SoVITS 目录，FastAPI 在其依赖树内）：

- `GET /health` → 模型加载状态（app 设置页据此显示，不探测合成）
- `GET /styles` → 与 voice.json 同构的情绪映射
- `POST /synthesize` `{text, style, speed}` → `audio/wav`（合成超时兜底，异常返回 500 + 可读错误）
- 启动即预载权重；每 style 一份 prompt cache 常驻（参考语义向量，几 MB 量级，7 份无压力）
- 代码注释里记录三个已踩坑：`TTS_Config` 必须包 `{"custom": base}`、`run()` 是生成器要取最后 yield、hz=25 补丁已打在 TTS.py

### P2 应用接入（2~3 天）

| 文件 | 改动 |
| --- | --- |
| `contracts.ts` | `SpeechOutputRequest` 加 `style?: Mood`；`VoiceEngineKind` 的 `"style-bert-vits2"` → `"aika-local"` |
| `speechQueue.ts` | `requestFor` 把 mood 写进 `style`（一行） |
| `services/voice/aikaLocalTtsOutput.ts`（新） | 镜像 cloudTtsOutput：generation 打断、缓存键含 style、`prefetch` 共用队列预取、Blob 类型改 wav |
| `outputEngine.ts` | `VoiceOutput` 加 `"aika-local"`；配置 = endpoint + voiceId；选择/降级/`note` 逻辑照抄 cloud-tts 分支 |
| `outputSettings.ts` + 设置页 | 链路选项加「Aika 本地声线」、endpoint 输入、试听按钮（TTS-04 模式） |
| `voice.json` 格式 | `engine: "gpt-sovits"`，styles 为 7 项 mood→(参考音频, 参考文本)；`CHARACTER_PACK.md` 同步修订 |

### P3 验收（TTS-06，1 天）

1. 新增 `docs/tts/specs/TTS-06.md`：契约用例（`speechOutput.conformance` 补 aikaLocalTtsOutput 用例包，照 cloudTtsOutput 修法）+ 真机试听项。
2. 试听包：7 情绪 × 6 句（复用 `make_demo.py`），人工听音验收。
3. 延迟指标（真机实测进验收报告）：
   - 首句出声 < 1.5s（模型已预热）
   - 句间 < 0.5s（预取生效，实测单句合成 ~0.6s/4s 音频）
   - 打断 < 0.3s（generation 丢弃迟到回调）
4. `docs/tts/reports/TTS-06_ACCEPTANCE.md` + `docs/tts/SPEC.md` 索引登记。

### P4 声音工坊完整化（后续，不阻塞 MVP）

- `tools/voice-workshop` 的 prepare/clean/preview/export 落地，训练侧自动化（VOICE_WORKSHOP 已有流程定义）。
- 三语单模型：同 CV 中/英素材收集。**MVP 不阻塞**——Aika 的语音正文即日语（`VoiceCaption` 主字幕），
  中/英句子继续走原链路；三语数据是纯数据缺口，不是代码缺口。
- 发布期再考虑 Tauri sidecar 打包（Python 环境随包分发），开发期按 whisper-server 模式由启动器/脚本拉起。

## 五、风险与对策

| 风险 | 对策 |
| --- | --- |
| 现权重过拟合，词级重复 | P0 重训；过渡期 B 组合 + `repetition_penalty` 1.5；接入验收标准里单列「不得重复」听音项 |
| 8GB 显存与训练/webui 并存 | sidecar 与训练互斥运行（文档写明）；推理 fp16 约 3GB，同机跑 app 无压力 |
| 7 情绪参考音频凑不齐 | 先 3 情绪启动（neutral / gentle_smile / happy），其余 mood 映射到最近情绪，素材攒齐再补 |
| sidecar 冷启动 15~30s | 应用启动时 probe + 懒提示；常驻则首句即快；设置页显示加载状态 |
| 端口冲突/进程管理 | 固定默认端口 + probe 失败时设置页给可读错误（照 whisper 链路现有做法） |
| 中英句子误入本地引擎 | `speechQueue` 逐句按 `speechLanguageFor` 判定，MVP 仅 `ja-JP` 走本地，其余回原链路 |

## 六、交付物清单

- 训练侧：`aika_jp_v2` 权重 + 情绪参考音频库（先 3 情绪）
- 服务侧：`aika_tts_server.py`
- 应用侧：`aikaLocalTtsOutput.ts`、outputEngine/settings 扩展、style 贯通 speechQueue
- 文档侧：TTS-06 SPEC + 验收报告 + SPEC 索引登记、CHARACTER_PACK voice.json 修订

## 七、与「交差」的关系

今天的演示包（`output/demo_aika/`，3 组合 × 2 参考 × 6 台词）就是本方案 P0 的阶段性成果证明：
先证明「授权音色能克隆」，再按本方案炼成「实时对话语音」。P0 完成即启动 P1/P2。

## 八、2026-09-17 修订：Voicebox 借鉴对照与 SPEC 拆分

调研了 [jamiepine/voicebox](https://github.com/jamiepine/voicebox)（MIT，~15.7k star，Tauri+FastAPI 本地语音克隆工具，与本方案 P1 同构）。源码快照在 `tmp/voicebox`。结论：**只抄 sidecar 层，不抄对话层**——它是生成工具，无流式逐句播放/打断/预取语义，前端 speechQueue 架构不被替代。

### SPEC 拆分修订

原 P3 的单一 TTS-06 拆为两份独立可执行 SPEC（沿用 TTS-04 设置 / TTS-05 真实试听的拆分先例）：

- **TTS-06** = P1 sidecar 服务（含真机听音 F，条件执行），已下发。
- **TTS-07** = P2 应用接入 + 端到端真机验收（首句/句间/打断延迟），TTS-06 通过后下发。

### 借鉴对照表

| Voicebox 位置 | 模式 | Aika 落点 |
| --- | --- | --- |
| `backend/backends/__init__.py` | TTSBackend Protocol + ModelConfig 声明式注册 + 双检锁单例 | `aika_tts_server.py` 的 Engine 协议；GPT-SoVITS 为第一实现，留第二引擎位置（TTS-06） |
| `services/task_queue.py` | 串行 GPU 队列 + queued/running 取消语义 + worker 崩溃兜底翻 failed | sidecar 内部队列（TTS-06-C） |
| `utils/chunked_tts.py` | runaway 检测 → 文本减半重试 | 移植为时长比守门 → 换 seed + 提高 repetition_penalty 重试一次（TTS-06-E）。**分句逻辑不抄**——前端 speechQueue 职责；**分块流式上游原生**（见第九节）。该守门信号已提前用于 P0 素材体检与 v1 基线量化 |
| `utils/cache.py` + `services/profiles.py` | prompt cache 键 (音频, 文本) + 组合 hash + 样本变更失效 | style→prompt 常驻缓存，键加 mtime（TTS-06-D） |
| `routes/health.py` + `tauri main.rs check_health` | health 响应 schema 校验防误认他人服务 | /health 稳定 schema（TTS-06-A）+ 应用 probe 校验（TTS-07） |
| `tauri main.rs` | 端口占用→校验→复用已有进程；遗留孤儿清理；探测带超时 | `aikaLocalTtsOutput` 的 probe/可读错误（TTS-07，照 whisperClient 先例扩展） |
| `backend/build_binary.py` + tauri externalBin | PyInstaller 单 exe sidecar、多 GPU 变体 | P4 打包阶段参考 |
| `.agents/skills/add-tts-engine` | agent skill 驱动的引擎接入流程（Phase 0 强制依赖审计） | 若引入第二引擎时参考 |
| SQLite generations/versions 数据层、异步任务轮询、Stories 多轨编辑 | — | **不抄**：非实时对话场景，前端已有等价物 |

### Qwen3-TTS 定位：对照组，不替代主线（2026-09-17 决策）

**项目本质是 AI 情感研究**（面向学术展示），语音模块的研究贡献在于：情感数据工程（ASMR 切片/转写/情绪分目录）→ 情绪-参考音频映射（7 mood → styles）→ zero-shot 情绪迁移合成 → 实时对话集成。这条链路自训 GPT-SoVITS 是主角，**不能换成 Qwen3-TTS**——换掉后语音模块退化为「调了一个开源模型」的工程集成，研究叙事消失。

Qwen3-TTS-12Hz CustomVoice（instruct 指令控制情感）的正确用法是**对照组**：reference-audio-based（GPT-SoVITS 参考音频情绪迁移）vs instruction-based（Qwen3 instruct 文字指令控情）两条技术路线的表现力对比，本身就是一个可讲的实验设计，强化而非稀释主线。试听对比实验在 P0 重训前做，结论进 TTS-06/07 验收报告与后续材料。

## 九、2026-09-17 二次勘定：Voicebox 现阶段只借一个信号，且上游能抄的更少了

### 1. P0 阶段为什么不搬 Voicebox

Voicebox 的能力全部落在 sidecar 与引擎管理层，而 P0 是数据与训练工作。现在把它的架构搬进来会同时踩两个坑：违反 AGENTS.md「默认一次只执行一个 SPEC、不为局部任务顺手重写架构」的执行纪律；把「过拟合诊断→修复→量化验证」的实验叙事掺进工程改动，反而削弱口述材料。

**唯一值得现在借的是它 runaway 检测背后的那个信号——「时长 / 文本量」的比值异常。** 这个信号在 P0 上有两处正好要用：

| 用途 | 落点 | 状态 |
| --- | --- | --- |
| 素材体检：语速离群 → 漏转写、误切、纯停顿段 | `GPT-SoVITS/review_list.py`（新增字/秒列、中位数离群门、低能量占比） | 已执行：39 段中 7 条可疑 |
| 效果量化：v1 vs v2 的时长膨胀与词级重复 | `GPT-SoVITS/repeat_metrics.py`（新增：时长膨胀指数 + 尾部低能量 + 可选 ASR 精确重复率） | 已执行：v1 基线已出 |

两个工具都是纯标准库 + 可选 numpy，不依赖 conda 环境，任何 python 都能跑。

### 2. 新发现：上游 `api_v2.py` 本身就是 FastAPI sidecar，`TTS.py` 已有 prompt cache

勘定 `E:\Work\Chat_model\GPT-SoVITS` 时发现，原计划要自己写的推理服务与缓存，上游已经有一大半：

| 上游位置 | 已有能力 | 对本方案的影响 |
| --- | --- | --- |
| `api_v2.py` `POST/GET /tts` | 合成；`streaming_mode` 0/1/2/3，配 `overlap_length` + `min_chunk_length` | **分块流式上游原生**，语义 token 重叠等价于 voicebox 的块间 crossfade → 不再需要移植 chunked_tts 的分块部分 |
| `api_v2.py` `/set_gpt_weights`、`/set_sovits_weights` | 运行中热换权重 | 换模型不重启进程 |
| `api_v2.py` `/set_refer_audio` + `TTS.py` `set_ref_audio()` | 运行中热换参考音频 | **「换参考音频 = 换情绪」零成本**，情绪切换不重载模型，对 P1 切换延迟是关键利好 |
| `TTS.py` `self.prompt_cache` | 参考音频的 semantic/spec 缓存（键含 ref_audio_path） | 原计划移植的 voicebox `utils/cache.py` 降级为「在 style 维度上包一层 + 键加 mtime」 |
| `api_v2.py` 单 worker uvicorn + 同步推理 | 并发请求实际被串行化 | 推理串行基本白拿，但显式队列仍要做——取消语义（未开始任务直接丢弃、不消耗推理）上游没有 |
| 上游没有的 | `/health` 稳定 schema、style 概念、runaway 守门、取消语义 | 这四项才是 TTS-06 真正要写的东西 |

**结论：Voicebox 借鉴对照表里「分块合成」一行作废（上游原生），「Engine 协议」「prompt cache」降级为薄适配层，真正剩下的借鉴只有三项 —— runaway 时长守门（已提前在 P0 落地）、串行队列的取消语义、health probe + 端口/孤儿进程管理（TTS-07）。**

### 3. TTS-06 范围收窄（已同步到 SPEC）

TTS-06 不重写 TTS 服务，改为**薄封装**：对外仍是极简 `/health` + `/styles` + `/synthesize`，对内改为薄适配上游（执行时二选一：直接调 `TTS_infer_pack` 少一跳，或调 `api_v2.py` 保持进程隔离）。api_v2.py 的 25 个参数不暴露给前端。

## 十、开发计划（2026-09-17 起，至 2027-01 中旬口述考试）

### 0. 计划目标（不是「把功能做完」，是「把可讲的证据做出来」）

口述考试的评分点是**你做了什么、怎么想的、怎么证明**，不是工程完成度。所以本计划的每个里程碑都必须产出一份**可直接进材料的证据**：数字、对照表、或听音样本。功能只是产出证据的手段。

| 里程碑 | 时间 | 内容 | 交付物（证据） | 谁做 | 依赖 |
| --- | --- | --- | --- | --- | --- |
| **M1 · 过拟合闭环** | 9/18–9/26 | 素材补强 → 复核 → 重训 v2 → v1/v2 对照 | `P0_RETRAIN_RESULTS.md`（训练曲线 + v1/v2 数字对照 + 听音结论）、`review_v2.md` | 素材/训练用户；工具与对比机器 | **用户提供 ASMR 素材**（关键路径起点） |
| **M2 · 情感控制路线对照** | 9/27–10/5 | 同台词矩阵用「自训 GPT-SoVITS」与「Qwen3-TTS instruct」双路合成，填主观打分表 | 对照矩阵音频包 + 打分表 + `Qwen3_VS_SOVITS.md` 结论（路线差异、中英日表现、切换成本） | 机器搭脚本；用户听音 | M1 的 v2 权重（或先用 B 组合） |
| **M3 · 实时链路落地** | 10/6–10/18 | TTS-06 sidecar（薄封装）→ TTS-07 应用接入 → 端到端延迟实测 | `TTS-06_ACCEPTANCE.md`、`TTS-07_ACCEPTANCE.md`、实测延迟表（首句/句间/打断）+ 尾部静音处理效果 | 机器（不占 GPU 编码）；用户跑真机 | 不需要 v2 权重即可开工；GPU 与 M1 互斥 |
| **M4 · 情绪迁移系统化** | 10/19–11/8 | 3 → 7 mood 参考音频库整理；验证「换参考音频 = 换情绪」的切换延迟与音色/情绪保真度 | 情绪 × 台词合成矩阵、切换延迟表（受益于上游 `set_ref_audio` 热切换）、`EMOTION_MAPPING.md` | 用户选/听；机器批量合成与量化 | M1 权重 + M3 链路；7 情绪素材 |
| **M5 · 主观评价实验** | 11/9–12/5 | 多人听音评分（自然度 / 情感表现力 / 音色相似度），做统计检验 | 统计报告：Wilcoxon 符号秩检验或配对 t 检验、置信区间、评分者一致性 | 用户邀被试；机器出统计脚本与图表 | M4 矩阵；被试 ≥5 人 |
| **M6 · 材料合成与排练** | 12/6–1 月中 | 研究陈述稿、图表、试听包、想定问答；口述排练 | 语音模块章节 + 试听包 + 问答准备（含 M1–M5 全部数字） | 用户主讲；机器写稿与出图 | M1–M5 全部结论 |

### 1. 关键路径与并行关系

```
素材(用户) ──► M1 过拟合闭环 ──► M2 路线对照 ──► M4 情绪系统化 ──► M5 主观评价 ──► M6 材料
                   │                                 ▲
                   └── M3 实时链路（可与 M1 并行，不依赖 v2 权重）┘
```

- **唯一硬阻塞是素材**：M1 之前的全部准备工作（工具、配置补丁、基线）已完成，素材一到就能连轴跑。
- **M3 与 M1 并行**：sidecar 与前端接入是纯代码工作，不占 GPU；但**同一时刻只能一方用 GPU**（8GB 显存），约定：用户跑训练/webui 时我不启动任何推理任务，反之亦然。
- **M5 是最有价值的新增项**：它把「我觉得改善了」变成「配对检验显著」，正好覆盖口述考试的 確率·統計 范围——同一份工作同时服务研究和考试准备。

### 2. 每个里程碑的验收口径（不许模糊）

| 里程碑 | 通过条件 |
| --- | --- |
| M1 | 素材 ≥10 分钟有效语音；v1/v2 在**同一批台词**上的词级重复率、时长膨胀、尾部静音三列数字齐备；人工听音确认 v2 无词级重复 |
| M2 | 两路线用**同一批台词与参考音频**；打分表覆盖 ≥7 句；结论能回答「表现力差在哪、切换成本差多少」 |
| M3 | 仅 A~E 自动 AC 全过才写 AUTO_PASS；延迟三项测得真机数字，NOT RUN 不得写成通过 |
| M4 | 7 个 mood 每个都有参考音频与参考文本；切换延迟有数字（预期热切换 ≈0 重载） |
| M5 | 检验方法与样本量写明；报告含效应量与置信区间，不只给 p 值 |
| M6 | 陈述稿中每个数字都能指回 M1–M5 的报告文件 |

### 3. 节奏约定

- 每个里程碑结束写一份 `docs/tts/reports/` 验收报告；**一次只执行一个 SPEC**（AGENTS.md），不为并行推进而顺手改架构。
- 改代码先本地验证再谈推送；未验证的结论不写进材料，未实测的指标不写成已完成。
- 每完成一步同步更新本计划与 `P0_RETRAIN_RUNBOOK`，保持文档与事实一致。

### 4. 已知风险

| 风险 | 影响 | 对策 |
| --- | --- | --- |
| 素材迟迟不到位 | M1 之后全部顺延，压缩 M6 排练时间 | 先做 M3（不依赖素材）；素材到位后 M1 集中 3 天冲刺 |
| 三语单模型缺口（自训仅日语） | 中英句子无法走自训声线 | M2 的结论决定分工：中英走 Qwen3、日语走自训，写成实验结论而非妥协 |
| 8GB 显存 | 训练与推理不能并存 | 明确互斥约定；推理走 fp16 |
| 主观评价被试不足 | M5 统计检验样本量不够 | 备选降级：先做单被试多轮次 + 汇报为初步结果，不冒充统计结论 |

