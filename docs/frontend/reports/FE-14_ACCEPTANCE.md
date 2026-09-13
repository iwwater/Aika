# FE-14 · 远程协议内核与受控消息投影 — 验收报告

日期：2026-09-13。执行者：goal worker（自动）。状态：**AUTO_PASS（自动 AC 全过，待人工审阅；真实传输归 FE-15/16）**。

## 改动范围

| 文件 | 内容 |
| --- | --- |
| `aika-crossplatform/src/services/outbound/contracts.ts`（新增） | `OutboundFrameV1`（channel=reply/status/trace 判别、schemaVersion=1、cursor、可选 turnId/conversationId）、`RemoteReplyV1`（白名单四字段）、`RemoteStatusV1`（code/state/requestId 白名单）、`RemoteTraceV1`（仅元数据）、`OutboundCommandV1`（submit/ping）、`AuthenticatedCommand`（principal 带外注入、conversation 从服务端映射）、`AuthorizedTarget`、`OutboundTransport`、`OUTBOUND_TEXT_MAX_CODEPOINTS=4000` |
| `aika-crossplatform/src/services/outbound/outboundGateway.ts`（新增） | `createOutboundGateway`：Runtime 事件→帧映射（generated→reply 白名单投影（actions 只留 sticker 类型，**memoryCandidates/内部数据结构性地不在投影里**）；settled/error→status 白名单（error.message 永不外发）；replyDelta 不外发）；turnId→授权目标映射（未映射零外发、TTL 清理）；cursor（epoch+seq 单调递增，过滤空洞非 gap）；命令（校验矩阵、principal+conversation+messageId 去重、submit 进统一 facade（scope=命令主体、mode=configForConversation 会话已保存配置）、ping 回原连接）；trace 四门（本地采集+远程外发+主体授权+显式订阅，全开才外发仅元数据投影）；慢消费者缓冲（帧数/字节上限、丢弃计数诊断） |
| `aika-crossplatform/src/services/outbound/outboundPlugin.ts`（新增） | `OutboundGatewayToken`；transport 缺失=帧无人消费（启动不受阻）；**命令授权端口缺失时不接命令**（fail-closed） |
| `aika-crossplatform/src/services/outbound/outbound.conformance.ts` + `.test.ts`（新增） | transport 一致性用例包（FE-15/16 复用）：定向投递、未映射零外发、cursor 单调且保留 Runtime 顺序、重放零重复+ping 回原连接、校验矩阵、退订隔离；内置内存 transport 复跑 |
| `aika-crossplatform/src/app/runtimeFacade.test.ts` | facade 白名单补 `services/outbound/outboundGateway.ts`（仅 type-only import RuntimeEvent） |
| `docs/modules/CONTRACTS.md` | 登记 FE-14 追加表 |

## 测试命令与退出码

| 命令（cwd: aika-crossplatform） | 退出码 | 结果 |
| --- | --- | --- |
| `npx vitest run src/services/outbound` | 0 | 2 文件 11 测试全过（conformance 6 + gateway 单测 5） |
| `npx vitest run src`（里程碑回归一次） | 0 | 106 文件 1237 测试通过、1 skip（既有） |
| `npx tsc --noEmit -p tsconfig.json` | 0 | 无错误 |

**突变验证（隔离副本变异→定向用例当场红→恢复）**：① 投影放行 memoryCandidates → 「定向投递」用例红；② cursor seq 恒 1 → 「cursor 单调」用例红。两次均命中，恢复后全绿（`git diff` 干净）。

## 逐 AC 证据

- **FE-14-A**：generated/state/settled/error 映射断言（conformance「定向投递」「cursor 单调」）；reply 白名单 JSON 深度不含 memoryCandidates/候选文本；error 帧只有 code+retryable 投影。
- **FE-14-B**：cursor 单调、跨轮不重置、epoch 重启变化（gateway 单测「epoch 重启变化」断言两实例各自 epoch 与独立起点）；未映射轮次零外发；同轮帧序=Runtime 序。
- **FE-14-C**：submit 进统一 facade（scope/会话 mode 断言）；同 messageId 重放 → `duplicate`、Runtime submit 只收到一次；跨身份提交（B 冒用 conv-A）→ scope principal 为 B 本人（隔离由 RT-02 兜底）；ping 帧回原 connectionId。
- **FE-14-D**：畸形 body/版本 2/未知 type/空文本/4001 码点全部拒绝且后续正常命令可执行。
- **FE-14-E**：四门逐一关闭断言零 trace 帧；全开仅元数据投影（无正文字段）；远程正文默认关，v1 投影结构上无正文，includeText 不连带。
- **FE-14-F**：principal 缺失 → `unauthorized`；plugin 在无授权端口时不接命令（fail-closed）；transport 缺失启动不受阻；facade 门禁白名单更新后 `runtimeFacade.test` 通过。
- **FE-14-G**：conformance 包六用例（定向/顺序/重放/校验/退订/慢消费者丢弃计数）对内置内存 transport 全过；FE-15/16 传输必须复跑同一份。

## 未执行 / 待人工

- 真实传输（Tauri WebSocket / dev-relay）与真实认证（token/会话映射）归 FE-15/16/17-pre；分页 gap 元信息的线上表达归真实传输实现。
- 突变验证按约定执行两处代表性变异；未做全量突变扫描（历史约定为代表性抽查）。
- 状态：AUTO_PASS = 所有可自动 AC 通过；完整验收待人工，不代表远程功能可用。
