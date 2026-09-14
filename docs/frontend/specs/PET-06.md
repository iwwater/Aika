# PET-06 · Aiki 装配、设置与旧路径迁移

状态：DRAFT / 实现 NOT RUN。需求 DPI-06；前置 PET-03/04/05。
依据：[RPD迁移表](../RPD_DESKTOP_PET_INTEGRATION.md)、[共享契约](../../modules/CONTRACTS.md)。

## 文件范围

`src/app/hosts/`、组合根/插件装配、`src/presentation/desktopPetPresenter.ts`、现有设置组件与持久化配置。按实际引用定向调整 `src/hooks/usePetWindow.ts`、`src/pet/manager.ts`、旧relay调用点；必要时停用原生pet启动注册，但不批量删除 `src/pet/` 或 `petWindow.rs`。保留未提交用户修改并在报告登记。

## 用户流程

- 设置展示桌宠集成开关、连接状态、测试连接、发送演示、连接地址、启动方式、运行程序路径、随Aiki启动、退出时处理。高级重启选项默认关闭。
- 0.5 provider只显示OpenPet；NyaDeskPet未完成前不能作为可选成功路径。地址错误、未安装、离线、协议不兼容和能力不足分别提示。
- 首次配置默认关闭；旧pet.enabled不自动转换为managed启动授权。用户启用OpenPet模式后只装配一个表现出口，关闭旧自研pet自动创建/relay；主窗头像与聊天UI照常工作。
- 没有OpenPet点击回传时，陪伴、看屏幕聊聊、暂停/结束等控制保留在主窗；设置如实显示“当前桌宠不支持点击回传”，不隐藏需求差距。

## 装配与兼容

遵守optional token、resolve白名单与宿主注入。Service消费公开展示事件，不直接调用Provider。0.5 TTS仍由Aiki播放，桌宠不再收到旧口型写入。

保存配置与诊断：provider、profile、连接状态、延迟、错误代码、重连/丢弃计数；日志不记正文或全路径等不必要私人内容。开关关闭或宿主能力不存在时不请求localhost、不启动进程，不影响已有聊天和手机消费者。

## 验收

| AC | 通过条件 |
| --- | --- |
| PET-06-A | 首次/旧配置/损坏配置恢复正确，关闭状态零网络零spawn；测试连接结果真实 |
| PET-06-B | 主窗生产Runtime事件→生产Service→fake HttpPort可观察到四类命令；不创建第二Runtime |
| PET-06-C | OpenPet模式下无旧pet窗口创建与relay发送；旧主窗头像、聊天、TTS继续工作 |
| PET-06-D | Provider/Runtime/存储不因桌宠离线、超时、字段变化受阻；清楚显示降级原因 |
| PET-06-E | 切换配置/重新启用/应用卸载订阅后，无重复气泡订阅或进程所有权遗留 |
| PET-06-F | FE-31点击菜单与输入缺口登记到报告；主窗同等业务入口可用，不标双向桌宠完成 |
| PET-06-G | 可选契约、旧配置兼容与受影响消费者登记；架构及定向消费者测试通过 |

报告 `reports/PET-06_ACCEPTANCE.md`。生产装配+fake外部端口证明接线；真实桌面能力仍需PET-07。旧源码的彻底移除仅在新入口验收后另列清理，不混入本SPEC。
