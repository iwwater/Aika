# SER-09 · 概率校准与 uncertain 拒识

状态：PASS（2026-09-22）。前置：[SER-08](SER-08.md) PASS。路线：[SER V2](../ROADMAP_V2.md)。

## 目标

为SER-08最佳的frozen emotion2vec linear probe建立无测试泄漏的概率校准和拒识协议，使模型可以在低置信输入上返回`unknown`，并量化校准质量与coverage-risk权衡。

## 方法与边界

- 输入固定为SER-06 manifest/split和SER-08的1,024维embedding缓存。
- 每个外层speaker测试折完全隔离；C仍只在外层训练speaker内选择。
- 在外层训练集上再生成speaker三折OOF logits，只用这些logits拟合单一temperature。
- 在训练OOF上从预定义阈值`0.00/0.50/0.60/0.70/0.80/0.90`中选择“coverage不低于80%时错误率最低”的阈值；平局优先更高coverage。
- 测试折报告raw/calibrated ECE、NLL、multiclass Brier、UAR、macro-F1，以及各固定阈值和训练选择阈值的coverage/selective risk。
- 被拒绝样本预测为`unknown`，继续由`ser_metrics/2`计为错误，不从分母消失。

本SPEC只完成RAVDESS协议。真人日语监督适配需要授权语料，未取得前为BLOCKED；18条Demo不得用于拟合、选阈值或发布准确率。

## Acceptance Criteria

| AC | 判据 |
| --- | --- |
| A | 五个外折均只以训练speaker OOF logits拟合temperature和选择阈值；记录C、temperature、阈值、训练/测试计数 |
| B | raw与calibrated分别报告ECE(15 bins)、NLL和multiclass Brier；概率每行有限、非负且和为1 |
| C | 输出固定阈值coverage-risk曲线；拒识预测为unknown并按`ser_metrics/2`进入错误分母，计数守恒 |
| D | 保存逐样本raw/calibrated概率、置信度、是否拒识与最终预测；离线重算指标一致 |
| E | 报告明确区分“校准改善”和“分类改善”，不从RAVDESS外推日语；日语适配标记BLOCKED |
| F | 定向测试、`py_compile`、`git diff --check`通过；历史产物不覆盖 |

## 报告

`docs/ser/reports/SER-09_ACCEPTANCE.md`。
