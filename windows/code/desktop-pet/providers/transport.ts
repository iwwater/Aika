import type { TurnScope } from '../contracts/index.js';
import { abortable, checkAbort } from '../media/scope.js';

export type ProviderOperation = 'asr' | 'perception' | 'dialogue' | 'tts' | 'memory_maintenance' | 'memory_turn' | 'summary' | 'admission';
export interface CallRequest { scope: TurnScope; operation: ProviderOperation; model: string; endpoint: string; textCharacters?: number; audioSeconds?: number }
export interface CallOutcome { status: 'success' | 'failed' | 'cancelled'; usage: unknown; requestId: string | null }
/** Integration owns one shared batch ledger. A permit must reserve budget before network access. */
export interface CallAuthorizer { authorize(request: CallRequest, signal: AbortSignal): Promise<{ settle(outcome: CallOutcome): Promise<void> }> }
export const denyPaidCalls: CallAuthorizer = { async authorize() { throw new Error('D09: paid calls have not been authorized'); } };
export interface EndpointConfig { endpoint: string; model: string; apiKey: () => string; authorizer: CallAuthorizer }
export type JsonRecord = Record<string, unknown>;
export function object(value: unknown): JsonRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid provider response object');
  return value as JsonRecord;
}
export function string(value: unknown): string { if (typeof value !== 'string') throw new Error('Invalid provider response text'); return value; }
export function parseModelJson(text: string): JsonRecord {
  const trimmed = text.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, '$1');
  try { return object(JSON.parse(trimmed)); } catch { throw new Error('Model did not return valid structured data'); }
}

/** Status and validated request identity only; never retain supplier body or URL. */
export class ProviderHttpError extends Error {
  readonly requestId: string | null;
  constructor(readonly status: number, readonly operation: ProviderOperation, requestId: string | null) {
    super(`Provider HTTP ${status}`); this.name = 'ProviderHttpError';
    this.requestId = requestId && /^[A-Za-z0-9_-]{1,128}$/.test(requestId) ? requestId : null;
  }
}

export interface ProviderRequestDiagnostic {
  phase: 'request_headers' | 'response_status' | 'response_body' | 'response_parse' | 'response_stream';
  elapsedMs: number; headersMs: number | null; httpStatus: number | null; requestId: string | null;
  responseBodyComplete: boolean; responseBodyUtf8Bytes: number | null;
  causeCode: string | null; abortReasonName: string | null;
}
/** Narrow strict-request diagnostic; original cause and cancellation behavior are retained. */
export class ProviderRequestFailure extends Error {
  constructor(error: unknown, readonly diagnostic: Readonly<ProviderRequestDiagnostic>) {
    super(error instanceof Error ? error.message : 'Provider request failed', { cause: error });
    this.name = error instanceof Error ? error.name : 'Error';
  }
}

