# 实验 2 报告：RAVDESS 英文 baseline 验证

> 对应 SPEC_SER-02.md 第 3 节 | 日期 2026-09-20

## 1. 目的

用公开英文数据（RAVDESS）验证 emotion2vec+ 的 baseline 能力，**排除「模型本身有问题」** 这个干扰解释，给 M0 的「日语偏置」结论上双保险。

## 2. 方法

- **数据**：RAVDESS speech 子集，1440 段（24 说话人 × 8 情绪 × 2 强度 × 2 语句 × 2 复述），48kHz。经 `ser_download_ravdess.py` 用 requests 直连下载到 E 盘（绕开 hf_hub 的 hf_xet 0 字节 bug）。
- **重采样**：48kHz → 16kHz（librosa.resample），emotion2vec+ 要求 16k。
- **模型**：`iic/emotion2vec_plus_large`（300M / 42526h），utterance 粒度，zero-shot。
- **标签映射**：RAVDESS 8 类 → emotion2vec+ 9 类。`calm` 无对应 → 映射 `other` 并**剔除**（不参与计分），其余 7 类直接对应（`disgust`→`disgusted`）。
- **指标**：准确率 + UAR（7 类宏平均 recall）+ 混淆矩阵。

## 3. 结果

| 指标 | 值 |
|---|---|
| 样本数（计分） | 1248（剔除 calm 192 段） |
| 失败 | 0 |
| **准确率** | **0.9215** |
| **UAR（7 类）** | **0.9241** |

每类 recall：

| 情绪 | recall |
|---|---|
| angry | 0.9740 |
| disgusted | 0.9791 |
| neutral | 0.9479 |
| happy | 0.9323 |
| surprised | 0.9167 |
| fearful | 0.8698 |
| sad | 0.8490 |

主要混淆（从混淆矩阵）：sad→neutral(16)、sad→disgusted(6)、fearful→sad(10)、happy→neutral(6)、surprised→disgusted(6)。均为相邻/相近情绪，符合预期。

## 4. 结论

1. **模型能力完全正常**：英文 RAVDESS 上 UAR 92.41%，高于 emotion2vec 论文在 IEMOCAP（4 类）的 71.79% 参照，量级合理甚至更优（RAVDESS 是录音棚 acted 语音，比 IEMOCAP 自然对话更「干净」）。
2. **反证「日语偏置」是研究空白，不是模型缺陷**：同一模型在英文 8 类上 92% 准确，却在用户 18 段日语娇柔声线上把 12/12 柔软类判成「恐惧」（base 模型）。这强烈说明偏差来自**训练数据的语言/文化分布**（英语 acted 语料缺乏日语女性撒娇/示弱声线），而非模型本身失效。这正是「日语 SER」的立项空白，第一手证据。
3. **sad 是相对最弱类（0.849）**：sad 与 fearful/neutral 声学特征天然邻近，这在跨语料也成立（与用户素材里「恳求→fearful」的稳定映射互相呼应）。

## 5. 边界

- acted 语音（表演性），不等同自然对话；RAVDESS 结论仅用于「模型 sanity check」，不迁移到日语自然语音。
- calm 被剔除，UAR 为 7 类口径。


---

## 勘误入口（2026-09-21，SER-03）

> 本报告正文（上方）为原始执行历史，**保留不改**。其中的 UAR 0.9241 等指标存在漏计缺陷，请以下述勘误产物为准。

- 缺陷：原计分把预测为 other/`<unk>` 的样本从混淆矩阵丢弃（矩阵总数 1247 ≠ n_scored 1248）。
- 校正后：accuracy 0.921474（不变）、UAR(七类) **0.923363**、disgusted recall 0.974（原 0.979）。
- 重算产物与逐样本证据：`recomputed_20260920_212308/`（本目录内）；规则：`research/ser/ser_metrics.py`（ser-metrics/2）；规格：`docs/ser/specs/SER-03.md`。
