# P0 重训执行手册 · aika_jp_v2

> 对应 [PLAN_AIKA_LOCAL_VOICE](PLAN_AIKA_LOCAL_VOICE.md) P0 / 开发计划 M1。2026-09-17 勘定现状后落地。
> 口述叙事目标：完整呈现「发现过拟合 → 定位原因 → **先建立测量方法并测基线** → 修复 → 量化验证」闭环。

## 现状体检（2026-09-17 实测）

- v1 素材：39 段，**总时长仅 2.9 分钟**（`output/asr_opt/slicer_opt.list`，全部来自单个 `audio [vocals].mp3` 人声分离产物），采样率 32000（切片器已统一）
- VOICE_WORKSHOP 自己的标准是 GPT-SoVITS 路线 10~30 分钟 → **数据量缺口是主因**，warmup 是次因
- 复核表：`output/review_v1.md`（39 条中 7 条可疑：4 条省略号堆叠疑似幻听转写、2 条低能量占比 >60%、1 条过短）
- 训练配置问题已实锤：`GPT_SoVITS/configs/s1longer-v2.yaml` 模板 `warmup_steps: 2000`，而 39 段 × 15 epoch ≈ 600 步 << 2000，**lr 从未离开 warmup 区**（webui 每次开训从该模板重生成 `tmp_s1.yaml`，改 tmp 文件会被打回）

## 已完成（2026-09-17）

1. **warmup 模板补丁**：`s1longer-v2.yaml` warmup_steps 2000→150（按总步数 ~1/4），带注释说明。对 v2/v2Pro/v2ProPlus 的 webui 训练全局生效。
2. **素材复核工具** `GPT-SoVITS/review_list.py`（纯标准库）：按 2~12s 时长、文本过短/重复/乱码、**语速相对中位数离群 >2.2 倍**、**低能量占比 >60%** 标记可疑，输出含「优先听音清单」的 markdown 复核表。
   ```
   python review_list.py <list文件> [--report 输出.md] [--low 2.2] [--high 2.2]
   ```
3. **生成音频量化工具** `GPT-SoVITS/repeat_metrics.py`（纯标准库 + 可选 numpy）：算时长膨胀指数、尾部低能量、低能量占比；给 `--asr 转写文件` 时另算词级重复率与最长重复子串。
   ```
   python repeat_metrics.py output/demo_aika/manifest.txt --report output/runaway_report.md [--asr asr.tsv] [--baseline C]
   ```
4. **v1 基线已测**：`output/runaway_baseline_v1.md`（见下「基线发现」）。

## 基线发现（v1，先测后改的直接产物）

| 发现 | 数字 | 含义 |
| --- | --- | --- |
| 时长膨胀指数 ≈ 1.0 | A 组 0.96 / B 组 1.00（基线 C = 纯底模 zero-shot） | **v1 的重复不是「时长爆炸」型**，runaway 守门抓不到它；词级重复必须靠 ASR 转写精确量化（工具已备好 `--asr`） |
| 尾部低能量段 0.5~0.7s，**三个组合共有**（含底模） | A 0.61s / B 0.45s / C 0.46s | 不是过拟合特征，是推理通病。**接实时链路时会直接吃掉「句间 <0.5s」的延迟预算**，TTS-06/07 要用 `fragment_interval` + 尾部修剪处理 |
| 平均低能量占比 43~46% | 三组合一致 | 耳语 ASMR 素材的固有属性；切片后做首尾静音修剪能提高有效语音时长 |

> 方法论意义：先有测量工具和基线，才有「变好了」的可验证说法。口述里这一段是加分项——避免「凭感觉说改善了」。

## 待执行（分工）

| 步骤 | 谁 | 内容 |
| --- | --- | --- |
| 1. 新素材 | 用户 | 提供更多授权 ASMR 原始音频（目标：人声分离后有效语音 ≥10 分钟） |
| 2. 预处理 | 用户 | webui 走 v1 同款流程：UVR5 人声分离 → 切片(2~12s) → Fun-ASR，输出新 .list |
| 3. 复核 | 机器 | `python review_list.py <新list> --report output/review_v2.md` |
| 4. 校对 | 用户 | 按「优先听音清单」人工听音：ASR 成功=保留，耳语/呼吸/失败=丢弃；错误转写修正 |
| 5. 重训 | 用户 | webui 开训 `aika_jp_v2`：GPT 15 epoch（warmup 已修），SoVITS 8 epoch 不动；验证指标 ~90% 早停，不追 100% |
| 6. 对比包 | 机器 | `make_demo.py` 的 COMBOS 改指 v2 权重（exp 名改 v2），生成 v1/v2 同台词对比包 |
| 7. 量化验证 | 机器+用户 | `verify_demo.py` 爆音检查 + `repeat_metrics.py` v1/v2 对比表 + ASR 词级重复率 + 人工听音 |
| 8. 结论归档 | 机器 | 追加 `P0_RETRAIN_RESULTS.md`：训练曲线、v1/v2 数字对照、听音结论 |

## 环境说明（避免踩坑）

- 训练/webui 走 conda 环境 **`GPTSoVits`**（见 `start_webui.bat`）；系统 python 3.13 里有 numpy 2.3.5，**没有 torch、没有 scipy**。
- `review_list.py` / `repeat_metrics.py` 只用标准库（numpy 仅可选），**任何 python 都能跑**，不占用 conda 环境。`make_demo.py` / `verify_demo.py` 必须在 conda 环境跑。
- GPU 独占：训练与推理侧工具不能同时跑（8GB 显存约束）。

## 验收标准（P0 完成）

- v2 素材 ≥10 分钟有效语音，复核表可疑条目全部人工裁决
- 同台词对比：**给出数字**——词级重复率（ASR 计）、时长膨胀指数、尾部静音（`repeat_metrics.py` 输出）
- 听音：v2 无词级重复；情绪参考音频（先 3 情绪）备料同步完成
- 证据归档：`P0_RETRAIN_RESULTS.md` 登记训练曲线截图、v1/v2 数字对照与对比结论
