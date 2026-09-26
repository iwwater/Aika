# SER-09 验收报告 · 概率校准与 uncertain 拒识

日期：2026-09-22。规格：[SER-09](../specs/SER-09.md)。结论：**PASS**。日语监督适配：**BLOCKED（等待授权语料）**。

## 实现与协议

新增`research/ser/ser_calibration.py`和定向测试。每个SER-06外层speaker折依次执行：训练speaker内选择C、按speaker三折生成OOF logits、只用OOF拟合temperature与选择拒识阈值、最后评估未见过的外层测试speaker。没有使用测试折概率调参。

五折C均为0.1；temperature依次为1.4014、1.5054、1.4799、1.3080、1.4983。训练OOF选择的阈值为0.8、0.8、0.8、0.9、0.8。

## 校准结果

| 概率 | ECE（15 bins） | NLL | Multiclass Brier |
| --- | ---: | ---: | ---: |
| Raw | **0.024315** | 0.322696 | **0.123821** |
| Temperature-scaled | 0.027558 | **0.305385** | 0.125813 |

Temperature scaling使NLL降低0.017312，但ECE增加0.003242、Brier增加0.001991。其优化目标就是NLL，所以NLL改善符合训练目标；结果不支持“全面校准改善”的说法。五折中只有fold 2/3的测试NLL改善，fold 0/1/4变差，说明24个speaker下校准参数仍有折间不稳定性。

温度缩放不改变argmax，因此无拒识时分类结果仍是SER-08 linear probe：accuracy 0.922276、UAR 0.920387、macro-F1 0.919450。校准改善与分类改善必须分开解释。

## Coverage-risk

下表使用全部外层测试预测的calibrated confidence，仅作固定阈值曲线；每折正式选择阈值仍只看该折训练OOF。

| 阈值 | Coverage | Accepted risk | 接受/拒绝 |
| ---: | ---: | ---: | ---: |
| 0.00 | 1.0000 | 0.0777 | 1,248 / 0 |
| 0.50 | 0.9679 | 0.0629 | 1,208 / 40 |
| 0.60 | 0.9287 | 0.0475 | 1,159 / 89 |
| 0.70 | 0.8894 | 0.0360 | 1,110 / 138 |
| 0.80 | 0.8357 | 0.0278 | 1,043 / 205 |
| 0.90 | 0.7228 | 0.0233 | 902 / 346 |

按各折训练OOF选出的正式阈值汇总后，测试coverage为 **0.824519**，接受1,029条、拒绝219条，accepted risk为 **0.025267**（接受样本准确率97.47%）。fold 4测试coverage只有0.75，低于训练选择时的80%约束，说明coverage约束不能保证跨speaker严格兑现。

拒识样本没有从指标分母删除，而是预测`unknown`。因此完整契约指标下降为accuracy **0.803686**、UAR **0.796875**、macro-F1 **0.874459**；这准确反映“拒绝也是未完成分类”，不能用97.47%的选择性准确率代替全量准确率。

## 逐AC证据

| AC | 结果 | 证据 |
| --- | --- | --- |
| A | PASS | 五折均保存C、temperature、训练选择阈值、inner score、train/test计数；校准器与阈值仅使用训练speaker OOF |
| B | PASS | raw/calibrated均输出ECE、NLL、Brier；1,440条两套概率逐行检查有限、非负、和为1 |
| C | PASS | 输出六个固定阈值的coverage-risk；219条正式拒识写为unknown并留在1,248条计分分母中 |
| D | PASS | JSONL含raw/calibrated七类概率、confidence、threshold、rejected及拒识前后预测；独立调用`evaluate_prediction_rows`与落盘指标完全一致 |
| E | PASS | 报告如实记录NLL改善但ECE/Brier未改善，不声称分类提升；日语监督适配明确BLOCKED |
| F | PASS | 39项相关测试通过、1项Windows symlink权限skip；`py_compile`和`git diff --check`通过；历史产物未覆盖 |

## 产物

- 实现：`research/ser/ser_calibration.py`
- embedding输入：`research/ser/output/features/ravdess_emotion2vec_plus_large.npz`
- 正式run：`research/ser/output/calibration/runs/20260922_ravdess_ser09/`
- 主要文件：`calibration.json`、`folds.json`、`predictions.jsonl`、`metrics_rejected.json`、`metadata.json`

## 下一步

当前可把“calibrated confidence + unknown拒识”作为研究候选，但不应直接冻结成产品阈值。SER-10需要在噪声、音量变化、短时窗和真实麦克风条件下检查confidence是否会随退化合理下降，并报告延迟与错误类型。日语授权语料到位后，应重新拟合校准器和阈值；不能沿用RAVDESS阈值宣称日语可靠性。
