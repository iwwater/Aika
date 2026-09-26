# 0.81 Collection 契约设计

状态：**目标接口，尚未实现**。日期：2026-09-25。需求见 [RPD](RPD.md)，分步归属见 [SPEC](SPEC.md)，参数见 [双配置](TEST_PROFILES.md)。本文件给实施者一个可审查的接口基线；名称、路径与字段在 N081-00 落类型前核对当前源码，若必须调整，同一提交更新本文件、对应 SPEC 和直接消费者，不默默换语义。

## 1. 责任边界与落点

| Owner | 提供接口/数据 | 直接消费方 | 明确不负责 | SPEC |
| --- | --- | --- | --- | --- |
| `contracts/collection.ts`（拟新增） | 版本化 grant、policy、candidate/record、状态、查询类型与校验 | 桌面 adapter、Collection service、管理 port、Timeline | 原生系统调用、持久化实现 | 00 |
| `core/collection-grants.ts`（拟新增） | grant 状态机、配对/代次核验、暂停/撤销、资源注册 | 三来源 adapter、Collection service、管理 port | 0.8 单帧 `CaptureGrant`；图片识别 | 01 |
| `memory/collection-store.ts`（拟新增）及受管资产目录 | 样本/资产/反馈/删除的唯一持久 owner | Collection service、管理 API、Timeline 查询 | 另一套 Memory；直接写对话 History | 02 |
| Windows 桌面采集 adapter（N081-00 确认进程路径） | 聚合 keyboard 活动、目录候选、剪贴板图片候选 | Collection service | 在 renderer/网页中读全局输入；文本键盘日志 | 03～05 |
| `core/collection-service.ts`（拟新增） | adapter 事件的授权复检、稳定读取、去重、存储提交和健康统计 | 正式组合根、管理 port | OCR/VLM、TurnPort、邀请和长期晋升 | 01～05 |
| `management/collection-routes.ts`（拟新增）及 server/bootstrap | 本机鉴权 API 的参数校验、scope 固定和状态/查询/操作响应 | Settings、Dashboard、Timeline UI | 任意路径文件浏览器或第二采集进程 | 06 |
| `memory/unified-timeline.ts` 扩展 | 显式 `collection` 查询的只读投影 | 管理 API、Developer Timeline | 存一份不可删除的图片正文 | 06 |
| `app/trial-backend.ts` 正式组合根 | 包/桌面 listener、Collection service/store、管理端口的生命周期装配 | Windows 产品 | 用开发预览脚本代替正式接线 | 06 |

当前事实：[PairingScope](../../../windows/code/desktop-pet/contracts/character-pack.ts) 有 userId/characterId/characterInstanceId；[HostResourceRegistrar](../../../windows/code/desktop-pet/contracts/plugin.ts) 可注册 listener/file-handle 等释放；[CompanionEventEnvelope](../../../windows/code/desktop-pet/contracts/perception.ts) 和 [Event Hub](../../../windows/code/desktop-pet/core/companion-event-hub.ts) 只承认 canon/companion/work；[管理服务](../../../windows/code/desktop-pet/management/server.ts) 用 Bearer token、同源和管理错误码。以下新结构都不是现有导出。

## 2. 公共 TypeScript 形状

