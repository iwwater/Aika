# SER-04 验收报告 · 公共逻辑、运行环境与产物边界

> 2026-09-21审阅更新：下文保留原执行证据。R1探针失败处理与R3日志告警经定向复现FAIL，完整PASS不再作为当前收口结论；见[复核与接续清单](OPTIMIZATION_REVIEW_20260921.md)。修复后在本报告追加生产入口回归与日志失败证据。
> 2026-09-21补修：R1/R3 已修复并验证，证据见文末「R1/R3 补修证据」节；测试总量 24 → 57（新增 20，其余为 SER-03/05 范围）。
> **2026-09-21 复核收口：R1–R4 全部关闭**（复核会话定向复跑 34 项测试通过），本报告为最终收口状态；上方「不再作为收口结论」为审阅时点快照，已被本行取代。新环境安装复现维持 NOT RUN。

日期：2026-09-21。规格：[SER-04](../specs/SER-04.md)。前置：SER-03（计分实现已冻结）。
环境：Windows，`research/ser/.venv`（Python 3.11.16）。无真实模型/网络/GPU。

## 执行命令与退出码

| 命令 | cwd | 退出码 |
| --- | --- | --- |
| `-m unittest discover -s research/ser/tests -p "test_ser_common.py" -v` | `E:/Work/AI CHAT` | 0（Ran 10 tests, OK） |
| `-m unittest discover -s research/ser/tests -p "test_*.py"`（含 SER-03 回归） | `E:/Work/AI CHAT` | 0（Ran 24 tests, OK） |
| `-m py_compile`（全部迁移后 .py） | `E:/Work/AI CHAT` | 0 |
| `recompute_ravdess.py --log .../baseline_ravdess_20260920_212308.jsonl`（迁移后回归） | `E:/Work/AI CHAT` | 0（指标与迁移前逐位一致） |
| `git check-ignore -v`（6 忽略目标 + 7 追踪目标） | `E:/Work/AI CHAT` | 见 AC-F |

## 逐 AC 结论

### AC-A · PASS

- `build_demo_samples()`：真实 demo data.json 为 fixture → 18 段、kind 顺序 ref×6→合成A×6→合成C×6、slug 顺序固定、18 条路径互异（不因去重误删不同来源）。probe 与 embedding 均消费该函数（迁移对照见下）。
- 路径全部由 `ser_common.py` 代码位置推导（`SER_ROOT/PROJECT_ROOT`），无盘符硬编码；带空格路径 join 测试通过（`test_paths_derive_from_code_location`）。
- 显式缓存环境变量优先：`test_explicit_cache_env_priority` 设置 `MODELSCOPE_CACHE` 后 setup 不覆盖；未设置的仍落 `research/ser/.cache`。

### AC-B · PASS

`parse_emotion2vec_result` 为探针/baseline/服务共用解析（归一化公式唯一来源 = `ser_metrics.normalize_label`，未复制第二套）：

- 纯英文 / 中文英文复合 / `<unk>` / unknown 同规则（`test_plain_composite_unk_same_rule`）；
- baseline 与服务对同一假响应得到相同规范标签（`test_baseline_and_server_share_rule`）；
- 异常 shape（数量不符）、空返回、非数值分数、非法标签、None 均显式 ValueError，不输出正常成功（`test_errors_not_silent`，8 种坏输入）。

### AC-C · PASS

- 18 条尝试、1 条失败 → 17 成功 / 1 失败，`attempted == success + failed`，退出判定非零（`test_18_try_1_fail`；失败立即写 stderr，含错误信息）。
- 全失败 → 0/3/3 且 report 非空（`test_all_fail`）。
- 降维样本不足（n<4）：`ensure_dimred_input` 明确 RuntimeError，embedding 脚本捕获后 exit 2，不输出伪图。门槛依据：PCA 需 n≥2、UMAP n_neighbors=min(8,n-1) 需有效邻域 → n_success≥4（已记录于 ser_common 与 RUNBOOK）。
- 成功计数不重复扣减：`ser_embedding_umap.py` 汇总改用 `batch.success`（直接取成功数），不再 `n - len(failed)` 二次扣减。

### AC-D · PASS

- 迁移后生产路径回归：24 用例全绿（含 `test_ser_metrics_regression_still_passes`：SER-03 计分不受标签规则迁移影响）；`recompute_ravdess.py` 迁移后重跑输出与迁移前逐位一致（accuracy 0.921474 / UAR 0.923363 / n_scored 1248 / 漏计清单同）。
- 无真实模型下载或推理：所有测试用假响应/fixture；`import ser_common` 不触发模型/网络（`setup_environment` 仅 DLL 目录 + env setdefault）。

