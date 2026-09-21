# 交付范围与建议提交批次（2026-09-22）

用途：把当前三个工作区的改动拆成**可独立审阅**的批次，附文件清单、所属任务、验证证据与明确排除项。
依据：[2026-09-22 开发任务](DAILY_TASKS_2026-09-22.md) 任务 3。

**本文件只给建议清单；未执行 `git add`、未提交、未推送。**

## 工作区总览

| 工作区 | 版本控制 | 当前状态 |
| --- | --- | --- |
| `E:\Work\AI CHAT`（Aika 主仓） | git | 12 项已跟踪改动 + **126** 项未跟踪（已排除 `.pyc` 等） |
| `E:\Work\Chat_model\GPT-SoVITS` | git | 8 项已跟踪改动（上游文件补丁）+ 27 项未跟踪（服务/工具/临时） |
| `E:\Work\toolchains` | **非 git 仓库** | 文件级交付（启动脚本 ×2），以校验和为证据 |

`.gitignore` 本轮补了一条精确规则：`research/ser/**/__pycache__/`（第 92 行）。
补前 15 个 `.pyc` 会进入候选，补后 `git check-ignore` 命中、候选数 141 → 126。

## 批次 1 · Aika 仓库 · 规范与索引文档（建议优先，无代码风险）

所属任务：语音侧本轮全部 SPEC 的规范、验收与台账（SER-03～05、TTS-06/08、STT-05～08）。

| 类别 | 文件 |
| --- | --- |
| 工程规范 | `AGENTS.md`、`.gitignore`、`docs/modules/CONTRACTS.md`、`docs/HANDOFF_MVP_0.5.md` |
| 模块索引/台账 | `docs/DEV_TASKS_VOICE.md`、`docs/VOICE_RESEARCH_OPTIMIZATION.md`、`docs/DAILY_TASKS_2026-09-22.md`、`docs/stt/SPEC.md`、`docs/tts/SPEC.md` |
| SER 文档 | `docs/ser/**`（PRD、RESEARCH_PLAN、RUNBOOK、SPEC_SER-01/02、specs/、reports/ 含复核清单与 SER-03/04/05 验收） |
| STT 文档 | `docs/stt/specs/STT-05～08.md`、`docs/stt/reports/STT-05～08_ACCEPTANCE.md`、`docs/stt/reports/evidence/**`、`docs/stt/further/WHISPER_CUDA_JIT_NOTES.md` |
| TTS 文档 | `docs/tts/specs/TTS-06～08.md`、`docs/tts/reports/TTS-06/TTS-08_ACCEPTANCE.md`、`docs/tts/reports/evidence/tts08/**`、`docs/tts/DEMO_GATEWAY_RUNBOOK.md`、`docs/tts/further/**`、`docs/tts/audio [vocals].mp3` |
| 其他证据 | `docs/integration/reports/evidence/HANDOFF_20260917_host_observation.jsonl`、`docs/runtime/**`（RT-05） |

验证证据：`git diff --check` 退出 0（仅 LF/CRLF 提示，无空白错误）；各报告内记录命令与退出码。

## 批次 2 · Aika 仓库 · SER 实现、测试与环境清单

所属任务：SER-03（计分修复）、SER-04（公共逻辑/环境边界）、SER-05（服务边界与页面安全）。

| 文件 | 性质 |
| --- | --- |
| `research/ser/ser_metrics.py`、`recompute_ravdess.py`、`ser_common.py`、`ser_log.py` | 新增/修改：唯一计分入口、离线重算、共享样本/标签/路径、日志告警 |
| `research/ser/ser_ravdess_baseline.py`、`ser_emotion2vec_probe.py`、`ser_embedding_umap.py`、`ser_server.py`、`ser_download_ravdess.py`、`ser_compare_base_large.py`、`ser_probe_features.py` | 修改：迁到共享入口 + R1/R2/R4 修复 |
| `research/ser/tests/**`（6 个测试文件） | 新增：57 例（含 SER-03/04/05 回归） |
| `research/ser/ser_server_browser_check.py` | 新增：SER-05 浏览器验证（11/11） |
| `research/ser/requirements.txt`、`requirements.snapshot.txt` | 新增：直接依赖 + 快照 |
| `research/ser/output/**`（baseline v2 产物、recomputed_*、embedding png、probe json） | 新增：实验证据（小体积 JSON/PNG；RAVDESS 音频与缓存已被忽略） |

## 批次 3 · Aika 仓库 · Demo 产物

所属任务：教授演示（`demo/aika-emotion-demo`）、SER 演示页（`demo/ser-demo`）、演示视频。

| 文件 | 说明 |
| --- | --- |
| `demo/aika-emotion-demo/**`（`index.html`、`audio/**` 18 段、`build.py`、`validate.py`） | 单页离线演示，含真人/合成 A/C 三组 |
| `demo/aika-emotion-demo.zip`（3.6 MB） | 同上的上传用打包（派生件，可选项） |
| `demo/ser-demo/index.html` | SER 演示前端（SER-05 转义修复） |
| `demo/video/make_video.py`、`demo/video/aika_voice_demo.mp4`（3.0 MB） | 演示视频成片与生成脚本（中间帧 `raw/`、`clips/` 已忽略） |

说明：`demo/ser-demo` 与 `demo/video` 若属同一演示交付，可合并成一个批次；`.zip` 为派生文件，建议按需保留而非必提。

## 批次 4 · Aika 仓库 · 主工程本地任务改动（**不并入语音批次**）

