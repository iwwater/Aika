# Aika Next 架构文档总览

更新日期：2026-09-23。

本目录承载跨版本、跨模块的长期架构知识。它不替代版本 RPD/SPEC，也不把尚未实现的设计写成实现事实。

## 文档职责

| 文档 | 负责的问题 | 变更时机 |
| --- | --- | --- |
| [ADR](adr/README.md) | 为什么采用某种边界、权威源或生命周期策略？ | 决策被接受、替代或撤销时 |
| [CONTRACT](contracts/README.md) | 模块之间的输入、输出、权限、生命周期和错误语义是什么？ | 公共接口或语义变化时 |
| [RPD/SPEC](../next/RPD_ROADMAP.md) | 当前版本要交付什么、按什么顺序交付？ | 需求范围或执行顺序变化时 |
| [REPORT](../next/0.79/reports/) | 哪些内容已经由实际代码和测试证明？ | 每个 SPEC 执行后 |
| [STATUS](../STATUS.md) | 当前版本状态和未过门槛是什么？ | 状态或证据发生变化时 |

## 目录

```text
docs/architecture/
├── README.md
├── adr/
│   ├── README.md
│   └── ADR-*.md
└── contracts/
    ├── README.md
    └── *.md
```

## 维护规则

1. 需求先写 RPD；RPD 下可执行的步骤再拆到 SPEC，不把 TODO 直接伪装成执行计划。
2. 架构讨论形成稳定结论后写 ADR；如果只是当前版本实现细节，留在 SPEC 或 REPORT。
3. 公共契约只保留一份跨版本语义。`next/<version>/CONTRACTS.md` 作为该版本的变更说明和验收补充，逐步减少重复定义。
4. “代码里有文件”不等于“能力已交付”。实现状态必须由对应 REPORT、生产接线证据和 STATUS 共同确认。
5. 旧版本文档保持原路径；新版本引用稳定的架构入口，不通过复制全文解决链接问题。

## 相关入口

- [当前状态](../STATUS.md)
- [待办、缺陷与技术债](../backlog/README.md)
- [文档模板](../templates/README.md)
- [总路线图](../next/RPD_ROADMAP.md)
