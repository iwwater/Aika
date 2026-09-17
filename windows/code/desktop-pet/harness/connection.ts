import { randomUUID } from 'node:crypto';

export type HarnessConnectionState = 'ready' | 'unavailable' | 'authentication_required' | 'incompatible';
export interface HarnessConnectionSnapshot {
  state: HarnessConnectionState;
  observedAt: string;
  /** This probe cannot establish a Codex executor or an App task connection. */
  codexDelivery: 'unverified';
}
export class HarnessConnectionError extends Error {
  constructor(readonly state: Exclude<HarnessConnectionState, 'ready'>) { super(state); }
}
export interface RelayMetrics {
  sessionId: string; running: boolean; preset: string | null;
  throughSeq?: number;
  model: { provider: string; model: string; reasoningEffort?: string } | null;
  usage: { uncachedInputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; outputTokens: number } | null;
}
export interface RelayTerminal { status: 'unknown' | 'ended'; turn?: number; reason?: string; errorCode?: string }

/** Native work stays in its own session and never interprets model prose as a terminal receipt. */
export interface NativeWorkReceipt {
  status: 'working' | 'approval' | 'completed' | 'failed' | 'unknown';
  result?: string;
  detail?: string;
  sessionUrl?: string;
  approvalTools?: string[];
}
interface WorkEvent {
  seq: number; type: string; turn?: number; rpcId?: string; reason?: string;
  approvalId?: string; approvalTool?: string; text?: string;
}
const nativeId = (value: string) => /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);

