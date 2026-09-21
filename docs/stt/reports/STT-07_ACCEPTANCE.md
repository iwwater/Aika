# STT-07 验收报告 · Whisper 更大模型在 GPU 下的延迟与识别质量标定

> 状态：**AUTO_PASS（2026-09-18）**。证据逐 AC 附下；判定规则下的表述边界见「结论与边界」。

## 摘要

在 GPU 后端（STT-06 已使能）下，对 base 与三档量化更大模型（small-q5_1 / medium-q5_0 / large-v3-turbo-q5_0）做同素材、同参数、同脚本的对照。两个核心结论：

1. **预算**：四档模型**全部进入**「单次 ASR ≤500 ms 且 ≤8 GB」工作阈值。GPU 下的延迟远低于 STT-06 之前的线性外推（medium 302 ms、turbo 216 ms，而非预估的 ~850 ms）。
2. **质量**：真人情绪语音的 CER 随模型规模**单调下降**——base 0.22 → small 0.18 → medium 0.11 → **large-v3-turbo 0.079**（相对 base **-64%**）。这是 STT-05「杠杆是模型规模」这一**未验证方向**的第一次实证，且 large-v3-turbo 是明确的「又快又准」甜点。

**样本量 n=6（R 组）**，质量结论按 SPEC 判定规则作**方向性观察**，不作因果断言；不声称「识别问题已解决」或「换模型提升准确率」。

## 做了什么