```ts
// 拟置于 contracts/collection.ts；PairingScope 复用现有定义。
type CollectionSourceKind = 'keyboard' | 'screenshot_directory' | 'clipboard_image';
type CollectionGrantState = 'active' | 'paused' | 'stopped' | 'revoked' | 'expired';
type CollectionProfile = 'normal' | 'smoke';
type CollectionConfidence = 'verified' | 'candidate' | 'unknown';

interface CollectionPolicy {
  readonly schemaVersion: 1;
  readonly profile: CollectionProfile;
  readonly policyVersion: number;
  readonly keyboardBucketMs: number;
  readonly keyboardQuietMs: number;
  readonly afkMs: number;
  readonly ringMaxAgeMs: number;
  readonly ringMaxItems: number;
  readonly sampleRetentionMs: number;
  readonly managedByteLimit: number;
  readonly queueItemLimit: number;
  readonly queueByteLimit: number;
  readonly crossSourceWindowMs: number;
  readonly grantMaxDurationMs: number;
  readonly fileStableIntervalMs: number;
  readonly clipboardRetryLimit: number;
  readonly clipboardRetryBudgetMs: number;
  readonly maxImageBytes: number;
  readonly maxImagePixels: number;
}

interface CollectionGrant {
  readonly schemaVersion: 1;
  readonly grantId: string;
  readonly revision: number;
  readonly pairing: PairingScope;
  readonly kind: CollectionSourceKind;
  /** 仅 screenshot_directory 提供，经 realpath 边界验证。 */
  readonly directoryRoot?: string;
  readonly purpose: 'local_sample_trial';
  readonly destination: 'local';
  readonly policyVersion: number;
  readonly state: CollectionGrantState;
  readonly grantedAt: string;
  readonly expiresAt: string;
}

interface CollectionSampleBase {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly revision: number;
  readonly pairing: PairingScope;
  readonly grantId: string;
  readonly grantRevision: number;
  readonly sourceKind: CollectionSourceKind;
  readonly policyVersion: number;
  readonly occurredAt: string | null; // 无法可靠得知时 null
  readonly receivedAt: string;
  readonly contextObservedAt: string | null;
  readonly expiresAt: string;
  readonly sourceConfidence: CollectionConfidence;
  readonly state: 'active' | 'invalidated';
}
interface KeyboardActivitySample extends CollectionSampleBase {
  readonly sampleKind: 'keyboard_activity';
  readonly bucketStart: string;
  readonly bucketEnd: string;
  readonly activityCount: number;
  readonly foregroundAppId: string | null;
  readonly afkBoundary: boolean;
  // 禁止 keyCode、scanCode、character、composition、逐键时间序列、输入正文。
}
interface ImageSample extends CollectionSampleBase {
  readonly sampleKind: 'image';
  readonly assetId: string; // 仅受管资产 ID；不向 UI 返回任意本地文件路径。
  readonly mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/bmp';
  readonly origin: 'directory_candidate' | 'clipboard_unknown' | 'correlated_capture';
  readonly repeated: boolean;
  readonly correlatedSourceIds: readonly string[];
  readonly foregroundAppId: string | null; // 仅关联线索，不充当事实来源。
}
type CollectionSample = KeyboardActivitySample | ImageSample;

interface CollectionQuery {
  readonly pairing: PairingScope; // 服务端从当前运行实例确定，不能信任浏览器自报。
  readonly from: string; // UTC ISO，包含
  readonly to: string;   // UTC ISO，不包含
  readonly kinds?: readonly CollectionSourceKind[];
  readonly limit: number; // 1..100
  readonly cursor?: string;
}
interface CollectionPage {
  readonly items: readonly CollectionSample[];
  readonly nextCursor: string | null;
  readonly totalMatching: number;
  readonly collectionRevision: number;
}
interface CollectionSourceStatus {
  readonly kind: CollectionSourceKind;
  readonly state: CollectionGrantState | 'disabled' | 'unavailable';
  readonly revision: number;
  readonly grantExpiresAt: string | null;
  readonly directoryDisplayPath: string | null; // 仅本机已鉴权管理页面可见的已授权目标
  readonly lastAcceptedAt: string | null;
  readonly accepted: number;
  readonly duplicates: number;
  readonly rejected: number;
  readonly dropped: number;
  readonly lastErrorCode: string | null;
}
interface CollectionStatus {
  readonly pairing: PairingScope;
  readonly instanceId: string;
  readonly collectionRevision: number;
  readonly profile: CollectionProfile;
  readonly policyVersion: number;
  readonly policy: CollectionPolicy;
  readonly managedBytes: number;
  readonly queueItems: number;
  readonly queueBytes: number;
  readonly sources: readonly CollectionSourceStatus[];
}
```

`normal`/`smoke` 的数值见 [配置表](TEST_PROFILES.md)。授权到期与样本 TTL 分开：授权过期只停止新采集，样本按各自 expiresAt 清理；主动撤销另触发来源数据失效。单次授权上限为 normal 7 天、smoke 30 分钟，用户可选更短期限；配置档切换不能沿用旧 grant。