/** dsh 0.1.5-rc.1 Host protocol. New sessions are explicit, per-session relay compositions. */
export class HarnessConnection {
  constructor(private readonly launchUrl: () => Promise<string>, private readonly timeoutMs = 5000) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('Invalid connection timeout');
  }

  async probe(): Promise<HarnessConnectionSnapshot> {
    const result = (state: HarnessConnectionState): HarnessConnectionSnapshot => ({ state, observedAt: new Date().toISOString(), codexDelivery: 'unverified' });
    try { await this.call('session/list', { _request: {} }); return result('ready'); }
    catch (error) { return result(error instanceof HarnessConnectionError ? error.state : 'unavailable'); }
  }

  async createRelaySession(sessionId: string, preset: string, cwd: string): Promise<void> {
    const value = await this.call('session/create', { request: { sessionId, agentPreset: preset, cwd } });
    if (value?.sessionId !== sessionId) throw new HarnessConnectionError('incompatible');
    // A deterministic title prevents the Host's optional first-prompt LLM title call.
    const title = 'Desktop pet relay ' + sessionId.slice(-8);
    const renamed = await this.call('session/rename', { request: { sessionId, title } });
    if (renamed?.title !== title || !Number.isSafeInteger(renamed.seq)) throw new HarnessConnectionError('incompatible');
    const selected = await this.call('session/selectModel', { request: { sessionId, provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' } });
    if (selected?.selected?.provider !== 'deepseek-official' || selected.selected.model !== 'deepseek-flash' || selected.selected.reasoningEffort !== 'high') throw new HarnessConnectionError('incompatible');
  }

  /** I installs this native composition without delegation, and owns confirmation before calling. */
  async createWorkSession(sessionId: string, cwd: string): Promise<void> {
    if (!nativeId(sessionId) || !cwd.startsWith('/') || /[\0\r\n]/.test(cwd)) throw new HarnessConnectionError('incompatible');
    const created = await this.call('session/create', { request: { sessionId, agentPreset: 'desktop-pet-work-v1', cwd } });
    if (created?.sessionId !== sessionId || created.agentPreset !== 'desktop-pet-work-v1') throw new HarnessConnectionError('incompatible');
    const title = 'Desktop pet work ' + sessionId.slice(-8);
    const renamed = await this.call('session/rename', { request: { sessionId, title } });
    if (renamed?.title !== title || !Number.isSafeInteger(renamed.seq)) throw new HarnessConnectionError('incompatible');
    const selected = await this.call('session/selectModel', { request: { sessionId, provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' } });
    if (selected?.selected?.provider !== 'deepseek-official' || selected.selected.model !== 'deepseek-flash' || selected.selected.reasoningEffort !== 'high') throw new HarnessConnectionError('incompatible');
  }

  /** No rewriting, implicit confirmation, retry, timeout cancellation, or local work queue. */
  async submitWork(sessionId: string, requestId: string, text: string): Promise<void> {
    if (!nativeId(sessionId) || !nativeId(requestId) || typeof text !== 'string' || !text.trim()) throw new HarnessConnectionError('incompatible');
    const value = await this.call('session/prompt', { request: { sessionId, requestId, mode: 'queue', content: [{ type: 'text', text }] } });
    if (value?.accepted !== true) throw new HarnessConnectionError('incompatible');
  }

  /** Actual Host root only, not a claimed session deep link. Browser authentication may be needed. */
  async workHostUrl(): Promise<string> {
    return (await this.launchEndpoint()).origin + '/';
  }

  /** Cold list/page only. Never starts/resumes work or grants an approval while observing it. */
  async workReceipt(sessionId: string, requestId: string): Promise<NativeWorkReceipt> {
    const unknown = (): NativeWorkReceipt => ({ status: 'unknown', detail: '暂时无法核实这次任务的状态；不会自动重发。' });
    if (!nativeId(sessionId) || !nativeId(requestId)) return unknown();
    const deadline = Date.now() + this.timeoutMs;
    try {
      const list = await this.call('session/list', { _request: {} });
      const matches = list.items.filter((row: any) => row?.sessionId === sessionId);
      if (matches.length !== 1) return unknown();
      const row = matches[0], throughSeq = row.projections?.asOfSeq;
      if (typeof row.running !== 'boolean' || !Number.isSafeInteger(throughSeq) || throughSeq < 0 || row.origin === 'subagent' || row.parentSessionId || row.projections?.values?.agentPreset !== 'desktop-pet-work-v1') return unknown();
      const inbox = row.projections?.values?.inbox;
      // Native inbox projection carries UserMessage.source.rpcId, not a made-up metrics flag.
      const queued = ['next-turn', 'next-step'].some(key => Array.isArray(inbox?.[key]) && inbox[key].some((message: any) => message?.source?.kind === 'user' && message.source.rpcId === requestId));
      const records: WorkEvent[] = [];
      let beforeSeq: number | undefined;
      for (let pageIndex = 0; pageIndex < 16; pageIndex++) {
        if (Date.now() >= deadline) return unknown();
        const page = await this.call('session/page', { request: { address: { kind: 'session', sessionId }, throughSeq, maxMessages: 6,
          ...(beforeSeq === undefined ? {} : { beforeSeq }) } }, Math.max(1, deadline - Date.now()));
        if (!Array.isArray(page?.records) || typeof page.hasMore !== 'boolean') return unknown();
        const events = page.records.map((entry: any) => entry?.type === 'event' ? entry.event : null);
        if (!events.length || events.some((event: any, index: number) => !Number.isSafeInteger(event?.seq) || event.seq < 0 || event.seq > throughSeq ||
          (beforeSeq !== undefined && event.seq >= beforeSeq) || (index > 0 && event.seq !== events[index - 1].seq + 1))) return unknown();
        if (events.at(-1).seq !== (beforeSeq ?? throughSeq + 1) - 1) return unknown();
        for (const event of events) {
          const data = event.data;
          if (['turn/start', 'turn/end'].includes(event.type) && (!Number.isSafeInteger(data?.turn) || data.turn < 0)) return unknown();
          if (event.type === 'turn/end' && typeof data?.reason?.kind !== 'string') return unknown();
          records.push({ seq: event.seq, type: event.type,
            ...(Number.isSafeInteger(data?.turn) ? { turn: data.turn } : {}),
            ...(event.type === 'user/message' && data?.source?.kind === 'user' && typeof data.source.rpcId === 'string' ? { rpcId: data.source.rpcId } : {}),
            ...(event.type === 'turn/end' && typeof data?.reason?.kind === 'string' ? { reason: data.reason.kind } : {}),
            ...(['approval/asked', 'approval/decided'].includes(event.type) && typeof data?.id === 'string' ? { approvalId: data.id } : {}),
            ...(event.type === 'approval/asked' && ['bash','read_file','write_file','edit_file','apply_patch'].includes(data?.toolName) ? {approvalTool:data.toolName} : {}),
            ...(event.type === 'assistant/message' && !data?.interrupted && Array.isArray(data?.message?.content) ? {
              // Retain text only; never thoughts, tool arguments/results, provider bodies, or streams.
              text: data.message.content.filter((part: any) => part?.type === 'text' && typeof part.text === 'string').map((part: any) => part.text).join('').slice(0, 4000),
            } : {}),
          });
        }
        let currentTurn: number | undefined, boundTurn: number | undefined, text: string | undefined;
        let reason: string | undefined, contaminated = false;
        const pending = new Map<string,string|undefined>();
        const turnsWithForeignInput = new Set<number>();
        for (const event of records.sort((a, b) => a.seq - b.seq)) {
          if (event.type === 'turn/start') currentTurn = event.turn;
          if (event.type === 'user/message' && currentTurn !== undefined && event.rpcId) {
            if (event.rpcId === requestId) {
              if (boundTurn !== undefined) contaminated = true;
              boundTurn = currentTurn;
            } else turnsWithForeignInput.add(currentTurn);
          }
          if (boundTurn !== undefined && currentTurn === boundTurn) {
            if (event.type === 'approval/asked') {
              if (!event.approvalId || pending.has(event.approvalId)) contaminated = true;
              else pending.set(event.approvalId,event.approvalTool);
            }
            if (event.type === 'approval/decided') {
              if (!event.approvalId || !pending.delete(event.approvalId)) contaminated = true;
            }
            if (event.type === 'assistant/message' && event.turn === boundTurn && event.text !== undefined) text = event.text;
            if (event.type === 'turn/end' && event.turn === boundTurn) reason = event.reason;
          }
          if (event.type === 'turn/end' && event.turn === currentTurn) currentTurn = undefined;
        }
        if (boundTurn !== undefined) {
          if (contaminated || turnsWithForeignInput.has(boundTurn) || queued) return unknown();
          if (reason === 'completed') return pending.size ? unknown() : { status: 'completed', ...(text ? { result: text } : {}), detail: '原生任务已完成。' };
          if (reason && ['error', 'aborted', 'blocked', 'max-tokens', 'interrupted'].includes(reason)) return { status: 'failed', detail: '原生任务未能完成，请在 Harness 查看。' };
          if (reason || !row.running || currentTurn !== boundTurn) return unknown();
          return pending.size ? { status: 'approval', detail: '任务正在等待原生批准，请在 Harness 中处理。', approvalTools:[...new Set([...pending.values()].filter((name):name is string=>!!name))], sessionUrl:await this.workHostUrl() }
            : { status: 'working', detail: '原生任务正在执行。' };
        }
        if (!page.hasMore) return queued ? { status: 'working', detail: '请求已在原生 Harness 中排队。' } : unknown();
        beforeSeq = events[0].seq;
      }
      return unknown();
    } catch { return unknown(); }
  }

  async relayMetrics(sessionId: string): Promise<RelayMetrics | null> {
    return (await this.relayMetricsBatch([sessionId]))[0] ?? null;
  }

  async relayMetricsBatch(sessionIds: readonly string[]): Promise<RelayMetrics[]> {
    if (!sessionIds.length) return [];
    const value = await this.call('session/list', { _request: {} });
    const selected = new Set(sessionIds);
    return value.items.filter((row: any) => selected.has(row.sessionId) && typeof row.running === 'boolean').map((row: any): RelayMetrics => {
    const projections = row.projections?.values, usage = projections?.tokenUsage, model = projections?.modelSelection?.lastUsed;
    const keys = ['uncachedInputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens'] as const;
    return { sessionId: row.sessionId, running: row.running, preset: typeof projections?.agentPreset === 'string' ? projections.agentPreset : null,
      ...(Number.isSafeInteger(row.projections?.asOfSeq) && row.projections.asOfSeq >= 0 ? { throughSeq: row.projections.asOfSeq } : {}),
      model: model && typeof model.provider === 'string' && typeof model.model === 'string' ? { provider: model.provider, model: model.model, ...(typeof model.reasoningEffort === 'string' ? { reasoningEffort: model.reasoningEffort } : {}) } : null,
      usage: usage && keys.every(key => Number.isSafeInteger(usage[key]) && usage[key] >= 0) ? Object.fromEntries(keys.map(key => [key, usage[key]])) as RelayMetrics['usage'] : null };
    });
  }

  /** Cold, bounded history pages. Bind the exact rpcId inside its turn, never the latest turn. */
  async requestTerminal(sessionId: string, requestId: string, throughSeq: number): Promise<RelayTerminal> {
    if (!Number.isSafeInteger(throughSeq) || throughSeq < 0) return { status: 'unknown' };
    const deadline = Date.now() + this.timeoutMs;
    const records: { seq: number; type: string; turn?: number; rpcId?: string; reason?: string; errorCode?: string }[] = [];
    let beforeSeq: number | undefined;
    for (let pageIndex = 0; pageIndex < 16; pageIndex++) {
      if (Date.now() >= deadline) return { status: 'unknown' };
      const page = await this.call('session/page', { request: { address: { kind: 'session', sessionId }, throughSeq, maxMessages: 6, ...(beforeSeq === undefined ? {} : { beforeSeq }) } }, Math.max(1, deadline - Date.now()));
      if (!Array.isArray(page?.records) || typeof page.hasMore !== 'boolean') return { status: 'unknown' };
      const events = page.records.filter((row: any) => row?.type === 'event').map((row: any) => row.event);
      if (!events.length || events.some((event: any, index: number) => !Number.isSafeInteger(event?.seq) || event.seq < 0 || event.seq > throughSeq ||
        (beforeSeq !== undefined && event.seq >= beforeSeq) || (index > 0 && event.seq !== events[index - 1].seq + 1))) return { status: 'unknown' };
      if (events.at(-1).seq !== (beforeSeq ?? throughSeq + 1) - 1) return { status: 'unknown' };
      for (const event of events) {
        const data = event.data;
        // Discard all content and provider messages; retain only bounded protocol identifiers.
        records.push({ seq: event.seq, type: event.type,
          ...(Number.isSafeInteger(data?.turn) ? { turn: data.turn } : {}),
          ...(event.type === 'user/message' && data?.source?.kind === 'user' && typeof data.source.rpcId === 'string' ? { rpcId: data.source.rpcId } : {}),
          ...(event.type === 'turn/end' && ['completed', 'error', 'aborted', 'blocked', 'max-tokens', 'interrupted'].includes(data?.reason?.kind) ? { reason: data.reason.kind } : {}),
          ...(event.type === 'turn/end' && typeof data?.reason?.error?.code === 'string' && /^[A-Z0-9_-]{1,80}$/.test(data.reason.error.code) ? { errorCode: data.reason.error.code } : {}),
        });
      }
      let currentTurn: number | undefined, boundTurn: number | undefined;
      for (const event of records.sort((a, b) => a.seq - b.seq)) {
        if (event.type === 'turn/start') currentTurn = event.turn;
        if (event.type === 'user/message' && event.rpcId === requestId) boundTurn = currentTurn;
        if (event.type === 'turn/end') {
          if (boundTurn !== undefined && event.turn === boundTurn && event.reason) return { status: 'ended', turn: boundTurn, reason: event.reason, ...(event.errorCode ? { errorCode: event.errorCode } : {}) };
          if (event.turn === currentTurn) currentTurn = undefined;
        }
      }
      if (!page.hasMore) return { status: 'unknown' };
      beforeSeq = events[0].seq;
    }
    return { status: 'unknown' };
  }

  async submitConfirmedOperation(sessionId: string, requestId: string, operationId: string): Promise<void> {
    if (!/^[0-9a-f-]{36}$/.test(operationId)) throw new HarnessConnectionError('incompatible');
    const value = await this.call('session/prompt', { request: { sessionId, requestId, mode: 'queue', content: [{ type: 'text',
      text: `Forward confirmed operation ${operationId} using send_confirmed once. The tool owns its immutable target and text. Return only the tool receipt. Do not plan, write code, or invent a result.` }] } });
    if (value?.accepted !== true) throw new HarnessConnectionError('incompatible');
  }

  private async launchEndpoint(): Promise<URL> {
    try {
      const url = new URL(await this.launchUrl());
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.pathname !== '/' || url.hash ||
          url.searchParams.getAll('token').length !== 1 || !url.searchParams.get('token') || [...url.searchParams.keys()].some(k => k !== 'token')) {
        throw new HarnessConnectionError('authentication_required');
      }
      return url;
    } catch (error) {
      if (error instanceof HarnessConnectionError) throw error;
      throw new HarnessConnectionError('unavailable');
    }
  }

  private async call(method: 'session/list' | 'session/create' | 'session/rename' | 'session/selectModel' | 'session/prompt' | 'session/page', args: object, timeoutMs = this.timeoutMs): Promise<any> {
    const result = (state: Exclude<HarnessConnectionState, 'ready'>): never => { throw new HarnessConnectionError(state); };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      // A launcher URL is a credential. Never follow redirects or send it to a configurable remote host.
      const url = await this.launchEndpoint();
      const exchange = await fetch(url, { redirect: 'manual', signal: controller.signal });
      const cookie = exchange.headers.get('set-cookie')?.split(';')[0];
      await exchange.body?.cancel();
      if (exchange.status !== 303 || exchange.headers.get('location') !== '/' || !cookie || !/^[A-Za-z0-9_-]+=[A-Za-z0-9_.-]+$/.test(cookie)) return result('authentication_required');
      const rpcId = randomUUID();
      const response = await fetch(url.origin + '/api/' + method, {
        method: 'POST', redirect: 'manual', signal: controller.signal,
        headers: { Cookie: cookie, Origin: url.origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } }),
      });
      if (response.status === 401 || response.status === 403) { await response.body?.cancel(); return result('authentication_required'); }
      if (!response.ok) { await response.body?.cancel(); return result('unavailable'); }
      // Read a bounded response; session contents must never escape into a status DTO or error log.
      const reader = response.body?.getReader();
      if (!reader) return result('incompatible');
      const chunks: Uint8Array[] = []; let bytes = 0;
      while (true) {
        const chunk = await reader.read(); if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 4 * 1024 * 1024) { await reader.cancel(); return result('incompatible'); }
        chunks.push(chunk.value);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (body?.type !== 'server-response' || body.rpcId !== rpcId || body.result?.ok !== true || (method === 'session/list' && !Array.isArray(body.result.value?.items))) return result('incompatible');
      return body.result.value;
    } catch (error) {
      // Fetch errors can contain the credential URL and remote response text.
      if (error instanceof HarnessConnectionError) throw error;
      return result('unavailable');
    } finally { clearTimeout(timer); }
  }
}
