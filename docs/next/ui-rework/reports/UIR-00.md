# UIR-00 验收报告 · 基线与接口冻结

日期：2026-09-25  
状态：PASS  
负责人：扫地僧模式 Agent  
工作树基准 Commit：`582570e1a4a789db43aef70cab669c36af0e5789`  
目标目录：`F:/AIVoice/Aika-Next/windows/code/desktop-pet`

---

## 1. 工作树基线与未提交修改保护

经静态检查与 `git status` 核验，当前仓库存在以下并行未提交修改：
- `windows/code/desktop-pet/management/ui/app.mjs`
- `windows/code/desktop-pet/management/ui/self-setup-view.mjs`
- `windows/code/desktop-pet/management/ui/views.mjs` (包含此前自建 OpenAI 兼容端点、快捷填入及凭据绑定的增强)
- `windows/code/desktop-pet/tools/serve-management.mjs` (引入 createSelfSetup)
- `windows/code/desktop-pet/tests/next08/*` 探测与调试脚本

**保护原则**：后续实施 UIR-01～UIR-08 过程中，基于当前工作树做最小增量修改，绝不执行覆盖或清除上述已有成果的操作。

---

## 2. 旧 17 个页面与 Section 路由映射登记 (AC 00-A)

依据 `RPD.md` 与 `SOURCE_MAPPING.md`，旧控制台的 17 个一级页面及全部 Section/深链均已建立新归属映射，映射表无遗失：

| 序号 | 旧 page/section | 新归属目的地 | 映射类别与行为 |
| --- | --- | --- | --- |
| 1 | `overview` | `Dashboard` | 默认一级入口，展示真实统计与快捷入口 |
| 2 | `models` | `Characters` (当前角色/模型) | 角色级绑定；全局来源配置深链指引至 `Settings/来源` |
| 3 | `voice` | `Characters` (语音) | 角色级音色与语音；全局音频设备深链指引至 `Settings/设备` |
| 4 | `skins` | `Characters` (外观) | 角色 Live2D / Sprite 外观与动作映射 |
| 5 | `characters` | `Characters` | 角色列表与基础信息管理 |
| 6 | `memory` (`records` 聊天) | `Developer` / `LLM Chat Trace` | 对话与推理记录，隐藏于 Developer 模式 |
| 7 | `memory` (`records` 事实/dynamics/fragments) | `Knowledge` (对应数据域) | 长期事实与连续性记忆条目 |
| 8 | `memory` (`prompt`) | `Characters` / `Persona` | 角色单段人设编辑，复用现有 Prompt 权威 |
| 9 | `memory` (`context`) | `Playground` (检索试算) | 检索试算与调试工具 |
| 10 | `memory` (`import`) | `Knowledge` (导入) | 外部知识与记忆导入 |
| 11 | `memory` (`emotion`) | `Characters` (高级表现) | 角色情感与表现状态 |
| 12 | `timeline` (`section=timeline`) | `Developer` / `Timeline Companion` | 双时间线合并入开发者详情；未开 Developer 时提示启用 |
| 13 | `knowledge` | `Knowledge` / `参考资料` | 现有文档库降为次级入口，新 Knowledge 默认展示已沉淀 Wiki |
| 14 | `packages` | `Plugins` | 已安装包管理、启停与配置；Flow 作为高级入口 |
| 15 | `health` (`section=runtime`) | `Settings` / `诊断` | 模块状态与就绪监控迁移至 Settings 诊断子区；Dashboard 显示摘要 |
| 16 | `events` (`section=diagnostics`) | `Developer` / `Runtime Logs` | 运行日志与诊断查询 |
| 17 | `projects` | `Settings` / `工作与集成` | 项目管理移入 Settings 工作组 |
| 18 | `tasks` | `Settings` / `工作与集成` | 任务调度中心移入 Settings；Work 协议确认卡保留深链 |
| 19 | `wechat` | `Settings` / `集成` | 微信连接与扫码移入 Settings 集成子区 |
| 20 | `presentation` | `Characters` / `外观` | 表情动作策略与外观合并 |
| 21 | `proactive` | `Settings` / `隐私与陪伴` | 主动陪伴策略与权限管理 |
| 22 | `perception` | `Settings` / `隐私与陪伴` | 授权感知开关与观察数据管理 |

---

## 3. 核心接口缺口与负责 SPEC 分工 (AC 00-B)

通过审阅 `management/server.ts`、`app/trial-backend.ts`、`routes.mjs` 等关键模块，明确以下缺口及责任归属：

