# PET-08 · NyaDeskPet Live2D 条件接入

> **2026-09-15 规划替代**：下文保留为历史参考；当前 0.6 Live2D 规格为 [MVP-11 草案](../../integration/specs/MVP-11.md)。本份不再作为可派发任务，不因选择 Live2D 自动启动 NyaDeskPet 接入；历史实现仍 NOT RUN。

状态：DEFERRED（0.6条件路线），实现NOT RUN。需求DPI-08。
启动条件：明确选择Live2D路线；复用PET-02/04/06接口。0.5不为本SPEC等待。

## 先做可行性出口

锁定NyaDeskPet tag/commit和Windows产物，验证能否通过设置把前端后端地址改到Aiki，并停止/禁用内置Agent的自动启动。先用未修改发行版配置；如必须修改启动装配，仅列最小patch与维护成本，不拆写renderer。无法可靠禁用内置Agent则停止实施并记录阻塞，不把猜测当“前端可独立部署”。

## 连接方向与范围

```text
Aiki DesktopPetService
        │ NyaDeskPetAdapter
        │ 本机WebSocket Server
        ↑ 前端发起连接
NyaDeskPet Desktop Frontend（WebSocket Client）
```

上游默认Agent地址为`ws://localhost:8011`，前端会发送`model_info`；展示下行使用`dialogue`和`live2d`。不能让Aiki与前端都充当连接同一Agent的客户端并假定自动转发。[官方API](https://github.com/gameswu/NyaDeskPet/blob/main/docs/API.md)

新增 `src/services/desktopPet/nyaDeskPetAdapter.ts` 与协议测试、宿主loopback WS服务端、必要装配。沿用已验证前端原有窗口/渲染/动作/口型。不要把NyaDeskPet的Agent、MCP执行或通用插件控制接进Aiki表现层。

## 协议与生命周期要求

- 按锁定版本核对WS路径、Origin/握手、客户端身份、单连接选择、帧大小上限、关闭与重连；只绑定loopback。端口冲突报错，不接管其他服务器。
- model_info后才将模型标ready；解析动作组/index、表情、参数并构建profile；切模型/断线清空能力。状态来自连接与模型信息，不虚构HTTP status。
- say→dialogue，action/emotion→live2d对应指令；Agent event按本地映射表达，未支持则明确降级。每条WS发送仅证明写入连接，缺应用确认时返回unknown，不伪造played。
- 首版仅处理model_info、character_info和受控tap_event；角色元信息不覆盖Aiki人格/记忆。tap_event若启用，只映射预设UI操作，不触发任意工具或自动开感知。
- 输出帧有界、断线丢过期任务、重连要求新的model_info；不能重播历史回复。每个连接绑定generation，旧连接帧不能污染新连接。
- 音频作为本SPEC后段可选子项：先核对音频格式/采样率/分片/顺序/结束/取消语义；Aiki生成、第三方播放及口型。单轮只选一个播放所有者，防止Aiki与前端双播。取消保证不足时不启用音频转交，口型标不支持。

## 验收

| AC | 通过条件 |
| --- | --- |
| PET-08-A | 真实Windows前端使用Aiki WS端点运行；内置Agent已禁用，无额外模型请求 |
| PET-08-B | 生产adapter+协议fixture验证握手/坏帧/超限/断线/迟到model_info/重连；不处理任意插件执行 |
| PET-08-C | 真实模型显示dialogue、动作与表情；不存在的motion/expression安全降级；切模型能力更新 |
| PET-08-D | OpenPet与NyaDeskPet切换后只有一个表现出口；同一业务fixture无需修改Agent或Memory；旧连接释放 |
| PET-08-E | 取消、重连、用户退出、进程所有权符合公共契约；本地端点无外网暴露 |
| PET-08-F | 若选择音频子项：真实口型、分片、截断/换轮、断线及单一播放者验证；否则明确DEFERRED，不宣称完整语音Live2D |
| PET-08-G | MIT源码许可、Live2D SDK及模型素材分别记录；最小配置/patch差异、可复现部署与回退步骤完整 |

输出 `reports/PET-08_ACCEPTANCE.md`，可行性、协议、device、音频分列。仅OpenPet已通过不能继承本适配器实机结论。
