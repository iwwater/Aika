# TTS-06 验收报告 · Aika 本地声线 sidecar

日期：2026-09-18（A~E）；2026-09-20（F 真机联调）；2026-09-22（F 人工听音收口）。
**最终结论：A~F 全 PASS**——F 含一条非阻断观察项「促音处电音/颤音」（12/18 段），已计入 M1/M4 验收维度，见 F 节补二。

## 改动清单（均为新增，未改上游与前端）

| 文件 | 内容 |
| --- | --- |
| `E:\Work\Chat_model\GPT-SoVITS\aika_tts_server.py` | sidecar 主体：`Engine` 协议、`SynthesisManager`（串行队列+取消+prompt cache）、`GPTSoVitsEngine`（真引擎）、FastAPI 路由 `/health` `/styles` `/synthesize`、守门逻辑 |
| `E:\Work\Chat_model\GPT-SoVITS\tests\test_aika_tts_server.py` | fake 推理测试 16 例（unittest + httpx ASGITransport，零新依赖） |
| `E:\Work\Chat_model\GPT-SoVITS\tests\__init__.py` | 包标记 |
| `E:\Work\Chat_model\GPT-SoVITS\aika_voice.json` | 生产配置模板：6 情绪参考（探针同款切片）、A 组合 v1 权重、gate 初值 |

未改动：`api_v2.py`、`TTS.py`、上游任何文件、aika-crossplatform 前端。

## 测试命令与退出码

```
cd E:\Work\Chat_model\GPT-SoVITS
D:/ANACONDA/envs/GPTSoVits/python.exe -m unittest tests.test_aika_tts_server -v
→ Ran 16 tests in ~1.7s，OK，exit code 0
```

开发过程为严格 TDD：先写测试跑出 RED（`ModuleNotFoundError: aika_tts_server`），实现后 GREEN；中途守门/超时/取消等 7 处失败逐一定向修复，最终 16/16 全绿。

## 逐 AC 证据

| AC | 结果 | 证据（测试名） |
| --- | --- | --- |
| A | PASS | `test_schema_stable_and_loading_then_ready`（health 四字段恒定、加载中 `model_loaded:false`、HTTP 不被权重加载阻塞）；`test_load_error_reported_readable`（失败报可读错误）；`test_styles_endpoint` |
| B | PASS | `test_returns_valid_wav`（RIFF/WAV 合法、时长>0）；`test_unknown_style_falls_back_to_default`（回落走 defaultStyle）；`test_unknown_style_without_default_400`；`test_empty_text_400`；`test_speed_passthrough` |
| C | PASS | `test_concurrent_requests_never_overlap_inference`（fake 记录 t_in/t_out，区间无重叠）；`test_cancel_not_started_job_triggers_no_inference`（排队中取消→`started` 仅 1 条、队列无残留）；`test_running_job_cancelled_cooperatively`（运行中取消→无产出） |
| D | PASS | `test_same_style_prompt_built_once`（同 style 二次请求 `create_voice_prompt` 仅 1 次，多 style 各 1 次）；`test_cache_invalidated_on_mtime_change`（mtime 变更后失效重建） |
| E | PASS | `test_oversized_output_retried_once_with_changed_params`（恰好 1 次重试、seed 变化、penalty 提高）；`test_retry_still_failing_returns_500_readable`（重试仍败→500 + 可读错误）；`test_synthesize_timeout_returns_500` |
| F | **PASS（2026-09-22 收口）** | 首句冷中位 **1066 ms < 1500 ms** ✅；守门 0/18 行超阈值 ✅；断开后队列无残留 ✅；ASR 回转写无词级重复（CER 中位 0.000）✅；**人工听音 ✅（18/18 段，词级重复=无）**。新增非阻断观察项：促音处电音/颤音（12/18 段），计入 M1/M4 验收维度。见文末「F 节补二」 |

fake 只替换引擎（load / create_voice_prompt / generate）；队列、缓存、路由、守门、health 状态机全部走生产代码。

## 关键实现决策（与 SPEC 的偏差，均已说明）

