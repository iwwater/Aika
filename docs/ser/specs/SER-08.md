# SER-08 · Frozen emotion2vec 表征与浅层探针

状态：PASS（2026-09-22）。前置：[SER-07](SER-07.md) PASS。路线：[SER V2](../ROADMAP_V2.md)。

## 目标

在SER-06冻结的RAVDESS manifest和speaker五折上，提取冻结的`iic/emotion2vec_plus_large` utterance embedding，比较linear probe、浅层MLP probe，并将embedding与SER-07 eGeMAPS拼接做融合对照。

## 范围与方法

- 输入固定为`ravdess_ser06_v1.jsonl`、`ravdess_ser06_v2/splits.jsonl`和SER-07的88维特征缓存。
- emotion2vec参数冻结，只提取1024维utterance embedding，不进行微调。
- 外层固定speaker五折；每个外层训练集内部按speaker三折选择超参数，测试折不得参与选择。
- 对照：embedding + class-weighted Logistic Regression、embedding + 单隐层MLP、embedding/eGeMAPS标准化后拼接 + Logistic Regression。
- calm不参与训练，预测成功后仍按`excluded=true`从七类指标中排除。
- 输出独立run目录，拒绝覆盖；逐样本预测必须可由`ser_metrics/2`复算。

不使用18条Demo训练，不做日语效果声明，不修改主工程或TTS。

## Acceptance Criteria

| AC | 判据 |
| --- | --- |
| A | 1,440条全部提取成功；embedding维度固定、顺序匹配manifest、无NaN/Inf；记录模型标识和输入/缓存SHA-256 |
| B | linear与MLP严格使用固定外折和训练speaker内调参，记录每折超参数、样本数与指标，speaker零泄漏 |
| C | fusion只拼接SER-07同样本顺序的eGeMAPS；单独报告embedding linear、embedding MLP、fusion linear三组结果 |
| D | 三份逐样本预测由`ser_metrics/2`离线重算完全一致；1,440 success、192 excluded、1,248 scored |
| E | 与SER-07基线在同split下比较，说明限制，不把英文表演语音结果外推到日语或真实场景 |
| F | 定向测试、`py_compile`、`git diff --check`通过；SER-06/07和历史baseline产物不被覆盖 |

## 报告

`docs/ser/reports/SER-08_ACCEPTANCE.md`。任何真实提取失败或预测记录缺失均为FAIL。