`sourceConfidence='verified'` 只表示**来源通道/字节已验证**，不表示图片内容真实或用户一定主动截图；目录图片仍先标 `directory_candidate`，普通剪贴板图片保持 `clipboard_unknown`。

## 3. 原生输入端口与服务端口

```ts
// 端口形状；实现放在 Windows 主进程/受控 native 层，绝不暴露到网页 DOM。
interface CollectionSourceLease { close(): Promise<void>; }
interface KeyboardActivityPort {
  start(input: { grantId: string; policy: CollectionPolicy },
        onActivity: (value: { bucketStart: string; bucketEnd: string; activityCount: number;
          foregroundAppId: string | null; afkBoundary: boolean }) => void): Promise<CollectionSourceLease>;
}
interface ScreenshotDirectoryPort {
  start(input: { grantId: string; canonicalRoot: string },
        onCandidate: (value: { opaqueFileRef: string; observedAt: string }) => void): Promise<CollectionSourceLease>;
}
interface ClipboardImagePort {
  start(input: { grantId: string },
        onChange: (value: { clipboardSequence: number; observedAt: string }) => void): Promise<CollectionSourceLease>;
  readImageIfCurrent(sequence: number): Promise<{ bytes: Uint8Array; mimeType: string } | null>;
}

interface CollectionServicePort {
  status(pairing: PairingScope): Promise<CollectionStatus>;
  activate(input: { pairing: PairingScope; kind: CollectionSourceKind; directoryRoot?: string;
    expiresAt: string; expectedRevision: number; operationId: string }): Promise<CollectionStatus>;
  transition(input: { pairing: PairingScope; kind: CollectionSourceKind;
    action: 'pause' | 'resume' | 'stop' | 'revoke'; expectedRevision: number;
    operationId: string }): Promise<CollectionStatus>;
  list(query: CollectionQuery): Promise<CollectionPage>;
  readAsset(input: { pairing: PairingScope; sampleId: string;
    variant: 'thumbnail' | 'original' }): Promise<{ bytes: Uint8Array; mimeType: string } | null>;
  feedback(input: { pairing: PairingScope; sampleId: string;
    label: 'useful' | 'not_useful' | 'mismatch'; expectedRevision: number;
    operationId: string }): Promise<{ revision: number }>;
  recordMissing(input: { pairing: PairingScope; kind: CollectionSourceKind;
    observedAt: string; operationId: string }): Promise<{ id: string }>;
  erase(input: { pairing: PairingScope; scope: 'item' | 'range' | 'all'; sampleId?: string;
    from?: string; to?: string; expectedRevision: number; operationId: string }): Promise<{ affected: number; revision: number }>;
}
```

`CollectionStatus` 至少返回每来源 state/revision、已授权目录的实际展示路径、授权截止、policy/profile、最近采集时间、accepted/duplicate/rejected/dropped 计数、队列深度、受管字节、最后错误代码；未装包为 unavailable，未授权为 disabled，不能把零条样本显示为“来源健康”。目录路径仅在本机鉴权管理状态中展示，不写默认日志/Timeline。实际二进制读取只在服务内部进行；IPC/事件总线只传聚合数据、候选引用或受管资产 ID，且每次提交前复检 grant revision。

来源计数按当前 grant 修订统计，跨日质量报告可再按有效样本和无正文计数聚合。“漏采”没有 sampleId，必须调用独立 `recordMissing`；不得在某条已采样本上贴 `missed` 标签伪造遗漏。

## 4. 管理 API v1

沿用当前 `management/server.ts` 的 Bearer token、同源、写入 Origin 与 `ManagementError`。所有请求的 `pairing` 从正式运行实例确定；浏览器不传或改写 userId/characterId/instanceId。写操作均含 `operationId`（幂等）；修改既有 grant/样本/集合的操作另含 `expectedRevision`（冲突为 409），新建漏采标注无需旧资源修订。不可用包返回 503；密钥或用户图像不写日志。以下路径为 0.81 要实现的目标路由，不是现有 API。

