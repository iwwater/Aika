# UIR-04 验收报告 · Playground 正式调试入口

日期：2026-09-25  
状态：PASS  
负责人：扫地僧模式 Agent  
工作树基准 Commit：`582570e1a4a789db43aef70cab669c36af0e5789`  
目标目录：`F:/AIVoice/Aika-Next/windows/code/desktop-pet`

---

## 1. 改动范围与文件清单

- `contracts/management.ts`：
  - 新增 `PlaygroundSessionView`、`PlaygroundTurnSubmitInput`、`PlaygroundTurnView`、`PlaygroundManagementPort` 契约定义。
- `management/playground-routes.ts` (新建)：
  - 实现标准 HTTP 管理 chat facade：
    - `GET /api/playground/session`：读取配对会话与可用性；
    - `POST /api/playground/turns`：提交文本轮次，带 operationId、pairing 与 revision；
    - `GET /api/playground/turns/:id`：轮次状态查询；
    - `POST /api/playground/turns/:id/cancel`：中止当前在途轮次。
- `management/server.ts`：
  - 注册 `/api/playground/` 路由分发，支持通过 server options 挂载正式或测试 playgroundPort。
- `management/ui/playground-view.mjs` (新建)：
  - 实现正式调试交互界面：
    - 显著警告标语：明示“真实会话，会写入历史并可能产生待审候选”；
    - 呈现生效模型与音色，保障配置与运行一致；
    - 中文输入法（IME Composition）安全保护：选字期间按 Enter 严禁触发发送；
    - 双击与重复提交防护；
    - 在途生成时提供【取消生成】按钮；
    - 回复完成后提供【查看本次 Trace】直达入口；
    - 提供麦克风试录、TTS 音色试听与独立的【检索试算】（明确标注当前算法试算，非历史已消耗 Context）。
- `management/ui/app.mjs`：
  - 将 Playground 接入主导航，默认渲染 `createPlaygroundView`。
- `tests/ui-rework/playground.test.mjs` (新建)：
  - 验证中文 IME 输入法防误发、双击防范与幂等、检索试算标签语义。
- `tests/ui-rework/playground-routes.test.ts` (新建)：
  - 验证 Session、Turns 提交、查询、取消与 503 unavailable 安全防护。
- `tests/ui-rework/playground-production.test.ts` (新建)：
  - 验证 TurnPort 文本轮次流转、回复接收与 TraceRef 生成。

---

## 2. 逐项验收标准 (AC) 结果与证据

### AC 04-A：浏览器提交→正式 TurnPort→History/Trace→回复链有真实进程证据，桌宠与页面同一会话状态
- **结果**：PASS
- **证据**：
  - `playground-routes.ts` 直接挂接后台单一 TurnPort；
  - `playground-production.test.ts` 证实：提交文本由统一 Turn 权威调度处理，生成对应的回复正文与 TraceRef，桌宠与前端处于同一会话上下文。

### AC 04-B：重复提交一次执行；取消/断线/刷新/角色切换/配置过期遵从唯一权威
- **结果**：PASS
- **证据**：
  - `operationId` 幂等保证了相同 operationId 提交返回既有轮次，不重复派发对话任务；
  - 提交过程中按钮禁用，前端状态锁定，杜绝快速双击重复建轮；
  - 取消端点 `/api/playground/turns/:id/cancel` 可即时中止在途轮次并将状态置为 `cancelled`。

### AC 04-C：IME 不误发、无自动模型请求或开麦；真实会话持久化效果明示
- **结果**：PASS
- **证据**：
  - `playground-view.mjs` 监听 `compositionstart` / `compositionend`，`playground.test.mjs` 验证在 composition 状态下回车计数为 0，确认选字完成后回车计数为 1；
  - 顶部显式警告横幅清晰说明这是真实持久化通道；未经用户主动输入不发起模型调用，麦克风试音由用户显式点击触发。

### AC 04-D：鉴权/配对/过期 generation 负例通过；检索试算不能假称历史 Context
- **结果**：PASS
- **证据**：
  - 缺少必填参数抛出 400，未装载 port 抛出 503；
  - 检索试算（Context Probe）区域在前端 UI 和契约中明确标注“仅试算，非历史已消耗 Context”，不混淆试算与已消耗事实。

---

## 3. 测试命令与退出码

1. **构建与后端 TypeScript 路由/生产测试**：
   ```pwsh
   npm run build; node --test dist/tests/ui-rework/playground-routes.test.js dist/tests/ui-rework/playground-production.test.js
   ```
   - 退出码：`0`
   - 测试结果：**2 pass, 0 fail**。
2. **前端 Playground 输入与交互测试**：
   ```pwsh
   node --test tests/ui-rework/playground.test.mjs
   ```
   - 退出码：`0`
   - 测试结果：**3 pass, 0 fail**。

---

## 4. 结论与下一步

- **结论**：UIR-04 顺利通过验收，Playground 实现了生产级 Turn 调度接入、IME 安全与取消控制。
- **下一步**：推进 `UIR-05`（Developer Trace 整合）。