- 下载 3 个量化模型到 `E:\Work\toolchains\whisper-b5130\models\`（与 base 并列）：`ggml-small-q5_1.bin`（190,085,487 B）、`ggml-medium-q5_0.bin`（539,212,467 B）、`ggml-large-v3-turbo-q5_0.bin`（574,041,195 B），体积与 HF 记录一致。
- 复用 `probe_latency.py` 对四档模型跑同一矩阵（jfk / jfk-silence / R / A / C，每段 5 次重复，生产字段面，GPU 后端 `-t 6`）。
- 新增 `analyze_stt07.py`（纯标准库）合并产物，输出延迟/显存/CER 对照与预算判定。
- 未触碰 `aika-crossplatform/src/**`、未改动现有 CPU 部署与 base 模型。

## 逐 AC 证据

### STT-07-A 模型就位 ✅

| 模型 | 文件大小 | 加载后 CUDA0 size | GPU 后端 |
| --- | --- | --- | --- |
| ggml-base.bin | 147,951,465 B | 已有（STT-06） | using CUDA0 backend |
| ggml-small-q5_1.bin | 190,085,487 B | 189.53 MB | using CUDA0 backend |
| ggml-medium-q5_0.bin | 539,212,467 B | 538.59 MB | using CUDA0 backend |
| ggml-large-v3-turbo-q5_0.bin | 574,041,195 B | 573.45 MB | using CUDA0 backend |

证据：`server_stt07-{base,small,medium,turbo}.log` 的 `whisper_model_load` / `whisper_backend_init_gpu` 行。

### STT-07-B 延迟矩阵 ✅（产物 `latency_stt07-*.json`）

GPU 后端、生产字段面、稳态中位（5 次重复）：

| 模型 | jfk 延迟 ms | jfk RTF | R 组中位 ms | A 组中位 ms | C 组中位 ms |
| --- | --- | --- | --- | --- | --- |
| base | 85.88 | 0.0078 | 78.28 | 76.34 | 80.67 |
| small-q5_1 | 128.71 | 0.0117 | 106.72 | 109.92 | 114.16 |
| medium-q5_0 | 302.54 | 0.0275 | 220.47 | 231.09 | 219.79 |
| large-v3-turbo-q5_0 | 215.95 | 0.0196 | 202.59 | 202.64 | 205.76 |

- 冷启动（缓存已 warm 后的首次，不含 JIT）：base 218 / small 237 / medium 408 / turbo 316 ms。
- 脚本退出码 0，各段 `median_ms` / `min_ms` / `max_ms` / `rtf_median` 逐条可复核（`latency_stt07-*.json` → `steady[]`）。

### STT-07-C 显存 ✅

| 模型 | 峰值显存（整卡，MiB） | 净增（峰值 − 启动前背景，MiB） |
| --- | --- | --- |
| base | 1205 | 212 |
| small-q5_1 | 1313 | 648 |
| medium-q5_0 | 1785 | 1120 |
| large-v3-turbo-q5_0 | 1689 | 1024 |

- 背景值：各模型启动前 `gpu_idle_mib_before_start` 约 993 MiB（含驱动/桌面占用），净增为 whisper 侧需求。
- **与 GPT-SoVITS 共存未实测**（GPT-SoVITS 推理占用未采样），按 SPEC 只给 whisper 侧需求、不外推。

### STT-07-D 质量对照 ✅（产物 `stt07_summary.md`）

CER 口径复用 STT-05（NFKC + 去标点/空白，编辑距离 ÷ 参照长度）：

| 模型 | R 真人 CER 中位 | R 全对 | A 合成 CER 中位 | C 合成 CER 中位 | 合成全对 |
| --- | --- | --- | --- | --- | --- |
| base | 0.2198 | 0/6 | 0.0 | 0.0 | 9/12 |
| small-q5_1 | 0.1831 | 1/6 | 0.0 | 0.025 | 8/12 |
| medium-q5_0 | 0.106 | 1/6 | 0.0 | 0.0 | 10/12 |
| large-v3-turbo-q5_0 | 0.0794 | 2/6 | 0.0 | 0.0 | 10/12 |

真人组逐段对照（base → turbo）最能说明改善幅度，抽查三例：

| id | base | turbo |
| --- | --- | --- |
| R01（恋人） | 0.2222（「恋人が」→「カイピードが」） | **0.0**（完全正确） |
| R04（童貞） | 0.5833（「童貞」→「どうれい」等） | 0.1667（「童貞」→「同齢」，接近） |
| R05（雑魚） | 0.7037（「雑魚」→「状況」等，全崩） | 0.1111（「雑魚」基本正确） |

完整逐段见 `latency_stt07-*.json` → `steady[].gt` 与 `steady[].texts`。

### STT-07-E 预算判定 ✅

| 模型 | ≤500 ms？ | ≤8 GB？ | 判定 |
| --- | --- | --- | --- |
| base | 85.88 ✅ | 212 MiB ✅ | ✅ 进预算 |
| small-q5_1 | 128.71 ✅ | 648 MiB ✅ | ✅ 进预算 |
| medium-q5_0 | 302.54 ✅ | 1120 MiB ✅ | ✅ 进预算 |
| large-v3-turbo-q5_0 | 215.95 ✅ | 1024 MiB ✅ | ✅ 进预算 |

阈值沿用 STT-06 的「ASR 单次 ≤500 ms」工作阈值假设（为 INT-02 首句 1.5 s 预算留余量），最终以 INT-02 实测为准。

### STT-07-F 零改动 ✅

- `git status --porcelain src/` 的改动全部为 2026-09-17 的 RT-05/localTasks 遗留（App.tsx、persistentScheduler*、localTasks* 等）；`find src -newermt "2026-09-18 10:09" -type f` **为空**，本次窗口未触碰 `src/**`。
- base 模型校验和 `sha256 = 60ed5bc3…fba2efe`、size 147,951,465，与 STT-06 记录一致；现有 CPU 运行时目录逐字节未动。
- 本次仅新增：模型文件（`models/`）、`GPT-SoVITS/tools/stt_probe/analyze_stt07.py`、`docs/stt/specs/STT-07.md`、本报告，均在 SPEC 允许范围内。

### STT-07-G 报告落盘 ✅

本报告即验收报告；每个汇总数字可指回产物字段：

- 延迟/显存 → `latency_stt07-{base,small,medium,turbo}.json`（`steady[].median_ms` / `gpu_peak_mib`）
- CER → `stt07_summary.md` §2 与 `latency_stt07-*.json` → `steady[].gt` / `steady[].texts`
- 汇总表 → `GPT-SoVITS/output/stt_probe/stt07_summary.md`

## 结论与边界（按 SPEC 判定规则）

**证据支持**：

1. **「杠杆是模型规模」成立为方向性结论**：真人情绪语音 CER 随模型规模单调下降（0.22 → 0.18 → 0.11 → 0.079），且逐段对照显示 base 完全听错的段（R01/R04/R05）在 large-v3-turbo 下显著改善。改善幅度可量化（相对 base **-64%**），样本 n=6。
2. **large-v3-turbo-q5_0 是甜点**：延迟 216 ms（比 medium 的 302 ms 快 29%），CER 0.079（比 medium 的 0.106 更低）——又快又准，且体积仅 547 MB、显存净增 1024 MiB。
3. **预算不是约束**：四档模型全部进 ≤500 ms 阈值，意味着「换更大模型」在 GPU 下不再受 STT-05 时代的 CPU 延迟预算锁死。

**未被证据支持 / 需谨慎表述**：

- **n=6 样本量小**：CER 下降是「方向性观察」，不作因果断言；不表述为「识别问题已解决」。
- **turbo 仍有残错**：R04「童貞」→「同齢」（0.17）、R03「抱っこ」→「託」（0.13），真人情绪语音的难词仍未被完全解决——这是「改善」而非「根治」。
- **不声称「提升准确率」**：本 SPEC 只记录 CER 事实，真机端到端验收仍属 STT-03（DEFERRED）。
- **合成组无增益**：A/C 合成音频在 base 已近 0 误差（9/12 全对），更大模型无额外收益（甚至 small-q5_1 略降至 8/12），符合「合成样本已在 base 能力范围内」的预期。
- **显存共存未实测**：GPT-SoVITS 推理占用未采样，whisper 侧需求（最大 1120 MiB）能否与 GPT-SoVITS 共存需另测，不外推。

## 未验证 / 不在本 SPEC

- 全精度 small（465 MB）、medium（1462.7 MB）：未下载（量化版优先，且结论已明确，无必要）。
- 把更大模型设为生产默认：需矩阵 + 用户决策，另立 SPEC。
- 修改 `whisperClient.ts`（模型选择）：另立 SPEC。
- GPT-SoVITS 显存共存实测：另立 SPEC。
- 真人麦克风 / INT-02 端到端：仍 DEFERRED。
