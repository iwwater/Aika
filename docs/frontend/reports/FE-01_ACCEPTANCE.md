# FE-01 验收报告 · Runtime 桥接与消息状态（复核补证）

- 性质：**复核补证报告**（2026-09-13，goal worker）。原始实现早于本文、无执行者自测记录；按当前 HEAD 实跑定向测试据实补证。
- SPEC：[FE-01](../specs/FE-01.md)。基线 commit：`191b89f`。

## 命令与退出码（2026-09-13 实跑，aika-crossplatform 下）

| 命令 | 结果 | 退出码 |
| --- | --- | --- |
| `npx vitest run src/hooks src/presentation src/domain/conversation.test.ts src/domain/captionHighlight.test.ts` | 10 文件 / 143 passed | 0 |

## 逐条 AC

| AC | 证据 | 结果 | 证据类型 |
| --- | --- | --- | --- |
| FE-01-A fake Runtime 流式/完成/失败/取消展示，旧 turn 不覆盖 | `hooks/useCompanionSession.integration.test.ts`：文本 send 展示与落库（:229）、Provider 错误与断流不存成功回复且下一轮可用（:284）、新 submit 取消旧轮且旧 chunk 不清新轮 pending（:471）、完整语音 drained 落库/中断只留 interrupted（:180） | PASS（hook/presenter 状态层） | production+fixture |
| FE-01-B 无 TTS/mic 时文本发送正常、错误后可再发 | 同上 :229/:284/:515（写库持续失败仍释放发送状态，恢复后可重发） | PASS（状态层） | production+fixture |
| FE-01-C 中断消息状态明确、卸载无重复订阅 | 中断只留 interrupted（:180）；`start 幂等：StrictMode 双次挂载不会重复装载或重复订阅`（:771） | PASS（状态层） | production+fixture |

## 未测/边界

- SPEC 审阅结论指出「A 的展示需页面证据，纯 Presenter 只能证明状态」：**页面视觉证据 NOT RUN**（需浏览器/桌面真机，归 INT-01 人工队列）。本报告全部证据限于 hook/presenter 状态层，不冒充界面验收。
- 真实模型/真实存储：NOT RUN。
