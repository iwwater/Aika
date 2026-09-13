# GOAL 最终状态汇总（Wave 8）

日期：2026-09-13。执行方式：goal worker 自动执行（每 SPEC 一次 commit，未推送）。
执行计划：波次 0～8（docs/GOAL_EXECUTION_PLAN.md）；持久账本：docs/GOAL_RUN_LEDGER.md。
最终回归：`npx vitest run src` → 116 文件 1301~1312 区间增长至 **119 文件 1312 测试通过、1 skip（既有）**；`npx tsc --noEmit -p tsconfig.json` → **0 错误**。按开发规范未循环全仓 build/Tauri 打包。

## 一、状态总览（按分类计数，节点明细见 GOAL_RUN_LEDGER.md 波次表）

| 分类 | 数量 | 节点 |
| --- | --- | --- |
| **AUTO_PASS**（可自动 AC 全过，待人工审阅） | 27 | Wave 3：LLM-04、LLM-11、LLM-12、TTS-04、FE-23、FE-24、FE-25、FE-26；Wave 4：RT-01、RT-02、RT-03、RT-04、GW-01、GW-02（fixture）、GW-03、GW-05（fixture）、GW-06（fixture）；Wave 5：FE-14、FE-17-pre、GW-04；Wave 6：AGT-01、AGT-02、AGT-03（fixture）、AGT-04（fixture）、AGT-05；Wave 7：RT-05、RT-06 |
| **PARTIAL** | 4 | Wave 2：INT-01（自动契约 PASS；浏览器/Tauri/手机/真实 Provider 四列 NOT RUN）；Wave 3：LLM-05（AC-D 真实模型 NOT RUN）；Wave 5：FE-15（A 过；B/C/D/E 需真实 Rust 宿主）；Wave 7：INT-04（fixture 轨 PASS；真实轨需授权） |
| **REVIEWED_AUTO**（波次 1 既有工作复核，非本轮实现） | 34 | CORE-01～09、LLM-01～03、LLM-06～10、STT-01/02/04、TTS-01/02、FE-01～13（复核发现的出入已在账本逐条记录，如 LLM-01 六条质量失败待修、CORE-04 行数漂移、FE-06 弱项等） |
| **FAIL** | 0 | 本轮无 FAIL 遗留（过程中 FAIL 均已定向修复，如架构门禁违规重构、内核拒启动漏声明等） |
| **NOT RUN**（真实宿主/凭证/授权缺失） | 15 项 | 真实 Tauri plugin-sql 迁移与长跑（INT-01/RT-02/RT-05）；真实 Provider 计费比对（LLM-12/FE-26）；真实模型质量（LLM-01/05/10 部分）；真实 ACP 进程与 Windows Job Object（AGT-02/03）；真实 Telegram/Feishu/QQ 双向消息（GW-02/05/06）；真实语音音质（STT/AGT）；Rust gateway.rs handler 与手机页（FE-15 B~E）；FE-16 dev-relay；FE-17-host/tauri 与 dev-relay；INT-04 真实轨 |
| **BLOCKED**（外部条件/授权） | 4 项 | public 暴露层（无真实 TLS 证据，策略层已实现恒拒绝）；QQ 官方能力缺口（C2C 审核/文件语音受限/个人 QQ 私聊不在官方范围）；真实账户接通（Telegram/Codex/Claude/Feishu/QQ 全部需用户明确授权）；真实只读写能力验证 |
| **DEFERRED**（用户明确后置，维持后置） | 6 项 | 桌宠/Live2D 回顾、环境感知（FE-18~22 五份草案未评审）、Stage3、云 Relay、GW LAN 自动 Discovery（手填地址已交付）、每主体独立记忆库（RT-04 已做来源分级） |

## 二、本轮新增能力（Wave 3~7 实现，全部走生产代码 + 定向/里程碑回归）

1. **LLM-12 用量台账 + FE-26 成本页**：per-attempt UsageRecordV1（幂等 upsert、coverage 三态、legacy scope）、双 store 一致性用例包、透明采集门控；成本页按日/Provider/模型/用途汇总、版本化价目、币种分列、错误率与最慢尝试语义。
2. **RT-01~04 身份与运行时**：SourceEnvelope（trust brand 型约束）、身份六类型、HostLifecycle 三态；绑定服务（一次性码/防暴力/撤权即失效）、会话 scope 存储（try-ALTER 迁移）、Runtime 多会话化（单生成槽+有界队列+cancel 归属校验）、memorySource 授权门；Permission Runtime（决策/执行两终态、原子认领、Windows 路径边界）。
3. **GW-01~06 渠道**：Channel Gateway（inbox 六态/重放防御/unknown 不自动重跑）、Telegram/Feishu/QQ 适配 fixture 轨（验签重放/能力快照/限流负例）、附件管道（AudioTranscriptionPort 与麦克风分离）、投递策略（静默/冷却/群私隔离/完成事件去重）。
4. **FE-14~17 远程**：OutboundGateway 白名单投影（cursor 单调/重放去重/trace 四门/慢消费者限额）+ conformance 包；tauriTransport（fake invoke/listen 复跑 conformance）；凭证仓库与暴露面纯策略（public 无 TLS 证据恒 BLOCKED）。
5. **AGT-01~05 Agent 链**：Session/Run 状态机分离、ACP 客户端（协议映射/六类终态/permission 原 id）、adapter manifest 与双适配器注册表（认证隔离/失败隔离）、TaskCommand facade（workspaceRef 白名单/重放去重/审批单次绑定凭据/进度节流）。
6. **INT-04 fixture 链路**：生产入口→manager→fake ACP→canary→审批→原渠道投递的完整链路 + 负例先行 + 入口×适配器矩阵。

## 三、下一步人工清单（按优先级）

1. **审阅本轮 27 个 AUTO_PASS 报告与代码证据**（docs/*/reports/，账本含逐节点指针）；AUTO_PASS 仅代表可自动 AC 通过，不代表人工验收通过。
2. **INT-03 发布门禁独立完成**（INT-04 已声明不代偿；真实部署前必须单独过门禁）。
3. **授权真实账户后执行真实轨**：Telegram Bot token（GW-02 真实双向）→ Codex/Claude 账户（AGT-03 真实版本探测与写模式）→ INT-04 真实轨（可控失败项目修复 diff + 测试命令退出码）。
4. **Tauri 宿主工程**：src-tauri gateway.rs/remote.rs 路由实现（events/commands + 凭证接线，FE-17-pre 端口已就绪）、手机页迁移（FE-15 B~D）、FE-17-host/tauri 逐宿主验收；plugin-sql 真实迁移验证（RT-02 try-ALTER）。
5. **Node dev-relay**（FE-16）→ FE-17-host/dev-relay 验收；public 层需真实 TLS 入口与后端不可直连证据，否则维持 BLOCKED。
6. **真实 Provider 凭证**：LLM-05 AC-D 真实模型问答、LLM-12/FE-26 真实计费比对、STT 真实音质（人工队列）。
7. **GW-04 设备端到端**：Android/Web 终端连真实宿主（租约/重连/能力降级的真机目视）。
8. **DEFERRED 项重启需用户明示**：桌宠/Live2D、环境感知 FE-18~22、Stage3、云 Relay。

## 四、诚实性声明

- AUTO_PASS 只表示「所有可自动 AC 通过且待人工」，不表示人工验收通过或发布可用。
- fixture 轨通过不代表真实渠道/真实账户已上线；真实轨全部独立 NOT RUN/BLOCKED 并需明确授权。
- 无 FAIL 遗留；无编造真实样本；未运行真实外部服务、未产生费用、未开放公网。
