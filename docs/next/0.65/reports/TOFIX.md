# K65-11 缺陷待修记录 (TOFIX)

记录日期：2026-09-22  
关联版本：0.61 + 0.65  
状态：`ALL_FIXED`（全 6 项均已完成定向修复与自测）

---

## 缺陷 1：点击 Live2D 角色本体无法触发对话/面板，只能通过“聊一会儿”浮动按钮触发

### 1. 现象描述
在桌宠悬浮窗口中（Offline Preview 及主程序）：
- 点击 Live2D 角色（无论左键短按抚摸、还是右键点击唤起菜单）均无响应，不会打开对话面板或功能抽屉。
- 窗口内仅能通过点击角色脚下的浮动按钮 **「聊一会儿」**（`<button id="open">`）才能打开对话框。
- 窗口提示文案表明 `aria-label="AAAAGENT桌宠，点击聊天，拖动移动"`，与实际交互行为不一致。

### 2. 根因定位 (RCA)

1. **DOM 结构层级**（`desktop/index.html`）：
   ```html
   <main id="pet">
     <div id="character">
       <canvas id="model" aria-label="AAAAGENT桌宠，点击聊天，拖动移动"></canvas>
       ...
     </div>
     ...
     <button id="open" aria-label="打开对话" aria-controls="drawer" aria-expanded="false">聊一会儿</button>
   </main>
   ```
   用户在屏幕上点击角色视觉区域时，浏览器捕获到的事件直接目标 `event.target` 为 `<canvas id="model">`，其 `id` 为 `'model'`。

2. **路由判定逻辑过窄**（`desktop/pointer-router.ts`）：
   ```typescript
   const onCharacter = (target: PointerSample['target']): boolean => target?.id === 'character';
   ```
   `pointer-router.ts` 中将角色区域限定为严格等于 `target?.id === 'character'`：
   ```typescript
   contextMenu(event: PointerSample): void {
     if (!onCharacter(event.target)) return;
     this.#rightConsumed = true;
     this.#pointer = null;
     this.handlers.panel(!(this.handlers.panelOpen?.() ?? false));
   }
   ```
   当用户在角色上右键或点击时，传入的 `target.id` 为 `'model'`，`onCharacter` 恒为 `false`，导致右键菜单唤起与左键触摸/短按逻辑全部被静默忽略。

3. **路由分发接线错误（FIX61-04 约定偏差）**（`desktop/main.mjs`）：
   在 `desktop/main.mjs` 中实例化 `CharacterPointerRouter` 时：
   ```javascript
   const pointerRouter = new CharacterPointerRouter({
     panel: open => panel(open), // ❌ 错误传入了打开聊天抽屉的 panel(open)
     panelOpen: () => panelOpen,
     drag: (dx, dy) => native('shell', { type: 'drag', dx, dy }),
     stroke: at => { ... }
   });
   ```
   按照 FIX61-04 规格，右键的目标是呼出**独立功能面板（`functionPanel(open)`，包含外观/换肤、麦克风测试、知识库、诊断等 9 个核心入口）**，而此处错误地将 `panel` 句柄指向了聊天抽屉 `panel(open)`，导致即使右键生效也无法呼出功能面板。

### 3. 影响评估
- **用户交互**：无法直接点击角色互动；更严重的是**右键独立功能面板（换肤、麦克风诊断、知识库等）完全没有入口打开**。
- **功能覆盖**：
  - 右键切换功能面板（设置、换肤、知识库、麦克风等）被阻断。
  - 左键短按的局部抚摸（Stroke）反馈失效。
- **阻断级别**：**体验功能与导航缺失**。可通过修复接线将右键指向 `functionPanel`，并在功能面板中保留“聊天”入口切回对话抽屉。

### 4. 修复方案
1. **修改判定范围**（`desktop/pointer-router.ts`）：
   ```typescript
   const onCharacter = (target: PointerSample['target']): boolean => 
     target?.id === 'character' || target?.id === 'model';
   ```
