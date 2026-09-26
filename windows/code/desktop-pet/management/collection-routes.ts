/**
 * management/collection-routes.ts
 *
 * N081-06: authenticated management API for 0.81 collection (API v1).
 *
 * Every request is scoped by the runtime's own pairing: the browser never supplies or overrides
 * userId/characterId/characterInstanceId. Writes carry an `operationId` (idempotent) and, when they
 * modify an existing resource, an `expectedRevision` (409 on conflict). A genuine miss uses its own
 * route and never fabricates a sample id.
 *
 * No route accepts an image payload from the browser and no route accepts an arbitrary file path.
 */

import { ManagementError } from '../contracts/management.js';
import type {
  CollectionSourceKind,
  CollectionStatus,
} from '../contracts/collection.js';

export interface CollectionManagementPort {
  status(): Promise<CollectionStatus>;
  activate(input: {
    readonly kind: CollectionSourceKind; readonly directoryRoot?: string; readonly expiresAt: string;
    readonly expectedRevision: number; readonly operationId: string;
  }): Promise<CollectionStatus>;
  transition(input: {
    readonly kind: CollectionSourceKind;
    readonly action: 'pause' | 'resume' | 'stop' | 'revoke';
    readonly expectedRevision: number; readonly operationId: string;
  }): Promise<CollectionStatus>;
  list(query: {
    readonly from: string; readonly to: string; readonly kinds?: readonly CollectionSourceKind[];
    readonly limit: number; readonly cursor?: string;
  }): Promise<unknown>;
  readAsset(input: { readonly sampleId: string; readonly variant: 'thumbnail' | 'original' }):
  Promise<{ readonly bytes: Uint8Array; readonly mimeType: string } | null>;
  feedback(input: {
    readonly sampleId: string; readonly label: 'useful' | 'not_useful' | 'mismatch';
    readonly expectedRevision: number; readonly operationId: string;
  }): Promise<{ readonly revision: number }>;
  recordMissing(input: {
    readonly kind: CollectionSourceKind; readonly observedAt: string; readonly operationId: string;
  }): Promise<{ readonly id: string }>;
  erase(input: {
    readonly scope: 'item' | 'range' | 'all';
    readonly sampleId?: string; readonly from?: string; readonly to?: string;
    readonly expectedRevision: number; readonly operationId: string;
  }): Promise<{ readonly affected: number; readonly revision: number }>;
}

const SOURCE_KINDS: readonly CollectionSourceKind[] = ['keyboard', 'screenshot_directory', 'clipboard_image'];

function sourceKind(value: string): CollectionSourceKind {
  if (!SOURCE_KINDS.includes(value as CollectionSourceKind)) {
    throw new ManagementError('invalid_request', '没有这个采集来源。');
  }
  return value as CollectionSourceKind;
}

/** UTC ISO instant. A non-instant is refused rather than coerced to "now". */
function instant(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length > 64) throw new ManagementError('invalid_request', `${field} 需要 ISO 时间。`);
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw new ManagementError('invalid_request', `${field} 不是有效时间。`);
  return new Date(parsed).toISOString();
}

function revision(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new ManagementError('invalid_request', `${field} 无效。`);
  return parsed;
}

function operationId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 128) {
    throw new ManagementError('invalid_request', 'operationId 无效。');
  }
  return value;
}

function sampleId(value: string): string {
  const decoded = decodeURIComponent(value);
  if (!decoded || decoded.length > 128 || decoded.includes('/') || decoded.includes('\\')) {
    throw new ManagementError('invalid_request', '样本编号无效。');
  }
  return decoded;
}