### AC-E · PASS（含 NOT RUN 项）

- `requirements.txt`（17 个直接依赖+安装渠道说明）、`requirements.snapshot.txt`（115 包 pip freeze）、`docs/ser/RUNBOOK.md`（Python/torch 构建来源/DLL 前置/模型 ID 与缓存路径/revision=unknown）可对照本机环境。
- **NOT RUN**：新环境安装复现验证未执行（规格允许如实标注）；snapshot 不宣称可复建成功。

### AC-F · PASS

`git check-ignore -v` 实测：

| 应忽略 | 命中规则 |
| --- | --- |
| `research/ser/.venv/Scripts/python.exe` | .gitignore:82 |
| `research/ser/.cache/modelscope` | .gitignore:83 |
| `research/ser/data/ravdess/speech/03-01-...wav` | .gitignore:84 |
| `demo/video/raw/shots.json` | .gitignore:87 |
| `demo/video/clips/00_yasashii.mp4` | .gitignore:88 |
| `demo/video/check_final_2.png` | .gitignore:89 |

不应忽略（exit 1，零误伤）：`ser_common.py`、`requirements.txt`、`docs/ser/RUNBOOK.md`、`demo/video/make_video.py`、`demo/video/aika_voice_demo.mp4`、`recomputed_*/metrics_..._v2.json`、`embedding/..._umap_scatter.png`。既有全局 `logs` 规则继续忽略 `output/logs/`（脱敏证据摘要按规格放 `docs/ser/reports/`）。未删除/搬动任何数据。

## 消费者迁移对照（逐个手工迁移，无自动全局替换）

| 消费者 | 旧 | 新 | 输入/输出对照 |
| --- | --- | --- | --- |
| `ser_log.py` | 内联 DLL 补丁；LOG_DIR 硬编码 | 调 `ser_common.setup_environment()`（ImportError 时回退内联补丁）；LOG_DIR 由模块位置推导 | 行为不变：import ser_log 即完成环境初始化；日志仍落 `research/ser/output/logs/` |
| `ser_emotion2vec_probe.py` | 本地 env 块 + DEMO/DATA 硬编码 + 本地 build_samples + 本地标签解析 | ser_common 全套 | **输出 JSON 路径不变**；既有字段 `pred_labels/pred_scores` 保留原始值（`ser_compare_base_large.py` 兼容）；新增 `pred_top/pred_top_score`（归一化 top1）；解析失败记 `parse_err` 不冒充结果 |
| `ser_embedding_umap.py` | 同上 + 手写循环（failed 扣减） | ser_common 样本/路径 + `run_batch` + `ensure_dimred_input` | 输出 npz/coords/png 路径与格式不变；汇总 `attempted=success+failed`（旧：`n-len(failed)` 二次扣减已修）；失败带完整堆栈落 JSONL；不足门槛 exit 2 |
| `ser_ravdess_baseline.py` | 本地 env/路径 + 本地 parse_pred | ser_common（parse_pred 包装 `parse_emotion2vec_result`）+ ser_metrics 计分（SER-03） | 落盘路径不变；v2 schema 不变 |
| `ser_server.py` | 硬编码 SER_DIR/DEMO_AUDIO_DIR/FRONTEND_DIR + 本地 `_norm` | ser_common 推导 + `parse_emotion2vec_result` | HTTP 接口/字段/路由语义不变；目录布局不变 |
| `ser_download_ravdess.py` | 硬编码 DATA_DIR | `ser_common.RAVDESS_DATA_DIR` | 下载目标路径不变 |
| `ser_compare_base_large.py` | 硬编码 OUT + 本地 top_pred 归一化 | `ser_common.OUTPUT_DIR` + `parse_emotion2vec_result` | 消费 probe JSON 字段不变；top 排序逻辑等价（`<unk>` 现归一化 unknown 显示） |
| `ser_probe_features.py` | 硬编码 DEMO_DIR/OUT_DIR | ser_common 推导 + setup_environment | 输出路径不变 |
| `env_probe.py` | 一次性环境探查脚本（2026-09-20 临时工具），不消费实验配置 | **未迁移**（不在规格范围） | — |

## 接口影响

- 公共 Python 工具为内部实现；服务字段与现有 CLI 保持兼容（`--model`/`--max`/`--port` 不变）。
- probe JSON 新增 `pred_top/pred_top_score` 字段（追加，不破坏既有消费者）。
- 入口已登记：本报告 + RUNBOOK §4；`VOICE_RESEARCH_OPTIMIZATION.md` 状态更新。

