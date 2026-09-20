// FIX61-02: server-side model discovery for the two wire protocols this build implements.
// The browser never carries a key: the management backend resolves the stored credential reference and
// performs the GET itself. Nothing here proves that a listed model can complete an inference request —
// discovery only proves that the models resource is reachable.
import { ManagementError } from '../contracts/management.js';
import { isAllowedEndpoint } from '../providers/slot-registry.js';

export type DiscoveryProtocol = 'openai-compatible' | 'gemini';
/** Provenance of an item's capability fields; 'unknown' is never upgraded by guessing from a model name. */
export type CapabilityEvidence = 'declared' | 'unknown';
export interface ModelCapabilities {
  /** Gemini supportedGenerationMethods, verbatim. Empty means the supplier declared nothing. */
  readonly methods: readonly string[];
  readonly evidence: CapabilityEvidence;
}
export interface DiscoveredModel { readonly id: string; readonly label: string; readonly capabilities: ModelCapabilities }
export interface ModelDiscoveryResult {
  readonly protocol: DiscoveryProtocol;
  readonly items: readonly DiscoveredModel[];
  readonly nextCursor?: string;
  readonly checkedAt: string;
  /** True when discovery stopped early at a bound; the returned list is incomplete, not authoritative. */
  readonly truncated: boolean;
}
export interface ModelDiscoveryRequest {
  protocol: DiscoveryProtocol;
  /** The configured inference endpoint; discovery reads its apiBase and never talks to this URL. */
  endpoint: string;
  credentialRef: string;
  /** Optional explicit models resource; required when the inference URL does not unambiguously carry an apiBase. */
  modelsEndpoint?: string;
  cursor?: string;
  signal?: AbortSignal;
}

export const MODEL_DISCOVERY_TIMEOUT_MS = 10_000;
export const MODEL_DISCOVERY_MAX_PAGES = 20;
export const MODEL_DISCOVERY_MAX_ITEMS = 1000;

/** Reservation of the upstream contract boundary; a user_id or x-goog-user-project header decides which quota pays. */
const RESERVED_HEADERS = new Set(['authorization', 'x-goog-api-key', 'x-api-key', 'api-key', 'x-goog-user-project', 'user_id', 'x-api-user']);
/** Referrer and tracing headers belong to an end-user page; the backend must not manufacture them. */
const FORBIDDEN_HEADERS = new Set(['referer', 'referrer', 'origin']);
const HEADER_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const CREDENTIAL_ECHO = /sk-[A-Za-z0-9_-]{4,}/g;
const MAX_HEADERS = 8;

export type ModelDiscoveryErrorCode = 'invalid_request' | 'unauthorized' | 'not_found' | 'rate_limited' | 'timeout' | 'invalid_response' | 'cancelled' | 'unavailable';

export class ModelDiscoveryError extends Error {
  readonly code: ModelDiscoveryErrorCode;
  readonly status: number | null;
  constructor(code: ModelDiscoveryErrorCode, message: string, status: number | null = null) {
    // Supplier bodies are never propagated: a supplier may echo the credential inside an error message.
    super(String(message).replace(CREDENTIAL_ECHO, '***'));
    this.name = 'ModelDiscoveryError';
    this.code = code;
    this.status = status;
  }
}

/** Credential lookup port. The key is read from the restricted local store and never cached here. */
export interface DiscoveryCredentials { key(ref: string): string | Promise<string> }
/** `timeoutMs` exists so a test can drive the same production timeout branch without waiting ten seconds. */
export interface ModelDiscoveryOptions { credentials: DiscoveryCredentials; fetch?: typeof fetch; timeoutMs?: number }

export interface ModelDiscoveryListRequest extends ModelDiscoveryRequest { headers?: Readonly<Record<string, string>>; modelsEndpoint?: string }

function requestFailure(message: string): never { throw new ModelDiscoveryError('invalid_request', message); }

function normalizedEndpoint(value: unknown, label: string): URL {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048 || /[\u0000-\u001f\u007f]/.test(value)) requestFailure(`${label}无效。`);
  if (!isAllowedEndpoint(value)) requestFailure(`${label}必须是 HTTPS 或显式回环 HTTP，且不能交给重定向后的其他主机。`);
  return new URL(value);
}

