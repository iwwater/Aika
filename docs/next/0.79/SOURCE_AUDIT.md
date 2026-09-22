# 0.79 前置 code review 与 0.7 MVP 清单

日期：2026-09-23；基线：`3ade2be`；方法：当前源码、0.7/0.75 RPD/SPEC/报告、定向构建测试、合成数据复现。开始时工作树干净。本文件是审查，不是人工验收或产品修复报告。

目录：[MVP](#1-mvp-是否存在) · [发现](#2-review-发现与风险) · [现场](#3-五项现场问题与新需求) · [证据](#4-验证记录) · [结论](#5-准入结论)

## 1. MVP 是否存在

| 能力 | 当前实现与接线 | 审查结论 |
| --- | --- | --- |
| 来源导入、证据定位、CharacterDistiller | character-pack-source/validator/store、providers/character-distiller；有测试 | 模块存在；不是已交付完整 UI；截止点仍有下列问题 |
| Pack 草稿、激活、升级、回退 | CharacterPackStore 有事务与实例指针，现有模块测试 | 存在；自动生产激活/实例切换 UI 不据此算完成 |
| Canon/Companion 双线读取 | getSnapshot、latest-N 已改；正式 Context 可消费 | 读取存在；app/core 未检出 appendCompanionEvent 正式调用，自动事件写入未闭环 |
| User Soul/Wiki/关系 | ContinuityMemoryStore、管理路由和 Composer | 存储/手动管理/读取存在；app/core 未检出 commitDerived 正式调用，自动沉淀不等于手工 seed |
| 普通 Memory 生命周期 | 正式 SqliteLifecycleMemoryPort、RoleMemoryLifecycleQueue、StrictTrialMemoryProvider | 正式路径存在；新 DistillationScheduler 仍无 app/core 消费，不能声称 batching 已接通 |
| Context 正式读取和失效 | trial-backend → ProductionContinuityContext → foregroundContext；assertContinuityCurrent 已传入 | 此前“完全未接线”“遗忘后不检查当前版本”旧结论已发生变化；派生闭包仍不足 |
| Knowledge Library | knowledge-library、正文查看/删除 API、modern-knowledge-view 已接静态资源 | 导入/查看/删除模块存在；长期检索/持久化质量未验，且与对话自动沉淀不是同一能力 |
| 可选连续性包、实际 Flow 执行 | Store 仍在 trial-backend 无条件打开；新 liveHost 在管理启动处创建 | 尚不能证明普通对话由同一 PackageHost/Flow 执行；不把“有 host 对象”写成包体/Flow 全闭环 |
| 管理及桌面体验 | 部分页面已做，另有五项现场待修和大量后续界面 | MVP 体验未全部完成；允许按用户决定后置，明确关闭未就绪能力 |

**不能确认完整 0.7 MVP 全部完成。可以确认核心存储/提炼/读取模块与受控文字链路存在。** 0.79 应补最小安全和生产闭环，其他长期观察/界面工作继续登记延期。

## 2. Review 发现与风险

### A79-01 / P1：遗忘根事实不失效已经派生的事实

`memory/continuity-memory-store.ts` 的 forget 只撤销 targetId；activeFact/record 的 revokedSource 查询的是 character_source_revocations，没有沿 continuity fact sourceIds 检查 tombstone/派生闭包。合成复现：Wiki A → 派生 Soul B，遗忘 A 后 A 消失，B 仍 active。新的后台 lease 也不能替代已存在派生内容失效。影响未来主动陪伴从 Soul/Wiki 再次取出用户已要求遗忘的信息。归 N079-01，不能仅靠“UI 列表刷新”解决。

### A79-02 / P1：提炼成功分支丢失剧情截止点和作品元数据

`providers/character-distiller.ts` 的 validationResult.valid 分支直接采用 parsed；只有失败草稿分支补 input.cutoffPoint/workTitle。模型按当前 prompt schema 返回合法内容而不回显元数据时，validated 草稿两字段丢失。`computeCutoffAllowedBlockIds` 在 cutoff 未匹配时还允许所有区块，拼写错误会使边界失效。两项均已合成复现。归 N079-01：请求元数据由本地权威持久化，未知截止点明确拒绝/要求定位，不能静默放开。

### A79-03 / P1：连续性自动写入尚不能当作正式完成

app/core 未检出 appendCompanionEvent/commitDerived 的生产调用，受测六种来源通过手工写入。普通 Memory 已有后台并不自动生成独立的 Continuity 表和 Companion Timeline。进入依赖长期资料的主动陪伴前，需 N079-08 完成真实提交→投影→后续请求证据；与其无关的临时观察可独立开发。

### A79-04 / P2：40 秒提示状态改变没有取消真实请求

`desktop/main.mjs:107–118` 的计时器只 showBubble、设置 view.error 和 renderUI，没有向后端发送 cancel，也没有绑定本次 scope/requestId。不能称为已解决模型请求超时；晚到回复、旧计时器和主动问候争用仍需验证。归 N079-07：选择真实取消或仅标“仍在等待”的语义，不能提示“再问一次”却让旧轮继续失控输出。

### A79-05 / P2：Host 的管理对象不等于实际执行路径

trial-backend 在管理启动处 createPackageHost 后传 Next65Management，文本执行仍走既有 providers/pipeline；未见该对象启动包执行/Flow 的消费链。修复前次缺少 host 参数是真实进展，仍不足以宣告可选包隔离和 Flow 已由正式聊天消费。N079-09 明确验证或维持 unavailable，0.8 不依赖未证实执行器。

### A79-06 / 文档：需求编号重用

TODO 中 R-TODO-17 原为测试分组纪律，新时间问候又使用同号。新需求本版使用 **N079-R08 / FEAT-01**，目录登记改为唯一 R-TODO-19，旧文档的 R-TODO-17 问候引用保留勘误映射，不覆盖原工程纪律。

## 3. 五项现场问题与新需求

| 项目 | 源码核对 | 计划调整 |
| --- | --- | --- |
| FIX-01 Trace 看不到正文 | 默认 digest 是现有隐私设计，并非数据可解密显示；Trace 阶段白名单与早到缓冲已修改 | 新需求用鉴权后读取 History 关联正文实现，避免重新引入隐私副本；N079-02 |
| FIX-02 记忆无遗忘按钮 | views.mjs recordEditor 仅有 saveRecord；后端 memory/forget 存在 | 按记录类型和真实 DTO 接遗忘，不给所有记录一律套同一接口；N079-03 |
| FIX-03 情绪 loading | emotion-view 有 accept 校验，但 catch 写 error、finally 清 reading；nullable 已接受 null | “background 严格校验导致永久 loading”未经证明；先拿脱敏响应和生命周期证据，覆盖未返回请求/可见性/实例切换，不能直接删作用域校验；N079-04 |
| FIX-04 预览空白 | presentation-view 已 loadCore、动态 import、createPresentationPreview；presentation-assets 已映射 core/model/shader | “缺少全局 core”只是可能原因。检查网络/CSP/WebGL/容器尺寸与 dispose 竞态，不先改引擎；N079-05 |
| FIX-05 长 URL 重叠 | 有现场反馈，未在本轮浏览器复现计算样式 | 按实际容器和 selector 找最小尺寸问题；不得盲目 overflow:hidden 剪掉下拉菜单/校验/焦点；N079-06 |
| FEAT-01 时间问候 | 已有 speech bubble；未发现此时间调度实现 | 新功能，纳入 N079-07；复用邀请策略，明确零 LLM/TTS 与用户控制，不当缺陷处理 |

## 4. 验证记录

基线构建随 `npm run test:next07` 执行成功：**50/50 PASS**。同一构建产物执行 `node tools/run-tests.mjs next075`：**9/9 PASS**。未重复构建。日志见 [next07](evidence/next07.log)、[next075](evidence/next075.log)。

新增审查复现见 [脚本](evidence/reproduce.mjs) 与 [结果](evidence/results.txt)：只使用内存 SQLite、合成资料、模型 transport stub；验证 A79-01/02，不访问用户数据库/密钥，不调用真实模型。

当前测试通过不覆盖长期真人使用、所有页面交互、物理设备和 0.8 未来变更。旧 RP75 复现脚本的 Context 构造未传新增 assertContinuityCurrent 回调，不能直接复跑旧脚本后把漏传回调当成当前正式入口缺陷。

## 5. 准入结论

主线方向保留，0.79 作为有界修复轮合理。优先修派生遗忘、截止点和最小生产写读闭环；现场五项按证据和用户参考逐页修；本地问候不得变成平行主动陪伴系统。可后置长期质量观察及未完成 UI，但不可用“以后一起修”豁免正在使用路径的数据隔离/取消/遗忘。完成 N079-09 后按能力进入 0.8，不做零风险承诺。
