# SER-06 · 日语 SER 数据契约与无泄漏评测协议

状态：PASS（2026-09-22）。前置：SER-03、SER-04 REVIEWED_PASS。路线：[SER V2](../ROADMAP_V2.md)。验收：[SER-06_ACCEPTANCE](../reports/SER-06_ACCEPTANCE.md)。

## 目标

在增加模型复杂度前，建立唯一的数据与评测入口，使后续 eGeMAPS、emotion2vec linear probe 和日语适配使用完全相同的样本、标签、split 与指标。该 SPEC 不追求新模型分数。

## 范围

- `research/ser/ser_dataset.py`：manifest 读取、字段校验、标签映射、文件存在性/哈希检查。
- `research/ser/ser_splits.py`：按 speaker 分组的可复现 split；数据允许时支持 speaker + text 双隔离。
- `research/ser/ser_evaluate.py`：调用现有 `ser_metrics.py`，统一输出逐样本结果、逐折指标与汇总。
- `research/ser/manifests/`：只提交无私人内容的 schema、示例和公开数据 manifest；受限数据只记录本机路径引用/数据集元信息，不提交音频。
- `research/ser/tests/`：使用小型临时 fixture 验证生产代码。
- `docs/ser/reports/SER-06_ACCEPTANCE.md`：验收报告。

不安装 openSMILE、不训练分类器、不下载或发送数据申请、不改现有历史产物、不接入主工程。

## Manifest 契约

每条样本至少包含：

```json
{
  "sample_id": "dataset-stable-id",
  "dataset": "ravdess",
  "audio_path": "relative/or/local-reference.wav",
  "speaker_id": "speaker-stable-id",
  "text_id": "optional-text-stable-id",
  "language": "en",
  "label_raw": "angry",
  "label_canonical": "angry",
  "license_scope": "public-research",
  "content_sha256": "..."
}
```

规则：

- `sample_id`、`speaker_id` 必填且非空；`sample_id` 全 manifest 唯一。
- `text_id` 未知时显式为 null，不能用文件名猜语义。
- `label_raw` 永久保存；`label_canonical` 由带版本的映射生成并校验。
- 路径必须在声明的数据根内解析；禁止 `..`、绝对路径逃逸和符号链接越界。
- 私人/受限音频不得复制进仓库；manifest 只保存满足许可要求的最少元数据。

## Split 协议

- 默认 5-fold GroupKFold，分组键为 `speaker_id`；固定 seed 与 split version。
- 同一 speaker 不得跨 train/validation/test。
- 有可靠 `text_id` 时提供 strict split：speaker 与 text 均不得跨 test 边界；若数据结构无法满足，明确 BLOCKED，不退化后冒充通过。
- 每折记录样本数、说话人数、文本数与各类分布；缺类折不可静默计为0。
- split 产物写入独立版本目录，已有目录拒绝覆盖。

## Acceptance Criteria

| AC | 判据 |
| --- | --- |
| SER-06-A | manifest 校验能拒绝重复 sample、空 speaker、未知 canonical label、文件缺失、哈希不符、路径/符号链接越界，并给出具体 sample_id 与原因 |
| SER-06-B | 同一输入与 seed 生成逐字节一致的 split；任意 speaker 跨折立即 FAIL |
| SER-06-C | strict 模式下同时检查 speaker/text 隔离；缺 text_id 或不可满足时返回明确 BLOCKED 结果，不伪装成普通 PASS |
| SER-06-D | 评测入口复用 `ser_metrics.py`；unknown/拒识/推理失败仍进入对应分母或失败计数，`attempted = success + failed` |
| SER-06-E | RAVDESS 1,440 条公开音频生成 manifest 审计摘要；情绪编码、说话人和两句文本结构与文件名协议一致，异常文件单列 |
| SER-06-F | 仓库不新增受限/私人音频；已有 baseline 与 recomputed 历史产物哈希不变 |

## 定向验证

```powershell
research/ser/.venv/Scripts/python.exe -m unittest `
  research.ser.tests.test_ser_dataset `
  research.ser.tests.test_ser_splits `
  research.ser.tests.test_ser_evaluate
```

RAVDESS 审计使用生产代码但不运行模型。不得为了验证本 SPEC 重跑 1,440 条 emotion2vec 推理。

## 交付边界

本 SPEC 通过只代表后续实验拥有可信数据入口和无泄漏评测协议，不代表日语识别质量提升。SER-07/08 才产生新模型基线；获得 JTES 等授权后，按本契约增加 manifest，而非修改本 SPEC 的判分规则。