/**
 * Derives the models resource. The inference path is replaced, never extended: '.../chat/completions'
 * becomes '.../models', and a configured apiBase gains '/models'. An endpoint whose apiBase cannot be
 * derived is refused so the user configures it explicitly instead of receiving an unexplained 404.
 */
export function resolveModelsUrl(protocol: DiscoveryProtocol, endpoint: string, modelsEndpoint?: string): string {
  if (modelsEndpoint !== undefined && modelsEndpoint !== null && String(modelsEndpoint).trim()) {
    const explicit = normalizedEndpoint(modelsEndpoint, '模型列表地址');
    explicit.search = ''; explicit.hash = '';
    return explicit.toString().replace(/\/$/, '');
  }
  const url = normalizedEndpoint(endpoint, '服务地址');
  url.search = ''; url.hash = '';
  if (protocol === 'gemini') {
    let path = url.pathname.replace(/\/+$/, '');
    if (path.endsWith('/models')) return url.origin + path;
    // '.../models/<id>:generateContent' -> '.../models/<id>' -> the apiBase that owns 'models'.
    path = path.replace(/:[A-Za-z]+$/, '');
    const marker = path.lastIndexOf('/models/');
    if (marker >= 0) path = path.slice(0, marker);
    if (!/(^|\/)v\d+(?:beta|alpha)?\d*$/.test(path)) requestFailure('无法从该 Gemini 地址推导 models 资源；请单独配置 modelsEndpoint，或直接手工填写型号名。');
    return url.origin + path + '/models';
  }
  if (protocol !== 'openai-compatible') requestFailure('协议未登记，本版本只支持 openai-compatible 与 gemini 的模型发现。');
  let path = url.pathname.replace(/\/+$/, '');
  if (path.endsWith('/models')) return url.origin + path;
  const derived = path.replace(/\/(chat\/completions|completions|responses|embeddings|messages)$/, '');
  if (derived === path && !/\/v\d+(?:beta|alpha)?\d*$/.test(path)) requestFailure('无法从该地址推导 OpenAI 兼容的 models 资源；请单独配置 modelsEndpoint，或直接手工填写型号名。');
  return url.origin + (derived === path ? path : derived) + '/models';
}

function headerBag(headers: Readonly<Record<string, string>> | undefined): Record<string, string> {
  if (headers === undefined) return {};
  const entries = Object.entries(headers);
  if (entries.length > MAX_HEADERS) requestFailure('自定义请求头过多。');
  const bag: Record<string, string> = {};
  for (const [rawName, rawValue] of entries) {
    const name = rawName.toLowerCase();
    if (!HEADER_NAME.test(name)) requestFailure('自定义请求头名称无效。');
    if (RESERVED_HEADERS.has(name)) requestFailure('鉴权头由本机凭据引用决定，不能在请求中覆盖。');
    if (FORBIDDEN_HEADERS.has(name)) requestFailure('该请求头不由本机后端发送。');
    if (typeof rawValue !== 'string' || !rawValue.length || rawValue.length > 256 || /[\u0000-\u000f\u007f]/.test(rawValue)) requestFailure('自定义请求头内容无效。');
    bag[name] = rawValue;
  }
  return bag;
}

const DECLARED_METHODS = /^[A-Za-z]{1,40}$/;
function readMethods(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  const methods: string[] = [];
  for (const entry of value) if (typeof entry === 'string' && DECLARED_METHODS.test(entry) && !methods.includes(entry) && methods.length < 32) methods.push(entry);
  return methods;
}
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);

