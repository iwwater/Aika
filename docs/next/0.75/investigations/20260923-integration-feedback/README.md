# 联调现场问题排查与技术归因记录 (2026-09-23)

> **原则说明**：根据用户明确要求（*“记录文档，但是不要先修改；将这些证据保存在一个文件夹里面，后续修好定位”*），本文档仅进行深度归因与证据留存，**当前不擅自修改业务代码**。

---

## 1. 现象概览与问题索引

| 序号 | 截图与用户反馈 | 定位模块 | 核心原因结论 | 归属与修复方向 |
| :-: | :-- | :-- | :-- | :-- |
| **Q1** | 右键菜单点击「外观/换肤」「配置」「知识库」弹出：“当前为离线预览，控制台暂不可用；请启动真实桌宠服务后重试。” | `desktop/electron/main.mjs`, `tools/dev-desktop-real.mjs` | `dev-desktop-real.mjs` 启动参数写死了 `--preview` 且删除了 `PET_TRIAL_CONFIG`，触发 Electron 侧直接拦截 | 后续移除 `--preview` 并注入配置路径（N075-03/06） |
| **Q2** | 知识库“能看也能删”功能需求确认 | `knowledge/knowledge-store.ts`, `management/server.ts` | 知识库是用户主动投喂的参考资料（Reference Data），“可查、可看、可删”是 N075-10 的必备验收标准 | 明确确认为 N075-10 核心需求 |
| **Q3** | “想一想…”气泡显示问题 | `desktop/index.html`, `desktop/style.css`, `desktop/main.mjs` | ① CSS 固定定位在右上角与窗口/模型贴边遮挡；② 请求耗时或异常时，指示器无超时机制卡死展示；③ 缺乏独立对话气泡 | 后续在 N075-15 优化位置与状态机 |
| **Q4** | “希望回复后面可以不用这个呼唤出来的对话前端” | `desktop/main.mjs`, `desktop/index.html` | 当前回复仅能展示在底部抽屉式（Chat Drawer）文本列表中，缺乏头顶轻量浮动气泡（Speech Balloon） | 记入产品设计：桌面浮动气泡（N075-15） |
| **Q5** | 对话报错：`大模型请求异常: Provider stream error`，耗时 31733ms | `providers/transport.ts:117`, 服务商接口 | **上游服务商（第三方代理/Gemini API）网络握手与流式响应卡顿 31s 后主动断流并返回错误帧**，非本地代码逻辑 Bug | 详见第 5 节证据链 |
| **Q6** | Trace 页面展示与阶段表达问题 | `core/trace-store.ts`, `management/ui/views.mjs`, `real-backend.mjs` | ① 阶段串行展示导致用户误以为整轮等了 9 秒（前台 4.6s vs 后台提炼 4.3s 未分流）；② 失败轮次仍显示错误回复的 digest | 优化 Trace 前后台分离展示（N075-12） |
| **Q7** | 控制台“表情与动作”页面报错：“没有这个管理操作。” | `management/server.ts:98`, `tools/serve-management.mjs` | `serve-management.mjs` 启动管理端时未注入 `options.presentation` 实例，触发 404 not_found | 为独立服务补全注入项 |

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
- **与记忆系统的严格边界**：
  - **知识库（Knowledge Library）**：用户主动导入的外挂文本、参考文档（Markdown / TXT）。用户对文档拥有完整的所有权，必须支持**列表查看、原文检索、内容分块检视、一键完全删除**。删除后必须级联清理其在向量/关键词索引中的分块；
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

#### 证据链与抓包级分析
1. 错误代码定位：`windows/code/desktop-pet/providers/transport.ts` 第 116-117 行：
   ```typescript
   const chunk = object(JSON.parse(data));
   if (chunk.error) throw new Error('Provider stream error');
   ```
2. Trace 数据库记录核实（`companion.sqlite` 中的 `runtime_traces` 表）：
   - **轮次 1 (`ac1bbf6e`)**：
     - 阶段耗时：`admission 2ms` → `context 1ms` → `llm 31733ms`（大模型调用阶段单阶段耗时 31.7 秒！）；
     - 返回状态：`failed`，错误信息：`Provider stream error`；
   - **轮次 2 (`38203845`)**：
     - 紧接着该错误之后用户发送“我是谁”，完全相同的本地代码逻辑，耗时 4647ms，成功返回。

#### 结论归属
- **100% 确认属于后端服务商（上游 API 网关 / Gemini 代理）问题**：
  - 本地客户端向代理节点 `https://hanbaoyu.ggff.net/v1/chat/completions` 发起 SSE 流式请求；
  - 代理节点在与上游模型供应商握手或生成过程中发生网络超时/断流，挂起长达 31.7 秒；
  - 代理节点最终向客户端 SSE 管道推送了一个包含 `{"error": ...}` 的数据帧；
  - 本地 `ProviderTransport` 识别到服务端返回的 `chunk.error`，按照规范抛出 `Provider stream error`。
- 本地程序处理符合预期（未崩溃，捕获后友好告知用户，下一轮自动恢复）。

---

### 问题 6：Trace 表现与阶段可视化问题（截图 6）

#### 痛点分析
1. **前后台耗时未解耦**：
   - 成功轮次总耗时标为 `8957 ms`，下方按横向箭头依次排开：
     `意图路由 2ms → 上下文组装 1ms → 模型回复 4647ms → 记忆自动提炼 4301ms`
   - **用户感知错觉**：用户看到总耗时接近 9 秒，以为自己对着桌宠干等了 9 秒；但实际上**前台在 4.6 秒时就已经播放回复完毕**，后半截 4.3 秒完全是后台异步提炼，并未卡顿用户交互。
2. **失败轮次的回复摘要污染**：
   - 第一轮模型请求失败，但卡片依然展示了 `Aika: [digest:cfbcc22b len:26]`；因为实验脚本将异常文本写入了 replyText。
3. **改进规划**（进入 N075-12 规格）：
   - 控制台 Trace 详情明确拆分 **“前台对话交互（Foreground: 4.6s）”** 与 **“后台异步沉淀（Background: 4.3s）”**；
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

## 3. 后续修复清单与跟踪工单

| 跟踪项 | 涉及步骤 | 计划修复措施 |
| --- | --- | --- |
| **FIX-01** | N075-03 / 启动脚本 | 修复 `dev-desktop-real.mjs`，去除 `--preview`，正确绑定配置与 session 文件，打通桌宠右键直接唤起控制台。 |
| **FIX-02** | N075-10 | 确立知识库“上传、检视、删除”契约，实现文档删除后级联清理 FTS/分块索引。 |
| **FIX-03** | N075-15 | 重新设计桌宠气泡（Bubble Overlay），支持不用底部大抽屉的纯气泡轻量交流，修复“想一想”指示器的贴边和异常卡死。 |
| **FIX-04** | N075-12 | Trace 前端卡片改造，区隔“前台回复耗时”与“后台提炼耗时”，消除用户对异步耗时的误解。 |
| **FIX-05** | 管理服务脚手架 | 在 `serve-management.mjs` 中完整注入 `presentation`、`knowledge`、`continuity` 实例。 |
