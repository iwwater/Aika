# Aika Next 文档入口

日期：2026-09-20。状态：NEXT-00～05、07 已完成（AUTO_PASS）；NEXT-06 逻辑项 PASS、06-E/06-F 真实回放 BLOCKED（IN_PROGRESS）；NEXT-08 收口待做。

用户使用 RPD 命名，本目录沿用 RPD，内容承担产品需求与路线图职责。

| 文档 | 用途 |
| --- | --- |
| [总路线图 RPD](next/RPD_ROADMAP.md) | 产品方向、版本边界、架构原则 |
| [需求 TODO](next/TODO.md) | 用户原始登记；指定 11 条已排入 0.61，其余保留待办，不改变 0.6 SPEC |
| [Aika Next 0.6 RPD](next/0.6/RPD.md) | 本版范围、需求、发布标准 |
| [Aika Next 0.61 RPD](next/0.61/RPD.md) / [SPEC 索引](next/0.61/SPEC.md) | 0.6 后修复与可用性轮；10 个 SPEC，含可用知识库切换 |
| [Aika Next 0.7 RPD](next/0.7/RPD.md) | Soul & Continuity 需求设计稿；不改变 0.6 执行范围 |
| [SPEC 索引](next/0.6/SPEC.md) | 开发顺序、依赖与状态 |
| [共享接口设计](next/0.6/CONTRACTS.md) | 逻辑接口和生命周期保证 |
| [测试与验收规则](next/0.6/TESTING.md) | TDD、语料回放、版本门槛 |
| [worker 交接](next/0.6/WORKER_HANDOFF.md) | 从文档分支开始实施 |

工作树：`F:/AIVoice/Aika-Next`；分支：`aika-next`；所属 Git 仓库：`F:/AIVoice/Aika`。本分支无旧 Aika 父提交，与旧 master 独立，不意味着新运行时也要从空项目手写。

只读旧库：`F:/AIVoice/Aika`；参考 commit：`30269c6d7abafbf1a65752af67b9f152757e51cc`。旧工作树存在其他未提交内容，不能将其当作固定基线；需要时从该 commit 建只读参考副本。

上游：[phoiex/AAAAGENT](https://github.com/phoiex/AAAAGENT)。本次只查阅仓库说明，未导入源码、未锁定上游 commit、未执行工程测试。README 列出的 Windows 源码入口是 `windows/code/desktop-pet/`，macOS 为 `code/desktop-pet/`；实际路径与命令由 NEXT-00 复核。

本目录中的“0.6”专指 **Aika Next 0.6**，不是旧库 `docs/RPD_MVP_0.6.md` 的 pet-shell / Live2D 计划。后者不自动成为本版工作项。