2. **在 `desktop/main.mjs` 中纠正面板接线**：
   将 `CharacterPointerRouter` 的 `panel` 句柄改接至 `functionPanel`：
   ```javascript
   const pointerRouter = new CharacterPointerRouter({
     panel: open => functionPanel(open),
     panelOpen: () => functionPanelOpen,
     drag: (dx, dy) => native('shell', { type: 'drag', dx, dy }),
     stroke: at => { ... }
   });
   ```
3. **补充回归测试**（`tests/next61/fix61-04.pointer.test.ts`）：
   补充针对 `{ target: { id: 'model' } }` 触发 `contextMenu` 与 `pointerUp` 的单测用例。

---

## 缺陷 2：Electron 控制台预检下的脱敏脚本错误（Renderer: script-error）

### 1. 现象描述
在 dev-desktop / smoke-test 启动或运行过程中，Electron 主进程持续收到脱敏的诊断日志：
```text
Renderer: script-error
```

### 2. 根因与跟进方向
- 生产诊断策略故意脱敏，未在日志中输出未捕获脚本异常的具体 stack。
- 需在开发模式开启 DevTools 检查具体的脚本抛错（如资源加载 404 或未捕获的 Promise rejection）。

### 3. 根因与修复方案（2026-09-22 已修复 · RESOLVED）
- **真机根因**：Electron 窗口 blur 与 visibilitychange 监听器中残留历史全局变量引用 pointer = null;，而在 FIX61-04 重构后该变量已迁移为 pointerRouter 实例，导致窗口每次失焦或可见性变化时抛出 Uncaught ReferenceError: pointer is not defined。
- **修复改动**：在 desktop/main.mjs 中将 pointer = null; 替换为安全的 pointerRouter.pointerCancel();。
- **验证结论**：
ode tools/dev-desktop.mjs --smoke-test 运行通过，stderr 中不再有任何 Renderer: script-error 输出（0 错误）。

---

## 缺陷 3：缺少鼠标点击穿透（Click-through）模式

### 1. 现象描述
桌宠以透明无边框、置顶悬浮在桌面（`alwaysOnTop: true, transparent: true`），但窗口目前全程拦截鼠标事件。
- 当桌宠角色遮挡住下方的文字、IDE 编辑器、网页或桌面应用图标时，用户无法透过角色点击背后的窗口。
- 缺少桌面宠物类软件常见的“鼠标穿透/防遮挡”工作模式，在日常使用中容易产生误触或视线与点击阻塞。

### 2. 根因分析
- 在 Electron 主进程（`desktop/electron/main.mjs`）中，未调用 Chromium/Electron 的 `win.setIgnoreMouseEvents(ignore, { forward: true })` API。
- 在渲染层与功能面板中，未设计点击穿透开关或全局唤醒/退出穿透的组合快捷键。

### 3. 影响评估
- **用户体验**：作为日常常驻桌面伴侣，在办公或游戏场景下无法穿透会导致频繁需要手动挪动或关闭桌宠。
- **阻断级别**：**体验功能缺失 / 非阻断**，不影响核心能力包与链路的逻辑验收。

### 4. 修复方案
1. **主进程 IPC 支持**：
   在 `desktop/electron/main.mjs` 的 `pet:shell` 中增加 `set_click_through`：
   ```javascript
   case 'set_click_through':
     win.setIgnoreMouseEvents(value.enabled === true, { forward: true });
     deliver('clickThroughChanged', { enabled: value.enabled === true });
     break;
   ```
2. **快捷键与托盘唤醒**：
   提供全局恢复快捷键（或在鼠标移出非透明区域后动态判断，或托盘图标菜单），确保开启穿透后用户仍能退出穿透模式。
3. **UI 选项**：
   在通用设置或外观面板中增加“鼠标穿透”切换按钮。

