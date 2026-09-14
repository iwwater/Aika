# PET-01 · OpenPet 版本与协议基线

状态：DRAFT / 实现 NOT RUN。需求 DPI-01；无代码前置。
依据：[RPD](../RPD_DESKTOP_PET_INTEGRATION.md)、[契约](../DESKTOP_PET_CONTRACT.md)。

## 目标与范围

用上游未修改的 Windows Release 建立兼容基线。交付 `reports/PET-01_ACCEPTANCE.md` 与 `reports/PET-01_PROTOCOL.md`，后者包含去敏的实测请求/响应和来源定位。可用临时探测脚本；本 SPEC 不实现 Adapter，不 Fork、不自编译桌宠、不改 Aiki 业务源码。

## 执行步骤

1. 从官方 Release 选择确定版本（本次资料候选 v0.1.6），记录 tag、完整 commit、下载资产名/URL/SHA256、Windows 架构、运行依赖。区分安装器与安装后运行文件，记录实际路径与版本关联。
2. 先只读源码/文档核对四端点。然后安装运行上游包，记录从启动到 status 可用与角色可见的状态。不把上游声称 Windows 验证当作本机 PASS。
3. 用固定公开短句和已确认的角色动作测试 status、say、action、event；保存准确请求、响应、状态码及可见表现证据。记录空值、未知动作、未知 event、非法 TTL 的实际响应。
4. 查明 status 的版本/角色/动作字段、是否存在身份特征及命令失败字段；记录没有的字段。核实 API 默认绑定地址、端口占用行为、CORS、角色切换、单实例、退出方式及是否存在接收确认以外的完成回调。
5. 编制 profile 所需角色/动作白名单，记录软件与当前素材的许可来源。0.5 默认外部安装，不捆绑资产。

## 验收

| AC | 可审查结果 | 证据 |
| --- | --- | --- |
| PET-01-A | tag/commit/资产哈希/实际运行 exe 可追溯；安装器不会成为启动路径 | 官方来源+本地记录 |
| PET-01-B | 原版程序在 Windows 可显示角色；四端点真实请求与 schema 已记录 | device |
| PET-01-C | 至少一次气泡、动作、thinking 可见，中文无乱码 | device 截图/录屏 |
| PET-01-D | 未知动作/非法输入、端口冲突、正常退出与崩溃的可观察差异有记录 | 协议及进程证据 |
| PET-01-E | capabilities 缺失时的 profile 来源明确；许可证与素材分别登记 | 文档 |

若版本不兼容，报告失败字段与替代 Release 候选，不无边界修改上游。没有真实运行环境时 B/C/D=NOT RUN 或有明确原因的 BLOCKED；PET-02/04 可用 fake 独立推进。