/** One page of either protocol, normalized. Duplicate ids inside or across pages are reported once. */
function pageItems(protocol: DiscoveryProtocol, payload: unknown): { items: DiscoveredModel[]; nextCursor?: string } {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new ModelDiscoveryError('invalid_response', '模型列表不是预期的 JSON 结构，请改为手工填写型号名。');
  const raw = payload as Record<string, unknown>;
  if (protocol === 'openai-compatible') {
    // A bare array is what several compatible gateways actually return; it is the only tolerated variant.
    const list = Array.isArray(payload) ? payload : raw.data;
    if (!Array.isArray(list)) throw new ModelDiscoveryError('invalid_response', '模型列表不是预期的 JSON 结构，请改为手工填写型号名。');
    const items: DiscoveredModel[] = [];
    for (const entry of list) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const id = (entry as Record<string, unknown>).id;
      if (!text(id, 200) || id.trim() !== id || items.some(item => item.id === id)) continue;
      items.push({ id, label: id, capabilities: { methods: [], evidence: 'unknown' } });
    }
    return { items };
  }
  const list = raw.models;
  if (!Array.isArray(list)) throw new ModelDiscoveryError('invalid_response', '模型列表不是预期的 JSON 结构，请改为手工填写型号名。');
  const items: DiscoveredModel[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const name = record.name;
    if (!text(name, 220)) continue;
    const id = name.startsWith('models/') ? name.slice('models/'.length) : name;
    if (!text(id, 200) || items.some(item => item.id === id)) continue;
    const methods = readMethods(record.supportedGenerationMethods);
    items.push({ id, label: text(record.displayName, 120) ? record.displayName : id,
      capabilities: { methods, evidence: methods.length ? 'declared' : 'unknown' } });
  }
  const next = raw.nextPageToken;
  return { items, ...(text(next, 512) ? { nextCursor: next } : {}) };
}

export class ModelDiscovery {
  private readonly fetcher: typeof fetch;
  constructor(private readonly options: ModelDiscoveryOptions) { this.fetcher = options.fetch ?? fetch; }

  async list(request: ModelDiscoveryListRequest): Promise<ModelDiscoveryResult> {
    const protocol = request.protocol;
    if (protocol !== 'openai-compatible' && protocol !== 'gemini') requestFailure('协议未登记，本版本只支持 openai-compatible 与 gemini 的模型发现。');
    const url = resolveModelsUrl(protocol, request.endpoint, request.modelsEndpoint);
    if (typeof request.credentialRef !== 'string' || !request.credentialRef.trim() || request.credentialRef.length > 200) requestFailure('请选择已保存的本机凭据。');
    const timeoutMs = this.options.timeoutMs ?? MODEL_DISCOVERY_TIMEOUT_MS;
    let key: string;
    try { key = await this.options.credentials.key(request.credentialRef); }
    catch { throw new ModelDiscoveryError('invalid_request', '凭据引用无法解析，请先在本机保存该服务的 API Key。'); }
    if (typeof key !== 'string' || !key.trim()) throw new ModelDiscoveryError('invalid_request', '凭据引用无法解析，请先在本机保存该服务的 API Key。');
    const custom = headerBag(request.headers);

    try { request.signal?.throwIfAborted(); }
    catch { throw new ModelDiscoveryError('cancelled', '模型发现已取消。'); }

    const items: DiscoveredModel[] = [];
    let cursor = request.cursor;
    const seenCursors = new Set<string>();
    let pages = 0;
    let truncated = false;
    for (;;) {
      request.signal?.throwIfAborted();
      const target = new URL(url);
      if (cursor !== undefined) target.searchParams.set(protocol === 'gemini' ? 'pageToken' : 'after', cursor);
      // One bounded deadline per page. Nothing from the management session is forwarded to the supplier.
      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
      let response: Response;
      try {
        response = await this.fetcher(target.toString(), { method: 'GET', redirect: 'error', signal,
          headers: { Accept: 'application/json', ...(protocol === 'gemini' ? { 'x-goog-api-key': key } : { Authorization: 'Bearer ' + key }), ...custom } });
      } catch (error) {
        if (request.signal?.aborted) throw new ModelDiscoveryError('cancelled', '模型发现已取消。');
        if (timeout.aborted || (error as { name?: string }).name === 'TimeoutError') throw new ModelDiscoveryError('timeout', `获取模型列表超过 ${Math.round(timeoutMs / 1000)} 秒未返回，请检查服务地址或直接手工填写型号名。`);
        if ((error as { name?: string }).name === 'AbortError') throw new ModelDiscoveryError('cancelled', '模型发现已取消。');
        throw new ModelDiscoveryError('unavailable', '无法连接该服务地址，请检查端点与网络后重试，或直接手工填写型号名。');
      }
      // Read the body under the same deadline, then release it before any other request.
      let raw: string;
      try { raw = await response.text(); }
      catch (error) {
        if (request.signal?.aborted) throw new ModelDiscoveryError('cancelled', '模型发现已取消。');
        if (timeout.aborted || (error as { name?: string }).name === 'TimeoutError') throw new ModelDiscoveryError('timeout', `获取模型列表超过 ${Math.round(timeoutMs / 1000)} 秒未返回，请检查服务地址或直接手工填写型号名。`);
        if ((error as { name?: string }).name === 'AbortError') throw new ModelDiscoveryError('cancelled', '模型发现已取消。');
        throw new ModelDiscoveryError('unavailable', '模型列表读取中断，请重试或直接手工填写型号名。');
      }
      await response.body?.cancel().catch(() => {});
      if (!response.ok) throw new ModelDiscoveryError(statusCode(response.status), statusMessage(response.status), response.status);
      let payload: unknown;
      try { payload = JSON.parse(raw); }
      catch { throw new ModelDiscoveryError('invalid_response', '该地址返回的不是 JSON 模型列表；可改用明确的服务地址，或直接手工填写型号名。'); }

      pages++;
      const page = pageItems(protocol, payload);
      for (const item of page.items) {
        if (items.length >= MODEL_DISCOVERY_MAX_ITEMS) { truncated = true; break; }
        if (!items.some(existing => existing.id === item.id)) items.push(item);
      }
      if (items.length >= MODEL_DISCOVERY_MAX_ITEMS) {
        truncated = truncated || page.nextCursor !== undefined;
        return result(protocol, items, undefined, truncated);
      }
      const next = page.nextCursor;
      if (next === undefined) return result(protocol, items, undefined, truncated);
      if (pages >= MODEL_DISCOVERY_MAX_PAGES || seenCursors.has(next)) {
        // A repeated or endless page token means the supplier cannot page any further; the list is incomplete.
        return result(protocol, items, next, true);
      }
      seenCursors.add(next);
      cursor = next;
    }
  }
}

