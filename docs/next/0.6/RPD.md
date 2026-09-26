# Aika Next 0.6 RPD

状态：READY FOR IMPLEMENTATION，开发 NOT RUN。本文是本版需求权威入口。

## 1. 版本目标与范围

用户能在 Windows 上配置 Aika 身份与 Provider，完成文字及基础语音对话，延续上游 Memory 能力，查看最小聊天 Timeline。版本开发期间全自动验证，最后一次集中人工验收。

| 需求 | 必须交付 | SPEC |
| --- | --- | --- |
| N06-R01 | 固定 Windows 上游及 Legacy 基线，可复现测试/构建，独立数据目录 | NEXT-00 |
| N06-R02 | 既有行为语料清单、稳定测试入口、跨模块契约 | NEXT-01 |
| N06-R03 | Aika 名称、静态角色配置与 Prompt、设置持久化 | NEXT-02 |
| N06-R04 | OpenAI-compatible（覆盖 DeepSeek 配置）与 Gemini 适配，流式、取消和错误处理 | NEXT-03 |
| N06-R05 | 上游文字主链及 Memory 读写/纠正/遗忘/作用域的兼容性保证 | NEXT-04 |
| N06-R06 | 持久化最小 Chat Timeline，分页查询、幂等、删除/遗忘派生数据不复活 | NEXT-05 |
| N06-R07 | 基础 STT→对话→TTS，复用既有 Whisper 路径与上游可用输出，打断和旧轮隔离 | NEXT-06 |
| N06-R08 | 最小操作 UI：配置、文本、语音控制、状态、Timeline | NEXT-07 |
| N06-R09 | 自动完整链路、全量回归、Windows 构建与验收包 | NEXT-08 |
| N06-R10 | 用户版本末尾人工验收与缺陷闭环 | NEXT-09 |

OpenAI-compatible 和 Gemini 为工程必需协议，Anthropic 独立协议后置。上游已有 Provider 可以保留，不承诺为每种云模型购买凭据并实测。真实 LLM 至少一条现有可用 Provider 路径完成回放；各必需协议都必须通过适配契约测试。

## 2. 明确排除

不新增 Wiki、动态 Persona/Relationship、OCR/VLM 强化、ACP/MCP/Reminder 集成、Live2D/桌宠移植、Mobile、音色训练/克隆、唤醒、全双工声学优化、Plugin Kernel 或旧数据库导入。上游已有功能无需为收窄范围而删掉，但不得自动启用外部动作，也不得冒充这些功能已经移植验收。

0.6 的 Timeline 仅 Chat 事件，不做 OCR/VLM 采集，也不新增 Timeline→Context 检索，避免与上游 recent history 重复注入。沿用上游原有 Context/Memory，检查取消、遗忘与预算约束。

## 3. 体验与接口

主交互：配置 → 输入文字/启动基础语音 → 可见生成状态 → 回复文本/语音 → 可停止 → 查看聊天 Timeline。模型或语音失败要显示可恢复错误，不把静默降级当成功。

静态 Aika 配置、Provider、Timeline 和 Voice 的接口定义见 [CONTRACTS](CONTRACTS.md)。它们是 Next 逻辑设计，NEXT-00 必须对应到真实 Windows 上游符号；不要求上游按本文整体重命名。

## 4. 验收门槛

- 每个必需 AC 有可复现证据；实现走生产路径，空测试、全 fake 被测对象、跳过失败均不算通过。
- NEXT-00～08 全部 AUTO_PASS，才叫“开发完成，待人工验收”。真实回放要求、语料固定方式见 [TESTING](TESTING.md)。
- 版本全量测试、必要静态检查、Windows 可运行构建通过；自动启动冒烟无需用户参与。
- 人工验收检查真实设备、语音听感和 UI 使用；用户未验收时不得标 RELEASE_ACCEPTED。
- 任一必需自动 AC BLOCKED/NOT RUN，版本仍未开发完成；不能将其无声转成人工项。

## 5. 数据与故障

Next 使用新的 app data 命名空间，不写入旧 Aika/AAAAGENT 用户库。配置导出和日志不含密钥；固定语料不含私人数据。重复事件不重复入库，取消后的迟到回调不能改变新轮状态；Timeline 失败不能回滚已完成回复，必须可诊断并有有界重试。

性能先记录真实环境和基线；不虚构 P95 门槛。顺序、终态、取消隔离等确定性条件必须断言。主观听感不由模拟事件或 LLM 自评代替。