/** Map a typed service refusal to a stable management error code with a scrubbed message. */
export function safeCollectionError(error: unknown): ManagementError {
  if (error instanceof ManagementError) return error;
  // `CollectionGrantError` carries the machine code on a property; its `message` is human text and
  // must never be matched against codes.
  const typed = error as { code?: unknown; message?: unknown } | null;
  const code = typeof typed?.code === 'string' ? typed.code
    : error instanceof Error ? error.message : '';
  if (code === 'collection_service_unavailable') return new ManagementError('unavailable', '当前运行实例未装配本地采集。');
  if (code === 'collection_source_not_authorized') return new ManagementError('forbidden', '该来源尚未授权。');
  if (code === 'collection_source_not_active') return new ManagementError('forbidden', '该来源当前不可采集。');
  if (code === 'collection_source_unavailable' || code === 'keyboard_source_unavailable'
    || code === 'screenshot_directory_unavailable' || code === 'clipboard_source_unavailable') {
    return new ManagementError('unavailable', '该来源在当前环境不可用；其他来源与基础对话不受影响。');
  }
  if (code === 'revision_conflict' || code === 'version_conflict') {
    return new ManagementError('version_conflict', '来源或样本已被更新，请刷新后重试。');
  }
  if (code === 'sample_not_available' || code === 'not_found') return new ManagementError('not_found', '没有这个有效样本。');
  if (code === 'revoked' || code === 'expired' || code === 'directory_required' || code === 'directory_forbidden'
    || code === 'invalid_request' || code === 'pairing_mismatch' || code === 'directory_boundary'
    || code === 'store_unavailable') {
    return new ManagementError('invalid_request', '采集请求无效、已过期或不属于当前配对。');
  }
  // Anything else is an internal failure: report a scrubbed reason, never a path or image content.
  return new ManagementError('unavailable', '采集操作未完成；原始图像与内部错误不会写入诊断。');
}