`aika-crossplatform/src/App.tsx`、`src/app/plugins/index.ts`、`src/services/runtime/persistentScheduler{,.test}.ts`
（已跟踪修改）+ `src/app/plugins/localTasksPlugin.ts`、`src/components/LocalTasksPanel.tsx`、
`src/services/runtime/localTasks{,.test}.ts`（新增）。

这批属**主工程的本地任务功能**，非语音模块产出（合作者重构期间语音侧按约定不触碰前端）。
建议交由该功能的负责人单独审阅提交；语音批次（1～3）不得包含它。

## 批次 5 · GPT-SoVITS 仓库 · 语音侧服务与工具（新增为主）

| 文件 | 性质 |
| --- | --- |
| `aika_tts_server.py`、`aika_voice.json`、`tests/` | TTS-06 sidecar 服务、生产配置模板、16+1 例 fake 测试 |
| `tools/tts_probe/`（31 项） | 探针、守门、网关与拆分模块、听音包工具、浏览器检查 |
| `tools/stt_probe/`（11 项） | Whisper 语言/服务取证、STT-05 分析、STT-08 显存共存探针 |
| `aika_patch_torchaudio.py` | torchaudio 解码补丁（不改上游源码） |
| `prosody_metrics.py`、`repeat_metrics.py`、`review_list.py`、`demo_emotion_probe.py` | 韵律量化、runaway 度量、素材体检、情绪探针 |
| `make_demo.py`、`verify_demo.py`、`setup_gsv.py`、`start_webui.bat`、`voice_playground.html`、`aika_voice_fp32.json`、`aika_voice_lowtemp.json` | 演示构建/校验、环境脚本、参数对照配置 |

注意：`tools/**/__pycache__/` 与任何产物日志不应进入本批次。

## 批次 6 · GPT-SoVITS 仓库 · 上游文件补丁（**需单独审阅**）

`git diff --stat`：8 个文件、+26/−24 行——改动虽小但触及上游训练/推理路径，必须单独列出理由：

```
GPT_SoVITS/AR/data/bucket_sampler.py   |  5 +++--
GPT_SoVITS/AR/data/data_module.py      | 10 +++++-----
GPT_SoVITS/TTS_infer_pack/TTS.py       |  3 ++-
GPT_SoVITS/configs/s1longer-v2.yaml    |  2 +-     ← warmup 2000 → 150（小数据集 lr 一直停在 warmup 区会过拟合式重复）
GPT_SoVITS/configs/tts_infer.yaml      |  6 +++---
GPT_SoVITS/inference_webui.py          |  4 +++-
GPT_SoVITS/s1_train.py                 |  6 ++++--
GPT_SoVITS/s2_train.py                 | 14 +++++---------
```

另有 `GPT_SoVITS/text/ja_userdic/user.dict`、`userdict.md5`（日语用户词典，属生成/下载物，需确认是否随仓库分发）。

建议：本批次单独立一次提交，提交信息写明补丁目的与影响面；不要与批次 5 的新增文件混在一起。

## 明确排除项（任何批次都不要加）

| 文件/目录 | 原因 |
| --- | --- |
| `GPT-SoVITS/1789553489.9300582.pth`（**951 MB**） | 训练中间检查点，仓库根目录散落物 |
| `GPT-SoVITS/tmp_s1.yaml`、`tmp_s2.json` | webui 每次开训重新生成的临时配置 |
| `research/ser/**/__pycache__/`、`GPT-SoVITS/tools/**/__pycache__/` | Python 字节码（本轮已加忽略规则） |
| `research/ser/.venv/`、`.cache/`、`data/ravdess/speech/` | 本地环境与下载数据（SER-04 已忽略） |
| `demo/video/raw/`、`demo/video/clips/`、`demo/video/check_*.png` | 视频中间帧与校验帧（已忽略） |
| `*/output/logs/**`、`server.stdout.log`、`stt08.server.log`、`tts08.sidecar.log` | 运行日志（全局 `logs` 规则已覆盖前者；toolchains 侧日志不进版本控制） |
| `aika-crossplatform/tmp/whisperLocal.*.test.ts` | `tmp/` 被 `.gitignore:3` 忽略，属本地 harness |

## toolchains（非 git 仓库）交付形式

| 文件 | 状态 | 校验和（sha256 前 16） |
| --- | --- | --- |
| `whisper-b5130\Start-Whisper.ps1` | 重写（CUDA + turbo） | 内容见 [JIT 说明](stt/further/WHISPER_CUDA_JIT_NOTES.md)（1910 字节） |
| `whisper-b5130\Start-Whisper.cpu.ps1` | 新增（回退用，原样保留） | 1299 字节 |
| `whisper-b5130-cuda\runtime\Release\whisper-server.exe` | 未改 | `4e6905841f62d7f2` |
| `whisper-b5130\models\ggml-base.bin` | 未改 | `60ed5bc3dd14eea8` |
| `whisper-b5130\models\ggml-large-v3-turbo-q5_0.bin` | 未改 | `394221709cd5ad1f` |

该目录不在版本控制内，交付形式为「脚本 + 上述校验和 + STT-08 报告」；
如需纳入版本控制，建议单独建仓库或复制到 `docs/stt/further/` 作为文档附件（本文件未执行该复制）。

## 提交前检查清单

- [ ] 每个批次单独 `git add <明确路径>`，**不使用 `git add .`**
- [ ] 批次 4（主工程本地任务）交由对应负责人，不混入语音批次
- [ ] 批次 6（上游补丁）提交信息写明补丁目的
- [ ] 提交前确认无密钥、无私人语料、无模型权重进入暂存区
- [ ] 跨仓库改动分别提交，不写成「单仓库已交付」
