# Windows 0.1.1 — 2026-09-17

- Codex 派发改用 Windows 官方 app-server JSONL 接口，支持已有任务、继承设置和精确回执；响应不明时不自动重发。
- 补齐旧 Harness 转交预设缺失的 MCP 入口，校验本机管理会话并只返回任务回执。
- Harness 支持 Windows 盘符工作目录、自定义 DSH_HOME；修复预设文件 ACL，并提供准备工具。
- 修复 Windows Node 路径 stat 与句柄 fstat 的设备编号差异导致合法凭据、数据库被拒绝的问题。
- 退出时等待后端完成清理，避免提前断开管道遗留锁。
- 支持本地模型参数覆盖；私有模型通过原生外观开关关闭水印，素材和私人参数不发布。
- 修复人工编辑记忆的保留逻辑，更新过期供应商测试数据，固定 Windows npm script-shell。

验证与限制见 [Windows validation](WINDOWS-VALIDATION.md#2026-09-17-windows-reproduction)。本次修改仅位于 windows/。