export interface ProviderRequestOptions {
  /** Replaces the default Authorization/Content-Type headers wholesale (e.g. x-goog-api-key for Gemini). */
  headers?: Record<string, string>;
  /** Suppresses the automatic top-level `model` field (the Gemini URL carries it). */
  omitModel?: boolean;
}
export class ProviderTransport {
  constructor(private readonly fetcher: typeof fetch = fetch) {}
  async request(config: EndpointConfig, scope: TurnScope, operation: ProviderOperation, body: JsonRecord, signal: AbortSignal, textCharacters?: number, audioSeconds?: number, opts?: ProviderRequestOptions): Promise<JsonRecord> {
    checkAbort(signal);
    const endpoint = new URL(config.endpoint);
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !config.model) throw new Error('Explicit HTTPS provider endpoint and model required');
    const apiKey = config.apiKey(); if (!apiKey) throw new Error('Provider API key is not configured');
    const permit = await config.authorizer.authorize({ scope, operation, model: config.model, endpoint: config.endpoint, ...(textCharacters === undefined ? {} : { textCharacters }), ...(audioSeconds === undefined ? {} : { audioSeconds }) }, signal);
    let outcome: CallOutcome = { status: 'failed', usage: null, requestId: null };
    const started = performance.now();
    const trace: ProviderRequestDiagnostic = {phase:'request_headers',elapsedMs:0,headersMs:null,httpStatus:null,requestId:null,
      responseBodyComplete:false,responseBodyUtf8Bytes:null,causeCode:null,abortReasonName:null};
    try {
      checkAbort(signal);
      const headers = opts?.headers ?? { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
      const response = await this.fetcher(config.endpoint, { method: 'POST', headers, body: JSON.stringify(opts?.omitModel ? body : { ...body, model: config.model }), signal, redirect: 'error' });
      trace.headersMs = Math.round(performance.now() - started); trace.httpStatus = response.status;
      outcome.requestId = response.headers.get('x-request-id');
      trace.requestId = outcome.requestId && /^[A-Za-z0-9_-]{1,128}$/.test(outcome.requestId) ? outcome.requestId : null;
      trace.phase = 'response_status';
      checkAbort(signal);
      if (!response.ok) {
        // Release the failed response before any narrowly permitted caller recovery.
        await response.body?.cancel().catch(() => {});
        throw new ProviderHttpError(response.status, operation, outcome.requestId);
      }
      trace.phase = body.stream === true ? 'response_stream' : 'response_body';
      let result: JsonRecord;
      if (operation === 'memory_turn' && body.stream !== true) {
        // Keep the existing non-streaming wire; distinguish byte collection from JSON decoding.
        const text = await response.text(); trace.responseBodyComplete = true; trace.responseBodyUtf8Bytes = Buffer.byteLength(text,'utf8');
        checkAbort(signal); trace.phase = 'response_parse'; result = object(JSON.parse(text));
      } else result = body.stream === true ? await this.readCompletion(response, signal) : object(await response.json());
      checkAbort(signal);
      outcome = { status: 'success', usage: result.usage ?? null, requestId: typeof result.request_id === 'string' ? result.request_id : outcome.requestId };
      return result;
    } catch (error) {
      if (signal.aborted) outcome.status = 'cancelled';
      // No prompt, content, reasoning, response body, URL or credential is included in this trace.
      if (operation === 'memory_turn') {
        const code = (error as {cause?:{code?:unknown};code?:unknown})?.cause?.code ?? (error as {code?:unknown})?.code;
        const reason = signal.aborted && signal.reason instanceof Error ? signal.reason.name : null;
        trace.elapsedMs = Math.round(performance.now() - started);
        trace.causeCode = typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code) ? code : null;
        trace.abortReasonName = typeof reason === 'string' && /^[A-Za-z]{1,40}$/.test(reason) ? reason : null;
        throw new ProviderRequestFailure(error, Object.freeze({...trace}));
      }
      throw error;
    } finally { await permit.settle(outcome); }
  }
  async downloadAudio(uri: string, signal: AbortSignal): Promise<Uint8Array> {
    checkAbort(signal); const parsed = new URL(uri);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('Invalid provider audio URL');
    // This URL is supplier-returned; never attach the API Authorization header.
    const response = await this.fetcher(uri, { signal, redirect: 'error' });
    if (!response.ok) throw new Error(`Audio download HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer()); checkAbort(signal); return bytes;
  }
  private async readCompletion(response: Response, signal: AbortSignal): Promise<JsonRecord> {
    if (!response.body) throw new Error('Provider returned no stream');
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let pending = '', content = '', usage: unknown = null, requestId: unknown = null, finished = false;
    const consume = (frame: string) => {
      const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      if (!data || data === '[DONE]') return;
      const chunk = object(JSON.parse(data));
      if (chunk.id) requestId = chunk.id;
      if (chunk.error) {
        const errObj = typeof chunk.error === 'object' && chunk.error !== null ? chunk.error as Record<string, unknown> : null;
        const errCode = errObj?.code ? String(errObj.code) : errObj?.type ? String(errObj.type) : 'stream_error';
        const err = new Error(`Provider stream error: ${errCode}`);
        (err as unknown as Record<string, unknown>).code = errCode;
        if (requestId) (err as unknown as Record<string, unknown>).requestId = requestId;
        throw err;
      }
      if (Array.isArray(chunk.choices)) for (const raw of chunk.choices) {
        const choice = object(raw), delta = object(choice.delta ?? {});
        if (typeof delta.content === 'string') content += delta.content;
        if (choice.finish_reason === 'length') throw new Error('Provider output was truncated');
        if (choice.finish_reason === 'stop') finished = true;
      }
    };
    try {
      while (true) {
        checkAbort(signal); const chunk = await abortable(reader.read(), signal); checkAbort(signal);
        pending += decoder.decode(chunk.value, { stream: !chunk.done });
        // Normalize after buffering so a CRLF split across transport chunks is preserved.
        pending = pending.replace(/\r\n/g, '\n');
        let boundary: number;
        while ((boundary = pending.indexOf('\n\n')) >= 0) { consume(pending.slice(0, boundary)); pending = pending.slice(boundary + 2); }
        if (chunk.done) break;
      }
      if (pending.trim()) consume(pending);
      if (!finished || !content) throw new Error('Incomplete provider completion');
      return { text: content, usage, request_id: requestId };
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
}
