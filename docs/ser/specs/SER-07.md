# SER-07 · eGeMAPS 可解释基线与特征组消融

状态：PASS（2026-09-22）。前置：[SER-06](SER-06.md) PASS。路线：[SER V2](../ROADMAP_V2.md)。

## 目标

在SER-06冻结的RAVDESS manifest和speaker五折上，用openSMILE eGeMAPSv02 Functionals（88维）建立传统可解释基线。比较class-weighted Logistic Regression与Linear SVM，并用特征组消融说明性能来自哪些声学线索。

## 范围

- 新增 `research/ser/ser_egemaps.py` 与定向测试。
- 依赖锁定 `opensmile==2.6.0`。该开源版本只用于非商业研究；特征或软件不得直接进入商业产品。
- 输入固定为 `ravdess_ser06_v1.jsonl` + `ravdess_ser06_v2/splits.jsonl`。
- 输出写独立run目录，包含特征元数据、逐折参数、逐样本预测、总指标和消融表。
- calm不参与训练，预测后按既有`excluded=true`规则进入成功数但不进入七类计分。

不做日语质量声明、不使用18条Demo训练、不微调emotion2vec、不修改主工程/TTS。

## 方法

1. openSMILE `FeatureSet.eGeMAPSv02` + `FeatureLevel.Functionals`，每段恰好88维。
2. 外层使用SER-06固定speaker五折；任意speaker不得跨train/test。
3. 每个外层训练集内部再按speaker分组选超参数；测试折不得参与选择。
4. 模型：`StandardScaler + LogisticRegression(class_weight=balanced)`、`StandardScaler + LinearSVC(class_weight=balanced)`；C候选固定为0.1/1/10。
5. 主指标复用`ser_metrics/2`：UAR、accuracy、每类recall、混淆矩阵；另外计算macro-F1。
6. 对LogReg执行预定义特征组leave-one-group-out消融；不按结果临时改组。

## Acceptance Criteria

| AC | 判据 |
| --- | --- |
| A | 1,440条全部提取成功，每条88维、列名一致、无NaN/Inf；记录openSMILE/feature-set版本与manifest/split SHA-256 |
| B | 两模型均严格使用固定外折和训练折内调参；自动检查speaker零泄漏，记录每折C、样本数和指标 |
| C | 逐样本预测可由`ser_metrics/2`离线复算出完全一致的accuracy/UAR/confusion；calm 192条保持excluded |
| D | 输出LogReg预定义特征组消融表；每项只去除一个组，使用相同split与调参规则 |
| E | 报告不得把RAVDESS结果外推为日语性能；明确openSMILE研究许可边界和下一步SER-08对照方式 |
| F | 相关定向测试、`py_compile`、`git diff --check`通过；已有SER-06与历史baseline产物不被覆盖 |

## 报告

`docs/ser/reports/SER-07_ACCEPTANCE.md`。如果真实提取或任一折失败，状态为FAIL；不得用fixture结果冒充模型基线。