1. **角色作用域 Binding 与 Persona 生效**（负责 SPEC：`UIR-02`）
   - **现有状态**：`server.ts` 仅有全局 `ManagedSettings.providers`（PUT `/api/settings`）；`GET/PUT /api/prompt` 仅支持全局单段 Prompt。
   - **生产提供者**：`management/server.ts`、`management/settings.ts`。
   - **消费者**：UI 角色页 (`character-view.mjs`)、`BackendSession` / `TurnPipeline`。
2. **Wiki Read Model 聚合**（负责 SPEC：`UIR-03`）
   - **现有状态**：`continuity-routes.ts` 暴露 `/api/continuity/snapshot` 等低阶存储接口；缺少对 Active / Candidate / Canon / 外部资料进行统一分页、类型筛选与搜索的聚合 facade。
   - **生产提供者**：`management/continuity-routes.ts`、`memory/character-pack-store.ts`。
   - **消费者**：`ui/knowledge-view.mjs` (Wiki 视图)。
3. **Playground 统一 TurnPort 管理 Facade**（负责 SPEC：`UIR-04`）
   - **现有状态**：`app/trial-backend.ts` 内部持有 `BackendSession` 和 `NextTurnPort`，但 HTTP 层面尚未暴露安全带鉴权和取消语义的交互端点（如 `/api/playground/session`、`/api/playground/turns`、`/api/playground/turns/:id/cancel`）。
   - **生产提供者**：`management/server.ts` 注入 trial backend 的 turnPort。
   - **消费者**：`ui/playground-view.mjs`。
4. **Trace 关联元数据与多域视图**（负责 SPEC：`UIR-05`）
   - **现有状态**：`server.ts` 提供 `/api/traces` 和 `/api/traces/:id/content`，但缺乏将 turnId、整理批次 (Ingest Batch) 以及最终 Wiki 条目串联的元数据投影。
   - **生产提供者**：`core/trace-store.ts`、`server.ts`。
   - **消费者**：`ui/developer-view.mjs`。
5. **Plugins 宿主管理端点**（负责 SPEC：`UIR-06`）
   - **现有状态**：`next65-management.ts` 实现了本地包扫描、启用、停用方法，但 `server.ts` 缺少 HTTP POST `/api/next65/packages/:id/enable` 等管理路由。
   - **生产提供者**：`management/server.ts`、`next65-management.ts`。
   - **消费者**：`ui/plugins-view.mjs`。
6. **Dashboard 聚合 Read Model**（负责 SPEC：`UIR-07`）
   - **现有状态**：前端需向多接口分别轮询，且缺乏时区、成功轮次、有效知识沉淀的统一统计契约。
   - **生产提供者**：`management/server.ts`。
   - **消费者**：`ui/modern-overview.mjs` (Dashboard)。

---

## 4. 最小公开 DTO 规范 (schemaVersion=1)

为避免状态混乱，统一表单交互的信封格式：
```typescript
interface UIEnvelope<T> {
  schemaVersion: 1;
  owner: 'character' | 'settings' | 'plugin' | 'user';
  scope: string; // e.g. characterId, slot, or global
  savedRevision: number;
  effectiveRevision: number;
  availability: 'installed' | 'enabled' | 'loaded' | 'ready' | 'pendingRestart' | 'unknown' | 'failed' | 'disabled' | 'unavailable';
  data: T;
  errors?: Array<{ field?: string; message: string; code?: string }>;
}
```
**铁律**：秘密凭证（如 API Key）始终 write-only，回显一律脱敏或占位；禁止在 URL、日志或客户端普通 localStorage 中留存凭据明文。

---

## 5. 验收结果与命令记录 (AC 00-C)

- **TypeScript 类型检查**：
  ```pwsh
  npm run check
  ```
  - 退出码：`0`
  - 结果：PASS（无任何类型或编译错误）。
- **既有路由定向测试**：
  ```pwsh
  node --test tests/management/routes.test.mjs
  ```
  - 退出码：`0`
  - 结果：4 个测试全部 PASS（N075-01 路由解析、legacy section 桥接、默认 overview 回退、静态资源存在性检查）。

---

## 6. 结论与交接

- `AC 00-A`：PASS。17 个旧页面及 legacy section 均映射至新六入口及 Developer 分区。
- `AC 00-B`：PASS。核心缺口均明确生产提供者/消费者及负责 SPEC，无臆造接口。
- `AC 00-C`：PASS。原有工作树完好保留，基线测试与 check 命令 100% 成功。
- **下一步**：进入 `UIR-01`，实现六入口壳、Developer 偏好开关、兼容路由及统一状态信封。
