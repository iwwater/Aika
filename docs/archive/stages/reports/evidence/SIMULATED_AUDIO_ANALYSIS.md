# S1 模拟语音与 Provider 分析

- 时间：2026-09-10（Asia/Shanghai）
- 输入目录：`F:\AIVoice\ALLMIND_VoiceLines`；用户消息中的 `ALLMIND\_VoiceLines` 不存在，实际使用同级的 `ALLMIND_VoiceLines`
- 输入内容：175 个 MP3，另有 `ALLMIND_全语音集_转录文本.txt`
- Provider：DashScope OpenAI-compatible，模型 `qwen-plus`
- API Key：仅在本次进程内使用，未写入仓库、报告、日志或持久化设置

## 音频资产分析

使用本机 Python 标准库解析 MP3 frame header，并将文件名时间轴与 frame 时长对照：

| 指标 | 结果 |
| --- | ---: |
| MP3 文件数 | 175 |
| 成功解析 frame 的文件数 | 175 |
| 文件名时间轴 | 606.820 s |
| MP3 有声 frame 总时长 | 594.216 s |
| 片段间隙总时长 | 12.604 s |
| 间隙数 / P50 / 最大值 | 43 / 0.720 s / 2.220 s |
| 采样率 / 声道 | 16 kHz / mono |
| MP3 bitrate 范围 | 8–144 kbps（VBR） |
| 单文件 frame 时长范围 | 0.540–6.624 s |

这一步只证明模拟音频资产可读取、时间轴和间隙可复核；它不是麦克风 waveform、耳机/外放回采，也不是 TTS 首音频测量。

## Provider 模拟样本

按转录文本前 20 条对应的本地语音片段顺序，逐条发送日文转录到用户指定 Provider；每条要求返回 Aika 双语 JSON。结果：

| 指标 | 结果 |
| --- | ---: |
| 模拟回合数 | 20 |
| 成功 / 失败 | 20 / 0 |
| Provider 请求耗时最小 / P50 / P95 / 最大 | 908 / 1,371 / 2,491 / 2,655 ms |
| 模拟输入时间跨度 | 70.900 s |

Provider 请求耗时不等于 `speechEnd → firstAudio`，也不等于 `turnCommitted` 调度开销；不能用于替代 AC04 的同设备修复前基线或实机首音频样本。完整命令与退出码见 [`S1_COMMAND_LOG.md`](S1_COMMAND_LOG.md)。

## 验收边界

- 该模拟覆盖了真实 DashScope 响应结构与 20 条固定输入，但没有运行麦克风、Whisper、TTS 声学播放或耳机/外放回采。
- 因此它只能作为 S1 自动/模拟补充证据；S1-AC03、S1-AC04、S1-AC05、S1-AC07 暂不宣称实机 PASS，统一后置真人验收。
- 不把修改后 Provider 样本倒填为修复前基线；AC04 的绝对首音频目标待真人验收时注册，不阻塞当前工程阶段。
