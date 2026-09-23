# ADR-004：Character Pack 与 Continuity 分层

状态：Accepted  
日期：2026-09-23  
来源：[0.7 RPD](../../next/0.7/RPD.md)、[总路线图](../../next/RPD_ROADMAP.md)

## Context

角色原作事实、稳定人格、用户画像和当前关系会共同影响回复，但它们的来源、可纠正性和生命周期不同。将所有内容合并成一个“角色 Prompt”会让原作事实被用户经历覆盖，也让推断变成事实。

## Decision

Character Pack 提供可追溯、可版本化的角色底色、Style、Character Wiki 和 Canon Timeline。Continuity 负责当前用户/角色实例的 Companion Timeline、User Soul、User Wiki 和 Relationship State。它们通过有预算的 Context Composer 进入既有 DialogueProvider。

## Consequences

- 角色切换、来源撤销、遗忘和纠正必须使受影响的 Context 失效。
- 动态关系不能自动改写原作事实；推断不能无审阅地升级为长期事实。
- Character Pack 不是通用爬虫、完整图数据库或音色克隆的授权。