function result(protocol: DiscoveryProtocol, items: readonly DiscoveredModel[], nextCursor: string | undefined, truncated: boolean): ModelDiscoveryResult {
  return Object.freeze({ protocol, items: Object.freeze([...items]), checkedAt: new Date().toISOString(), truncated,
    ...(nextCursor === undefined ? {} : { nextCursor }) });
}
function statusCode(status: number): ModelDiscoveryErrorCode {
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'unavailable';
  return 'invalid_request';
}
function statusMessage(status: number): string {
  if (status === 401) return '该服务拒绝了这次请求（401）：请核对端点与 API Key；也可以直接手工填写型号名。';
  if (status === 403) return '该服务不允许列出模型（403）：可能是权限或地区限制；可以直接手工填写型号名。';
  if (status === 404) return '该地址没有模型列表（404）：请核对服务地址，或直接手工填写型号名。';
  if (status === 429) return '该服务限流（429）：请稍后重试，或直接手工填写型号名。';
  if (status >= 500) return '该服务暂时不可用：请稍后重试，或直接手工填写型号名。';
  return `获取模型列表失败（HTTP ${status}）：可以直接手工填写型号名。`;
}

/** Keeps the management error vocabulary: routes translate these into the existing HTTP error plane. */
export function managementFailure(error: unknown): ManagementError {
  if (error instanceof ModelDiscoveryError) {
    const code = error.code === 'unauthorized' ? 'forbidden' : error.code === 'not_found' ? 'not_found'
      : error.code === 'cancelled' ? 'unavailable' : error.code === 'unavailable' ? 'unavailable' : 'invalid_request';
    return new ManagementError(code, error.message);
  }
  return new ManagementError('internal_error', '模型发现未完成，原始内容和内部错误未对外输出。');
}

export { isAllowedEndpoint };
