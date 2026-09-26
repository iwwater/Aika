# Aika Next 0.7 SPEC 执行索引 · 文字连续性闭环

日期：2026-09-22；状态：N07-00～N07-05 已完成受控自动验收；版本人工验收仍暂缓。

> **完成层级口径（2026-09-22）**：上述 AUTO_PASS 均为 **0.7 domain/core acceptance**（IMPLEMENTED：模块代码 + 受控自动测试 + 受控真实回放）。据此不得推导"正式桌面对话已完整消费连续性能力"（WIRED）；Production Dialogue Context integration 明确 deferred to N075-01（[SPEC N075-01](../0.75/SPEC.md)、[架构核对 AR-01～05](../ARCHITECTURE_REVIEW_20260922.md)）。完成度统一按 `IMPLEMENTED / WIRED / EXPOSED` 三态记录（[Runtime Maturity Matrix](../0.75/CONTRACTS.md#6-runtime-maturity-matrix)）。

本索引把 [RPD](RPD.md) 拆成可逐步交付的执行 SPEC。本轮只推进文字链路：本地 TXT/Markdown 资料、角色包、双时间线/双 Wiki 的最小读取、上下文召回和真实 LLM 文本回复。鼠标、Live2D、麦克风、ASR、TTS、听感和 0.65 的 32 项人工验收继续后置。

## 1. 执行纪律

- 先核对实际源码接口，再冻结本步输入、输出、失败语义和迁移；不把 RPD 逻辑边界当成已存在的源码接口。
- 每一步先写确定性 fixture 测试，再实现，再跑相关回归。真实 LLM 只用于结构、证据和短链路回放，不替代确定性隔离/撤销测试。
- 真实调用统一复用 `ProviderTransport`、现有调用授权和环境变量；不把 key、完整 endpoint、原始私人资料写入仓库。当前验证最多使用 2 次调用，遵守 5 RPM 限制。
- 0.7 连续性包是可选能力。未加载时，内核 + 普通包仍走现有文字流程；不得复制第二条 Dialogue Pipeline。
- 每步完成状态只能是 `NOT_STARTED`、`IN_PROGRESS`、`AUTO_PASS`、`BLOCKED` 或 `PENDING_USER_ACCEPTANCE`。

## 2. 步骤与门槛

| SPEC | 交付 | 前置 | 状态 |
| --- | --- | --- | --- |
| [N07-00](specs/N07-00.md) | 实际接口基线、文字闭环边界、真实 LLM 受控探针 | 0.65 自动基线；0.61 知识库/生命周期接口 | **AUTO_PASS（部分验收）**（[报告](reports/N07-00-real.md)） |
| [N07-01](specs/N07-01.md) | 来源快照、证据定位、Character Pack 草稿 schema/store | N07-00 | **AUTO_PASS（受控自动闭环）**（[报告](reports/N07-01.md)） |
| [N07-02](specs/N07-02.md) | 可替换 CharacterSourceProvider 与 CharacterDistiller | N07-01 | **AUTO_PASS（受控自动闭环）**（[报告](reports/N07-02.md)） |
| [N07-03](specs/N07-03.md) | Pack 预览/激活/升级/回退、Canon/Companion 双时间线读取 | N07-01 | **AUTO_PASS（受控自动闭环）**（[报告](reports/N07-03.md)） |
| [N07-04](specs/N07-04.md) | User Soul/User Wiki、关系覆盖、纠正/撤销/遗忘失效 | N07-03；0.61 Memory lifecycle | **AUTO_PASS（受控自动闭环）**（[报告](reports/N07-04.md)） |
| [N07-05](specs/N07-05.md) | Context 预算/去重/解释、管理入口、文字端到端回放 | N07-02～04 | **AUTO_PASS（受控自动闭环）**（[报告](reports/N07-05.md)） |

## 3. 本轮实际验收范围

本轮 N07-00～N07-05 已完成两类证据：

1. 确定性源码与生产适配测试：来源、提炼、Pack 生命周期、双时间线、User Soul/Wiki、纠正/遗忘、Context 预算/去重、管理入口和文字回归。
2. 受控真实回放：N07-03 验证 Pack/双时间线，N07-05 验证“记住称呼→回复→遗忘→再次回复”；每次最多 2 次 LLM 调用。

这些报告证明文字闭环和自动门槛已完成；仍不能替代 0.65 的 32 项人工验收，也不覆盖鼠标、Live2D、麦克风、ASR、TTS 和听感。
