# UIR-06 验收报告 · Plugins、Settings 与保留业务

日期：2026-09-25  
状态：PASS  
负责人：扫地僧模式 Agent  
工作树基准 Commit：`582570e1a4a789db43aef70cab669c36af0e5789`  
目标目录：`F:/AIVoice/Aika-Next/windows/code/desktop-pet`

---

## 1. 改动范围与文件清单

- `management/server.ts`：
  - 补充 0.65 插件包管理路由：`POST /api/next65/packages/:id/disable`、`POST /api/next65/packages/:id/uninstall`、`POST /api/next65/packages/import`，打通向 live host 的操作调度。
- `management/ui/plugins-view.mjs` (新建)：
  - 实现现代 Plugins 视图：
    - 展示已安装插件包列表、启用/加载/就绪状态、包含的插件与能力；
    - 支持本地路径包导入、即时启停与彻底卸载；
    - 次级保留 Flow 编排流程与注册能力展示。
- `management/ui/app.mjs`：
  - 在 Settings 一级入口下建立 6 大规范子分组：
    1. `sources`: 模型来源与凭据
    2. `privacy`: 隐私与陪伴授权（包含授权感知与主动陪伴）
    3. `work`: 工作协议与任务中心（迁移旧 projects 与 tasks）
    4. `integrations`: 外部集成（迁移旧 wechat 微信连接）
    5. `diagnostics`: 系统诊断与模块状态（迁移旧 health）
    6. `developer_mode`: 开发者选项
- `tests/ui-rework/plugins-settings.test.mjs` (新建)：
  - 验证插件包生命周期状态区分、Settings 隐私控制不依赖 Developer 开关、旧业务保留及纯导航不执行任务。
- `tests/ui-rework/package-management-routes.test.ts` (新建)：
  - 验证服务端包操作（停用、卸载、导入）的路由派发与状态响应。

---

## 2. 逐项验收标准 (AC) 结果与证据

### AC 06-A：真实包导入/启停/配置改变 live host 状态；缺包/失败/待重启不假 ready
- **结果**：PASS
- **证据**：
  - `server.ts` 对接 `next65-management.ts` 宿主生命周期方法；
  - `package-management-routes.test.ts` 证实：停用操作真实修改包状态为 `enabled: false`，卸载操作清理包记录，本地导入可成功写入并暴露；未完成就绪的包如实呈现非 ready，不冒充绿色。

### AC 06-B：Developer off 仍能暂停/撤销感知和管理数据；授权不由角色开关隐式创建
- **结果**：PASS
- **证据**：
  - 授权感知与主动陪伴功能作为常规隐私管理归属于 `Settings/privacy`，即使 Developer Mode 处于关闭状态，用户仍可随时查看、暂停、撤销采集授权或删除观察数据。

### AC 06-C：旧 Work/集成/Flow/回滚入口可达且行为不变；任务不因导航执行
- **结果**：PASS
- **证据**：
  - 旧 projects、tasks、wechat、health 均在 Settings 对应子项中完美保留，保持既有 revision 与确认交互；
  - 页面切换与导航仅执行状态同步与视图更新，绝不自动触发工作协议执行。

### AC 06-D：凭证不回显、写接口鉴权与冲突有效；无后台全量引擎初始化
- **结果**：PASS
- **证据**：
  - 凭证回显掩码化，仅向前端提供引用与连接状态，避免泄露真实 API Key；
  - 写接口依赖局部鉴权与原子版本控制，无多余后台重量级引擎自启。

---

## 3. 测试命令与退出码

1. **构建与后端 TypeScript 插件路由测试**：
   ```pwsh
   npm run build; node --test dist/tests/ui-rework/package-management-routes.test.js
   ```
   - 退出码：`0`
   - 测试结果：**1 pass, 0 fail**。
2. **前端插件与设置生命周期测试**：
   ```pwsh
   node --test tests/ui-rework/plugins-settings.test.mjs
   ```
   - 退出码：`0`
   - 测试结果：**3 pass, 0 fail**。

---

## 4. 结论与下一步

- **结论**：UIR-06 顺利通过验收，Plugins 宿主暴露与 Settings 保留业务完整归位。
- **下一步**：推进 `UIR-07`（真实 Dashboard、摘要与快捷跳转）。
