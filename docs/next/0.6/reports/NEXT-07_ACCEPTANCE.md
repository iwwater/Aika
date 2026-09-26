# NEXT-07 验收报告 · 最小操作 UI

- 执行：goal worker（2026-09-20）。SPEC：[NEXT-07](../specs/NEXT-07.md)。需求：N06-R08。
- 状态：**AUTO_PASS**（本 SPEC 各 AC 全过；上游管理套件中的既有环境失败为基线行为，见 §4）。
- 基线：`2e87cdb`（NEXT-06 后）。产出：`management/aika-console.ts`（presenter）、`management/aika-routes.ts`（路由）、`management/ui/aika-view.mjs`（薄视图）、server.ts 三处最小接线、7 个用例（总计 70）。

## 1. 实际范围

- **presenter（纯逻辑，可全测）**：`AikaConsolePresenter` 消费 profile/provider 配置端口、TurnPort、Timeline 查询与语音可用性；不直接调用模型、不抽取 Memory。
  - 07-A 配置经端口读写；保存失败/非法值进 `lastError` 可见；state 中只有 credentialRef+credentialConfigured，正文剥离。
  - 07-B `sendText` 并发拒绝（恰一次命令）；状态只随生产 terminal（sending→completed/cancelled/failed）；failed 显示错误码后可再次发送；cancel 到达端口。
  - 07-C `setSession` 后旧会话迟到结果不覆盖当前视图；`dispose()` 解除全部订阅且停用响应。
  - 07-D Timeline 分页（cursor 追加）、cancelled/failed 状态展示、redact 后 text 缺失即不显示。
  - 07-E 语音后端缺失 → `voiceStatus: 'unavailable'`，不假装启用。
- **路由**：`aikaRoute`（GET/PUT `/api/aika/profile`、GET `/api/aika/timeline`）；server.ts 增 `options.aika` 分支 + `/aika-view.mjs` 静态映射 + 1 条 import——纯增量，既有分支未动。
- **薄视图**：`aika-view.mjs` 自包含页面（fetch/渲染/表单），不重写整套控制台；导航接线留 NEXT-09 人工验收（如实登记）。

## 2. 命令与退出码（cwd `windows/code/desktop-pet/`）

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `npm run test:next`（实现后） | 0 | 70 tests / 70 pass（63→70） |
| `npm run test:next`（第 2 遍） | 0 | 70/70；剥离耗时后两遍逐行一致 |
| `node --test dist/tests/management/server.test.js` | 0 | 2/2（覆盖改后的管理 server 路由/鉴权） |
| `node --test dist/tests/management/balance-http|project-routes|wechat-http` | 0 | 1/0、1/0、2/0 全过 |

## 3. 逐 AC

| ID | 结论 | 证据 |
| --- | --- | --- |
| 07-A | **PASS** | load/save 调用端口被记录；保存冲突 → lastError 可见并上抛；state 中 provider 仅 credentialRef/credentialConfigured（apiKey 被过滤断言） |
| 07-B | **PASS** | 空文本拒绝、并发第二发拒绝且 submit 恰 1 次；terminal 驱动 sending→completed→failed；failed 后第三发成功；cancel 计数 1 |
| 07-C | **PASS** | setSession('session-b') 后 session-a 的 completed 事件被忽略（状态仍 idle）；dispose 后 listenerCount 0 且不再响应 |
| 07-D | **PASS** | cursor 分页 2+1 条、cancelled 状态展示、redact 条目 text 恒 undefined 不显示 |
| 07-E | **PASS** | voice.available()=false → state.voiceStatus='unavailable' |
| 07-F | **PASS** | 装配测试：真实 AikaProfileStore+AikaTimelineStore（临时文件）+真实 NextTurnPort+Recorder+真实 management 适配器——saveProfile 落盘 JSON 复核、sendText→真轮 completed→Timeline 恰两条；另有 aikaRoute 直连真实 stores 的路由用例 |

## 4. 上游管理套件既有问题（stash 对照实验，非本轮回归）

server.ts 变更需回归上游管理套件。全量 16 文件串行运行时 `memory-dynamics-http.test.js` **挂起**；`settings.test.js` 2 例断言失败（438!==384）；`integration.test.js` 2 例失败（`EPERM symlink node_modules`——Windows 需管理员/开发者模式；`EBUSY` 文件锁）。**对照实验**：`git stash` 暂存本轮全部改动后同环境重跑，`memory-dynamics-http` 仍挂起、`settings` 仍 4 过 2 败——均为本机既有状态，与本轮无关。受影响回归面改用直接覆盖 server.ts 的 `server.test.js`（2/2）+ balance/project/wechat-http（全过）作为证据；`settings`/`memory-dynamics-http`/`integration` 登记为基线环境问题，建议在 NEXT-08 收口时以管理员环境或上游原始环境复核。

## 5. 已知限制与待办

1. 管理控制台导航未加入 Aika 页入口（app.mjs 渲染管线未动）；页面文件已可经 `/aika-view.mjs` 访问，最终 UX 走 NEXT-09 人工验收。
2. 文本发送/语音启停在桌宠窗口沿用上游既有交互入口（bridge submit_text/start_voice），管理页不做第二套发送通道。
3. `settings.test.js`/`memory-dynamics-http`/`integration.test.js` 的本机失败按 §4 登记，归入 NEXT-08 收口清单。