1. **上游接法二选一 → 选直接调 `TTS_infer_pack`（进程内）**：sidecar 本身已是独立进程（对前端隔离目标已达成），再走 api_v2.py 等于双服务双加载模型，8GB 显存不可接受；少一跳对 F 的延迟指标有利。api_v2.py 的宽参数面未暴露（`/synthesize` 仅 text/style/speed）。
2. **Engine 协议扩展**：`generate` 增加 `seed / penalty / cancel_event` 关键字参数——SPEC 协议形状无此三者，但 AC-E（重试参数可观察）与 AC-C（运行中协作取消）必须经此传递。属接口扩展非破坏，第二引擎（Qwen3-TTS）实现同一签名即可。
3. **错误响应统一 `{"error": ...}`**（FastAPI 默认是 `detail`）：sidecar 对外契约的一部分，`/synthesize` 的 400/500 与 `/health` 的 error 字段口径一致。
4. **运行中取消用上游 `TTS.stop_flag`**：cancel_event 触发后置位，上游 run() 在推理步边界自行停止——对应 SPEC「best-effort 在推理步边界停止」。
5. **尾部修剪内置真引擎**（`_trim_tail`）：v1 基线显示尾部低能量 0.5~0.7s 三组合共有，直接吃句间延迟预算，在 sidecar 层修剪。
6. **已知实现教训（对后续 SPEC 的提醒）**：队列入队语句曾在重构中丢失导致死锁（worker 空等 queue、future 无人 resolve），靠 faulthandler + 任务栈 dump 定位——多任务死锁排查用「打印所有 pending task 的栈」比看日志快。

## 共享接口影响

- 不改前端契约。新增 sidecar HTTP 契约（本 SPEC 产物，TTS-07 消费）：
  - `GET /health` → `{status: "loading"|"ready"|"error", model_loaded: bool, styles_ready: bool, error: str|null}`（字段集恒定）
  - `GET /styles` → `{engine, defaultStyle, styles: {mood: {ref_audio_path, prompt_text, prompt_ready}}}`
  - `POST /synthesize` `{text, style?, speed?}` → `audio/wav`；400/500 → `{"error": 可读信息}`；回落时带 `x-aika-style-fallback: 1` 头
- 生产配置 `aika_voice.json` 的 styles 键（温柔/安心/亲密/嘲讽/毒舌/恳求）即 TTS-07 前端 mood 映射目标；与 `domain/mood.ts` 的 7 mood 对齐（缺 1 个，待 TTS-07 定义默认回落）。

## 待联调项（移交 TTS-07 / F）

1. ~~真机跑 `python aika_tts_server.py`，完成 F 四项实测~~ → **已全部执行（含 2026-09-22 人工听音），无剩余**。
2. gate 阈值 `max_sec_per_char: 0.75` 为保守初值，真机按 JP 语速标定（v1 中位 2.83 字/s）→ 真机实测最慢 0.38 s/字，**初值偏保守但不误杀，维持**。
3. TTS-07：应用 probe 接 /health schema 校验、speechQueue 的 style 透传、端到端延迟指标。**注意 `x-aika-style` 现为百分号编码（见 F 节坑 ①），消费方须 unquote**。
4. P0 重训 v2 后权重路径更新 `aika_voice.json`。

## F 节 · 真机联调实录（2026-09-20）

环境：conda env `GPTSoVits`，B 组合权重（aika_jp_v1-e5.ckpt + e8_s624.pth），RTX 5060 8GB，sidecar 端口 9880。取证工具：`tools/tts_probe/probe_tts06_f.py`（延迟+产物）、`asr_check_tts06f.py`（whisper 回转写初筛）；产物 `output/tts_probe_tts06f/`（latency.json / asr_check.json / summary.md / wav×19）。

### 实测数据（6 情绪 × 固定句，冷/热/换句三相位）

| 相位 | 中位 | 范围 | 判定 |
| --- | --- | --- | --- |
| 首句冷（含 prompt 构建） | **1066 ms** | 924~1355 | < 1500 ms ✅ |
| 同句热（prompt 缓存命中） | 975 ms | 884~1197 | — |
| 换句热（单句合成墙钟） | 1612 ms | 831~1965 | 见边界 ⚠️ |

