# PET-05 · Sidecar 生命周期管理

状态：DRAFT / 实现 NOT RUN。需求 DPI-05；前置 PET-02 与 PET-01 的启动/退出证据。
依据：[契约进程端口](../DESKTOP_PET_CONTRACT.md)。

## 文件范围

`src/services/desktopPet/processManager.ts` 及测试；宿主进程端口拟放 `src-tauri/src/desktop_pet_process.rs`，只在必要注册点和 `src/app/hosts/` 装配。只管理配置的现成可执行程序，不下载/更新/安装上游、不支持任意命令执行。

## 状态与处理

| 状态/事件 | 行为 |
| --- | --- |
| attach | 只probe，离线提示用户启动；不spawn、不stop |
| managed开始 | 合并并发启动；先probe，已存在兼容实例则attach，否则验证exe后spawn |
| starting | 500ms探测一次，最多15秒；子进程在不代表窗口/HTTP就绪 |
| ready | 保存进程所有权；健康检查与进程状态分别观测 |
| 端口占用且非OpenPet | incompatible；不抢占端口，不终止占用者 |
| 仅API掉线、进程还活着 | 降级并重探测，不重复spawn |
| 崩溃 | 默认offline；开启autoRestart才按预算重启确定崩溃的自有进程 |
| 正常退出/原因不明 | offline，尊重用户关闭，手动重连 |
| disable/退出 | 取消未完成启动与重启任务；仅stopOwnedOnExit允许停止仍属自己的进程 |

不自动恢复持久化 PID 所有权。进程路径须为实际运行 exe，拒绝已知安装器，校验与 PET-01 安装记录一致；使用绝对路径、实参数组与 shell=false。辅助启动不弹控制台，但角色窗口须按 Runtime 自身行为显示。

## 验收

| AC | 通过条件 |
| --- | --- |
| PET-05-A | attach模式任何错误分支都零spawn/stop；外部已有实例不被接管 |
| PET-05-B | 20个并发启动只spawn一次；路径含空格/中文正确；安装器、缺文件、脚本输入拒绝 |
| PET-05-C | 超时/端口冲突/存活但API离线分别反馈；不无限启动 |
| PET-05-D | PID复用、重启后旧记录、单实例转交均不误杀；只使用本次spawn身份 |
| PET-05-E | 5分钟最多2次自动重启；禁用/正常退出/未知退出原因不会拉起 |
| PET-05-F | 启动中disable、停止超时、Aiki退出不遗留timer或阻塞业务；默认保留桌宠 |
| PET-05-G | 用受控测试进程验证原生spawn/stop与所有权；OpenPet实测留PET-07 |

先 fake ProcessPort+Clock 测生产状态机，再用本地测试进程测宿主。输出 `reports/PET-05_ACCEPTANCE.md`，不得通过按名称kill OpenPet制造测试结果。
