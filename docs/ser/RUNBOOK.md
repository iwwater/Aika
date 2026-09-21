# SER 环境与实验运行手册（RUNBOOK）

更新：2026-09-21（SER-04）。覆盖：环境、依赖、模型、缓存、常见实验/服务启动、演示视频入口、产物可再生成性。

## 1. 运行环境

| 项 | 值 |
| --- | --- |
| Python | 3.11.16（venv：`research/ser/.venv`，**基于 GPTSoVits conda python 创建**，见 §2 DLL 前置） |
| OS / GPU | Windows x64 / RTX 5060 8GB（sm_120） |
| torch | 2.11.0+cu128（**必须 PyTorch 官方 cu128 源**；清华镜像无 cu128 wheel） |
| CUDA 运行 | torch 自带 cu128 运行时，无需系统 CUDA Toolkit |
| 安装可复现性 | **NOT RUN**——本清单来自当前环境实测快照，未在新环境验证重建。复建：`pip install -r requirements.txt`（torch 用 §上 命令），失败时对照 `requirements.snapshot.txt`（115 包全量快照） |

## 2. Windows DLL 前置（重要）

ser venv 由 GPTSoVits conda python（`D:\ANACONDA\envs\GPTSoVits`）创建，其标准库 `_lzma` 依赖 base conda 的 `D:\ANACONDA\Library\bin\liblzma.dll`。已由 `ser_common.setup_environment()`（`os.add_dll_directory`）集中处理，所有实验脚本 import ser_log/ser_common 时自动生效。若把项目迁到别的机器且 conda 路径不同，改 `ser_common._DLL_DIRS`。

## 3. 缓存与模型

- 缓存根：`research/ser/.cache/`（`MODELSCOPE_CACHE` / `HF_HOME` / `TORCH_HOME` setdefault；**显式设置的环境变量优先**）。
- 模型：
  - `iic/emotion2vec_plus_base`（~90M，finetune 4788h）— ModelScope，缓存 `research/ser/.cache/modelscope/models/iic--emotion2vec_plus_base/`
  - `iic/emotion2vec_plus_large`（~300M，42526h，主用）— 同上 `iic--emotion2vec_plus_large/`
  - 模型文件 revision：**unknown**（ModelScope 快照目录，未记录 commit id）。
- 数据：RAVDESS speech 1440 wav @ `research/ser/data/ravdess/speech/`（来源 `MahiA/RAVDESS`，可由 `ser_download_ravdess.py` 断点续传再生成）。

## 4. 常用命令（cwd 任意；`SERPY` = `research/ser/.venv/Scripts/python.exe`）

| 用途 | 命令 |
| --- | --- |
| 单元测试（24 用例） | `SERPY -m unittest discover -s research/ser/tests -p "test_*.py" -v` |
| 探针评测（18 段） | `SERPY research/ser/ser_emotion2vec_probe.py [--model iic/emotion2vec_plus_base]` |
| embedding+UMAP | `SERPY research/ser/ser_embedding_umap.py` |
| RAVDESS baseline | `SERPY research/ser/ser_ravdess_baseline.py` |
| 离线重算（无 GPU） | `SERPY research/ser/recompute_ravdess.py --log research/ser/output/logs/baseline_ravdess_20260920_212308.jsonl` |
| base vs large 对比表 | `SERPY research/ser/ser_compare_base_large.py` |
| SER demo 服务 | `SERPY research/ser/ser_server.py --port 8787` → http://127.0.0.1:8787/ |

## 5. 演示视频入口

- 成片：`demo/video/aika_voice_demo.mp4`（唯一交付产物）。
- 生成链：`demo/video/record_tts.py`（TTS 段真录屏）→ `demo/video/record_ser_v2.py`（SER 段截图序列，`raw/ser_shots/shots_v2.json`）→ `demo/video/compose.py`（贴音频转码）→ `demo/video/make_video.py`（标题卡+拼接）。
- **注意**：SER 段截图序列已剪掉推理等待，**不作为实时延迟证明**。

## 6. 产物可再生成性

| 路径 | 性质 |
| --- | --- |
| `demo/aika-emotion-demo/audio/ref/` | **唯一原始素材**（真人参考音频），不可再生成，勿删 |
| `research/ser/data/ravdess/speech/` | 可再生成（下载脚本断点续传） |
| `research/ser/output/`（实验 JSON/图/重算目录） | 可由上述命令再生成；`recomputed_*/` 依赖历史日志，日志只追加不删除 |
| `research/ser/output/logs/` | 原始执行日志，已全局 git 忽略；需要追溯的脱敏结论摘要在 `docs/ser/reports/` |
| `research/ser/.cache/` `.venv/` | 可再生成（模型/依赖），git 忽略 |
| `demo/video/raw/` `demo/video/clips/` | 录制/拼接中间产物，git 忽略；成片 mp4 与生成脚本保留 |
