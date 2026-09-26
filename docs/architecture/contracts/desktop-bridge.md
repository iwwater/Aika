# Desktop Bridge Contract

## 责任边界

| 层 | 可以负责 | 不应负责 |
| --- | --- | --- |
| Console | 草稿、展示、用户操作、错误呈现 | 直接写数据库、持有 Provider 私有对象 |
| Management API | 鉴权、配置、诊断、记忆管理和 live runtime 投影 | 绕过 Runtime 执行隐藏副作用 |
| Electron preload/Bridge | 白名单命令、受控窗口能力 | 暴露任意 Node/fs/shell |
| Desktop renderer | 桌宠窗口、Live2D、尺寸、显示和表现生命周期 | 复制对话、Memory 或管理状态机 |

命令、静态资源和页面入口都必须经过白名单。鼠标穿透只影响桌宠主体的命中，不应让聊天框和设置栏失去正常交互；具体行为仍需由版本 SPEC 和真实 UI 证据确认。

页面重写应保持鉴权 epoch、请求序号、版本冲突和草稿保留机制，不能用一次无作用域的刷新覆盖正在编辑的状态。