| 方法与路径 | 请求 | 响应与边界 |
| --- | --- | --- |
| `GET /api/collection/status` | 无 | `CollectionStatus`；只含当前配对与授权可见数据 |
| `POST /api/collection/sources/:kind/activate` | `{operationId,expectedRevision,expiresAt,directoryRoot?,userConfirmed:true}` | grant/status；只有目录源接收目录，服务端 realpath 校验；确认展示的来源与本地留存 |
| `POST /api/collection/sources/:kind/{pause,resume,stop}` | `{operationId,expectedRevision}` | 新状态与修订；resume 复验同一范围 |
| `POST /api/collection/sources/:kind/revoke` | `{operationId,expectedRevision,userConfirmed:true}` | 撤销该来源并删除其有效样本；其他来源样本按仍有效证据重算 |
| `GET /api/collection/samples?from=&to=&kinds=&limit=&cursor=` | UTC 半开区间，limit 1～100 | `CollectionPage`；按 `receivedAt,id` 稳定分页，不能越配对读取 |
| `GET /api/collection/samples/:id/asset?variant=thumbnail|original` | ID 与变体 | 受鉴权的图片 bytes；仅有效且未过期的当前配对样本可读；`no-store`，无任意路径参数 |
| `POST /api/collection/samples/:id/feedback` | `{label,expectedRevision,operationId}` | 新修订；标签只用于质量评估，不自动晋升 Memory |
| `POST /api/collection/feedback/missing` | `{kind,observedAt,operationId}` | 记录无正文漏采标注；不创建假样本/Timeline 卡片 |
| `POST /api/collection/samples/:id/delete` | `{expectedRevision,operationId}` | `{affected,revision}`；副本、缩略图和投影失效，原图保留 |
| `POST /api/collection/samples/delete-range` | `{from,to,expectedRevision,operationId,userConfirmed:true}` | 半开区间删除；限制跨度并复核配对 |
| `POST /api/collection/samples/clear` | `{expectedRevision,operationId,userConfirmed:true}` | 当前配对试运行样本清空；保留无正文 tombstone 防重放 |

来源动作的 `expectedRevision` 是该来源 grant revision；feedback 的是该样本 revision；批量删除/清空的则是 `collectionRevision`。各写请求在同一 pairing 内按 `operationId` 幂等，重复 body 返回初次结果，body 冲突拒绝。管理端每次响应包含当前 policy/profile/revision，页面切换或迟到响应不覆盖新配对；时间区间 UI 显示本地日与时区，转换 UTC 传参。全量清空/撤销与停止是不同动作。API 不提供从浏览器传图片 base64 或任意文件路径读取的通道。`invalid_request`/`forbidden`/`version_conflict`/`unavailable` 等沿用现有错误码；内部系统错误只给脱敏原因与可查 requestId，不回传路径/图片正文。

## 5. 本地存储与身份/去重

单一 owner 的拟议持久结构：`collection_grants`（配对×来源的当前修订/状态/目录/期限）、`collection_samples`（事件/时间/来源/资产引用/有效性）、`collection_assets`（受管内容摘要、路径、字节、引用数，**仅同配对去重**）、`collection_feedback`、`collection_tombstones`（无正文的失效 key）、`collection_counters`。表名最终由 N081-00 对现有 SQLite owner 核对；不能在 UI 或 Timeline 再保存一份图片正文。受管图片写入临时文件、校验/原子转正并与样本事务提交；恢复时清孤儿、补缺失索引，先执行过期/撤销检查再开放读取。

重放 key 含配对、grant/revision、来源 kind 和来源自己的稳定通知 ID：keyboard 为桶起点/策略版，目录为同一文件版本，剪贴板为 sequence；**内容 hash 不作为事件 ID**。同一次文件/剪贴板捕获只有在精确内容等价、时间落窗口、同配对、两来源各自授权有效且候选一对一时关联为一个体验事件；底层仍保留两条来源证据，查询投影合并显示。证据不足保留两条并标 uncertain，不能靠相似 pHash 删除。不同时间重用同图保留新样本/事件但共享受管资产；撤销某来源只失效该来源证据，投影从剩余有效来源重算；按引用数清理资产，跨配对绝不共享受管文件。

