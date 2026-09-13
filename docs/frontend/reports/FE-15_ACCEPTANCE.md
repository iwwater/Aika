# FE-15 · Tauri HTTP 传输与手机页迁移 — 验收报告

日期：2026-09-13。执行者：goal worker（自动）。状态：**PARTIAL —— FE-15-A PASS（TS 传输 + conformance）；B/C/D 的 Rust 侧已实现并通过单元测试，但真实 Tauri 进程启动/手机目视 NOT RUN；E 的宿主装配与主窗门禁仅完成 Rust 侧约束，真实多 WebView 场景 NOT RUN。整体不写全 PASS。**

> 本报告覆盖 N2 步骤（src-tauri/gateway.rs + remote.rs 路由 + lib.rs 装配 + mobile/index.html）。
> 此前 FE-15 只有 A 项本地部分（`tauriTransport.ts`），B~E 全部 NOT RUN；本次补齐了 B/C/D 的 **Rust 实现与可自动验证部分**。

## 改动范围

| 文件 | 内容 |
| --- | --- |
| `src-tauri/src/gateway.rs`（新增） | 宿主侧远程网关纯逻辑：`FrameBuffer`（**500 帧 + 4MB 双上限**，超限丢最旧并计数）、`GatewayState`（epoch/会话表/全局单调 seq/心跳在线性）、`read_events`（epoch 变化或 cursor 过期**明确报 gap**）、`admit_command`（未登记会话→Unauthorized、Runtime 离线→**503**、超限→400）、`check_origin`（fail-closed）、`classify_route`、`session_summaries`（脱敏：无正文无凭证） |
| `src-tauri/src/remote.rs`（最小改） | 路由分发重写：`GET /` 公开 → **统一鉴权门** → `classify_route` 分派到 Events/Commands/History/Legacy/NotFound。新增 `GET /api/v1/events`（长轮询 ≤25s，200ms 分片醒来查停止标志与是否有帧）、`POST /api/v1/commands`（202 accepted / 503 offline / 401 / 400）、`GET /api/v1/history`。新增 5 个 invoke 命令（`outbound_publish`/`outbound_heartbeat`/`outbound_offline`/`outbound_revoke`/`outbound_sessions`）。`remote_start` 增加 `allowed_origins`/`lan_enabled`（默认 **只绑 loopback**） |
| `src-tauri/src/lib.rs` | 注册 `mod gateway` 与 5 个新 invoke 命令 |
| `src-tauri/mobile/index.html` | 迁移到新协议：长轮询 `/api/v1/events`（带 epoch/cursor、处理 `gap`、`runtimeStatus`）+ `POST /api/v1/commands`（202 语义）+ 首屏 `/api/v1/history`。**不再调用 `/api/messages`、`/api/send`**；用 turnId 做消息键，status/reply/settled 不再各造一条 |
| `src/services/outbound/tauriTransport.ts` | 对齐 Rust 命令签名：`invoke("outbound_publish", { input: { principal_id, connection_id, conversation_id, frame, epoch } })`；新增 `gatewayEpoch`/`principalId` 选项 |
| `src/services/outbound/tauriTransport.test.ts` | fake invoke 对齐新参数形状 |

## 测试命令与退出码

| 命令（cwd） | 退出码 | 结果 |
| --- | --- | --- |
| `cargo test --lib`（`src-tauri`） | 0 | **18 passed, 0 failed**（gateway 13 + remote 3 + secret_store 2） |
| `cargo check --lib`（`src-tauri`） | 0 | Finished，**零 warning** |
| `npx vitest run src/services/outbound`（`aika-crossplatform`） | 0 | **43/43**（含 FE-14/15/16/17-pre） |
| `npx vitest run`（全量） | 0 | 120 文件通过，**1335 passed \| 4 skipped** |
| `npx tsc --noEmit` | 0 | 无错误（`LEN=0`） |
| 手机页 `<script>` 语法解析（node `new Function`，不执行） | 0 | `SYNTAX_OK` |

## 逐 AC 分列

### FE-15-A —— PASS（本地，fake invoke/listen）

`tauriTransport` 在 fake invoke/listen 下复跑 FE-14 conformance 六用例全过；退订后无迟到业务回调。本次因对齐 Rust 参数形状，`publish` 的 fake 断言改为读 `input.connection_id`（`connectionId` 是 TS 侧投递目标标识，Rust 只用它做诊断字段，不参与授权）。

### FE-15-B —— PASS（Rust 单元，真实 HTTP 端到端仍 NOT RUN）

| 要求 | 实现与证据 |
| --- | --- |
| 缺/错/撤销会话 | `admit_command` 未登记会话 → `Unauthorized("session-unknown")`；`revoke_principal` 清空该主体全部会话且其后读/命令均失败（`revoked_session_is_not_readable`） |
| 错误 Origin | `check_origin` fail-closed：白名单外 → `bad-origin`，空白 → `missing-origin`，**无 Origin 不自动放行私有数据**（交给 token 门继续判断）。`handle` 中 Origin 校验在鉴权之前（403） |
| 超大 body | `MAX_BODY_BYTES=256KB`；`admit_command` 超限 → `Rejected("body-too-large")` → 400（`oversized_body_is_rejected`） |
| 旧路由不能旁路 | `classify_route` 把 `/api/messages`、`/api/send` 归 `Legacy`，**与 v1 路由同一个鉴权门**；`?t=` 只作为本次请求凭证，不再授予长期权限 |
| 合法 cursor 增量准确 | `FrameBuffer::since(after)` 只返回 `seq > after` 的帧；顺序与 cursor 单调由测试断言（`truncated_cursor_reports_gap...`） |

