# MVP-04 · OCR Observation与陪伴

依据：[RPD](../../RPD_MVP_0.5.md) MVP-R04；前置MVP-01/03。

范围：domain/environment、services/environment、环境插件/presenter、ContextSource与定向测试。复用现有OCR引擎与采集；观察语义与供应商无关，原文继续独立授权通道，不增加万能EventBus或第二Agent。

| AC | 验收 |
| --- | --- |
| A | 至少一个PENTAKILL/胜利/build failed类明确规则→规范化Observation；重复帧合并、低置信度拒绝 |
| B | OCR OFF/暂停/锁屏后旧结果不进Context或Agent；quiet和busy不触发自动轮 |
| C | production规则→上下文源→生产Runtime→fake Provider→Presentation端口，恰好一次生成且含相应观察；OCR不直接调用桌宠 |
| D | 实际非私人画面→真实OCR→Agent→外部桌宠演示；缺真实条件单列NOT RUN，fixture不冒充device |
| E | 观察故障不阻断普通对话；OCR原文无授权不外发/入长期记忆 |

报告frontend/reports/MVP-04_ACCEPTANCE.md。实际采集仅限任务相关演示窗口，不读取私人画面。