删除事务先令来源不可见并写 tombstone，再清受管资产；任何迟到任务和补扫须查 tombstone。用户原图不在受管资产目录，从不纳入清理。派生缩略图/投影通过来源 ID 和版本反查有效性；未来 Observation/Memory 若显式引用该源，也必须消费失效信号，不默认把样本变成长期记忆。

## 6. Timeline、事件和兼容

在 `EventDomain` 新增 `collection`，`CompanionEventHub` 的验证与订阅范围同步适配。内部 live envelope 仅发布 `collection.sample.created`/`collection.sample.invalidated`，载荷为 `{sampleId,sourceKind,grantRevision,timeBasis}` 等非正文引用，`turnId` 缺省；采集发生时间不可靠时 envelope 的必填 occurredAt 取 receivedAt，`timeBasis='received'` 明示这是到达时间，不冒充原始发生时间。不要调用当前会合成 `host-user` 配对的通用 `HostEventChannel.publish()` 来伪造来源。Collection store 是耐久权威，Event Hub 只是通知；即使没有 subscriber，正式按日查询仍从有效样本生成投影。

`GET /api/unified-timeline` **未给 `domains` 时继续只返回 canon/companion/work**；只有 `domains=collection`（可与旧域组合）才读 Collection 投影。旧客户端对三域的排序、cursor、权限和 schema 不变；若复用 cursor 必须包含/校验域集与配对，不能跨域或跨用户复用。Collection 卡片增加 `collectionDetails:{sampleIds,timeBasis,sourceKinds,sourceConfidence}`，只显示“键盘活动区间”“图片候选/来源不确定”等有据文案；原图经单独鉴权资产路由读取，撤销后 Timeline 与资产路由同样不可见。

## 7. 配置与进程边界

`normal` 为正式默认；`smoke` 仅开发/测试启动时显式选择，独立数据根与授权，界面持续标识。配置加载拒绝未知 profile、负值、超过固定图片安全上限和数据根共用；只允许缩短等待/收紧测试预算，不允许跳过授权或把本地处理改云端。建议 N081-00 冻结一个内部启动参数或现有配置项，不虚构当前已有环境变量。

首选落点为正式 `trial-backend` 在当前 Windows 用户会话内启动**受控采集 helper**（拟放 `desktop/collection/`，构建产物由 Windows 构建纳入），而不是管理页或桌宠 renderer。helper 的 Raw Input 回调在自身进程内聚合 keyboard；clipboard 通知只报 sequence，收到后端带 grant/revision 的读取命令才把图片写入独立受管 staging 文件。指定目录由后端受限 watcher 监听。若 N081-00 验证该 helper 部署不可行，必须先修订本契约并说明替代桥的作用域与关闭语义，不能悄悄改为 renderer 键盘监听。

helper stdin/stdout 使用版本化、限长 NDJSON 控制消息，`{schemaVersion:1,instanceId,requestId,grantId,grantRevision,kind,op:'start'|'stop'|'read_clipboard_image'|'close',sequence?}`；上行带同一 instanceId/requestId/grantRevision，只允许聚合 keyboard 桶、clipboard sequence、健康/错误码或 `{stagedAssetId,mimeType,byteLength}`。**不传逐键字段，也不把 20 MiB 图片转成 base64 NDJSON**。后端仅凭同代次、未消费的 stagedAssetId 从 smoke/normal 各自的 staging 根一次性读取、校验并删除；helper 不能指定任意读取路径。文件候选 opaqueRef 也只在后端映射到已授权根。helper 崩溃、锁屏、暂停、停包或 backend 退出时终止监听、清 staging 并显式标 unavailable；`HostResourceRegistrar` 或等价生命周期记录 process/listener/file-handle。正式 `trial-backend`/管理 bootstrap 实例拥有 Collection service 的装配和关闭，预览脚本/fixture 不算生产接线。
