# LLM-02 · Runtime 与 Context

状态：未开始。

## 目标与边界

- 输入：文本、Mode、时钟、存储、可选上下文源、输入预算。
- 输出：可订阅 Runtime 事件、AgentContext、来源/裁剪/降级 trace。
- 前置：依赖 LLM-01 的类型契约，可用兼容 adapter；真实 UI/STT/TTS 不前置。
- 负责范围：拟新增 services/runtime、services/context、domain/context；通过 adapter 保留既有入口。
- 不做：不实现前端桥接页面、新 ASR/TTS 或完整 Memory/RAG。

## 实施内容与验收条件

交付独立 React 的 CompanionRuntime；注入 Provider/Storage/Clock 和检索源，统一 turn 生命周期、取消、存储与状态订阅。AgentContext 含时间、Soul、关系、Mode、近期历史/摘要、Memory/Knowledge/环境数据。Hook 接入若需跨前端修改，由 FE-01/INT-01 消费适配；本阶段先验 headless 生产逻辑。

| AC | 模块内验收 |
| --- | --- |
| LLM-02-A | 无 React、麦克风或 TTS 时可流式回复、完成落库；取消后迟到 chunk 不影响新轮，文本完成不等待播放 |
| LLM-02-B | 固定输入/时钟产生稳定 Context；用户时区与跨午夜正确；估算 token 不超过预算，必需内容超限显式报错 |
| LLM-02-C | Memory/RAG/环境数据源各自超时/抛错时仍可回复并记录降级原因，不注入错误文本或将检索内容提升为指令 |
| LLM-02-D | 交付状态用 fixture 模拟：complete/interrupted/cancelled 与未知播放范围不会把未交付文本当已听完；旧消息迁移不丢失 |

## 模块内执行与交付

1. 先确认上述接口与负责范围，再实现当前 SPEC；不要顺带执行下一份 SPEC。
2. 对本次修改的生产逻辑准备定向测试名单。只 mock 外部依赖，不 mock 本模块被验收逻辑；无需启动其他模块。
3. 报告每条 AC 的测试文件/样本、真实命令及退出码，质量样本标明实际模型或 fixture。证据不足保留 NOT RUN/BLOCKED，不能降低门槛。
4. 交付 `../reports/LLM-02_ACCEPTANCE.md`；原任务审阅证据。只在 [集成触发条件](../../integration/SPEC.md) 满足时安排全流程调试，当前小 SPEC 不默认跑全仓测试或产品打包。

共享规则见 [模块测试规则](../../modules/TESTING.md)；输入输出遵循 [共享契约](../../modules/CONTRACTS.md)。