- **句间 <0.5s 的判读**：F 判据是「前端预取 + 串行队列配合」——播放期预取下一句，只要**合成延迟 < 当前句播放时长**即无断流。实测最慢合成 1965 ms，最短播放 2.5 s，余量充足 ✅。**边界风险**：极短句（如「うん」播放 <0.6s）时单句合成 1~2s 接不住，需 TTS-07 的 speechQueue 分句粒度配合（短句合并预取），已记入 TTS-07 输入。
- **守门**：18 行全部 ≤0.38 s/字，0 行触发重试（阈值 0.75 初值不误杀）✅。
- **断开行为**：客户端 0.8s 掐断连接 → 6s 后 /health 仍 ready，后续请求 601 ms 正常返回，日志无残留任务报错 ✅。
- **人工听音**：**PASS（2026-09-22 用户听音，18/18 段已评）**。ASR 初筛（whisper large-v3-turbo CUDA 回转写 18 段）：**CER 中位 0.000、最大 0.167**，差异均为情绪语气词（「うん→ん?」、亲密风格自加「はぁ…」），**无词级重复、无乱码**——runaway 自动证据为阴性。人工听音结论与之吻合（见下「F 节补」）。

### 显存共存（STT-08 前置数据，顺带取证）

sidecar 常驻后全 GPU **2610 MiB / 8151 MiB**（净增约 1.9 GB）；ASR 初筛期间 whisper(large-v3-turbo, CUDA) 与 sidecar **同时驻留**无 OOM。粗算共存峰值 ≈ 1.9 + 1.0 (whisper) ≈ 3 GB < 8 GB，STT-08 的共存实测有充分余量（正式数据仍以 STT-08 实测为准）。

### 真机暴露并修复的缺陷（fake 测试盲区）

① **响应头 latin-1 编码崩溃**：`x-aika-style: 温柔` 直接 `UnicodeEncodeError → 500`（合成本身成功）。fake 测试全用 ASCII style 名故未拦截。修复：`urllib.parse.quote` 百分号编码后下发，消费方 unquote 还原；**新增回归测试 `test_non_ascii_style_header_is_latin1_safe`**，17/17 全绿。**契约变更**：`x-aika-style` 从「原文」改为「percent-encoded」，TTS-07 消费时须 `unquote`。
② 教训沉淀：**fake 测试的输入名应覆盖非 ASCII**——本项目 style 键天然是中文，测试配置却用英文，属于 fixture 与生产配置形态不一致。

## F 节补 · 听音包（2026-09-22：包已备妥并自检通过；人工听音结果见 F 节补二）

目的是把「人工听音」从「先装环境再想办法播」变成「打开一个页面、按顺序听、勾选完导出」，
让 F 项剩下的唯一人工动作可独立完成。

**产物**：`E:\Work\Chat_model\GPT-SoVITS\output\tts_probe_tts06f\listen.html`（与 `wav/` 同级，
`file://` 直接打开即可播放，无需服务器）。

**生成与自检工具**（可复用于 M1 v2 对照、M4 情绪扩库后的复听）：

| 工具 | 作用 |
| --- | --- |
| `tools/tts_probe/make_listening_pack.py <产物目录>` | 从该目录 `latency.json` + `wav/` 生成听音页（分 style 分组、带相位/延迟/秒每字、评分项、导出 Markdown） |
| `tools/tts_probe/check_listening_pack.py <listen.html>` | 真实浏览器自检：18 段可加载、顺序播放、评分与导出可用、localStorage 落盘 |

自检结果（Playwright + Chromium，`file://`）：**6/6 PASS** —— 音频元素 18、全部 `duration>0` 且无 `error`
（样例 4.31 / 4.31 / 2.51 s）、顺序播放能从第 1 段起播、导出 Markdown 产出表头 + 18 行、
勾选与备注进入导出、评分写入 localStorage。

**页面已做的听音引导**：

- 按 6 style 分组，每 style 三段：冷启动·句A / 热稳态·句A / 换句·句B；
- 每段标注实测延迟、音频时长、秒每字（便于对照 F 节的延迟表）；
- 评分项即 F 节要求的维度：词级重复 / 乱码 / 异常语气词 / 尾部静音 / 音色破裂 + 可懂度(1-5) + 备注；
- 顶部固定提示**重点复听 ASR 曾出现差异的片段**（亲密 style 的「うん→ん?」与额外语气词），
  要求区分「合理语气表现」与「生成异常」；
- 评分自动存本机（关页不丢），底部「导出 Markdown」直接产出可粘进本报告的表格。

**人工听音**：已由用户完成（2026-09-22，18/18 段），结果、逐段评分表与判据核对见 **F 节补二**。
ASR 回转写阴性（CER 中位 0.000，差异全为语气词）只是自动侧证据；「无词级重复」最终由真人听音支持。

