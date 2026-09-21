# 四份优化 SPEC 复核与接续清单

日期：2026-09-21。范围：SER-03、SER-04、SER-05、TTS-08。执行入口：[VOICE_RESEARCH_OPTIMIZATION](../../VOICE_RESEARCH_OPTIMIZATION.md)。

## 交接结论

四份 SPEC 均已有生产实现和执行者验收报告。首次复核发现的 SER-03/04 缺口 R1–R4 已由执行者补修；本次复核确认补修实现和定向测试通过，四份代码优化 SPEC 收口。条件验收项继续保持 NOT RUN，不随代码收口自动升级。

> 复核关闭（2026-09-21）：R1/R3 定向测试 10 项、R2/R4 定向测试 10 项、SER-03 计分回归 14 项，合计 **34 项通过**；相关 Python 文件 `py_compile` 通过，文档/代码 `git diff --check` 通过。测试均使用 fake、fixture 和临时目录，无真实模型、网络或 GPU。`test_ser_baseline_run.py` 有测试文件未关闭句柄导致的 `ResourceWarning`，不影响断言与生产代码；列为低优先级测试卫生项。

本次只做源码审阅、既有证据核对和离线定向复现。未修改业务代码，未启动真实模型、读取凭证、重启服务或重复运行全套测试。本文记录的是审阅结论，不替代原执行报告；原报告的历史测试结果保留，发现的问题由执行者修复后追加证据。

| SPEC | 已确认的工作 | 当前状态 |
| --- | --- | --- |
| [SER-03](../specs/SER-03.md) | 计分模块、unknown漏计修复、历史日志重算及v2产物；R2/R4补修 | **REVIEWED_PASS**；真实模型重推理不需要，原NOT RUN边界保留 |
| [SER-04](../specs/SER-04.md) | 公共样本/标签/路径、环境清单、Git忽略；R1/R3补修 | **REVIEWED_PASS**；新环境复建仍NOT RUN |
| [SER-05](../specs/SER-05.md) | 路径校验、动态文本转义、推理线程处理已实现；报告记37测试含1 skip、浏览器11/11 | 本次未发现新增阻断；符号链接越界 **NOT RUN** |
| [TTS-08](../../tts/specs/TTS-08.md) | 网关已拆成入口/STT/会话/留存/页面；报告记54测试、浏览器9/9 | 本次未发现新增阻断；真实启动与真人设备 **NOT RUN** |

以上测试数量来自执行者报告，本次没有重跑，不表述为本轮测试结果。

## 已关闭的复核项

### R1 · CLOSED · 探针失败可能复制上一条预测（SER-04）

位置：`research/ser/ser_emotion2vec_probe.py`，审阅时第35–60行。

`parse_emotion2vec_result()` 在初始化 `top_label/top_score` 前调用；解析抛错后仍使用这两个变量构造结果。推理调用位于逐样本异常处理之外，缺失文件也只打印后跳过。

**离线复现已确认（FAIL）**：用假 `funasr.AutoModel` 替换模型，样本读取使用固定fixture，直接调用生产 `main()`；文件读取/输出在内存替换，不读取实际音频、不写实验产物。

| 输入序列 | 实际观察 |
| --- | --- |
| 首条 `labels=['happy'], scores=[]` | `UnboundLocalError: top_label`，批次中断 |
| 首条 `labels=['happy'], scores=[0.9]`，第二条 `labels=['happy'], scores=[]` | 第二条 `pred_labels/pred_scores=null`，却保存 `pred_top='happy', pred_top_score=0.9`，入口正常返回 |
| 样本音频不存在 | 输出空列表，入口正常返回，未给非零失败退出码 |

正常返回表示脚本未调用失败退出，不是验收PASS。复现使用 `C:/Users/BAi/AppData/Local/Programs/Python/Python311/python.exe -B -` 的内存脚本，无新增测试文件；该复现需在修复时转成永久回归用例。

**修复范围**：逐条隔离预测变量；将缺文件、推理异常、解析异常纳入一致的失败记录与继续处理逻辑；失败样本不得携带前条预测。复用已有生产批处理工具或同等最小实现，勿再复制一套计数规则。

**关闭证据**：`test_ser_probe.py` 6项通过，覆盖首条解析失败、前条成功后失败、模型异常、缺失文件、18次尝试1失败和全成功兼容；生产入口有失败时退出1，失败行预测字段为null。

原关闭条件：

- 测试实际 `main()` 或它直接调用的生产批处理入口，不能只测 `run_batch(lambda)`。
- 第一条坏、后一条坏、模型抛错、音频缺失四种情况均记录失败；后续正常样本照常处理。
- 18次尝试、1次失败为17成功/1失败；有失败则入口非零退出；输出不包含伪有效预测。
- 固定fixture证明成功样本字段和顺序兼容；更新 SER-04 AC-B/C/D 证据。

### R2 · CLOSED · 生产重跑仍会覆盖历史证据（SER-03）

位置：`research/ser/ser_ravdess_baseline.py`，审阅时第173–184行。

