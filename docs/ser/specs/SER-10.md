# SER-10 · 声学扰动、短时窗与延迟压力测试

状态：PASS（2026-09-22；真实麦克风项BLOCKED）。前置：[SER-09](SER-09.md) PASS。路线：[SER V2](../ROADMAP_V2.md)。

## 目标

冻结SER-08 linear probe和SER-09每折temperature/拒识阈值，在未见speaker的RAVDESS测试样本上施加可复现的声学扰动，量化分类、置信度、拒识和推理延迟退化。

## 条件

- clean；白噪声SNR 20/10/0 dB；增益-12/+12 dB（+12 dB允许削波）；中心短时窗1.0/0.5秒。
- 只评估1,248条七类计分样本；训练始终使用SER-08干净embedding，不用扰动测试样本再训练。
- 噪声按sample ID派生固定seed；所有音频统一16 kHz mono。
- 每个样本仅由其SER-06外折对应模型预测；使用SER-09已冻结的temperature和threshold。
- 报告无拒识分类指标、calibration指标、正式拒识coverage/risk、完整unknown计分指标和embedding推理延迟。

真实麦克风采集需要录音授权、设备与环境记录。本SPEC不自动录音，真实麦克风项标记BLOCKED；受控数字扰动不得冒充麦克风结果。

## Acceptance Criteria

| AC | 判据 |
| --- | --- |
| A | 8个条件均覆盖1,248条样本、零失败；扰动确定性、样本顺序和fold归属可验证 |
| B | 每个条件分别报告accuracy/UAR/macro-F1、ECE/NLL/Brier、coverage/accepted risk与unknown完整计分 |
| C | clean重跑无拒识指标与SER-08在允许数值误差内一致，正式拒识协议与SER-09一致 |
| D | 每条件记录embedding推理mean/p50/p95及real-time factor；不得把仅分类器耗时冒充端到端延迟 |
| E | 输出错误类型与退化排序；结论限定于数字扰动RAVDESS，真实麦克风明确BLOCKED |
| F | 定向测试、`py_compile`、`git diff --check`通过，历史产物不覆盖 |

## 报告

`docs/ser/reports/SER-10_ACCEPTANCE.md`。
