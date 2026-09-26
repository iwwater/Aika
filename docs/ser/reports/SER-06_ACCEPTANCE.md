# SER-06 验收报告 · 数据契约与无泄漏评测协议

日期：2026-09-22。规格：[SER-06](../specs/SER-06.md)。结论：**PASS**。

## 改动

| 文件 | 内容 |
| --- | --- |
| `research/ser/ser_dataset.py` | manifest 校验、路径/哈希/标签边界、RAVDESS 文件名解析与审计 CLI |
| `research/ser/ser_splits.py` | 确定性 speaker split、样本量均衡、泄漏检查、strict 可行性判定、拒绝覆盖 |
| `research/ser/ser_evaluate.py` | 适配逐样本预测并复用 `ser_metrics/2` 唯一计分入口 |
| `research/ser/tests/test_ser_{dataset,splits,evaluate}.py` | 15 项新增定向测试（整组运行时含既有 metrics 共29项） |
| `research/ser/manifests/ravdess_ser06_v1.jsonl` | 1,440条公开RAVDESS音频的版本化manifest |
| `research/ser/output/datasets/ravdess_ser06_audit.json` | 数据审计摘要 |
| `research/ser/output/splits/ravdess_ser06_v2/` | 正式5折split及metadata；v1不均衡尝试未保留 |

未修改已有模型、baseline、历史重算结果、Demo、TTS或`aika-crossplatform/`。

## 验证命令

```powershell
research\ser\.venv\Scripts\python.exe -m unittest `
  research.ser.tests.test_ser_dataset `
  research.ser.tests.test_ser_splits `
  research.ser.tests.test_ser_evaluate `
  research.ser.tests.test_ser_metrics -v
# exit 0：29 passed，1 skipped

research\ser\.venv\Scripts\python.exe -m py_compile `
  research\ser\ser_dataset.py research\ser\ser_splits.py research\ser\ser_evaluate.py `
  research\ser\tests\test_ser_dataset.py research\ser\tests\test_ser_splits.py `
  research\ser\tests\test_ser_evaluate.py
# exit 0

research\ser\.venv\Scripts\python.exe research\ser\ser_dataset.py `
  --ravdess-root research\ser\data\ravdess\speech `
  --manifest research\ser\manifests\ravdess_ser06_v1.jsonl `
  --audit research\ser\output\datasets\ravdess_ser06_audit.json
# exit 0

research\ser\.venv\Scripts\python.exe research\ser\ser_splits.py `
  --manifest research\ser\manifests\ravdess_ser06_v1.jsonl `
  --output-dir research\ser\output\splits\ravdess_ser06_v2 `
  --folds 5 --seed 20260922
# exit 0
```

`git diff --check -- docs/ser research/ser` 退出0，仅有仓库既有LF→CRLF提示。

## 数据审计

- 1,440条音频全部通过路径、文件存在性和SHA-256验证，异常文件0。
- 24名说话人、2条固定文本。
- 标签分布：neutral 96；calm 192；其余 angry/disgusted/fearful/happy/sad/surprised 各192。
- calm保留原始标签，并映射为canonical `other` + `excluded=true`，与既有计分规则一致。
- manifest SHA-256：`d384b6b9d225de9f42bc6dfb9326c5e862ba6b0a82c36c82f08626aded64f041`。

## Split结果与修正记录

第一版采用稳定哈希直接分配说话人，无泄漏但产生240/180/540/240/240的严重不均衡。该方案被判定不合格，没有保留为正式产物。生产算法改为“说话人样本量降序 + seed hash平局顺序 + 当前最轻折贪心分配”。

正式v2分布为 **300/300/300/300/240**，对应说话人数5/5/5/5/4；这是24名等样本说话人在5折下可达到的均衡结果。相同输入与seed生成的`metadata.json`和`splits.jsonl`逐字节相同。split SHA-256：`c4923a08569575b230de09585921c585d7870638f174bfd922aada09848d9e44`。

RAVDESS每位说话人都朗读相同两条文本，因此speaker/text二部图只有一个连通分量。在“不丢弃交叉块”的完整数据5折定义下，speaker + text双隔离不可满足；strict模式按约定返回 **BLOCKED**，没有降级冒充PASS。未来JTES或其他数据到位后按其真实speaker/text结构重新判断。

## 逐AC证据

| AC | 结果 | 证据 |
| --- | --- | --- |
| A | PASS | 重复ID、空speaker、未知标签、缺文件、错哈希、`..`路径均由单测拒绝；普通文件symlink创建因Windows权限跳过，但用真实directory junction指向数据根外单独验证，生产校验返回“越出数据根”，exit 0 |
| B | PASS | 相同输入/seed结构与落盘字节一致；注入speaker跨折后明确FAIL；正式v2零speaker泄漏 |
| C | PASS | 缺`text_id`返回BLOCKED；RAVDESS连通结构返回BLOCKED并说明原因，不静默退化 |
| D | PASS | adapter直接调用`score_run`，ruleVersion=`ser-metrics/2`；unknown进入混淆矩阵，failed保留，计数守恒 |
| E | PASS | 1,440条、24 speaker、2 text、8个原始标签全部审计，异常0 |
| F | PASS | 未新增受限/私人音频；`git diff --name-only -- research/ser/output/baseline_ravdess`为空，历史metrics/confusion哈希仍为`b11017ab…`/`6eff77ad…` |

## 接口影响与下一步

新增的是研究工具内部契约，不改变主工程或语音服务HTTP接口。SER-07必须消费本SPEC的manifest/split，并在同一折上运行eGeMAPS基线；不得重新随机划分。取得真人日语授权数据后新增独立manifest，不修改RAVDESS历史证据。
