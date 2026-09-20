# Aika Next 0.61 SPEC 执行索引

日期：2026-09-20；状态：文档已拆分，全部开发 NOT RUN。

目录：[执行规则](#1-执行规则) · [任务](#2-任务与依赖) · [接口归属](#3-共享接口归属) · [验收](#4-验证与交接)

## 1. 执行规则

先读根 AGENTS、[总路线图](../RPD_ROADMAP.md)、[本版 RPD](RPD.md)、[源码盘点](SOURCE_AUDIT.md)，再读当前 SPEC。根 AGENTS 中 0.6 专属报告路径对本修复轮替换为 `docs/next/0.61/reports/`，其他 TDD、取消、来源、测试诚实性和禁止改旧库规则继续适用。

先固定 0.6 交付提交/可复现环境，再执行下表；一次一个 SPEC。建议顺序 01→02→03→04→05→06→07→08→09→10（依赖表为最小依赖，不授权自动并行改共享文件）。本次仅规划，不能把本索引当作已执行证据。

## 2. 任务与依赖

| SPEC | 任务 | 依赖 | 状态 |
| --- | --- | --- | --- |
| [FIX61-01](specs/FIX61-01.md) | 开放模型配置与生产接线 | 无 | NOT RUN |
| [FIX61-02](specs/FIX61-02.md) | 模型发现与配置表单 | FIX61-01 | NOT RUN |
| [FIX61-03](specs/FIX61-03.md) | 启动进度、停滞监视与重试 | 无 | NOT RUN |
| [FIX61-04](specs/FIX61-04.md) | 左右键分流与独立功能面板 | FIX61-03 | NOT RUN |
| [FIX61-05](specs/FIX61-05.md) | 多模型换肤与模型包生命周期 | FIX61-04 | NOT RUN |
| [FIX61-06](specs/FIX61-06.md) | 最小知识库导入、切换与上下文隔离 | FIX61-01、FIX61-04 | NOT RUN |
| [FIX61-07](specs/FIX61-07.md) | 模块健康状态与麦克风诊断 | FIX61-01、FIX61-02、FIX61-03、FIX61-04 | NOT RUN |
| [FIX61-08](specs/FIX61-08.md) | 逐 chunk 实时 ASR 与单次轮次提交 | FIX61-01、FIX61-07 | NOT RUN |
| [FIX61-09](specs/FIX61-09.md) | 冻结上下文前缀与异步更新 | FIX61-01、FIX61-06 | NOT RUN |
| [FIX61-10](specs/FIX61-10.md) | 版本自动收口与末尾人工验收 | FIX61-01～09 | NOT RUN |

## 3. 共享接口归属

| 所有者 | 契约 | 消费者与变更约束 |
| --- | --- | --- |
| 01 | SlotBinding / ProviderRegistry / configRevision / 凭据引用 | 02/07/08/09；不复制两份“当前模型” |
| 03 | backend_startup / generation / 进程关闭序列 | 04/07；ready 前进度可读，旧代消息不可用 |
| 04 | 功能面板 view / shell IPC | 05/06/07；统一来源校验与布局 |
| 05 | SkinStore / asset registry / model revision | renderer 与展示管理；不改角色/知识作用域 |
| 06 | KnowledgeLibrary / activeRevision / revocation | 09 和 0.7；切库/删除立即失效 |
| 07 | mic preference / 试麦租约 / HealthSnapshot | 08；设备试用与正式采集互斥 |
| 08 | voice_chunk / ack / inputSessionId / partial-final | 原 BackendSession/TurnController；最终仅提交一次 |
| 09 | PrefixSnapshot / historyWatermark / CAS publish | Provider、Memory lifecycle；保留来源与撤销检查 |

新接口是逻辑设计，不是已存在导出。公共类型、bridge 版本、持久化版本变化需附旧→新映射及所有消费者回归证据。后端内部 API 与 UI 路由均复用现有鉴权。

## 4. 验证与交接

所有 SPEC 提供逐条 AC；先 RED，再 GREEN，再受影响回归。既有测例归属见各 SPEC，源码基线变化后重新定位，不能按过期行号盲改。

新增 test:next61 及其测试目录是 FIX61-10 的交付，当前并不存在。此前单个任务可使用 `npm run build` 后 `node --test <实际编译后的测试文件>`；MJS 测例直接运行。不要提前把不存在的命令写成 PASS。

报告逐 AC 写命令、退出码、测试数量、失败原因、源码提交和 fixture hash；Fixture/真实本地 ASR/真实远程模型/人工验收分列。生产代码为被测对象，外部网络和设备可 fake，不能 fake 被修复的组合根来证明接线。

[FIX61-10](specs/FIX61-10.md) 管整版自动收口与唯一一次版本末人工验收。未运行标 NOT RUN，缺模型/凭据/构建资源标 BLOCKED，尚有必需阻塞不得宣布开发完成。

