# SER-03 验收报告 · 计分修复与研究证据校正

> 2026-09-21审阅更新：下文保留原执行证据。生产入口仍有R2历史产物覆盖风险、R4空指标显示为零，尚未收口；见[复核与接续清单](OPTIMIZATION_REVIEW_20260921.md)。历史离线重算结果不作废；修复后在本报告追加定向测试证据。
> 2026-09-21补修：R2/R4 已修复并验证，证据见文末「R2/R4 补修证据」节；历史平面产物 `metrics_emotion2vec_plus_large.json` 等未动。
> **2026-09-21 复核收口：R1–R4 全部关闭**（复核会话定向复跑 34 项测试通过），本报告为最终收口状态；上方「尚未收口」为审阅时点快照，已被本行取代。

日期：2026-09-21。规格：[SPEC_SER-03](../specs/SER-03.md)。规则版本：ser-metrics/2。
执行环境：Windows，`research/ser/.venv`（Python 3.11.16）。无 GPU / 真实模型 / 网络参与。

## 执行命令与退出码

| 命令 | cwd | 退出码 |
| --- | --- | --- |
| `.venv/Scripts/python.exe -m unittest discover -s research/ser/tests -p "test_ser_metrics.py" -v` | `E:/Work/AI CHAT` | 0（Ran 14 tests, OK） |
| `.venv/Scripts/python.exe research/ser/recompute_ravdess.py --log research/ser/output/logs/baseline_ravdess_20260920_212308.jsonl` | `E:/Work/AI CHAT` | 0 |
| `-m py_compile ser_ravdess_baseline.py ser_metrics.py recompute_ravdess.py` | `E:/Work/AI CHAT` | 0 |

## 逐 AC 结论

### AC-A · PASS

生产计分函数（`ser_metrics.score_run`，已被 `ser_ravdess_baseline.py` 引用）对同类两条样本（一条正确、一条未知预测）给出 recall=0.5、accuracy=0.5。两种未知来源均覆盖：

- `test_unknown_pred_counts_as_error`（pred=`<unk>` → 归一化 unknown）
- `test_other_pred_counts_as_error`（pred=other）
- `test_composite_unk_normalized`（复合格式 `未知/<unk>`）

矩阵总数等于 n_scored（未知预测不消失）。

### AC-B · PASS

fixture 覆盖（`tests/test_ser_metrics.py`，14 用例）：

- calm 剔除按真实标签、与预测内容无关（`test_calm_excluded_by_target_not_pred`）
- 中文/英文复合标签（`test_compound_labels_everywhere` / `test_compound_cn_en`）
- 缺失类 → UAR=None + missing_classes，不悄悄六类平均（`test_missing_class_uar_null`）
- 推理失败计数守恒（`test_failed_records_conservation`）
- 重复文件 raise（`test_duplicate_file_raises`）、非法标签 raise 不静默丢弃（`test_illegal_label_raises_not_dropped`）
- 计数守恒 attempted=success+failed、success=excluded+scored（多处断言 + score_run 内部 assert）
- 空运行：accuracy/UAR 均为 None（`test_empty_run`）

### AC-C · PASS（完整重建，非 BLOCKED）

重算源：`output/logs/baseline_ravdess_20260920_212308.jsonl`（归一化修复后的重跑，即产出现有 metrics 的那次运行；同日 211945 为标签未归一化的首次运行，未使用）。

核对结果：单次运行（1 个启动事件）、模型唯一 `iic/emotion2vec_plus_large`、**1440 attempted / 1440 唯一文件 / 0 失败**；文件名解析情绪与日志 slug 全量一致；预测 `<unk>` 恰 1 条 = SPEC 点名的 `03-01-07-01-02-02-07.wav`（disgust）。

v2 计分（重算，非硬编码）：

| 项 | v2 | 旧 | 差异来源 |
| --- | --- | --- | --- |
| n_attempted / success / failed | 1440 / 1440 / 0 | —（旧无此字段） | — |
| n_excluded / n_scored | 192 / **1248** | — / 1248 | — |
| 矩阵总数 | **1248**（7×9） | **1247** | 漏 1 条 `<unk>` |
| accuracy | **0.921474** | 0.9215 | 不变（旧 accuracy 分母本就含未知预测） |
| UAR(七类) | **0.923363** | 0.9241 | disgusted 分母 191→192 |
| disgusted recall | 0.973958 | 0.979 | 同上 |
| sad recall | 0.848958 | 0.849 | 不变 |

