# NEXT-06 · 基础语音与无人值守回放

状态：AUTO_PASS（2026-09-20；06-A/B/C/D/G PASS，06-E/06-F 真实回放同日经用户授权恢复并通过，见报告 §6）。需求：N06-R07。前置：NEXT-04、05；真实路径按 NEXT-00 盘点。证据见 [验收报告](../reports/NEXT-06_ACCEPTANCE.md)；桥接在 `core/speech-bridge.ts`。

## 边界与接口

薄适配 SpeechInputPort/SpeechOutputPort。优先复用 Legacy Whisper 输入及上游可用合成/播放。输入分段、生产 WAV 编码/传输、流式分句、队列和打断属于范围；不做音色克隆、唤醒、全双工声学优化或 Live2D。

## TDD 步骤

复用语音契约、句子、队列、VAD 和 Hook 行为用例，先针对 Next adapter 建失败测试。生产桥接连接输入 turnReady 与 TurnPort，Provider 可 fake。再用已有录音调用真实 VAD/ASR、固定文本调用真实 TTS，全程自动，不要求用户开麦。

## AC

| ID | 验收 |
| --- | --- |
| 06-A | 段乱序按音频序合并、重复去重、空输入不提交；turnReady 仅提交一次 |
| 06-B | 固定文本流首句可提前入队、尾句不丢、合成乱序播放仍按句序、endTurn 正确 drain |
| 06-C | 用户开始新输入触发旧轮 cancel+stop；旧音频回调不恢复播放，新输入不被清掉 |
| 06-D | 合成/播放失败、服务断开与不可用状态可见；不把失败队列 drained 当全部已听到 |
| 06-E | 至少一条固定真实录音及静音负例通过 TESTING 的真实 ASR 判定，模型/音频 hash 留档 |
| 06-F | 至少一条固定文本真实合成为可解码、正时长音频；接口代理事件与真实音频证据区分 |
| 06-G | 生产语音桥接→Runtime→Timeline 的自动集成通过，生成与交付状态分开 |

真实路径缺失为 BLOCKED，其他逻辑工作可继续。麦克风现场输入、扬声器真实停止和听感只在 NEXT-09 人工验收；本步不得标声学体验通过。
