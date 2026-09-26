# 联调现场问题排查与技术归因记录 (2026-09-23)

> **原则说明与证据边界**：根据用户要求，本文档记录现场排查归因与问题定位。2026-09-23 依据 Review 进行严谨校准：
> 1. 本目录当前以文本证据与源码分析为主，未随仓库持久化提交用户原始截图与二进制网络抓包实体文件；
> 2. 撤回过度武断的结论（如“100% 服务商问题”、“4.6 秒播放结束”）；
> 3. 所有技术问题映射至 [RP75 修复计划](../REPAIR_PLAN_20260923.md)。

---

## 1. 现象概览与问题索引

| 序号 | 截图与用户反馈 | 定位模块 | 核心原因结论 | 归属与修复方向 |
| :-: | :-- | :-- | :-- | :-- |
| **Q1** | 右键菜单点击「外观/换肤」「配置」「知识库」弹出：“当前为离线预览，控制台暂不可用；请启动真实桌宠服务后重试。” | `desktop/electron/main.mjs`, `tools/dev-desktop-real.mjs` | `dev-desktop-real.mjs` 启动参数写死了 `--preview` 且未注入会话配置，Electron 侧短路拦截；控制台另起独立服务 | 统一由 `trial-backend` 唯一真实启动，生成并注入管理 session（RP75-01） |
| **Q2** | 知识库“能看也能删”功能需求确认 | `memory/knowledge-library.ts`, `management/server.ts` | 知识库已有文档与库删除实现（含修订更新）；缺失的是正文检视、分页投影与在途失效闭环 | 补受控正文查看与在途失效验收，复用现有删除逻辑（RP75-06） |
| **Q3** | “想一想…”气泡显示问题 | `desktop/index.html`, `desktop/style.css`, `desktop/main.mjs` | ① CSS 固定定位在右上角与窗口/模型贴边遮挡；② 请求耗时或异常时，指示器无超时机制卡死展示；③ 缺乏独立对话气泡 | 优化动态锚定、超时保护与终态状态机（RP75-07） |
| **Q4** | “希望回复后面可以不用这个呼唤出来的对话前端” | `desktop/main.mjs`, `desktop/index.html` | 当前回复仅能展示在底部抽屉式（Chat Drawer）文本列表中，缺乏头顶轻量浮动气泡（Speech Balloon） | 确立免大抽屉的桌面浮动气泡（RP75-07） |
| **Q5** | 对话报错：`大模型请求异常: Provider stream error`，耗时 31733ms | `providers/transport.ts:117`, 服务商接口 | 传输层捕获到 SSE 流返回 `chunk.error`，阶段耗时 31.7s；不能排除超时配置或上游异常 | 记录结构化脱敏错误码，不妄断责任归属（RP75-03） |
| **Q6** | Trace 页面展示与阶段表达问题 | `core/trace-store.ts`, `management/ui/views.mjs`, `real-backend.mjs` | ① 阶段串行展示导致用户误解总时长（文字到达 4.6s vs 后台提炼 4.3s 未分流；无音频播放回执）；② 失败轮次显示错误回复 digest | 拆分前后台耗时、区分文字到达与音频回执（RP75-03/08） |
| **Q7** | 控制台“表情与动作”页面报错：“没有这个管理操作。” | `management/server.ts:98`, `tools/serve-management.mjs` | 独立控制台脚手架未注入 `options.presentation` 实例，触发 404 not_found | 统一由正式组合根提供完整服务，消除独立服务差异（RP75-01） |

---

## 2. 深度排查细节与源码证据

### 问题 1：桌宠右键功能无法跳转控制台（截图 1 & 截图 7）

#### 源码证据
1. `windows/code/desktop-pet/desktop/electron/main.mjs` 第 172-176 行：
   ```javascript
   case 'open_management':
     if (preview) { deliver('managementResult', { ok: false }); break; }
     if (value.path !== undefined && ...) { deliver('managementResult', { ok: false }); break; }
     void managementUrl(process.env.PET_TRIAL_CONFIG)
   ```
2. `windows/code/desktop-pet/tools/dev-desktop-real.mjs` 第 8-16 行：
   ```javascript
   delete env.PET_TRIAL_CONFIG;
   delete env.PET_TRIAL_ACTIVATION;
   const child = spawn(electron, [
     ...,
     '--backend', fileURLToPath(new URL('./real-backend.mjs', import.meta.url)),
     '--preview', // <--- 关键点：传入了 --preview！
   ]);
   ```
3. `windows/code/desktop-pet/desktop/main.mjs` 第 93 行：
   ```javascript
   } else {
     const message = '当前为离线预览，控制台暂不可用；请启动真实桌宠服务后重试。';
     $('function-notice').textContent = message;
     showToast(message);
   }
   ```