漏计文件清单：`03-01-07-01-02-02-07.wav`（target=disgusted, pred=unknown）。与规格审阅推算 UAR≈0.923363 一致（复核线索，未硬编码）。

### AC-D · PASS

- 原始产物哈希不变：`sha256(logs/baseline_ravdess_20260920_212308.jsonl)` 与 `sha256(metrics_emotion2vec_plus_large.json)` 与 provenance.json 记录一致（原始日志、原 metrics/confusion/report 均未覆写）。
- 离线复算：读取 `recomputed_20260920_212308/samples.jsonl`（逐样本 file/target_raw/pred_raw/excluded/status，scores 全 null——历史日志无 scores 字段，如实留空未补造），经 `ser_metrics.score_run` 独立复算，accuracy/uar/全部计数/混淆矩阵与 v2 metrics 完全一致（脚本输出 `AC-D offline recompute matches v2: True`）。测试 `TestACDRecompute` 用随机构造 fixture 验证同一性质，不依赖任何写死常数。

### AC-E · PASS

研究表述校正（`docs/ser/RESEARCH_PLAN.md`）：

| 过度推断 | 处理 |
| --- | --- |
| ①「英文 8 类」计分 | 改为「剔除 calm 后七类」；对 IEMOCAP 71.79% 的比较降级为「能力量级参照」，明确不构成排名 |
| ② base/large「同模型/控制变量对照」 | 5.2 加校正块：容量与训练数据同时改变，不归因单一变量；结论 1 改为观察+假设 |
| ③ 标签一致 → embedding 不可分 / UMAP 证明原空间距离 | 5.1 结论 3 改为「分类输出层面」；5.3 加「单次二维布局不能证明原空间可分性/因果」 |
| ④「恳求→fearful 跨语言普适」 | 5.2 结论 2 降级为观察 + 待验证假设 |
| ⑤「不看词义 = 已隔离词义」 | 5.1 结论 1 加边界：不接收文本 ≠ 已隔离词义，严格隔离留待 RQ3 |
| ⑥ 原数值保留 + 观察标注 | 全部原数值保留（5.4 用新旧对照表）；5.1/5.2/5.3 结论逐条标注「观察 / 假设」 |

配套勘误：`SPEC_SER-02.md` 追加 §7 勘误节（保留原始执行历史）；`output/baseline_ravdess/report.md` 追加勘误入口（正文未动）。人工复核：勘误文字与 v2 数据逐项相符（本报告上表）。

## 产物清单

| 文件 | 性质 |
| --- | --- |
| `research/ser/ser_metrics.py` | 新增，纯计分模块（唯一计分入口） |
| `research/ser/tests/test_ser_metrics.py` | 新增，14 用例 |
| `research/ser/recompute_ravdess.py` | 新增，离线重算脚本 |
| `research/ser/ser_ravdess_baseline.py` | 修改：计分切换到 ser_metrics；失败样本进 records；落盘 v2 + 逐样本 JSONL |
| `research/ser/output/baseline_ravdess/recomputed_20260920_212308/` | 新增：`metrics_emotion2vec_plus_large_v2.json`、`confusion_..._v2.json`、`samples.jsonl`、`provenance.json`（含原始日志/旧 JSON SHA-256、规则版本、命令、新旧差异） |
| `docs/ser/RESEARCH_PLAN.md` | 修改：§5.1–5.4 研究表述校正 + 5.4 新旧对照表 + 勘误块 |
| `docs/ser/SPEC_SER-02.md` | 追加 §7 勘误 |
| `output/baseline_ravdess/report.md` | 追加勘误入口 |

## 边界与 NOT RUN

- 未运行真实模型重推理（规格禁止自动补证；历史日志已足够完整重建）。
- 生产脚本 `ser_ravdess_baseline.py` 的端到端重跑未执行（需 GPU 与全量数据；其计分路径与 score_run 一致，语法检查通过）。下次真实重跑将产出 v2 schema 结果。
- 本修复只影响指标计算，**不构成模型质量变化的证据**；UAR 0.9241→0.9234 是消漏计，不是模型变差。
- v2 消费影响：baseline 报告与研究计划已更新；`metrics/confusion` 文件名不变，schemaVersion 字段新增，旧消费者（读 accuracy/uar/per_class_recall）兼容；per_class_recall 缺类时值缺失并以 missing_classes 列出。

---

## R2/R4 补修证据（2026-09-21，对应复核清单 R2·P1 / R4·P2）

