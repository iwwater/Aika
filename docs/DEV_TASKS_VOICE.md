# 语音模块开发任务台账

> 用途：记录语音模块（STT + TTS）的**开发任务**状态与归宿。本表是**状态看板**，不是执行授权——开工一律走 RPD/SPEC 流程（一次一个 SPEC，逐 AC 验收）。
> 顶层里程碑与时间线见 [PLAN_AIKA_LOCAL_VOICE.md 第十节](tts/further/PLAN_AIKA_LOCAL_VOICE.md)；产品级愿望池见 [TODO.md](TODO.md)。
> 创建：2026-09-18 · 最后更新：2026-09-21

## 协作约束（2026-09-20，来自合作者）

合作者正在**重构主工程 aika-crossplatform**，要求语音侧「单独做自己的部分」。因此：

- **凡触碰 `aika-crossplatform/` 前端代码的任务一律冻结**（V-T07 应用接入等重构落地后再解冻），避免与重构冲突。
- **完全独立的任务不受影响**：V-T06F（纯 GPT-SoVITS 仓库内 sidecar）、V-S08（纯 toolchains 服务端部署，`whisperClient.ts` 零改动）。
- 用户主责 **TTS**，TTS 线优先于 STT 线。

## 定位

项目本质是 AI 情感研究（面向学术展示），语音模块是用户的核心贡献，服务 2027-01 中旬的日本大学院口述考试。研究叙事：情感数据工程 → 情绪-参考音频映射 → zero-shot 情绪迁移 → 实时对话集成。**自训声线（GPT-SoVITS）是研究贡献主体，Qwen3-TTS 是对照组。**

## 状态图例

已完成（有验收报告）→ 已立 SPEC 待执行 → 待立 SPEC / 待决策 → 阻塞（等素材/设备/决策）

---

## 一、已完成（近期，作为上下文）

| 任务 | 结论 | 报告 |
| --- | --- | --- |
| STT-05 Whisper 语言判定取证 | 判中文 0/57；真瓶颈是真人情绪语音解码质量（CER 0.22 vs 合成 0.0）；`language=ja` 零收益 | [STT-05_ACCEPTANCE](stt/reports/STT-05_ACCEPTANCE.md) |
| STT-06 CPU→CUDA 后端切换 | sm_120 经 PTX JIT 可用，无需源码构建；jfk 稳态 763→85.5 ms（8.9×）；CPU 侧 720 ms 固定开销；首次 JIT 33.8 s | [STT-06_ACCEPTANCE](stt/reports/STT-06_ACCEPTANCE.md) |
| STT-07 更大模型标定 | 四档全进预算；真人 CER 单调下降 0.22→0.079（-64%）；**large-v3-turbo-q5_0 是甜点** | [STT-07_ACCEPTANCE](stt/reports/STT-07_ACCEPTANCE.md) |
| STT-08 turbo 落地 + 显存共存 | 生产切 CUDA+turbo（去 `-ng`）；契约中位 **217.59 ms**（n=5，探活 18.98 ms）；whisper+GPT-SoVITS **可共存**，峰值 3570/8151 MiB 无 OOM；CPU/base 可一键回退 | [STT-08_ACCEPTANCE](stt/reports/STT-08_ACCEPTANCE.md) |
| TTS-06 本地声线 sidecar | A~E通过；F已有GPU合成、断开与ASR初筛，人工听音及实际播放口径未完成 | [TTS-06_ACCEPTANCE](tts/reports/TTS-06_ACCEPTANCE.md) |

---

## 二、未完成任务（按优先级）

### P0 · 立即可做（不依赖新素材，纯代码/实测）

| ID | 任务 | 状态 | 依赖 | SPEC 归宿 |
| --- | --- | --- | --- | --- |
| V-T06F | TTS-06-F 真机联调：sidecar 真 GPU 跑通 + 首句/句间/打断延迟实测 + 听音 | **完成（2026-09-22）**：GPU合成、断开、ASR初筛、**人工听音**（18/18 词级重复=无）均已取证；新增非阻断观察项「促音处电音/颤音」计入 M1/M4 验收维度；应用播放延迟留待 TTS-07-F | B 组合权重（已实测可用） | [TTS-06](tts/specs/TTS-06.md) F 项 |
| V-T07 | **TTS-07 应用接入 + 端到端真机验收**：aikaLocalTtsOutput 接入 + mood→style 映射 + 语言守卫 + 端到端延迟 | **冻结（2026-09-20）：触碰前端，等合作者重构落地** | TTS-06 sidecar 契约 + 重构后的前端结构 | [TTS-07](tts/specs/TTS-07.md) |
| V-S08 | **STT-08 更大模型落地 + 显存共存实测**：部署切 CUDA+turbo + whisper/GPT-SoVITS 8GB 共存 | **已完成（2026-09-22）**：生产切 CUDA+turbo，契约中位 217.59 ms，峰值 3570/8151 MiB 可共存无 OOM；见[验收报告](stt/reports/STT-08_ACCEPTANCE.md) | STT-07 甜点结论 | [STT-08](stt/specs/STT-08.md) |

### P1 · 依赖用户提供素材（唯一硬阻塞）

| ID | 任务 | 状态 | 依赖 | SPEC 归宿 |
| --- | --- | --- | --- | --- |
| V-M1 | **M1 过拟合闭环**：素材补强 → 复核 → 重训 v2 → v1/v2 对照 | **阻塞**：等 ≥10 分钟授权 ASMR 素材（当前仅 3.52 分钟） | 用户提供素材 | [P0_RETRAIN_RUNBOOK](tts/further/P0_RETRAIN_RUNBOOK.md)（runbook，非 SPEC） |