## 未运行项

- 真实模型推理 / demo 服务起服 / 浏览器 UI（属 SER-05 范围）。
- 新环境安装复现（AC-E 标 NOT RUN）。
- 未执行 git add/rm（规格禁止）。

---

## R1/R3 补修证据（2026-09-21，对应复核清单 R1·P1 / R3·P2）

### 执行命令与退出码

| 命令 | cwd | 退出码 |
| --- | --- | --- |
| `.venv/Scripts/python.exe -m unittest discover -s research/ser/tests -p "test_*.py"` | `E:/Work/AI CHAT` | 0（Ran 57 tests, OK, skipped=1） |
| `python -m unittest discover -s tests -p "test_ser_probe.py"` / `"test_ser_log.py"`（定向） | `E:/Work/AI CHAT/research/ser` | 0（6 / 4 tests, OK） |
| `python -m py_compile ser_emotion2vec_probe.py ser_ravdess_baseline.py ser_log.py tests/test_ser_{probe,log,baseline_run}.py` | `E:/Work/AI CHAT/research/ser` | 0（COMPILE_OK） |
| `recompute_ravdess.py --log output/logs/baseline_ravdess_20260920_212308.jsonl`（回归） | `E:/Work/AI CHAT/research/ser` | 0（accuracy 0.921474 / UAR 0.923363 逐位一致） |

无真实模型/网络/GPU；假模型 + 临时目录。

### R1 · 探针失败隔离（修复 `ser_emotion2vec_probe.py`）

修复方式：主循环改为逐样本 `predict_one`（文件存在性 → 推理 → 解析全部在单样本作用域内），经生产批处理入口 `ser_common.run_batch` 执行；失败行按原顺序插回输出，`pred_*` 全 None + `error` 字段；有失败 `sys.exit(1)`。复核清单的三个复现场景对应的回归（`tests/test_ser_probe.py`，直接调用生产 `main()`，非只测 `run_batch`）：

| 复核清单复现场景 | 修复后行为 | 回归用例 |
| --- | --- | --- |
| 首条 `scores=[]` → `UnboundLocalError`，批次中断 | 记失败行（error 含「数量不符」），后续照常，exit 1 | `test_first_bad_parse_then_good_isolated` |
| 前条成功 happy/0.9，后条坏 → 后条携带前条预测 | 后条 `pred_top/pred_top_score` 为 None | `test_no_carry_over_from_previous_success` |
| 样本缺失 → 空列表 + 退出码 0 | 缺失样本记失败行（「音频缺失」）入输出，不调用模型，exit 1 | `test_missing_audio_is_failed_not_skipped` |

关闭条件核对：18 尝试/1 失败 = 17 成功/1 失败（`test_18_try_1_fail_semantics`）；模型抛错继续（`test_model_exception_continues`）；全成功 exit 0 且字段/顺序兼容、原始 `pred_labels/pred_scores` 保留（`test_all_success_exit0_field_and_order_compat`，`ser_compare_base_large.py` 兼容）。**AC-B/C/D 证据更新**：AC-B 标签规则不变；AC-C 失败语义延伸到探针入口；AC-D 迁移后回归含新用例。

### R3 · 日志写失败告警（修复 `ser_log.py`）

修复方式：`JsonlHandler.emit()` 的 `except Exception: pass` 改为向 stderr 输出最小告警（含 path repr、reason repr、原事件文本），stderr 不可用时才静默；不递归调用坏 handler、不外抛。定向测试（`tests/test_ser_log.py`，内存/临时文件）：

- 正常写入保持 JSONL 格式（`test_normal_write_jsonl_format`）；
- 打开失败（目录作 path，PermissionError）：无外抛、stderr 含告警 + path + 原事件（`test_open_failure_warns_stderr_no_raise`）；
- 写入失败（patch `json.dumps` 抛 RuntimeError）：同上（`test_write_failure_warns_stderr_no_raise`）;
- 连续 3 次失败不拖垮实验、console 通道不受影响（`test_experiment_not_killed_by_log_failure`）。

### 接口影响与边界

- 探针输出 JSON 路径不变；成功行字段为原字段超集（新增 `status`；失败行新增 `error`）。
- baseline 消费者注意：探针失败行 `pred_labels/pred_scores/pred_top*` 为 null——消费方如做数值统计需跳过 `status != "success"`（现仓库消费者 `ser_compare_base_large.py` 仅在无失败运行下使用，字段语义不变）。
- 未运行项不变：真实模型推理、新环境安装复现（NOT RUN）。
