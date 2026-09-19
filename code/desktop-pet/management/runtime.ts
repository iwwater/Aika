import { ProviderHttpError } from '../providers/transport.js';
import { COMPANION_ID, COMPANION_LABEL } from '../contracts/character.js';
import { randomUUID } from 'node:crypto';
import type { CharacterId } from '../contracts/index.js';
import type { BackendToDesktop } from '../contracts/desktop-bridge.js';
import type { MemoryPendingSnapshot } from '../contracts/memory-lifecycle.js';
import type { ManagementSnapshot, RuntimeEvent, RuntimeModule, ProviderSlot } from '../contracts/management.js';

const descriptions: Record<ProviderSlot, string> = { asr:'语音转写', dialogue: '前台对话', memory_turn: '严格记忆维护', summary: '对话摘要', perception: '视频情绪', tts: '语音合成', admission: '记忆请求识别' };
function localRefusal(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if(message==='Background reservation would block foreground')return '后台此次未发送：保留当前前台请求所需的费用预留，聊天可继续。原账和未知费用没有清除；未完成的记忆请求可在网页核对。';
  if (['Phase budget cannot cover the next worst-case call', 'Shared evaluation budget exhausted'].includes(message))
    return '调用未发送：当前可用额度不足以预留本次费用。后台请求结束后可自行重新发起；仍受累计总预算与剩余额度限制，不自动重试。';
  if (['Phase generation limit reached', 'Trial operation call limit reached'].includes(message))
    return '调用未发送：当前阶段的调用次数已用完。';
  if (['Budget is blocked pending reconciliation', 'Trial is stopped pending unknown-cost reconciliation', 'Trial is stopped'].includes(message))
    return '调用未发送：阶段已停止或费用尚待核对。';
  return '调用未发送：本地配置、凭据或调用条件未通过检查。';
}
/** In-process observations only. No provider probe or private message body is retained. */
export class ManagementRuntime {
  readonly instanceId = randomUUID();
  readonly startedAt = new Date().toISOString();
  private characterId: CharacterId = COMPANION_ID;
  private sessionId = '';
  private eventId = 0;
  private events: RuntimeEvent[] = [];
  private states = new Map<string, RuntimeModule>();
  private pendingReader: () => readonly MemoryPendingSnapshot[] = () => [];
  observeMemoryQueue(reader: () => readonly MemoryPendingSnapshot[]): void { this.pendingReader = reader; }
  constructor(readonly sourceRevision: string, private readonly failureSink?: (diagnostic: {event: RuntimeEvent; stage: 'provider_request'; httpStatus: number | null; requestId: string | null}) => Promise<void>) {
    for (const [id, label] of Object.entries(descriptions)) this.states.set(id, { id, label, providerSlot: id as ProviderSlot, status: 'unknown',
      detail: '适配器已加载；本次运行尚无真实调用结果。', activeJobs: 0, calls: 0, lastElapsedMs: null, lastError: null, lastObservedAt: null });
    for (const [id, label, status, detail] of [
      ['backend', '本机后端', 'ready', '当前管理接口由这个实际后端进程提供。'],
      ['retrieval', '记忆检索与上下文', 'ready', '使用同一业务SQLite库、角色隔离的关键词检索和上下文组装；未接独立向量服务。'],
      ['capture', '麦克风与摄像头', 'unknown', '由原生桌面按用户操作采集；管理页不启用设备。'],
      ['playback', '音频播放', 'unknown', '由原生桌面播放；管理页不自动播放或测试声音。'],
      ['presentation', '角色表情与口型', 'unknown', '已接原生桌面表达通道；本接口不接收逐帧绘制确认。'],
      ['invitations', '主动关心', 'unavailable', '持久额度规则已有，实际事件生成与点击接线尚未完成。'],
    ] as const) this.states.set(id, { id, label, status, detail, activeJobs: 0, calls: 0, lastElapsedMs: null, lastError: null, lastObservedAt: this.startedAt });
  }
  identity(): ManagementSnapshot['runtime'] { return { instanceId: this.instanceId, pid: process.pid, sourceRevision: this.sourceRevision,
    startedAt: this.startedAt, observedAt: new Date().toISOString(), characterId: this.characterId, sessionId: this.sessionId, online: true }; }
  modules(): RuntimeModule[] {
    const modules = [...this.states.values()].map(value => ({ ...value }));
    const pending = this.pendingReader(), activeJobs = pending.reduce((n, p) => n + p.queued + p.running, 0);
    modules.push({ id: 'memory_queue', label: '后台记忆任务', status: activeJobs ? 'busy' : pending.length ? 'ready' : 'unknown', activeJobs,
      calls: 0, lastElapsedMs: null, lastError: null, lastObservedAt: new Date().toISOString(),
      detail: pending.length ? pending.map(p => COMPANION_LABEL + '：排队' + p.queued + '，执行' + p.running).join('；') : '尚无队列观察；不能据此判断记忆质量。' });
    return modules;
  }
  recentEvents(): RuntimeEvent[] { return this.events.map(value => ({ ...value })); }
  record(moduleId: string, kind: RuntimeEvent['kind'], characterId: CharacterId | null, message: string, elapsedMs: number | null = null): void {
    this.events.unshift({ id: ++this.eventId, at: new Date().toISOString(), moduleId, kind, characterId, elapsedMs, message }); this.events.length = Math.min(this.events.length, 100);
  }
  async observeCall<T>(slot: ProviderSlot, characterId: CharacterId, work: (sent: () => void) => Promise<T>, signal: AbortSignal): Promise<T> {
    const state = this.states.get(slot)!; state.activeJobs++; state.status = 'busy';
    state.lastObservedAt = new Date().toISOString(); state.detail = '正在核对本地调用条件，尚未发送请求。';
    let sent = false; const start = performance.now();
    const markSent = () => {
      if (sent) return; sent = true; state.calls++; state.detail = '本进程正在执行实际供应商请求。';
      this.record(slot, 'started', characterId, '实际请求开始');
    };
    try {
      const result = await work(markSent); state.lastElapsedMs = Math.round(performance.now() - start); state.lastError = null;
      state.status = 'ready'; state.detail = '本进程最近一次供应商请求返回成功；不等于语义或物理设备验收。';
      this.record(slot, 'completed', characterId, '实际请求完成', state.lastElapsedMs); return result;
    } catch (error) {
      state.lastElapsedMs = Math.round(performance.now() - start); state.status = signal.aborted ? 'unknown' : sent ? 'error' : 'unavailable';
      state.lastError = signal.aborted ? null : sent ? error instanceof ProviderHttpError
        ? `${descriptions[slot]}请求返回 HTTP ${error.status}${error.requestId ? `（请求编号 ${error.requestId}）` : ''}。${slot === 'tts' ? '此请求未取得可播放音频。' : '请求未完成。'}`
        : '请求失败；请检查模型、凭据状态、配置与费用边界。' : localRefusal(error);
      state.detail = signal.aborted ? '请求已取消；不能据此判断供应商是否可用。' : state.lastError!;
      this.record(slot, signal.aborted ? 'cancelled' : sent ? 'failed' : 'state', characterId, state.detail, state.lastElapsedMs);
      if (slot === 'tts' && !signal.aborted && this.failureSink) {
        const event = { ...this.events[0]! };
        await this.failureSink({event, stage:'provider_request', httpStatus:error instanceof ProviderHttpError ? error.status : null,
          requestId:error instanceof ProviderHttpError ? error.requestId : null}).catch(() => {});
      }
      throw error;
    } finally { state.activeJobs--; state.lastObservedAt = new Date().toISOString(); if (state.activeJobs) state.status = 'busy'; }
  }
  observeDesktop(message: BackendToDesktop): void {
    if (message.channel === 'backend_ready') {
      this.characterId = message.characterId; this.sessionId = message.sessionId;
      this.record('backend', 'state', this.characterId, '后端会话已就绪，等待桌面命令。');
    } else if (message.channel === 'event' && message.event.type === 'error') {
      this.record('backend', 'failed', message.event.scope?.characterId ?? null, '本轮操作未完成；原始对话和供应商错误正文未写入监控。');
    } else if (message.channel === 'capture_start' || message.channel === 'capture_finish' || message.channel === 'capture_stop') {
      this.record('capture', 'state', message.scope.characterId, message.channel === 'capture_start' ? '已向桌面请求采集，设备是否成功以客户端确认为准。' : '已向桌面请求结束或停止采集。');
    } else if (message.channel === 'play' || message.channel === 'stop') {
      this.record('playback', 'state', message.channel === 'play' ? message.tts.scope.characterId : message.scope.characterId, message.channel === 'play' ? '语音已交给桌面播放；没有物理出声确认。' : '已请求桌面停止播放。');
    }
  }
}