### 执行命令与退出码

| 命令 | cwd | 退出码 |
| --- | --- | --- |
| `.venv/Scripts/python.exe -m unittest discover -s research/ser/tests -p "test_*.py"` | `E:/Work/AI CHAT` | 0（Ran 57 tests, OK, skipped=1） |
| `python -m unittest discover -s tests -p "test_ser_baseline_run.py"`（定向，10 用例） | `E:/Work/AI CHAT/research/ser` | 0 |
| `python -m py_compile ser_ravdess_baseline.py ser_log.py tests/test_ser_baseline_run.py` | `E:/Work/AI CHAT/research/ser` | 0 |
| `recompute_ravdess.py --log output/logs/baseline_ravdess_20260920_212308.jsonl`（回归） | `E:/Work/AI CHAT/research/ser` | 0（accuracy 0.921474 / UAR 0.923363 / 漏计清单逐位一致） |

无真实模型重跑（规格禁止）：假模型 + 假 `load_16k` + 临时目录验证落盘行为。

### R2 · 生产落盘改独立 run 目录（修复 `ser_ravdess_baseline.py`）

修复方式：产物从固定的 `output/baseline_ravdess/metrics_<m>.json`（`w` 覆盖）改为每次运行写 `output/baseline_ravdess/runs/<run_id>/`，`run_id = <时间戳>_<模型名>[_maxN]`；目录内为 `metrics.json` / `confusion.json` / `samples.jsonl` / `provenance.json`（记录模型、参数、规则版本 ser-metrics/2、JSONL 日志路径、产物清单）。`make_run_dir` 对已存在目录抛 `FileExistsError` → 明确拒绝（exit 4），不静默覆盖。`--max` 调试运行自动带 `_maxN` 后缀与全量分离。

定向测试（`tests/test_ser_baseline_run.py`）：

- 连续两次生产落盘：第一次全部文件哈希不变；根目录无平面 `metrics_*.json` 产生（`test_two_runs_first_evidence_untouched`）；
- 同名冲突：预置 `r1/metrics.json="KEEP"` → exit 4、stderr 含「拒绝覆盖」、文件保持 `KEEP`（`test_collision_explicitly_refused`）；
- `--max 2`：run 目录名以 `_max2` 结尾、仅 2 条样本，与全量分离（`test_max_run_separated_from_full`）；
- 新产物可离线复算：run 目录 `samples.jsonl` 经 `score_run` 与 `metrics.json` 的 accuracy/uar/confusion/n_scored 一致（`test_new_artifacts_offline_recomputable`）；
- provenance 记录完整（`test_provenance_records_run`）。

消费者兼容说明：历史平面产物（`metrics_emotion2vec_plus_large.json` 等）与 `recomputed_20260920_212308/` 原位未动，`recompute_ravdess.py --old-metrics` 默认值继续有效；生产入口此后不再写平面文件——新消费者请读 `runs/<run_id>/`。

### R4 · 缺类指标呈现（同文件）

修复方式：`accuracy/uar` 不再 `or 0.0`；JSON 保留 null，控制台经 `format_metric()` 显示 `N/A（不可计算）`，stderr 输出 `missing_reason()`（缺类清单或「无计分样本」），合法 0 分仍显示 `0.0000`。结构化日志（JSONL params）同样传 null。

定向测试覆盖生产汇总路径四类 fixture：

| fixture | JSON | 控制台 | stderr |
| --- | --- | --- | --- |
| 缺类（仅 happy 目标，UAR 不可算） | `uar: null` | `UAR(7类) N/A（不可计算）` | 「计分类别缺失: …」 |
| 合法零分（全预测错） | `accuracy: 0.0` | `准确率 0.0000` | 无「不可计算」误报（UAR 缺类告警照常） |
| 无成功样本（模型抛错） | accuracy/uar 均 null | N/A | 「无计分样本」 |
| 正常（8 情绪齐全） | 数值 | `准确率 0.xxxx | UAR(7类) 0.xxxx` | — |

用例：`test_missing_class_uar_is_na_not_zero` / `test_legit_zero_still_shows_zero` / `test_no_success_sample_is_na` / `test_normal_run_shows_numbers` + `test_format_metric_distinguishes_none_and_zero`。

### 边界与 NOT RUN

- 未运行真实模型重推理（维持原边界）；下一次真实重跑将产出 `runs/<run_id>/` 新布局。
- 本补修不改变计分公式（ser-metrics/2 未动）与历史重算结论。