离线重算已写入独立的 `recomputed_20260920_212308/`；但生产推理入口仍用固定 `metrics_<model>.json`、`confusion_<model>.json`、`samples_<model>.jsonl` 并以 `w` 打开。下一次运行，包括 `--max` 调试运行，可能覆盖原产物以及 provenance 引用的旧指标文件。

**证据级别**：源码确认的覆盖路径；本次未实际运行写盘，未毁损已有证据。属于 SER-03 的证据保留/可追溯要求未覆盖生产入口。

**修复范围**：生产每次运行使用独立run目录；记录模型、参数、规则版本、样本与产物位置；同名运行冲突明确拒绝或生成新标识，不静默覆盖。若保留“最新结果”入口，应与不可变历史证据分离并说明消费者兼容方式。

**关闭证据**：`test_ser_baseline_run.py` 覆盖连续运行、显式拒绝run id冲突、`--max`隔离、新产物离线复算与provenance；10项通过。生产改为 `runs/<run_id>/`，历史平面产物未改。

### R3 · CLOSED · 日志写失败没有告警（SER-04）

位置：`research/ser/ser_log.py`，审阅时第58–59行。

`JsonlHandler.emit()` 仍用 `except Exception: pass`。内存复现让文件打开抛 `PermissionError`，捕获到 stderr 为空，**FAIL**。SER-04 明确要求至少向stderr报告证据丢失。

**修复范围**：日志写失败输出最小可读告警；不得递归调用同一坏日志handler，也不让日志失败拖垮实验。保留正常JSONL格式。

**关闭证据**：`test_ser_log.py` 4项通过；正常JSONL、打开失败、写入失败、连续失败不拖垮实验均覆盖，失败向stderr输出且不递归。

### R4 · CLOSED · 缺类UAR在日志中显示成零（SER-03）

位置：`research/ser/ser_ravdess_baseline.py`，审阅时第165–166行及末尾汇总。

计分函数按规格给缺类运行 `uar=None`，但汇总使用 `metrics['uar'] or 0.0`，使控制台和日志显示0分。JSON中的null仍保留，问题在消费/呈现口径；`accuracy=None` 同样不应被当成真实0分。

**证据级别**：源码确认；本次未启动真实baseline。属于不可计算与零分混淆。

**修复范围**：JSON和结构化日志保留null；控制台显示“不可计算”或N/A及缺失类/空样本原因。合法0分继续显示0，不能把零值也当缺失。

**关闭证据**：`test_ser_baseline_run.py` 覆盖缺类、无成功样本、合法零分及正常完整计分；JSON保留null，控制台显示N/A，合法0分仍显示0.0000。

## 补修执行记录

1. SER-04已补修R1/R3，证据追加在 `SER-04_ACCEPTANCE.md`。
2. SER-03已补修R2/R4，证据追加在 `SER-03_ACCEPTANCE.md`。
3. 本次独立复跑34项定向测试并检查生产实现，R1–R4关闭。
4. 明日安排见 [2026-09-22任务](../../DAILY_TASKS_2026-09-22.md)。

补测命令由执行者按实际文件记录。当前可复用的窄回归（cwd为Aika仓库根）：

```powershell
& 'research/ser/.venv/Scripts/python.exe' -m unittest discover -s research/ser/tests -p 'test_ser_metrics.py' -v
& 'research/ser/.venv/Scripts/python.exe' -m unittest discover -s research/ser/tests -p 'test_ser_common.py' -v
```

上述两条旧接续命令保留作维护入口；本次实际执行的是 `test_ser_probe.py`、`test_ser_log.py`、`test_ser_baseline_run.py`、`test_ser_metrics.py` 四组，共34项。

## 仍未验证、但不属于上述代码补修的项目

| 项目 | 当前边界 |
| --- | --- |
| SER-04新环境安装复现 | NOT RUN；现有依赖清单不等于已证明新机器可复建 |
| SER-05符号链接越界 | NOT RUN；执行报告记本机有效链接fixture无法建立，不能用其他路径测试替代 |
| TTS-08真实CLI启动 | NOT RUN；原验收避免占用9881和读取真实DPAPI，已有fake HTTP/CLI help证据 |
| TTS-08真人麦克风/扬声器 | NOT RUN；已有受控音频浏览器检查不等于真人或听感验收 |
| TTS-06-F | 已有真实合成证据；人工听音及实际首句出声/句间播放测量仍需对照原AC，不能由HTTP耗时推算通过 |
| STT-08 | 既有索引仍为READY；本轮未取得其正式部署与显存共存完整验收报告，不据Demo使用turbo推定已完成 |
| TTS-07 / 主工程大文件拆分 | 仍遵守主工程重构冻结；等待合作者落地再复核，不在本次补修改 aika-crossplatform |

## 文档同步与本轮交付

本轮同步四SPEC的优化入口、SER/TTS索引、语音台账，并在SER-03/04原验收报告顶部链接本次复核，保留历史结果。未修改其他历史TTS验收结论；TTS-06不同文档的PASS/NOT RUN口径仍须其后续验收负责人按真实证据统一。

本次复核未修改业务代码、未删除数据、未提交或推送。R1–R4补修由此前执行者完成，本次仅确认并更新文档状态。
