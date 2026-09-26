# UIR-06 · Plugins、Settings 与保留业务

状态：NOT_STARTED；日期：2026-09-25。关联 [PRD](../RPD.md)、[SPEC 索引](../SPEC.md)、[工程映射](../SOURCE_MAPPING.md)。

## 1. 目标与责任边界

覆盖：UIR-R10/R11/R12。前置：UIR-01、02 配置所有权。

ui/next65、perception、proactive、health、projects/tasks、wechat 等现有 view 的组合入口；management/server.ts、next65-management.ts 与 live host 的最小暴露。

本专项 UI 可直接自行设计，不等待参考图或逐页批准。不得覆盖其他未提交修改；沿唯一运行时和既有存储权威完成直接消费者适配。

## 2. 实施步骤

1. Plugins 展示真实 installed/enabled/loaded/ready/failed/pendingRestart、依赖和配置；检查现有包导入/disable/stageUpdate/uninstall 方法，补必需 authenticated HTTP 管理适配并注入正在运行的 host。
2. 实现本地包导入、启停、配置、移除的最小流程；包路径校验/依赖失败/在用状态明确，停用即释放资源，不以重启延迟停止采集。配置保存遵循所属包契约。
3. Settings 按来源与凭证、设备、隐私与数据、集成/Work、诊断/高级分组。来源共享编辑显示影响范围，凭证 write-only；角色选择与全局默认不重复存储。
4. 感知授权/暂停/撤销/观察删除与主动策略在正常模式可用；0.81 来源仅预留接入位置，不伪造能力。用户删除操作沿已有 API 确认与遗忘语义。
5. 旧 projects/tasks、微信、唤醒、健康、配置历史/回滚、Flow 高级入口完整迁移；Work 确认保持 revision/显式确认，导航不能自动执行任务。
6. 数据目录迁移/更新器若不存在仅显示路径/版本及不支持说明；不得提供看似能保存但未生效的设置。

## 3. 验收标准

| AC | 必需结果 | 当前证据 |
| --- | --- | --- |
| 06-A | 真实包导入/启停/配置改变 live host 状态；缺包/失败/待重启不假 ready | NOT RUN |
| 06-B | Developer off 仍能暂停/撤销感知和管理数据；授权不由角色开关隐式创建 | NOT RUN |
| 06-C | 旧 Work/集成/Flow/回滚入口可达且行为不变；任务不因导航执行 | NOT RUN |
| 06-D | 凭证不回显、写接口鉴权与冲突有效；无后台全量引擎初始化 | NOT RUN |

## 4. 验证与交接

新增 tests/ui-rework/plugins-settings.test.mjs、package-management-routes.test.ts；复用 live-host-management、settings、perception/proactive/work-protocol-view 测试；真实临时包安装目录验证资源释放，不改用户已有包。

新增测试路径是计划文件，不表示已存在或通过。报告写入 `reports/UIR-06.md`（相对专项根）；记录基线/改动文件、公开契约及消费者、每项 AC、命令退出码、真实/fixture 区别和未运行项。下一步只能消费已有证据的能力。

## 5. 兼容、风险与未做项

不实现市场或替代插件平台。旧配置/包目录保持 owner，卸载沿既有影响确认；不能以移走页面删除业务。

