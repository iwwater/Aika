# SER-03 · 计分修复与研究证据校正

状态：READY，未执行。日期：2026-09-21。
需求：[PRD](../PRD.md)；前序实验：[SER-02](../SPEC_SER-02.md)。共享边界：[CONTRACTS](../../modules/CONTRACTS.md)。

## 问题与目标

`ser_ravdess_baseline.py` 仅将预测落在七个计分类中的样本写进混淆矩阵，再用矩阵行和作为 recall 分母，导致 `other` / `<unk>` 错误预测消失。现有产物 n_scored=1248，矩阵总数=1247；2026-09-20 日志中 `03-01-07-01-02-02-07.wav` 的 disgust 被预测为 `<unk>`。

目标：修复生产计分函数，用已有逐样本证据重算，区分模型观察与未经验证的研究推断。审阅时推算 UAR 约 0.923363（原 0.9241），accuracy 约 0.9215；这些数值是复核线索，禁止硬编码为测试输出或为了吻合它修改样本。

## 文件范围

- 修改 `research/ser/ser_ravdess_baseline.py`；新增纯计分模块 `research/ser/ser_metrics.py`、`research/ser/tests/test_ser_metrics.py`、必要的离线证据重算脚本。
- 修订 `docs/ser/RESEARCH_PLAN.md` 中对应结论；在 `SPEC_SER-02.md` 添加勘误说明，保留原始执行历史。
- 对 `research/ser/output/baseline_ravdess/report.md` 仅追加勘误入口；原 metrics/confusion/log 不覆写。重算产物置于该目录的 `recomputed_<run-id>/`，新报告同目录；验收报告在 `docs/ser/reports/SER-03_ACCEPTANCE.md`。
- 不改模型、推理参数、数据集、训练流程、SER 服务或 TTS 代码。

## 计分定义

1. 计分真实标签固定为 neutral/happy/sad/angry/fearful/disgusted/surprised；calm 按既有约定剔除，不因预测内容剔除样本。
2. `recall(c) = target=c 且 pred=c 的数量 / target=c 的全部成功推理样本数`。预测为 other/unknown 仍进入该类分母，记为错误。
3. accuracy 分母为全部成功推理的非 calm 样本。UAR 为七类 recall 的算术平均；任一应计分类没有样本时，整体 UAR 为 null、明确列出缺失类，不悄悄改成六类平均。
4. 归一化中文/英文复合标签，`<unk>` 与 `unknown` 统一为 unknown；已知 other 保留。非法标签或不合法记录显式报错，不能丢弃后仍报完整成功。
5. 混淆矩阵按七个真实类 × 九个预测类保存；矩阵总数必须等于 n_scored。分别记录 n_attempted、n_success、n_failed、n_excluded、n_scored，满足 attempted=success+failed、success=excluded+scored。

## 证据与兼容

- 新结果标记 `schemaVersion: 2`，保留 accuracy/uar/per_class_recall 的名称；新增计数字段和样本记录。旧 n_total 若保留，只能继续表示成功数量，并明确旧语义。
- 保存逐样本 file/target/pred/excluded；真实新推理时保存 scores。历史日志重建只能恢复实际存在的字段，缺 scores 留空并说明，禁止补造。
- 选择单次完整运行的日志，核对模型、1440 个唯一文件、失败记录和输入清单；不可混合多次运行或用最终矩阵倒造预测。已有日志不足以重建完整批次时，历史重算 AC 标 BLOCKED，修复与 fixture AC 可独立交付；不自动启动真实模型补证。
- 重算目录记录原始日志与原 JSON 的相对路径、SHA-256、模型标识、规则版本和命令。旧产物原样保留，新旧差异逐项说明。
- 消费者为 baseline 报告、研究计划和本地结果阅读脚本。执行时搜索消费者，更新受影响读取逻辑；本 SPEC 不改变 HTTP 或主工程契约。

## 研究表述校正

- 将“8 类计分”更正为剔除 calm 后七类；不同数据集、类别和评测协议的分数不直接用来排名或证明模型更强。
- 英文 large 与日语 base 不称为同模型对照；base/large 同时改变容量和训练数据，不能归因于单一变量。
- 标签一致不能证明 embedding 不可分；UMAP 坐标范围和单次二维布局不能证明原空间距离、跨语言普适或训练数据偏置的因果来源。
- 音频模型不接收转写文本不等于不利用波形中的语义信息；当前实验不能冒充已隔离全部词义。
- 保留原数值与探索性观察，分别标注“观察 / 假设 / 未验证”，不得用更换措辞掩盖反例。新文献结论不在本任务范围。

## 验收条件

| AC | 可核对的证据 |
| --- | --- |
| A | 生产计分函数对同类两条样本（一条正确、一条 unknown 或 other）计算 recall=0.5；两种未知来源均覆盖，accuracy 同样记错 |
| B | fixture 覆盖 calm 剔除、中文复合标签、缺失类、推理失败与重复文件；计数守恒，重复或非法记录不能静默计分 |
| C | 单次历史运行完整重建后，1440 attempted、1248 scored、矩阵总数1248；列出漏计文件，给出新旧指标与计算过程；数据不足则如实 BLOCKED |
| D | 原始产物哈希不变；v2 新结果与逐样本证据可离线再次计算出相同指标，不能只测试预先写死的常数 |
| E | 研究计划及历史 SPEC 的勘误可追溯，上述六类过度推断均有处理；人工复核文字与数据相符 |

## 验证与交付

cwd=`E:/Work/AI CHAT`。拟用 `research/ser/.venv/Scripts/python.exe -m unittest discover -s research/ser/tests -p test_ser_metrics.py -v`；另运行新增离线重算命令，报告记录实际参数与退出码。无需 GPU、真实服务、网络或全仓测试。

报告逐 AC 区分 PASS/FAIL/BLOCKED/NOT RUN，说明 v2 消费影响。不要因修复计算便宣称模型质量提升。