**口径边界（不变）**：F 既有的 sidecar 合成延迟与「实际句间 <0.5 s」是两件事——应用首句出声、
句间、打断三项指标属 TTS-07-F，TTS-07 冻结期间不为收口 TTS-06 而改 AC。

## F 节补二 · 人工听音结果（2026-09-22，用户听音，18/18 段）

听音人：用户。方式：`listen.html`（与 `wav/` 同级，默认浏览器播放）。听音时环境已核实
`torch 2.11.0+cu128` 且 `cuda.is_available() == True`（排除「合成延迟骤升/artifact」类环境降级）。

**逐段评分表**（用户原表，未改动；「是」=勾选该项异常）：

| # | style | phase | 词级重复 | 乱码 | 异常语气词 | 尾部静音 | 音色破裂 | 可懂度 | 备注 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 温柔 | cold | | | | | 是 | 5 | |
| 2 | 温柔 | warm | | | | | 是 | 4 | |
| 3 | 温柔 | sentB-warm | | | | | | 5 | |
| 4 | 安心 | cold | | | | | 是 | 4 | |
| 5 | 安心 | warm | | | | | 是 | 4 | |
| 6 | 安心 | sentB-warm | | | | | 是 | 5 | |
| 7 | 亲密 | cold | | | | | 是 | 4 | |
| 8 | 亲密 | warm | | | | | 是 | 4 | |
| 9 | 亲密 | sentB-warm | | | | | | 5 | |
| 10 | 嘲讽 | cold | | | | | | 4 | |
| 11 | 嘲讽 | warm | | | | | | 4 | |
| 12 | 嘲讽 | sentB-warm | | | | | 是 | 4 | |
| 13 | 毒舌 | cold | | | | | | 5 | |
| 14 | 毒舌 | warm | | | | | | 5 | |
| 15 | 毒舌 | sentB-warm | | | | | | 5 | |
| 16 | 恳求 | cold | | | | | 是 | 4 | |
| 17 | 恳求 | warm | | | | | 是 | 4 | |
| 18 | 恳求 | sentB-warm | | | | | 是 | 4 | |

**结论汇总**：

| 维度 | 结果 |
| --- | --- |
| 词级重复 | **无**（18/18 全未勾选）——由真人听音支持，runaway/ASR 阴性结论成立 |
| 乱码 | **无**（18/18 全未勾选） |
| 异常语气词 | **无**（18/18 全未勾选）→ 亲密 style 的「うん→ん?」与「はぁ…」在听音人判断下属**合理语气表现**，非生成异常（回答了重点复听项） |
| 尾部静音 | **无**（18/18 全未勾选）→ 尾部修剪（`_trim_tail`）生效 |
| 可懂度 | 5 分 ×9、4 分 ×9，无 <4 → 整体清晰可懂 |
| **音色破裂** | **有，18 段中 12 段勾选**（温柔 2 / 安心 4 / 亲密 2 / 嘲讽 1 / 恳求 3；毒舌 0），为**系统性**现象 |

**音色破裂的口径（用户原话）**：问题集中在**促音（っ）处**，可听出明显的**电音 / 颤音**，
表现为该音位处音色破裂感。

**判读与后续**：
- 这是一条**真实的人工听音发现**，性质已钉死：环境健康（CUDA 正常）→ 属**权重本身 / 合成链路**
  的产物，非 torch 降级或采样参数造成（与 MEMORY 中「韵律=参考音频属性，非采样参数」的判断并列，
  但「音色破裂」是另一维度，需单独立项）。
- 分布看：**毒舌 0 处、嘲讽 1 处**，其余集中在偏「软/恳求」系——是否与这些 style 参考音频的
  促音段能量/时长特性相关，需 M1 重训素材或 M4 情绪扩库时一并复核，**不在此刻下因果结论**。
- 后续动作：此项计入 M1 重训 / M4 情绪库的验收维度（音色破裂 = 促音处电音/颤音），
  在素材到位前维持「已知、未根治」状态，不为收口 TTS-06 而篡改口径。

**F 项整体状态更新**：延迟 ✅（首句冷 1066 ms）+ 守门 ✅ + 断开 ✅ + ASR 阴性 ✅ + **人工听音 ✅（词级重复=无）**；
新增非阻断观察项「促音处电音/颤音」计入后续重训验收维度。F 项从「部分 PASS」转为 **PASS**（含一条待后续跟踪的音色观察项）。
