# SER-07 验收报告 · eGeMAPS 可解释基线与特征组消融

日期：2026-09-22。规格：[SER-07](../specs/SER-07.md)。结论：**PASS**。

## 改动与产物

| 路径 | 内容 |
| --- | --- |
| `research/ser/ser_egemaps.py` | eGeMAPSv02提取、缓存校验、嵌套speaker CV、两种线性模型与特征组消融 |
| `research/ser/tests/test_ser_egemaps.py` | 88维/顺序/有限值、缓存顺序、特征组覆盖和嵌套CV契约测试 |
| `research/ser/output/features/ravdess_egemaps_v02.npz` | 1,440 × 88特征矩阵、sample ID和固定列名 |
| `research/ser/output/egemaps/runs/20260922_ravdess_ser07/` | 元数据、逐样本预测、逐折调参与总指标、LogReg消融结果 |
| `research/ser/requirements*.txt` | 锁定`opensmile==2.6.0`及其环境快照 |

没有修改主工程、TTS、历史baseline产物或SER-06输入与split。

## 正式结果

外层固定使用SER-06的speaker五折，内层只在外层训练speaker中进行三折选C。两个模型五个外折均选择`C=0.1`。

| 模型 | Accuracy | UAR | Macro-F1 | 计分/排除 |
| --- | ---: | ---: | ---: | ---: |
| class-weighted Logistic Regression | 0.508013 | 0.514137 | 0.505267 | 1,248 / 192 |
| class-weighted Linear SVM | 0.512019 | **0.517113** | **0.510715** | 1,248 / 192 |

Linear SVM在本实验中略优，但差值很小，不能据此声称对新语料或日语具有稳定优势。LogReg逐类recall为：angry 0.6771、neutral 0.5938、fearful 0.5365、surprised 0.5208、disgusted 0.4479、sad 0.4427、happy 0.3802。happy是当前最弱类别。

## 特征组消融

消融沿用相同外折和训练折内调参。基准为LogReg UAR 0.514137 / macro-F1 0.505267。

| 移除组 | 特征数 | UAR | ΔUAR | Macro-F1 |
| --- | ---: | ---: | ---: | ---: |
| prosody/timing | 26 | 0.467262 | -0.046875 | 0.458218 |
| formants | 18 | 0.504464 | -0.009673 | 0.493880 |
| spectral/MFCC | 34 | 0.508929 | -0.005208 | 0.498251 |
| voice quality | 10 | 0.511161 | -0.002976 | 0.501211 |

在这份RAVDESS协议中，去掉韵律/时序组造成最大下降，可作为SER-08深度embedding融合时的优先对照线索。该结果只说明组级预测贡献，不构成因果解释。

## 逐AC证据

| AC | 结果 | 证据 |
| --- | --- | --- |
| A | PASS | 1,440/1,440成功；矩阵`(1440, 88)`，ID与列名均唯一且全为有限值；metadata记录openSMILE 2.6.0、eGeMAPSv02/Functionals及三个SHA-256 |
| B | PASS | 启动时自动验证固定split零speaker泄漏；每个模型均记录5折的C、inner score、train/test计数与macro-F1 |
| C | PASS | 从两份prediction JSONL独立调用`evaluate_prediction_rows`，accuracy/UAR/confusion和计数与落盘metrics完全一致；1,440 success，192 excluded，1,248 scored，0 failed |
| D | PASS | 四个预定义组各执行一次leave-one-group-out；每项重新在训练speaker中选C，外层split不变 |
| E | PASS | 本报告不外推日语性能；openSMILE开源版只用于研究/非商业用途，不能把软件或其特征直接接入商业产品 |
| F | PASS | 相关33项测试通过，1项Windows普通symlink权限skip；`py_compile`与`git diff --check`通过；旧输出未覆盖 |

## 验证命令

```powershell
research\ser\.venv\Scripts\python.exe -m unittest `
  research.ser.tests.test_ser_egemaps `
  research.ser.tests.test_ser_dataset `
  research.ser.tests.test_ser_splits `
  research.ser.tests.test_ser_evaluate `
  research.ser.tests.test_ser_metrics -v
# exit 0：33 passed，1 skipped

research\ser\.venv\Scripts\python.exe research\ser\ser_egemaps.py `
  --manifest research\ser\manifests\ravdess_ser06_v1.jsonl `
  --data-root research\ser\data\ravdess\speech `
  --splits research\ser\output\splits\ravdess_ser06_v2\splits.jsonl `
  --feature-cache research\ser\output\features\ravdess_egemaps_v02.npz `
  --output-dir research\ser\output\egemaps\runs\20260922_ravdess_ser07
# exit 0
```

## 边界与下一步

openSMILE Python包的开源许可限定非商业研究使用；未来若面向产品，应更换可商用特征实现或取得商业许可，并重新验证数值一致性。SER-08应在同一SER-06外折上评测冻结的深度embedding，并同时报告eGeMAPS单独、embedding单独和融合三组结果。真人日语数据到位前，所有结论保持为英文表演语音基线。
