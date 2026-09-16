# MVP-10 验收报告 · 最小插件槽

日期：2026-09-15。SPEC：[MVP-10](../specs/MVP-10.md)。依据：[RPD v1.2](../../RPD_MVP_0.6.md) MVP-R10、[SPEC 索引](../SPEC_MVP_0.6.md)。前置：[MVP-07](MVP-07_ACCEPTANCE.md)（基线与剪枝 PASS）。

## 状态摘要

| AC | 结论 | 证据等级 |
| --- | --- | --- |
| A | **PASS** | 源码 + 单元测试 |
| B | **PASS** | 单元测试 + 浏览器 E2E + 真机四端点 |
| C | **PASS** | 单元测试 |
| D | **PASS** | 单元测试 + 可见降级 UI |
| E | **PASS** | 单元测试 |

## 1. 交付范围

| 槽 | 接口 | 默认实现 | 文件 |
| --- | --- | --- | --- |
| renderer | `PetRendererPlugin` | `SpriteRendererPlugin` | `src/plugins/renderers/spriteRenderer.ts` |
| behavior | `PetBehaviorPlugin` | `IdleBehaviorPlugin` | `src/plugins/behaviors/idleBehavior.ts` |
| menu | `PetMenuPlugin` | `DefaultMenuPlugin` | `src/plugins/menus/defaultMenu.ts` |

支撑：`src/plugins/types.ts`（契约）、`registry.ts`（注册表）、`rendererHost.ts`（单实例宿主）。`src/PetWindow.tsx` 改为「传输 + 宿主外壳」，`src/pet/PetSprite.tsx` 被 renderer 取代后**删除**。

## 2. AC-A：契约、能力声明与生命周期 — PASS

`PetRendererPlugin` 明确区分四类语义：

- `capabilities()`：`actions`（**真实可播放的动作 id 清单**）、`bubble`、`costumes`、`hitAreas`。动作白名单来自代码常量而非猜测，sprite 声明为上游六个动作。
- `prepare(ctx) → Promise`：分配资源并挂载 DOM，但**不得产生可见输出**（sprite 的根节点在 prepare 后仍为 `hidden`，单测断言）。
- `activate()` / `deactivate()`：接管 / 让出可见输出。
- `action(request) → boolean`：不能履约时返回 `false`，不假装成功。
- `pose(animationId) → boolean`：**与 action 分离**的连续姿态（idle / 走路）。姿态没有时长、也不计入动作完成。
- `bubble(text, ttlMs)`、`applySettings(settings, pet)`、`dispose()`（幂等）。

`PetBehaviorPlugin` 通过 `BehaviorContext` 拿到 `getSettings / isPaused / isActionActive / lastActivityAt / now / requestAction / requestPose / markActivity`，**没有**直接触达 renderer 的通道；`syncWindowPosition?` 为可选宿主通知。

**HTTP 不依赖某一 renderer**：Rust 侧四端点在本次改动中**一行未动**；`PetWindow` 订阅 `pet-action` / `pet-say` / `pet-settings` / `runtime-status` 后转发给当前活跃 renderer。renderer 未激活时 `action` 返回 `false` 并计入 `actionsWithoutRenderer`，不会被当成已受理。

## 3. AC-B：默认实现迁移与表现等价 — PASS

| 迁移项 | 前 | 后 |
| --- | --- | --- |
| sprite 渲染 | `PetSprite.tsx`（React 组件，`useState` + rAF） | `SpriteRendererPlugin`（自持 DOM，rAF 循环） |
| 气泡 | `PetWindow` 的 React state + JSX | renderer 的 `.pet-bubble` 节点，TTL 语义不变 |
| 待机/自娱 | `PetWindow` 的 `setInterval` | `IdleBehaviorPlugin` |
| 走路/贴边 | `PetWindow` 的 motion effect | `IdleBehaviorPlugin` + 注入的 `DesktopEnvironment` |
| 右键菜单 | `PetWindow` 内写死的四个按钮 | `DefaultMenuPlugin.entries(ctx)` |

保留的可见表现：DOM 类名（`.pet-sprite`、`.pet-hit-target`、`.pet-bubble-*`）、气泡四种样式与 TTL、悬停高亮、拖动阈值 4px、右键菜单四项及其文案（en / zh-CN）。

回归证据：

```text
pnpm exec tsc --noEmit                    0 error
pnpm exec vitest run                      19 passed / 0 failed
pnpm e2e（Playwright/Chromium）           3 passed
```

真机四端点（对插件化后的新构建）：

| 用例 | 结果 |
| --- | --- |
| `GET /api/status` | 200 |
| `POST /api/action {"animationId":"jumping"}` | 200，`lastAction=jumping` |
| `POST /api/say`（中文） | 200，`bubbleText` 逐字读回「插件化回归 你好」 |
| `POST /api/event {"type":"success"}` | 200，`lastAction=jumping`、`recentEvents`=1 |
| 未知 event 变体 | 400，错误体与 PET-01 fixture 逐字一致 |
| `POST /api/import/website` | 404（剪枝保持生效） |
| `POST /api/import/local` | 400 `source path is required`（路由保留） |

`openpet.exe`（本次构建）SHA256 `83A9F321FD4DCD3A109A339CE6B0881531646F11D0E37F9F61DBCD3D24FFBA56`，12 811 776 B。