#### 根因剖析
- 开发者启动脚本 `dev-desktop-real.mjs` 沿用了离线预览启动脚本 `dev-desktop.mjs` 的参数，将 `--preview` 传给了 Electron；
- Electron 检测到 `preview === true`，在收到桌宠渲染进程的 `open_management` 请求时，**硬编码短路拦截**，直接返回 `{ ok: false }`；
- 渲染层收到 `{ ok: false }` 后，根据本地文案直接弹窗提示：“当前为离线预览，控制台暂不可用”。
- **修复方案**：`dev-desktop-real.mjs` 移除 `--preview`，并挂载 `PET_TRIAL_CONFIG` 指向有效的管理端 session 配置文件。

---

### 问题 2：知识库功能需求（“能看也能删”）确认

#### 分析结论
- **完全需要，且为 0.75 N075-10 的强制核心契约**。
- **与已有实现的关系**：
  - 代码库中 `memory/knowledge-library.ts:195–220` 已经具备文档与知识库删除实现（包含版本修订 `revision` 更新）；
  - **真正的缺口**：现有接口仅提供列表元数据，缺乏受控的正文检视与分块投影 API；且文档删除后，在途 Context 与后续检索必须立即失效。
  - 当前表结构与 selection 是按正文现算分块，不存在外挂向量库或持久化 FTS 索引，因此不需要也不应“重造一套删除机制”或试图清理不存在的索引。
- **与记忆系统的严格边界**：
  - **知识库（Knowledge Library）**：用户主动导入的外挂文本、参考文档（Markdown / TXT）。用户对文档拥有完整的所有权，必须支持**列表查看、原文检索、内容分块检视、一键完全删除**；
  - **长期记忆 / Wiki（User Soul / Wiki）**：AI 提炼的用户长期事实。其删除与纠正走严格的隐私生命周期（`forget` / `correction` / `PendingMutations`）。

---

### 问题 3 & 4：气泡显示问题与免抽屉直接回复诉求（截图 4）

#### 源码现状
- 思考气泡定位在 `windows/code/desktop-pet/desktop/style.css` 第 88 行：
  ```css
  #thinking-indicator {
    position: absolute;
    top: 24px;
    right: 10px;
    ...
  }
  ```
- 思考状态更新在 `windows/code/desktop-pet/desktop/main.mjs` 第 190 行：
  ```javascript
  $('thinking-indicator').hidden = !connection.connected || !!view.error || awaitingTranscript || !(awaitingTextTurn || view.state === 'thinking');
  ```

#### 存在问题与用户体验痛点
1. **视觉割裂**：思考时右上角浮现“想一想…”，但思考完成后，**回复内容只能缩在底部弹出的巨大聊天抽屉里**；
2. **缺乏自然气泡**：桌宠没有跟随人物头顶/身旁的漫画式说话气泡（Speech Balloon），导致用户每轮对话都必须忍受大抽屉挡住桌宠与屏幕；
3. **卡死风险**：当大模型连接超时（如第 5 节的 31s 超时）或异常中断时，`thinking-indicator` 缺乏客户端自保倒计时，容易一直停留在桌宠头顶。
4. **改进规划**（进入 N075-15 规格）：
   - 支持轻量浮动说话气泡（Bubble Overlay），回复直接在桌宠旁边浮现淡出，无需展开完整历史抽屉；
   - 气泡位置跟随模型头顶动态锚定，避免固定绝对像素造成穿模。

---

### 问题 5：模型请求异常（`Provider stream error`，耗时 31733ms，截图 5 & 6）

#### 证据链与分析
1. 错误代码定位：`windows/code/desktop-pet/providers/transport.ts` 第 116-117 行：
   ```typescript
   const chunk = object(JSON.parse(data));
   if (chunk.error) throw new Error('Provider stream error');
   ```
2. Trace 数据库记录核实（`companion.sqlite` 中的 `runtime_traces` 表）：
   - **轮次 1 (`ac1bbf6e`)**：
     - 阶段耗时：`admission 2ms` → `context 1ms` → `llm 31733ms`（大模型调用阶段单阶段耗时 31.7 秒）；
     - 返回状态：`failed`，错误信息：`Provider stream error`；
   - **轮次 2 (`38203845`)**：
     - 紧接着该错误之后用户发送“我是谁”，相同逻辑下耗时 4647ms 成功返回。

#### 严谨结论与责任边界
- **撤回“100% 确认属于服务商问题，本地完全正常”的过度断言**：
  - 本地传输层在持续等待 31.7 秒后，从 SSE 数据流中解析到了服务端返回的 `chunk.error` 帧；
  - 尽管紧随其后的下一轮对话在相同逻辑下成功，表明该服务节点已恢复；但**当前证据不足以完全排除本地请求超时策略、网络波动、代理握手配置或特定请求体参数引发异常的可能**；
  - 正确的工程处理：在 Trace 中保留脱敏的结构化错误信息（HTTP 状态码、requestId、错误类型），而非向用户宣称 100% 排除本地程序原因。

