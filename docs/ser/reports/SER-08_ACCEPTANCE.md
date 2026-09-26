# SER-08 验收报告 · Frozen emotion2vec 表征与浅层探针

日期：2026-09-22。规格：[SER-08](../specs/SER-08.md)。结论：**PASS**。

## 改动与产物

| 路径 | 内容 |
| --- | --- |
| `research/ser/ser_ssl_probe.py` | 冻结embedding提取、缓存契约、nested speaker CV、linear/MLP/fusion三组探针 |
| `research/ser/tests/test_ser_ssl_probe.py` | embedding矩阵、模型缓存边界和预测完整性测试 |
| `research/ser/output/features/ravdess_emotion2vec_plus_large.npz` | 1,440 × 1,024 embedding及固定sample ID |
| `research/ser/output/ssl/runs/20260922_ravdess_ser08/` | 三组逐样本预测、逐折调参、指标与可追溯元数据 |

模型为冻结的`iic/emotion2vec_plus_large`；没有更新预训练权重，没有使用18条Demo训练，也没有修改主工程、TTS或历史结果。

## 正式结果

三组模型使用SER-06同一speaker五折。超参数只在每个外层训练集内部按speaker三折选择。

| 输入与探针 | Accuracy | UAR | Macro-F1 | 逐折Macro-F1均值±样本标准差 |
| --- | ---: | ---: | ---: | ---: |
| emotion2vec + class-weighted Linear | **0.922276** | **0.920387** | **0.919450** | 0.9179 ± 0.0253 |
| emotion2vec + 128-unit MLP | 0.900641 | 0.892857 | 0.895249 | 0.8945 ± 0.0354 |
| emotion2vec + eGeMAPS + class-weighted Linear | 0.911058 | 0.906250 | 0.907958 | 0.9066 ± 0.0303 |
| SER-07 eGeMAPS Linear SVM参照 | 0.512019 | 0.517113 | 0.510715 | — |

Linear probe相对eGeMAPS Linear SVM的UAR提高0.403274，说明冻结SSL表征在RAVDESS上包含更强的情绪判别信息。MLP比linear低0.027530 UAR，未证明小数据下增加非线性容量有效。简单拼接eGeMAPS比纯embedding linear低0.014137 UAR，因此后续不应默认采用早期拼接；若继续融合，应在训练折内研究正则化或late fusion。

最佳linear probe各类recall为：angry 0.9688、disgusted 0.9323、surprised 0.9219、happy 0.9167、sad 0.9063、fearful 0.9010、neutral 0.8958。五折macro-F1范围0.8840–0.9518，仍存在明显speaker折波动。

## 逐AC证据

| AC | 结果 | 证据 |
| --- | --- | --- |
| A | PASS | 1,440/1,440成功；矩阵`(1440, 1024)`，ID唯一且顺序匹配manifest，全为有限值；记录模型ID、权重SHA-256、manifest/split/cache SHA-256 |
| B | PASS | 启动时验证固定split零speaker泄漏；linear五折均选C=0.1；MLP逐折alpha为0.0001/0.001/0.0001/0.001/0.0001；保存inner分数与train/test计数 |
| C | PASS | fusion载入并校验SER-07同顺序88维缓存，拼接为1,112维；三组结果独立落盘 |
| D | PASS | 三份prediction JSONL分别重新调用`evaluate_prediction_rows`，accuracy/UAR/confusion与全部计数完全一致；每组1,440 success、192 excluded、1,248 scored、0 failed |
| E | PASS | 与SER-07共享相同manifest和split SHA-256；结论限定于RAVDESS英文表演语音，不外推日语、自然对话或真实麦克风 |
| F | PASS | 相关36项测试通过，1项Windows普通symlink权限skip；`py_compile`和`git diff --check`通过；既有产物未覆盖 |

## 可复现标识

- 模型：`iic/emotion2vec_plus_large`
- 模型权重SHA-256：`be501a01f26fcdc7663a062dff86af839afbaef7c4de32f5e42d7e1ad2784da4`
- embedding缓存SHA-256：`b7d329f7e0a7302380189b8f8cee7a8ddcc674ee49d041f6e6b9c5583acbc1e2`
- eGeMAPS缓存SHA-256：`d19478f7c2a1899049e32c331aa5083782fa453b47944c47c091a864bdd398c0`
- manifest SHA-256：`d384b6b9d225de9f42bc6dfb9326c5e862ba6b0a82c36c82f08626aded64f041`
- split SHA-256：`c4923a08569575b230de09585921c585d7870638f174bfd922aada09848d9e44`

## 边界与下一步

本结果证明的是冻结SSL表征在公开英文acted语音上的speaker-independent强基线。它没有证明日语少样本泛化，也没有概率校准或拒识能力。SER-09应以最佳linear probe为主模型：先输出未校准decision/probability分数，再在训练speaker内部拟合temperature或其他校准器，并在外层测试折报告ECE、NLL、coverage-risk与拒识阈值；真人日语授权数据未到位时，日语部分保持BLOCKED，不用18条Demo生成准确率。
