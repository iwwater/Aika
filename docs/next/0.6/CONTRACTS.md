# 0.6 共享逻辑接口 v0.1

状态：设计契约，未实现。NEXT-00 产出源码符号映射，NEXT-01 冻结可执行契约；优先适配上游已有类型。下面的伪 TypeScript 是语义说明，不代表已经存在的导出。

## 1. 轮次、生成与终态

```ts
type Scope = { sessionId: string; turnId: string; generation: number };
type TurnInput = { text: string; source: 'text' | 'voice'; clientRequestId: string };
type TurnEnd = 'completed' | 'cancelled' | 'failed';
interface TurnPort {
  submit(sessionId: string, input: TurnInput): Promise<Scope>;
  cancel(scope: Scope): Promise<void>;
  subscribe(listener: (event: TurnEvent) => void): () => void;
}
type TurnEvent = { scope: Scope; eventId: string; sequence: number } & (
  | { type: 'replyDelta'; text: string }
  | { type: 'terminal'; status: TurnEnd; replyText?: string; errorCode?: string }
);
```

- 轮次 ID 和 generation 由上游权威运行时分配，适配层不再做第二套轮次状态机。submit 只等待接受请求，不等待整轮完成。
- submit 的 clientRequestId 在会话内幂等；事件先注册订阅，避免 submit resolve 前丢首事件。
- 同一会话新提交取消旧活跃轮；跨会话互不污染。cancel 幂等，终态恰好一次，终态后不再接受有效 delta。非合作 Provider 即使迟到也被作用域过滤。
- sequence 在轮内递增；UI、Memory writeback、TTS、Timeline 消费同一 Scope。STT segmentId 不能当 turnId。

## 2. Provider 与角色

```ts
type ProviderConfig = {
  id: string; protocol: 'openai-compatible' | 'gemini';
  endpoint: string; model: string; credentialRef: string;
};
interface DialogueAdapter {
  stream(request: {
    scope: Scope; messages: readonly ContextMessage[]; signal: AbortSignal;
  }): AsyncIterable<{ type: 'delta'; text: string } | { type: 'done' }>;
}
type AikaProfile = { schemaVersion: 1; id: string; displayName: string; systemPrompt: string };
```

ContextMessage 复用已核实的上游消息类型。Provider 不写 Memory/Timeline，不分配轮次，不操作 UI/TTS；错误抛标准错误类别，由上游运行时决定终态。done 最多一次，EOF 缺完成标记按对应协议明确处理。流分片可能切断 UTF-8/JSON；必须测试缓冲解析。

endpoint/model 可配置；credentialRef 只引用已有 SecretStore 或上游等价设施，普通配置不存明文 Key。角色配置作为一份系统上下文注入；不要在 Provider 中硬编码第二份 Prompt。已有角色字段不足时用最薄 adapter。

## 3. Context / Memory

沿用上游 lifecycle、correction/forget 和 budget 接口，不新增抽取器。NEXT-00 必须列出真实入口；不存在的能力登记差距，不能根据聊天方案凭空宣称存在。

保证：被取消的旧轮不能写入新轮上下文；会话隔离；遗忘中的内容不被后台任务重新写回；纠正后的检索不恢复旧值；Context 的实际预算按上游规则可复现。Timeline 不参与 0.6 检索，也不承担另一份 Memory。

## 4. Timeline

```ts
type ChatEvent = {
  schemaVersion: 1; eventId: string; scope: Scope; sequence: number;
  occurredAt: string; kind: 'userMessage' | 'assistantTerminal';
  messageId: string; text?: string; status?: TurnEnd;
};
interface TimelinePort {
  append(event: ChatEvent): Promise<'inserted' | 'duplicate'>;
  list(query: { sessionId: string; cursor?: string; limit: number }):
    Promise<{ items: ChatEvent[]; nextCursor?: string }>;
  redactByMessageIds(ids: readonly string[]): Promise<void>;
}
```

- eventId 唯一：相同 ID 相同 payload 幂等；不同 payload 报冲突，不能悄悄覆盖。分页按持久化排序键稳定排序，时间戳相同也不重复/漏项；limit 取 1～100。
- userMessage 在上游接受输入后记录一次；assistantTerminal 仅终态记录，不逐 token 落库。cancelled/failed 可保留明确标注的部分文本，不能声称完整回复。
- adapter 从上游已接受事件生成 stable ID；事件必须可追到 messageId。持久化使用上游现有存储设施或最小独立表，不引入另一套 ORM。
- redact 幂等并保留 tombstone，重放/重试不得恢复正文。Memory forget 若关联来源消息，则同步清理对应 Timeline 正文；若上游无法给出范围，NEXT-05 必须补映射与测试，不猜测删全库。
- Timeline 写失败不阻塞用户已收到的回复；错误状态可见。有界重试最多 3 次、重启不无限循环，最终失败显式标记；版本测试验证重放不会重复。

## 5. Voice

```ts
type AsrSegment = {
  inputSessionId: string; segmentId: string; index: number;
  text: string; audioEndMs: number; timeSource: 'audio' | 'estimated';
};
type SpeakRequest = { scope: Scope; sentenceId: string; text: string; language?: string };
interface SpeechInputPort { start(): Promise<void>; stop(): Promise<void>; cancel(): Promise<void> }
interface SpeechOutputPort { enqueue(request: SpeakRequest): Promise<void>; endTurn(scope: Scope): void; stop(scope: Scope): Promise<void> }
```

输入通过订阅发送 segmentFinal / turnReady / error；只有 turnReady 聚合成一次 TurnInput。段乱序按 index 合并，重复 segmentId 去重；stop 收尾，cancel 丢弃当前待发输入，不清掉新的输入会话。

输出订阅 started / sentenceCompleted / drained / stopped / error，每个事件含 Scope、sentenceId（如适用）、单调时间和 precision（measured/proxy/unknown）。endTurn 且队列与在途合成均空才 drained；失败或停止不能伪报成功交付。

打断由单一桥接入口执行 TurnPort.cancel + SpeechOutputPort.stop；继续监听新输入。旧音频回调不得恢复播放；句序不受合成完成顺序影响。生成完成与用户听到分开记录，拿不到实际测量只能标 proxy/unknown。

## 6. 修改归属

NEXT-01 管契约和 harness；NEXT-02 管 profile/settings；NEXT-03 管 Provider adapter；NEXT-04 管上游行为兼容；NEXT-05 管 Timeline；NEXT-06 管 Voice；NEXT-07 管 UI；NEXT-08 管跨模块集成。

共享文件变化需记录：原语义、新语义、受影响消费者、兼容 adapter、必跑用例。不可各模块复制一份 Scope。路径以 NEXT-00 SOURCE_MAP 为准，不根据本伪码先创建大批空模块。