---

### 问题 6：Trace 表现与阶段可视化问题（截图 6）

#### 痛点分析
1. **前后台耗时未解耦与播放回执缺失**：
   - 成功轮次总耗时标为 `8957 ms`，下方按横向箭头依次排开：
     `意图路由 2ms → 上下文组装 1ms → 模型回复 4647ms → 记忆自动提炼 4301ms`
   - **用户感知错觉**：用户看到总耗时接近 9 秒，以为前台等待了 9 秒；但实际上文字回复事件在 4.6 秒即发出，后半截 4.3 秒为后台提炼。
   - **撤回“4.6 秒播放完毕”的表述**：源码只能证明 4.6 秒向前端派发了文本回复与 speaking 状态，**并无声学层或前端音频播放结束的回执**，不能妄言音频已播毕。
2. **失败轮次的回复摘要污染**：
   - 第一轮模型请求失败，但卡片依然展示了 `Aika: [digest:cfbcc22b len:26]`；因为实验脚本将异常文本写入了 replyText。
3. **改进规划**（进入 N075-12 / RP75-03 规格）：
   - 控制台 Trace 详情明确拆分 **“前台交互耗时（Foreground）”** 与 **“后台异步提炼（Background）”**；
   - 对未采集真实音频播放回执的情况如实标注，不臆测播放时长；
   - 失败轮次清晰标注失败阶段，不显示虚假回复 digest。

---

### 问题 7：控制台“表情与动作”报错：“没有这个管理操作。”（截图 3）

#### 源码证据
1. `windows/code/desktop-pet/management/server.ts` 第 98 行：
   ```typescript
   if (url.pathname === '/api/presentation' && options.presentation) {
     ...
   }
   ```
2. 未命中该分支时，直接落入默认路由（第 151 行）：
   ```typescript
   throw new ManagementError('not_found', '没有这个管理操作。');
   ```
3. `tools/serve-management.mjs` 第 77-85 行：
   ```javascript
   const instance = await startManagementServer({
     uiRoot: resolve(root, 'management/ui'),
     settings,
     skins: store,
     token,
     port: 10158,
     memory: memoryPort,
     traces: traceStore,
     // <--- 缺少 options.presentation!
   });
   ```

#### 根因剖析
- 验收服务启动脚本 `serve-management.mjs` 中只传入了 `settings`、`skins`、`memory`、`traces`，遗漏了 `presentation` 实例的初始化与注入；
- 前端页面请求 `GET /api/presentation`，后端找不到 `options.presentation`，抛出 404 `没有这个管理操作。`。

---

## 3. 后续修复清单与计划映射 (依据 RP75 计划)

| 跟踪项 | 现场问题 | 对应修复步骤 | 核心行动目标 |
| --- | --- | --- | --- |
| **FIX-01** | Q1/Q7 桌面右键离线、控制台独立运行 | **RP75-01** | 恢复 `trial-backend` 唯一真实生产入口，发布统一随机 session 凭据，Electron 桌宠注入该配置并允许 `open_management`，隔离测试 harness。 |
| **FIX-02** | 连续性遗忘在途失效（RV75-02） | **RP75-02** | 在 `assertContextCurrent()` 中加入连续性修订校验，防止已遗忘/纠正的私密事实在在途对话中继续泄露。 |
| **FIX-03** | Trace 阶段明文与时序丢失（RV75-03/05） | **RP75-03** | 实行 Trace 阶段 details 白名单脱敏，解耦前后台阶段记录时序，确保后台先完不丢记录。 |
| **FIX-04** | live Host/Flow 组合根未注入（RV75-04） | **RP75-04** | 真实接入宿主实例；未接入时真实返回 unavailable，不以新建空对象冒充在线。 |
| **FIX-05** | 控制台 epoch 错误与总览假数据（RV75-06/07） | **RP75-05** | 修正 catch epoch 判断；绑定请求序号；向用户确认真实健康/总量指标呈现要求后重写总览。 |
| **FIX-06** | Q2 知识库“能看也能删”闭环 | **RP75-06** | 增补受控正文查看与分块检视 API，复用已有删除并增加在途 Context 失效保护。 |
| **FIX-07** | Q3/Q4 气泡贴边、思考卡死与免大抽屉回复 | **RP75-07** | 先向用户确认样式参考图；实现桌面轻量浮动气泡（Speech Balloon），完善思考指示器超时与终态。 |
| **FIX-08** | Q6 Trace 前后台耗时混排与右键减负 | **RP75-08** | 前端 Trace 拆分前后台交互；右键菜单功能减负与错误反馈优化；全流程真实联调复验。 |
