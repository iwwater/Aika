# Aika Next 文档入口

更新日期：2026-09-21。开发规范见根 [AGENTS.md](../AGENTS.md)；版本执行状态以对应 SPEC 索引和实际报告为准，本入口不复制易过期的状态清单。

用户使用 RPD 命名，本目录沿用 RPD，内容承担产品需求与路线图职责。

| 文档 | 用途 |
| --- | --- |
| [开发与 Agent 协作规范](../AGENTS.md) | 模块责任、契约变更、定向测试、交接与版本验收 |
| [插件与能力包开发规范](development/PLUGIN_DEVELOPMENT.md) | STT/TTS/情感陪伴合作者的分工、接口与交付清单 |
| [0.61 → 0.65 连续开发计划](next/EXECUTION_061_065.md) | 自动接续、人工验收后置、可复制的 Goal 指令 |
| [0.65 架构改造测试计划](next/0.65/TEST_PLAN.md) | 保留旧业务回归，按 K65 步骤新增契约、插件、多源与独立产物测试 |
| [DSH 分发意向](integrations/dsh/README.md) | 后置，不增加本轮实现或验收要求 |
| [总路线图 RPD](next/RPD_ROADMAP.md) | 产品方向、版本边界、架构原则 |
| [需求 TODO](next/TODO.md) | 用户原始登记；指定 11 条已排入 0.61，其余保留待办，不改变 0.6 SPEC |
| [Aika Next 0.6 RPD](next/0.6/RPD.md) | 本版范围、需求、发布标准 |
| [Aika Next 0.61 RPD](next/0.61/RPD.md) / [SPEC 索引](next/0.61/SPEC.md) | 0.6 后修复与可用性轮；10 个 SPEC，含可用知识库切换 |
| [Aika Next 0.65 RPD](next/0.65/RPD.md) | 插件化与包体化内核，六份子 RPD；0.61 后、0.7 前，已拆 [13 步执行 SPEC](next/0.65/SPEC.md)，开发 NOT RUN |
| [Aika Next 0.7 RPD](next/0.7/RPD.md) | Soul & Continuity 需求设计稿；不改变 0.6 执行范围 |
| [SPEC 索引](next/0.6/SPEC.md) | 开发顺序、依赖与状态 |
| [共享接口设计](next/0.6/CONTRACTS.md) | 逻辑接口和生命周期保证 |
| [测试与验收规则](next/0.6/TESTING.md) | TDD、语料回放、版本门槛 |
| [worker 交接](next/0.6/WORKER_HANDOFF.md) | 从文档分支开始实施 |

工作树：`F:/AIVoice/Aika-Next`；分支：`aika-next`；所属 Git 仓库：`F:/AIVoice/Aika`。本分支无旧 Aika 父提交，与旧 master 独立，不意味着新运行时也要从空项目手写。

只读旧库：`F:/AIVoice/Aika`；参考 commit：`30269c6d7abafbf1a65752af67b9f152757e51cc`。旧工作树存在其他未提交内容，不能将其当作固定基线；需要时从该 commit 建只读参考副本。

上游：[phoiex/AAAAGENT](https://github.com/phoiex/AAAAGENT)。上游导入与固定基线以 [0.6 BASELINE](next/0.6/BASELINE.md) 和 NEXT-00 报告为准；后续版本按实际交付提交重新核对。Windows 源码入口是 `windows/code/desktop-pet/`，macOS 为 `code/desktop-pet/`；实际路径与命令由 NEXT-00 复核。

本目录中的“0.6”专指 **Aika Next 0.6**，不是旧库 `docs/RPD_MVP_0.6.md` 的 pet-shell / Live2D 计划。后者不自动成为本版工作项。
