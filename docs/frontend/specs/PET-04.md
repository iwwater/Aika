# PET-04 · 事件与情绪映射

状态：DRAFT / 实现 NOT RUN。需求 DPI-04；前置 PET-02，使用 fake adapter 即可独立开发。
依据：[契约调度与映射](../DESKTOP_PET_CONTRACT.md)。

## 文件范围

新增 `src/services/desktopPet/eventMapping.ts`、`commandBuffer.ts` 及测试；桥接拟放 `src/presentation/desktopPetPresenter.ts`。只读已有 CompanionRuntime 事件与最终 ReplyEnvelopeV1；不改 LLM prompt、Memory、Emotion 算法、感知源或 TTS 引擎。

## 实现要求

1. 执行时扫描真实 Runtime/ReplyEnvelope 定义，报告“实际字段→语义→桌宠命令”表。现有事件没有工具/审阅语义时保留受控显式入口，不能依据文本猜测工具启动。
2. 按最终 replyText 投影文本；mood 映射 emotion，合法 motion 映射 action。同轮只发一次最终文本；显式动作优先，最多一项表现命令。拒绝内部候选、思维链和自由脚本。
3. 实现单在途+16待发、状态合并、去重、期限、generation 和 runtimeTurnId 校验，具体规则完全遵守契约；不实现动画优先级 FSM。
4. 旧轮失败、异步映射、重连结果不得覆盖新轮。取消时本地丢弃/abort；对已送达动画不声称完成撤回。
5. 不按 delta 发气泡；Agent 终态含文本时只走表现+say，不再 success event 覆盖正文。任一表现失败仍尝试未过期文本。

## 验收

| AC | 用例 |
| --- | --- |
| PET-04-A | 开始→多 delta→完成，仅一个 thinking 与一个最终 say；语义动作准确 |
| PET-04-B | happy 无映射仅 say，映射存在按 profile 发 action；不把 happy 当合法供应商 event |
| PET-04-C | A轮取消→B轮开始→A轮迟到完成/失败，不出现A轮新发命令；无turn演示仍可用 |
| PET-04-D | 1000条状态突发最多1在途+16待发；中间态合并、终态清理与满队列策略可复现 |
| PET-04-E | POST unknown不补发；重连不重播；过期、禁用后零新发；去重缓存有界 |
| PET-04-F | 最终任务 action失败仍say；say之后不再发送覆盖正文的success；时序由假时钟验证 |
| PET-04-G | 输入带记忆候选、密钥哨兵、内部推理时，出站与日志无该内容；业务状态不被adapter失败改变 |

只测生产 mapper/buffer/presenter，使用假 Runtime/Adapter/Clock。报告 `reports/PET-04_ACCEPTANCE.md`；不启动麦克风、OCR 或真实 Provider。