### FE-15-C —— PASS（Rust 单元，真实并发端到端仍 NOT RUN）

| 要求 | 实现与证据 |
| --- | --- |
| 超 500 帧限额 | `MAX_BUFFER_FRAMES=500`，超限丢最旧并累计 `dropped`（`buffer_drops_oldest_beyond_frame_limit`：推 520 帧后剩 500，oldest=21） |
| 字节限额 | `MAX_BUFFER_BYTES=4MB`，同样丢最旧（`buffer_respects_byte_limit`） |
| 超限返回可识别 gap | `since()` 在 `after+1 < oldest` 时返回 `truncated=true` → HTTP `gap: true`（`truncated_cursor_reports_gap_instead_of_pretending_continuous`） |
| 过期 cursor | 同上路径；空缓存但历史上丢过帧也报 gap |
| epoch 重启 gap | `read_events` 中 client epoch ≠ server epoch → 恒 `gap: true` 且不返回帧（`epoch_change_forces_resync`） |
| 各会话隔离 | 会话键 = `principal:conversation`；读/缓存/撤销均按该键。cursor **全局单调、跨会话不重置**（`cursor_is_monotonic_across_sessions`） |
| 长轮询不阻塞 POST/stop | 每个请求**单独线程**；长轮询循环每 200ms 检查 `running.stop`，总等待 ≤25s；不持有全局锁（`GatewayState` 锁只在单次读/写内持有）。**真实并发压力 NOT RUN** |

### FE-15-D —— PARTIAL（本地实现完成，真机目视 NOT RUN）

- 手机页**只用新协议**：`/api/v1/events`（长轮询）+ `/api/v1/commands`（202）+ `/api/v1/history`（首屏）。
- 功能对齐：发送（messageId 客户端生成、重放去重由宿主+TS 双层保证）、历史（首屏拉一次）、回复（reply 帧的 `replyText`/`translation`）、error（只显示白名单 `code`，**不显示任何内部 message**）。
- `gap` 显示为「连接重新同步中…」；`runtimeStatus: offline` 显示为「电脑上还没配置模型」，**不伪称在线**。
- 已实测：JS 语法解析 `SYNTAX_OK`；无任何残留的旧路由调用（grep `/api/messages|/api/send` 无命中）。
- **NOT RUN**：真实 iOS/Android Safari/Chrome 上的目视、真机长轮询行为、真机中文输入与自动增高。归人工队列。

### FE-15-E —— PARTIAL（Rust 侧约束成立，真实多 WebView NOT RUN）

- **平台选择只在宿主装配**：`selectHostPlugins`（`app/hosts/index.ts`）是唯一按平台分叉处，本次未新增第二处。
- **非主窗口不能发布帧**：`outbound_publish` 目前对所有 invoke 调用方开放（Tauri 默认单主窗）。**真实「第二个 WebView 调用被拒」未验证**——这需要多窗场景，NOT RUN。
- **Runtime 离线不执行/不假确认**：`runtime_online()` 同时看**声明 + 心跳新鲜度**（30s 超期即离线）；离线时 `admit_command` → `RuntimeOffline` → HTTP **503**，绝不返回 202（`commands_require_live_runtime_and_known_session`、`runtime_goes_offline_without_heartbeat`）。

## 未执行 / 待人工

- **真实 Tauri 进程启动**：`cargo run` / `tauri dev` 起真实宿主、真实 `remote_start` 监听、真实手机连接——NOT RUN（本步骤只做库编译与单元测试，未启动 GUI 进程）。
- **真实 HTTP 端到端**：curl/手机对 `/api/v1/events`、`/api/v1/commands` 的真实请求—响应—长轮询时序——NOT RUN。
- **真实并发压力**：多客户端同时长轮询是否影响 POST/stop 的实测——NOT RUN。
- **手机目视**：FE-15-D 全部真机项——NOT RUN。
- **多 WebView 越权**：FE-15-E 的「非主窗口不能发布帧」——NOT RUN。
- **plugin-sql 真实迁移、局域网手机列 INT-01**：按 SPEC 归 INT-01，NOT RUN。
- **状态口径**：FE-15-A 为 **PASS**；B/C 为 **PASS（Rust 单元）** 但真实端到端 NOT RUN；D/E 为 **PARTIAL**。整体 **PARTIAL**，不写全 PASS。

## 共享接口影响

- **TS 侧**：`TauriTransportOptions` 新增两个**可选**字段（`gatewayEpoch`、`principalId`）；`publish` 的 invoke 参数形状由 `{target, frame}` 改为 `{input: {...}}`。消费者只有 `tauriTransport.test.ts`（已同步）。**`contracts.ts` 的 FE-14 契约未改**。
- **Rust 侧**：`remote_start` 新增两个可选参数（`Option<Vec<String>>`/`Option<bool>`）；新增 5 个 invoke 命令与 4 个新路由。前端目前**尚未调用**新 invoke（宿主装配接线属后续 FE-17-host/tauri 步骤）。
- **`docs/modules/CONTRACTS.md`**：需登记 FE-15 宿主侧追加表（见下）。

## 复现命令

```powershell
# Rust 侧
Set-Location F:\AIVoice\Aika\aika-crossplatform\src-tauri
cargo test --lib     # 18 passed
cargo check --lib    # exit 0, 零 warning

# TS 侧
Set-Location F:\AIVoice\Aika\aika-crossplatform
npx vitest run src/services/outbound   # 43/43
npx vitest run                         # 1335 passed | 4 skipped
npx tsc --noEmit                       # exit 0
```
