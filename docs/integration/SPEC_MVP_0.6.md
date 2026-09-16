# Aiki 0.6 · Pet Shell SPEC 索引（草案）

依据：[RPD v1.2](../RPD_MVP_0.6.md)。2026-09-15 文档修订。

**执行状态（2026-09-15 更新）**：用户已拍板三项决策（位置 `f:/AIVoice/pet-shell`、自用不分发、MVP-12 纳入且仅点击交互）并授权执行全部未完成 SPEC。

- [MVP-07](reports/MVP-07_ACCEPTANCE.md)：**A～E PASS**（基线与可复现构建、四端点/功能盘点、Live2D 技术出口、剪枝、可推进范围）。
- [MVP-10](reports/MVP-10_ACCEPTANCE.md)：**A～E PASS**（renderer/behavior/menu 三槽与默认实现迁移）。
- [MVP-08](reports/MVP-08_ACCEPTANCE.md)：**A～F PASS**（品牌替换、菜单入口、单实例、退出语义、协议退出鉴权、回归）。临时标识 PetShell / `dev.aiki.petshell`。
- [MVP-09](reports/MVP-09_ACCEPTANCE.md)：**A/B/C/D/F PASS，E PARTIAL**——`product`/`capabilities` 识别、版本绑定、owned-only 协议退出与回退、三通道与双仓 fixture 同步已落地；**屏幕可见层未跑**，故本 SPEC 尚未整体收口。
- MVP-11、MVP-12、MVP-13、KB-01：**NOT RUN**，仍未派发实施。

## 决策与进入条件

| 决策 | 当前状态 | 影响 |
| --- | --- | --- |
| 正式产品名、独立仓库名及位置 | 待用户决定；文档暂用 pet-shell | MVP-07 建仓、MVP-08 品牌资产 |
| 自用或对外分发 | 待用户决定 | MVP-07 依赖组合可行性、MVP-13 发行材料 |
| MVP-12 是否纳入、点击或文件输入范围 | 待用户决定 | 条件 SPEC；不阻塞无反向交互的基础路线 |

用户决定产品范围后仍须通过技术出口；不把决定等同于已证明兼容。Live2D 未通过技术/目标用途许可核查时，相关路径保持 BLOCKED，不擅自删减 0.6 DoD 或以 sprite 成果宣告 0.6 完成。

## 依赖与交付

| SPEC | 交付 | 前置 | 规划状态 |
| --- | --- | --- | --- |
| [MVP-07](specs/MVP-07.md) | 锁定基线、可复现构建、功能盘点、可行性、剪枝 | 决策及独立实施授权 | DRAFT |
| [MVP-10](specs/MVP-10.md) | 三个最小插件槽与默认实现 | MVP-07 相应基线/剪枝 AC | DRAFT |
| [MVP-08](specs/MVP-08.md) | 品牌、菜单、单实例、受管退出 | MVP-10；正式命名 | DRAFT |
| [MVP-09](specs/MVP-09.md) | 四端点兼容、身份/profile、Aiki 最小增量 | MVP-08/10 | DRAFT |
| [MVP-11](specs/MVP-11.md) | Live2D 与首种换装方式 | MVP-07 Live2D 可行性 PASS、MVP-09/10 | DRAFT |
| [MVP-12](specs/MVP-12.md) | 可选双向交互 | 用户选定范围、MVP-08/09；依赖 Live2D 时另需 11 | CONDITIONAL，未纳入 |
| [MVP-13](specs/MVP-13.md) | 真机、性能、打包及用途对应许可验收 | MVP-08～11；12 仅在纳入时要求 | DRAFT |

执行顺序：**07 → 10 → 08 → 09 → 11 → 13**。12 按冻结范围的实际依赖加入 13 之前。每次一份，四端点回归从 07 起持续进行，09 是综合兼容出口。可独立推进的 sprite 工作不代表 Live2D 阻塞已解除。

## 文件、验证与报告规则

- shell 源码只在待确定的独立仓库；Aika 仅允许 SPEC 明列的 adapter/profile/进程管理最小增量。不得恢复旧 PetApp 或扩大到 Agent、Memory、OCR 重构。
- 每份实施前登记实际源码路径与双仓完整 commit；本文的目录范围不是已存在文件的声明。契约变更同时记录版本、兼容方式和双方消费者。
- 报告统一为 `docs/integration/reports/MVP-xx_ACCEPTANCE.md`，实施后才创建。逐 AC 使用 PASS/FAIL/BLOCKED/NOT RUN，分 fixture、真实进程、device、real-provider、human；不得以草案完成冒充实现完成。
- 小阶段仅定向验证；13 才执行明确的组合验收。复用相同构建/配置的证据，注明来源和覆盖；新构建不得直接继承旧安装器结果。
- 0.5 产品与发布欠账仍以 [0.5 索引](SPEC_MVP_0.5.md) 为准；0.6 规划与实施不会自动清账。