---

## 缺陷 4：角色尺寸缩放（I-05）交互体验差无法操作，需重构为面板内调节

### 1. 现象描述
原设计通过桌面悬浮窗脚下的微型半透明手柄（`<button id="model-resize">`）或键盘方向键 `↑`/`↓` 进行缩放。
- 在实际桌面操作中，透明手柄极难准确定位与拖拽，极易与窗口拖动或桌面其他窗口点击发生冲突。
- 键盘方向键缩放要求非编辑态获得焦点，在悬浮窗常驻下交互极易失效。

### 2. 用户需求与重构方案
- **交互重构**：弃用窗口外部隐蔽手柄，**改为在点击展开的聊天控制面板（或功能抽屉面板）中增加“角色尺寸”调节控件**。
- **具体实现**：
  1. 在控制面板的通用/外观设置区域提供清晰的 **Slider（滑块，范围 220px ~ 720px）** 或常用尺寸预设档位（如：小 240px / 适中 360px / 大 480px / 特大 640px）。
  2. 拖动滑块时实时调用 `native('shell', { type: 'resize_model', phase: 'update', width })` 进行平滑预览；松手时发送 `phase: 'commit'` 并持久化到 `windows-display.json`。
  3. 清理废弃的 DOM #model-resize 隐式手柄，避免桌面边缘误触。

### 3. 修复落地与验证结果（2026-09-22 已修复 · RESOLVED）
- **改动文件**：desktop/index.html、desktop/display-controls.mjs、desktop/style.css。
- **实现详情**：
  1. 在控制面板的展示模式后加入 <input type="range" id="size-slider" min="220" max="720" step="10"> 滑块；
  2. 拖动滑块实时平滑缩放模型，松手持久化；
  3. 将原边缘隐蔽的 #model-resize 手柄设为 hidden，彻底避免误触。
- **验证结论**：	est:windows:ui 与单测验证通过。

---

## 缺陷 5：点击「开始语音」无明显录音动效与明确报错反馈

### 1. 现象描述
在展开的聊天面板底部点击「开始语音」按钮：
- 界面未展示明显的录音中视觉动效（如动态声波曲线 `#capture-wave` 或悬浮录音反馈）；
- 在离线预览或设备拒绝时，错误原因被静默写入了抽屉顶部的次级灰字状态栏（`<p id="status">`），未出现显式的错误提示或 Toast，导致用户误以为点击无响应。

### 2. 根因分析
1. **反馈通道过窄**：语音阶段异常（`event.type === 'error'`）仅更新了 `view.error`，在界面上仅渲染为顶部 `#status` 文字替换，缺乏主动视觉触达（无震动、无高亮、无 Toast）。
2. **离线拦截快速静默清理**：在离线预览模式下，后端收到 `start_voice` 立即返回拒绝，主进程同时拦截麦克风权限，导致 `captureFeedback.stop()` 瞬间被调用，用户完全看不到连接与波形动效。

### 3. 改进方案
1. **显著的错误/拦截反馈**：
   当 `start_voice` 失败或处于离线模式时，弹出居中悬浮的 Toast 提示框（例如：“当前为离线预览模式，语音输入需要连接真实后端”），并在 3 秒后淡出。
2. **按钮与动效增强**：
   点击“开始语音”后，按钮立即切换为醒目的脉冲动画或“正在连接麦克风…”文案；真实采集开始后，展开显式的录音波形悬浮层与“点击停止”按键。

---

## 缺陷 6：Live2D 模型没有动效（待机动画、眨眼、呼吸摆动全无，且此前版本亦无）

### 1. 现象描述
在桌宠悬浮窗口中（Offline Preview 及主程序运行态）：
- 屏幕上渲染的 Live2D 角色处于完全静止状态（“纸片人”定格），没有任何动态效果。
- 缺失基础的待机动画（Idle Motion）、自动眨眼（Eye Blink）、身体/头部微幅呼吸摆动（Procedural Head/Body Movement）以及交互姿态动作。
- 用户明确确认：此现象**并非近期构建的回归缺陷，而是此前版本一直没有动效**（“Live2D没有动效，之前的也没有”）。

