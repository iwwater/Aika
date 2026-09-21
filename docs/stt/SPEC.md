# STT SPEC 执行索引

需求见 [模块 PRD](PRD.md)，一次下发一份独立 SPEC。

| SPEC | 交付 | 状态 |
| --- | --- | --- |
| [STT-01](specs/STT-01.md) | 输入契约与识别适配 | 已补证（2026-09-13 复核报告）：定向 49/118 测试全绿；真机 NOT RUN |
| [STT-02](specs/STT-02.md) | 分段排序与回合提交 | 已补证（2026-09-13 复核报告）：定向 76 测试全绿；clearPending 幂等证据弱 |
| [STT-03](specs/STT-03.md) | 设备与识别验收（DEFERRED） | **部分复验（2026-09-22）**：本地 Whisper（turbo）真人麦克风 20 句量化——识别 7/20（英 4/5、中 3/5、日 0/5、混 0/5）；延迟中位 222ms；**发现前端本地引擎缺 demo 网关已有的语言纠偏**（日语 auto 误判）；STT-03-B/C 仍 NOT RUN。见[验收报告](reports/STT-03_ACCEPTANCE_2026-09-22.md) |
| [STT-04](specs/STT-04.md) | 识别语言判定不再自锁 | REVIEWED_AUTO（2026-09-13 证据审阅：报告逐 AC 齐全，定向复跑 134 测试范围全绿） |
| [STT-05](specs/STT-05.md) | Whisper 自动语言判定取证与失败归因 | **AUTO_PASS（2026-09-18）**：57 段两路取证完成（cli + 生产 server 路径）。判成中文 **0 段**；真瓶颈是真人情绪化语音的解码质量（CER 中位 0.22 vs 合成 0.0）；指定 `language=ja` 零收益。见[验收报告](reports/STT-05_ACCEPTANCE.md)，修复方向需另立 SPEC |
| [STT-06](specs/STT-06.md) | Whisper 推理后端切换（CPU → CUDA）与延迟预算标定 | **AUTO_PASS（2026-09-18）**：H1 **通过**——sm_120 经 `900` PTX 由驱动 JIT 可用，**无需源码构建**。jfk 稳态 763.26 → **85.52 ms（8.9×）**；生产客户端视角 776.04 → 75.57 ms（10.3×）。关键发现：CPU 侧约 **720 ms 是与音频时长无关的固定开销**（3.84 s→11.0 s 仅涨 37 ms），GPU 把它压到 ~70 ms。新增代价：**首次调用 33.8 s** PTX JIT，缓存后 220 ms 且跨进程持久（`%APPDATA%\NVIDIA\ComputeCache`）。质量无变化（文本 19/20 逐字一致、CER 无差异）。**AC-F 更大模型未下载、未验证**。见[验收报告](reports/STT-06_ACCEPTANCE.md) |
| [STT-07](specs/STT-07.md) | Whisper 更大模型在 GPU 下的延迟与识别质量标定 | **AUTO_PASS（2026-09-18）**：四档模型（base/small-q5_1/medium-q5_0/large-v3-turbo-q5_0）**全部进预算**（jfk 稳态 85.88/128.71/302.54/215.95 ms，均 ≤500ms；显存净增最大 1120 MiB）。**真人 CER 单调下降 0.22 → 0.18 → 0.11 → 0.079（-64%）**——STT-05「杠杆是模型规模」第一次实证。**large-v3-turbo-q5_0 是甜点**（又快又准，547 MB）。n=6 作方向性观察，不作因果断言。见[验收报告](reports/STT-07_ACCEPTANCE.md) |
| [STT-08](specs/STT-08.md) | 更大模型落地为生产默认 + 显存共存实测 | **AUTO_PASS（2026-09-22）**：生产已切 CUDA + large-v3-turbo-q5_0（去 `-ng`，CUDA 目录），启动日志 `using CUDA0 backend` + `CUDA0 total size = 573.45 MB`，探活 200。契约复跑（真实 `createWhisperClient`，n=5）：探活 18.98 ms、稳态中位 **217.59 ms**、文本 5/5 稳定。**显存共存：可共存**——两服务同加载并同时推理，峰值 **3570 / 8151 MiB**，无 OOM（余量 ≥4238 MiB）；whisper 净增 ≈1055 MiB。首次 JIT（`ARCHS` 无 sm_120 → PTX JIT）与预热步骤见 [JIT 部署说明](further/WHISPER_CUDA_JIT_NOTES.md)。CPU/base 未改、可一键回退。见[验收报告](reports/STT-08_ACCEPTANCE.md) |
| [STT-09](specs/STT-09.md) | 生产前端本地引擎语言纠偏下沉 | **SPEC 冻结（需求与方案就绪，待合作者重构落地）**：STT-03 实测日语 0/5 归因于前端本地引擎缺 demo 网关已有的语言纠偏（auto 误判英语/小语种）；下沉需改 `whisperClient`/`whisperInput` 且可能触及 contracts 签名，属被冻结的 voice 内部区域，先立 SPEC 不执行 |

已有适配不等于新 SPEC 全部验收通过；设备与后置范围保持原状态。

STT-04 只在 Web Speech 退路上关闭了语言自锁，并把「根治」挂靠在本地 whisper 上——**该假设本身未被验证**。STT-05 对 whisper 真实路径取证（同一现象、不同链路），先测量再决定是否修改 `whisperClient`。

STT-05 的结论是「质量瓶颈在解码质量，杠杆是模型规模」，而更大模型受延迟预算限制——该预算此前**没有任何测量数据**。STT-06 因此先解决运行时后端并标定预算，不改 `whisperClient`；它同样**不触碰 STT-05 的质量结论**。

STT-06 完成后，预算第一次有了基线：GPU 让 base 只占 500 ms 工作阈值的 17%（余量约 415 ms）。STT-07 把这个余量用了起来——四档模型全部进预算，且**真人 CER 随模型规模单调下降（0.22 → 0.079，-64%）**，large-v3-turbo-q5_0 是「又快又准」甜点。STT 侧现在有了一张完整的 (模型 × 延迟 × 显存 × CER) 矩阵，「换更大模型进生产」因此具备了决策依据，该落地动作由 [STT-08](specs/STT-08.md) 承接（部署切换 + 显存共存实测）。