### P2 · 依赖 M1 素材 + 前序里程碑（实验/数据/统计，非代码 SPEC）

| ID | 任务 | 状态 | 依赖 | 归宿 |
| --- | --- | --- | --- | --- |
| V-M2 | **M2 情感控制路线对照**：自训 GPT-SoVITS vs Qwen3-TTS instruct 双路合成打分 | 待立 SPEC（届时） | M1 v2 权重（或先用 B 组合） | PLAN 第十节 M2 |
| V-M4 | **M4 情绪迁移系统化**：3→7 mood 参考音频库 + 切换延迟/保真度验证 | 待立 SPEC（届时） | M1 权重 + M3 链路 + 7 情绪素材 | PLAN 第十节 M4 |
| V-M5 | **M5 主观评价实验**：多人听音评分 + Wilcoxon/配对 t 检验 | 待立 SPEC（届时） | M4 矩阵 + 被试 ≥5 人 | PLAN 第十节 M5 |
| V-M6 | **M6 材料合成与排练**：研究陈述稿 + 试听包 + 想定问答 | 待立 SPEC（届时） | M1~M5 全部结论 | PLAN 第十节 M6 |

---

### 情绪缺口与临时映射（2026-09-20 决策）

用户听音反馈：**「三无」（cold，日漫無感情属性——無口・無表情・無感情，淡々とした口調）不在现有情绪库里**。`mood.ts` 7 标签无对应（最接近 `neutral` 但仍偏暖）；`aika_voice.json` 6 参考音频也无三无素材（最淡的「温柔/安心」是**有温度的平**，非三无的**无温度的平**）。

**决策：暂不新增三无参考音频，临时映射到「安心」style。** 明确标注：安心 = 关怀语气的平缓 ≠ 三无的无温度平淡，此为**临时顶替**；真正的三无参考音频等 M1 重训素材 / M4 情绪扩库时补齐，作为第 7 个 style 加入并回填 TTS-07 映射表。

- 边界：临时映射只发生在 **style 层**（`aika_voice.json` / TTS-07 映射表），**不碰 `mood.ts`**（前端 domain，重构冻结中）。
- 依据：GPT-SoVITS 情绪由**参考音频**决定（非采样参数），拿温柔/安心参考凑不出三无，只能等真素材。

---

## 三、STT 线遗留 DEFERRED / 未启动（不阻塞语音主线，记账）

| ID | 任务 | 状态 | 说明 |
| --- | --- | --- | --- |
| STT-03 | 设备与识别验收（真机麦克风） | 部分复验（2026-09-22，本地 Whisper 20 句量化：日/混短板 + 缺语言纠偏，见报告） | 完整 B/C 仍待 App 内测 |
| STT-09 | 生产前端本地引擎语言纠偏下沉 | **SPEC 冻结（2026-09-22）**：等合作者重构落地后执行 | 见 [STT-09](stt/specs/STT-09.md) |
| TODO-10 | Streaming Voice Pipeline V2（流式 ASR/TTS 改造） | 愿望（资料已沉淀） | [STT further 笔记](stt/further/STREAMING_ASR_PIPELINE_V2_NOTES.md)，与 TODO-06 相关 |
| STT-05 修复方向 | 真人情绪语音解码质量根治 | 已被 STT-07 部分回答（换大模型 -64%） | 剩余残错「改善非根治」，非阻塞 |

---

## 四、下一步建议（2026-09-20 按协作约束修订）

合作者重构主工程期间，执行顺序为 **V-T06F → V-S08**（两者均完全不触碰前端）：先打通自训声线真机（TTS 是用户主责、研究贡献主体），再做 STT 服务端收尾。**V-T07 冻结**至重构落地——届时前端结构可能已变，SPEC 中的文件级路径（contracts/speechQueue 等）须先对照重构后代码再开工。素材到位后再连轴跑 M1→M2→M4→M5→M6。

唯一硬阻塞是 **V-M1 的素材**——用户提供 ≥10 分钟授权 ASMR 原始音频前，M1 之后的实验里程碑（M2/M4/M5）无法启动，但 V-T06F/V-T07/V-S08 全程不受影响。

## 五、2026-09-21 代码收口复核与补修（R1–R4 已关闭）

四份优化SPEC已有实现与执行报告。R1–R4补修经独立定向复跑确认，代码优化阶段收口；证据见[复核清单](ser/reports/OPTIMIZATION_REVIEW_20260921.md)。条件验收继续按NOT RUN保留。明日执行见[2026-09-22任务单](DAILY_TASKS_2026-09-22.md)。

| 顺序 | SPEC | 范围 | 状态 |
| --- | --- | --- | --- |
| 1 | [SER-03](ser/specs/SER-03.md) | 指标漏计修复、已有证据重算、研究结论勘误 | REVIEWED_PASS；R2/R4关闭，历史重算不变 |
| 2 | [SER-04](ser/specs/SER-04.md) | 共享样本/标签/路径、环境清单与精确Git忽略 | REVIEWED_PASS；R1/R3关闭；新环境复建NOT RUN |
| 3 | [SER-05](ser/specs/SER-05.md) | Demo路径校验、动态文本渲染、推理期间响应性 | 已实施，报告有自动验证；符号链接项NOT RUN |
| 4 | [TTS-08](tts/specs/TTS-08.md) | 独立语音网关拆分，保留接口和识别策略 | 已实施，报告有自动验证；真实 CLI 启动已生产冒烟补证（2026-09-22）；真人设备/听音 NOT RUN |

下一步顺序：TTS-06-F人工听音 → STT-08 → 交付范围整理。主工程重构期间仍禁止触碰 aika-crossplatform；已有实验产物、环境、用户音频不因整理而删除。