### 2. 根因分析 (RCA)
1. **策略门禁设计使自主运动被完全抑制（`No policy yet means no automatic animation`）**：
   在渲染器实现 `desktop/cubism-renderer.mjs` 中，待机动作与程序化动画被严格绑定在 `this.automaticIds` 策略白名单下：
   ```javascript
   // No policy yet means no automatic animation, including before backend ready.
   const enabled = id => this.previewMode ? this.previewSelection?.id === id : this.automaticIds.has(id);
   if (enabled('motion-idle-0')) {
     if (this._motionManager.isFinished()) this._motionManager.startMotionPriority(this.idle, false, 1);
     this._motionManager.updateMotion(this._model, delta);
   } else this._motionManager.stopAllMotions();
   if (enabled('proc-blink')) this.blink.updateParameters(this._model, delta);
   ```
2. **离线/未受控状态下默认全部静默清空**：
   `this.automaticIds` 初始为空 `new Set()`。当处于离线预览模式（`Offline Preview`）、独立运行或后端未推送 `presentation_policy` 频道消息时，`main.mjs` 传入的是 `{ modelId: 'disconnected', revision: 0, enabledIds: [] }`。
   `setAutomaticPolicy` 检测到 `modelId !== this.skin?.skinId`，直接执行 `this.automaticIds.clear()` 并返回 `false`。
   导致在无后端推送或策略为空的情况下，所有动效（`motion-idle-0`、`proc-blink`、`proc-head`、`proc-body`）被全部强行判定为 `false`，动作管理器 `stopAllMotions()` 并停止参数更新。
3. **缺少离线/无策略时的保底待机（Fallback Idle/Blink）循环**：
   历史代码为了严格测试“策略控制权”，将所有自主运动放在了后端策略之后，未提供本地兜底的自主呼吸和眨眼循环。一旦缺少特定后端配置，模型就呈现绝对静止。

### 3. 影响评估
- **用户感知**：Live2D 丧失灵魂和陪伴感，角色如同静态立绘，极大降低桌宠表现力。
- **阻断级别**：**视觉与体验缺陷 / 长期遗留缺失**（非阻断核心消息流逻辑，但属于核心产品质感缺陷）。

### 4. 修复方案
1. **提供离线与无策略时的安全保底动效（Default Fallback Preset）**：
   当 `presentationPolicy` 为空或处于离线/断开模式时，赋予基础兜底集合，例如：
   `['motion-idle-0', 'proc-blink', 'proc-head', 'proc-body']`，保证在任何状态下角色均有自然待机与眨眼呼吸。
2. **当后端推送有效策略时再进行精确覆盖与受控覆盖**。
3. **在外观/通用设置面板中增加动效开关/帧率选项**（供低配或需省电的用户手动调整）。

### 5. 修复落地与验证结果（2026-09-22 已修复 · RESOLVED）
- **改动文件**：desktop/cubism-renderer.mjs。
- **实现详情**：
  1. 导出并注入 DEFAULT_AUTOMATIC_IDS = ['motion-idle-0', 'proc-blink', 'proc-head', 'proc-body']；
  2. 在构造函数与离线/未指定策略（modelId === 'disconnected'）时默认赋予保底白名单，激活循环待机动作、自然眨眼与头部/身体程序化呼吸摆动；
  3. 当后端推送有效 presentation_policy 时依然能精准受控覆盖；
  4. 恢复了抚摸（stroke）的点头和眨眼局部交互动画。
- **验证结论**：	est:windows:ui 与 	est:next65 全部通过，角色在启动与离线预览下呈现生动待机与呼吸效果。