export async function collectionRoute(
  method: string | undefined,
  port: CollectionManagementPort | undefined,
  pathname: string,
  query: URLSearchParams,
  body: () => Promise<Record<string, unknown>>,
  send: (value: unknown) => void,
  binary: (bytes: Uint8Array, mimeType: string) => void,
): Promise<boolean> {
  if (!pathname.startsWith('/api/collection')) return false;
  if (!port) throw new ManagementError('unavailable', '当前运行实例未装配本地采集。');

  if (method === 'GET' && pathname === '/api/collection/status') {
    send(await port.status());
    return true;
  }

  const activate = /^\/api\/collection\/sources\/([^/]+)\/activate$/.exec(pathname);
  if (method === 'POST' && activate) {
    const value = await body();
    // Activation always requires an explicit user confirmation in the trusted UI.
    if (value.userConfirmed !== true) throw new ManagementError('forbidden', '需要先确认来源与本地留存范围。');
    const kind = sourceKind(decodeURIComponent(activate[1]!));
    const directoryRoot = value.directoryRoot === undefined ? undefined : String(value.directoryRoot);
    if (kind === 'screenshot_directory' && (directoryRoot === undefined || !directoryRoot.trim())) {
      throw new ManagementError('invalid_request', '目录来源必须指定一个目录。');
    }
    if (kind !== 'screenshot_directory' && directoryRoot !== undefined) {
      throw new ManagementError('invalid_request', '只有目录来源可以指定目录。');
    }
    try {
      send(await port.activate({
        kind,
        ...(directoryRoot !== undefined ? { directoryRoot } : {}),
        expiresAt: instant(value.expiresAt, 'expiresAt'),
        expectedRevision: revision(value.expectedRevision, 'expectedRevision'),
        operationId: operationId(value.operationId),
      }));
    } catch (error) { throw safeCollectionError(error); }
    return true;
  }

  const transition = /^\/api\/collection\/sources\/([^/]+)\/(pause|resume|stop|revoke)$/.exec(pathname);
  if (method === 'POST' && transition) {
    const value = await body();
    const action = transition[2] as 'pause' | 'resume' | 'stop' | 'revoke';
    // Revocation removes evidence, so it needs the same explicit confirmation as activation.
    if (action === 'revoke' && value.userConfirmed !== true) {
      throw new ManagementError('forbidden', '需要先确认撤销该来源并删除其有效样本。');
    }
    try {
      send(await port.transition({
        kind: sourceKind(decodeURIComponent(transition[1]!)),
        action,
        expectedRevision: revision(value.expectedRevision, 'expectedRevision'),
        operationId: operationId(value.operationId),
      }));
    } catch (error) { throw safeCollectionError(error); }
    return true;
  }

  if (method === 'GET' && pathname === '/api/collection/samples') {
    const from = instant(query.get('from'), 'from');
    const to = instant(query.get('to'), 'to');
    if (Date.parse(from) >= Date.parse(to)) throw new ManagementError('invalid_request', '时间区间无效。');
    const kinds = query.get('kinds');
    const parsedKinds = kinds ? kinds.split(',').filter(Boolean).map(sourceKind) : undefined;
    const limitRaw = query.get('limit');
    const limit = limitRaw === null ? 50 : revision(limitRaw, 'limit');
    if (limit < 1 || limit > 100) throw new ManagementError('invalid_request', 'limit 需在 1～100。');
    const cursor = query.get('cursor');
    send(await port.list({
      from, to,
      ...(parsedKinds && parsedKinds.length > 0 ? { kinds: parsedKinds } : {}),
      limit,
      ...(cursor ? { cursor } : {}),
    }));
    return true;
  }

  const asset = /^\/api\/collection\/samples\/([^/]+)\/asset$/.exec(pathname);
  if (method === 'GET' && asset) {
    const variant = query.get('variant') === 'thumbnail' ? 'thumbnail' : query.get('variant') === 'original' ? 'original' : null;
    if (!variant) throw new ManagementError('invalid_request', 'variant 只能是 thumbnail 或 original。');
    const found = await port.readAsset({ sampleId: sampleId(asset[1]!), variant });
    if (!found) throw new ManagementError('not_found', '没有这个有效样本或它已失效。');
    // Managed bytes are served no-store: they must not outlive validity in any cache.
    binary(found.bytes, found.mimeType);
    return true;
  }

  const feedback = /^\/api\/collection\/samples\/([^/]+)\/feedback$/.exec(pathname);
  if (method === 'POST' && feedback) {
    const value = await body();
    const label = value.label;
    if (label !== 'useful' && label !== 'not_useful' && label !== 'mismatch') {
      throw new ManagementError('invalid_request', '标注类型无效。');
    }
    try {
      send(await port.feedback({
        sampleId: sampleId(feedback[1]!), label,
        expectedRevision: revision(value.expectedRevision, 'expectedRevision'),
        operationId: operationId(value.operationId),
      }));
    } catch (error) { throw safeCollectionError(error); }
    return true;
  }

  if (method === 'POST' && pathname === '/api/collection/feedback/missing') {
    const value = await body();
    try {
      // A miss has no sample revision: it is idempotent on the pairing plus operationId only.
      send(await port.recordMissing({
        kind: sourceKind(String(value.kind ?? '')),
        observedAt: instant(value.observedAt, 'observedAt'),
        operationId: operationId(value.operationId),
      }));
    } catch (error) { throw safeCollectionError(error); }
    return true;
  }

  const remove = /^\/api\/collection\/samples\/([^/]+)\/delete$/.exec(pathname);
  if (method === 'POST' && remove) {
    const value = await body();
    try {
      send(await port.erase({
        scope: 'item', sampleId: sampleId(remove[1]!),
        expectedRevision: revision(value.expectedRevision, 'expectedRevision'),
        operationId: operationId(value.operationId),
      }));
    } catch (error) { throw safeCollectionError(error); }
    return true;
  }

  if (method === 'POST' && pathname === '/api/collection/samples/delete-range') {
    const value = await body();
    if (value.userConfirmed !== true) throw new ManagementError('forbidden', '需要先确认删除该时间段的样本。');
    const from = instant(value.from, 'from');
    const to = instant(value.to, 'to');
    if (Date.parse(from) >= Date.parse(to)) throw new ManagementError('invalid_request', '时间区间无效。');
    try {
      send(await port.erase({
        scope: 'range', from, to,
        expectedRevision: revision(value.expectedRevision, 'expectedRevision'),
        operationId: operationId(value.operationId),
      }));
    } catch (error) { throw safeCollectionError(error); }
    return true;
  }

  if (method === 'POST' && pathname === '/api/collection/samples/clear') {
    const value = await body();
    if (value.userConfirmed !== true) throw new ManagementError('forbidden', '需要先确认清空当前试运行样本。');
    try {
      send(await port.erase({
        scope: 'all',
        expectedRevision: revision(value.expectedRevision, 'expectedRevision'),
        operationId: operationId(value.operationId),
      }));
    } catch (error) { throw safeCollectionError(error); }
    return true;
  }

  throw new ManagementError('not_found', '没有这个采集操作。');
}