## 4. AC-C：单一输出、先准备后提交、generation — PASS

`RendererHost` 的实现约束：

- 任一时刻只有一个 `active` 实例；提交新实例前先 `prepare`，失败则**不改变**当前输出。
- 切换成功后旧实例才被 `deactivate + dispose`，且各调用一次。
- `generation` 每次 `start` / `switchTo` 自增；prepare 返回后若 generation 已过期，该实例被直接销毁而**不会**激活。

单测覆盖：失败切换保留旧实例且 `sprite.disposeCalls === 0`；成功切换后旧实例恰释放一次；慢 prepare 被新 start 超越后 `disposeCalls === 1` 且 `activateCalls === 0`。

## 5. AC-D：降级与不虚报 — PASS

| 场景 | 行为 |
| --- | --- |
| 首选 renderer prepare 失败 | 回退默认 sprite，状态 `degraded`，窗口显示「已回退到默认外观」并携带原因（`lastError` 在降级时**故意保留**） |
| 首选与默认都失败 | 状态 `unavailable`，窗口显示「宠物渲染器不可用」，且不渲染任何占位角色 |
| 无活跃 renderer 时收到 action / pose / bubble | 返回 `false`，计入 `actionsWithoutRenderer`，**不计入已受理** |
| renderer 拒绝未知动作 | 返回 `false`，计入 `actionsRefused`；sprite 对未知 action / pose 明确返回 false |
| 精灵图加载失败 | `prepare` reject，被宿主转为降级而非静默空白 |

降级 UI 是 `.pet-slot-notice` 节点，`degraded` 与 `unavailable` 两种文案，不遮挡点击区域（`pointer-events: none`）。

## 6. AC-E：重复启停后的稳定性 — PASS

单测断言：

- 连续 4 次 `start` 后 `disposedInstances` 恰为 3，无实例堆积；两次 `stop` 后 `active === null`、状态 `unavailable`、`getCapabilities() === null`。
- `deactivate` 次数 ≥ `dispose` 次数（每个交接点都让出输出），不存在只 dispose 不 deactivate 的路径。
- behavior：连续 3 轮 `start`/`stop` 后推进 5 秒定时器**不再**触发任何动作，说明 timer 全部清理。
- behavior 的 idle 自娱必须经 `requestAction(..., 'behavior')` 出去，不能绕过动作约束；且受静默阈值、`isPaused`、`isActionActive` 三重抑制（单测用可控时钟验证阈值分支）。

菜单同理：`DefaultMenuPlugin` 只调用宿主给的 `openSettings / hidePet / playAction / updateSettings`，自身不持有 renderer，也不产生动作。

## 7. 测试发现的两个真实缺陷（已修）

这一节是本 SPEC 最有价值的部分：两处都不是「测试写错」，而是插件槽语义确有漏洞。

1. **注册表按实例注册导致跨 host 共享。** React StrictMode 双挂载会创建两个宿主，两者拿到**同一个** renderer 实例；旧宿主的过期 prepare 收尾时 dispose 会把新宿主正在使用的 DOM 隐藏，表现为角色消失。修复：注册表改为持有**工厂**（`registerRenderer(id, () => new X())`、`registerBehavior(id, factory)`），每次激活创建独立实例。已加回归测试「两个宿主各自拿到独立实例，拆掉 A 不影响 B」。
2. **双挂载窗口期页面上同时存在两个 hit target。** 即使实例独立，先前宿主的容器在被异步 dispose 前仍留在文档里，违反「任一时刻仅一个输出」。修复：每个宿主创建私有容器并在挂载时 `replaceChildren` 原子替换，卸载时移除自己的容器。

第 2 点由 E2E 的 strict mode violation（`resolved to 2 elements`）暴露，而不是单测——说明浏览器级回归对「只有一个输出」这类断言不可替代。

## 8. 共享接口影响

- 四端点及其请求/响应/错误语义**未改动**；`docs/frontend/DESKTOP_PET_CONTRACT.md` 未修改，无需双仓同轮修订。
- pet-shell 内新增前端契约仅服务于内部插件槽，不对外暴露，也未进入 `POST`/`GET` 载荷。
- 新增测试基建：`vitest` + `jsdom`（devDependencies）与 `vitest.config.ts`、`pnpm test` 脚本。此前该仓库只有 Playwright，纯逻辑断言无处可放。
- `probe/live2d/` 探针（MVP-07 AC-C）保留；模型与 Core 资产仍被 gitignore。

## 9. 未覆盖与后续

| 项 | 状态 |
| --- | --- |
| Live2D renderer 接入同一槽位 | 属 MVP-11；`costumes` 能力位已预留 |
| renderer 切换的 UI 入口 | 属 MVP-08 菜单（本地模型/表现设置） |
| 真机上 renderer 切换的目视验证 | 归 MVP-08/11；本轮切换语义只有单测，无真实第二 renderer 可切 |
| 托盘/窗口即 `menu` 槽的 Rust 侧部分 | 托盘仍在 Rust，属 MVP-08 生命周期 |
| 性能（帧率、CPU） | 归 MVP-13 |

模块通过不等于 0.6 产品完成：Live2D 未接入前，「sprite 与 Live2D 单一出口可切换」这一冻结点**尚未证明**。
