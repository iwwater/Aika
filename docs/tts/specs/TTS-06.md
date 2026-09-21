# TTS-06 · Aika 本地声线 sidecar（GPT-SoVITS 推理服务）

状态：READY（fake 推理下可自动验收 A~E；真实合成与听音 F 为条件执行项）。
需求来源：[本地声线接入方案](../further/PLAN_AIKA_LOCAL_VOICE.md) P1；实现参考 jamiepine/voicebox（源码快照 `tmp/voicebox`，MIT，只借鉴模式不引入依赖）。执行规则：[安全执行计划](../../GOAL_EXECUTION_PLAN.md)。

## 前置与范围

- 前置：B 组合权重（底模 GPT + 自训 SoVITS）已实测可用；本 SPEC 不依赖 P0 重训完成。
- **上游能力复用（2026-09-17 勘定，见 [PLAN 第九节](../further/PLAN_AIKA_LOCAL_VOICE.md)）**：GPT-SoVITS 仓库自带 `api_v2.py`（FastAPI + uvicorn，`/tts` 支持 `streaming_mode` 0/1/2/3 与 `overlap_length`/`min_chunk_length`，`/set_gpt_weights`、`/set_sovits_weights`、`/set_refer_audio`、`/control`），`TTS_infer_pack/TTS.py` 自带 `self.prompt_cache` 与 `set_ref_audio()`（参考音频热切换）。因此本 SPEC **不重写 TTS 服务、不自己实现分块合成与 prompt 缓存**，只写上游没有的四项：`/health` 稳定 schema、style→参考音频映射、runaway 时长守门、串行队列的取消语义。
- 交付物：`aika_tts_server.py`（放 GPT-SoVITS 仓库目录，FastAPI 在其依赖树内；具体路径执行时确认并登记到验收报告）。对上游的接法执行时二选一并在报告中写明理由：直接调 `TTS_infer_pack`（少一跳）或调 `api_v2.py`（进程隔离）；`api_v2.py` 的宽参数面不暴露给前端。
- 修改范围：仅新增 sidecar 及其测试。不改 aika-crossplatform 前端（应用接入属 TTS-07），不动 speechQueue。不改动上游 `api_v2.py`/`TTS.py`（如确需改动，须在报告中单列并给出兼容性说明）。
- 非目标：不分句（前端 speechQueue 职责，sidecar 收到的是单句）；不做音频效果链；不做多引擎管理界面；不做打包分发（P4）；不引入 voicebox 任何运行时依赖。

## 行为与接口

对外 HTTP：

- `GET /health` → `{status, model_loaded, styles_ready}`（字段与取值稳定，供应用 probe 做 schema 校验，参考 voicebox `routes/health.py`）；启动即后台预载权重，加载不阻塞 HTTP；加载失败上报可读错误。
- `GET /styles` → 与 voice.json `styles` 同构的情绪映射（每项含参考音频路径、参考文本、加载状态）。
- `POST /synthesize` `{text, style, speed}` → `audio/wav`。未知 style 按 voice.json 映射回落到最近情绪；无可用映射返回 400 + 可读错误。合成超时与异常返回 500 + 可读错误，不吞错。

内部结构（协议形状对齐 voicebox `backend/backends/__init__.py`，但**只做薄适配层**；分块合成、prompt 编码缓存由上游承担）：

- `Engine` 协议：`load / unload / is_loaded / create_voice_prompt(use_cache) / generate(text, prompt, speed)`。GPT-SoVITS 为第一个实现，内部委托上游 `TTS_infer_pack`（或 `api_v2.py`）；接口按「可加第二引擎」设计（如 Qwen3-TTS），但不实现。
- 串行生成队列（参考 `services/task_queue.py`；上游单 worker uvicorn 的串行只是副作用，取消语义仍需自建）：asyncio.Queue 单 worker，并发请求不并发推理；客户端取消时，未开始任务直接丢弃不消耗推理，已开始任务 best-effort 在推理步边界停止。
- prompt cache（上游 `TTS.py` `self.prompt_cache` 已有参考音频编码缓存，本 SPEC 只在其上包 style 维度）：键 = (参考音频路径, mtime, 参考文本, 引擎配置 hash)；每 style 常驻一份，参考文件或配置变更自动失效。
- 生成守门（移植 `utils/chunked_tts.py` runaway 模式到 GPT-SoVITS 场景）：实际时长/文本字数比超过阈值 → 换 seed、提高 repetition_penalty 重试一次；仍异常 → 500 报错。阈值与重试参数进配置文件，初值真机标定，不硬编码。

GPT-SoVITS 三个已踩坑（TTS_Config 必须包 `{"custom": base}`、`run()` 是生成器取最后 yield、hz=25 补丁）按 [PLAN P1](../further/PLAN_AIKA_LOCAL_VOICE.md) 备注执行，写入代码注释。

## 验收条件

| AC | 要求 |
| --- | --- |
| TTS-06-A | /health schema 稳定；模型加载中如实上报 `model_loaded:false`；加载失败给可读错误；HTTP 启动不被权重加载阻塞 |
| TTS-06-B | fake 推理下 /synthesize 固定文本返回合法 WAV（RIFF 头、采样率、非零时长）；未知 style 的回落与 400 语义各有测试 |
| TTS-06-C | 并发 2 请求时推理调用无时间重叠（fake 记录进入/退出时间）；取消未开始任务不触发任何推理 |
| TTS-06-D | 同 style 二次请求 prompt 构建仅发生一次（fake 计数）；参考文件 mtime/文本变更后缓存失效并重建 |
| TTS-06-E | fake 输出超阈值时长触发恰好一次重试且重试参数（seed/penalty）变化可观察；重试仍失败返回 500，错误信息可读 |
| TTS-06-F | 真机试听（条件执行，B 组合权重）：首句出声 <1.5s；句间 <0.5s（前端预取 + sidecar 串行队列配合）；无词级重复（人工听音）；客户端断开后队列不再残留该任务 |

## 验证与交付

A~E 用 fake 推理引擎跑 pytest 定向验证：fake 只替换 GPT-SoVITS 推理本身，队列/缓存/路由/守门必须走生产代码。F 为真机项，条件不满足记 NOT RUN，不得由 fixture 冒充声学结果。

报告路径：../reports/TTS-06_ACCEPTANCE.md，含：改动清单、测试命令及退出码、逐 AC 证据、与 [共享契约](../../modules/CONTRACTS.md) 的影响（本 SPEC 不改前端契约，HTTP 接口作为新契约登记）、待联调项（TTS-07）。仅 A~E 全过可写 AUTO_PASS；FAIL 不得改 NOT RUN 推进依赖；不自动提交或推送。
