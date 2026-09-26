import type { DesktopCommand } from '../contracts/index.js';
import type { BackendToDesktop } from '../contracts/desktop-bridge.js';
import type {
  PlaygroundManagementPort,
  PlaygroundSessionView,
  PlaygroundTurnSubmitInput,
  PlaygroundTurnView,
} from '../contracts/management.js';
import { ManagementError } from '../contracts/management.js';
import type { RuntimeTraceStore, RuntimeTrace } from '../core/trace-store.js';

export interface ProductionPlaygroundPortOptions {
  sendCommand: (command: DesktopCommand) => Promise<void> | void;
  cancelCurrent: () => Promise<void> | void;
  pairing: { userId: string; characterId: string; characterInstanceId: string };
  sessionId?: string;
  getConfigRevision: () => number;
  hasStt?: () => boolean;
  hasTts?: () => boolean;
  traceStore?: RuntimeTraceStore;
  isBusy?: () => boolean;
}

export class ProductionPlaygroundPort implements PlaygroundManagementPort {
  private readonly turns = new Map<string, PlaygroundTurnView>();
  private readonly turnsByOpId = new Map<string, PlaygroundTurnView>();
  private readonly pendingWaiters = new Map<string, {
    resolve: (view: PlaygroundTurnView) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  private activeTurnId: string | null = null;
  private currentSessionId: string;
  private replyTimers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly options: ProductionPlaygroundPortOptions) {
    this.currentSessionId = options.sessionId || `session-${Date.now()}`;
  }

  observeDesktopMessage(message: BackendToDesktop): void {
    if (message.channel !== 'event') return;
    const event = message.event;

    if (event.type === 'turn') {
      const turnId = event.input.scope.turnId;
      const opId = event.input.clientRequestId;
      this.activeTurnId = turnId;

      let view = opId ? this.turnsByOpId.get(opId) : undefined;
      if (!view) {
        view = {
          turnId,
          operationId: opId || turnId,
          status: 'running',
          text: event.input.text || '',
          reply: null,
          traceRef: null,
          startedAt: new Date().toISOString(),
        };
        if (opId) this.turnsByOpId.set(opId, view);
      } else {
        view.turnId = turnId;
        view.status = 'running';
      }
      this.turns.set(turnId, view);
    } else if (event.type === 'reply') {
      if (this.activeTurnId) {
        const view = this.turns.get(this.activeTurnId);
        if (view) {
          view.reply = event.reply.text || '';
          // If in text mode or after reply arrives, settle after short grace window if playback doesn't trigger
          const currentId = this.activeTurnId;
          const timer = setTimeout(() => {
            if (view.status === 'running') {
              view.status = 'completed';
              view.completedAt = new Date().toISOString();
              if (!view.traceRef && this.options.traceStore) {
                view.traceRef = `trace-${view.turnId}`;
              }
              this.settleTurn(currentId, view);
              if (this.activeTurnId === currentId) this.activeTurnId = null;
            }
          }, 350);
          this.replyTimers.set(currentId, timer);
        }
      }
    } else if (event.type === 'playback' && (event.playback.type === 'ended' || event.playback.type === 'stopped')) {
      if (this.activeTurnId) {
        const view = this.turns.get(this.activeTurnId);
        const timer = this.replyTimers.get(this.activeTurnId);
        if (timer) {
          clearTimeout(timer);
          this.replyTimers.delete(this.activeTurnId);
        }
        if (view && view.status === 'running') {
          view.status = 'completed';
          view.completedAt = new Date().toISOString();
          if (!view.traceRef && this.options.traceStore) {
            view.traceRef = `trace-${view.turnId}`;
          }
          this.settleTurn(view.turnId, view);
        }
        this.activeTurnId = null;
      }
    } else if (event.type === 'error') {
      const errScope = event.scope;
      const targetTurnId = errScope?.turnId || this.activeTurnId;
      if (targetTurnId) {
        const view = this.turns.get(targetTurnId);
        const timer = this.replyTimers.get(targetTurnId);
        if (timer) {
          clearTimeout(timer);
          this.replyTimers.delete(targetTurnId);
        }
        if (view && view.status === 'running') {
          view.status = 'failed';
          view.error = event.message;
          view.completedAt = new Date().toISOString();
          this.settleTurn(targetTurnId, view);
        }
      }
      this.activeTurnId = null;
    }
  }

  private settleTurn(turnId: string, view: PlaygroundTurnView): void {
    const waiter = this.pendingWaiters.get(turnId);
    if (waiter) {
      clearTimeout(waiter.timer);
      this.pendingWaiters.delete(turnId);
      waiter.resolve(view);
    }
  }

  session(pairing?: { userId: string; characterId: string; characterInstanceId: string }): PlaygroundSessionView {
    const p = pairing || this.options.pairing;
    return {
      pairing: p,
      sessionId: this.currentSessionId,
      capabilities: {
        canSubmitText: true,
        canCancel: true,
        hasStt: this.options.hasStt?.() ?? false,
        hasTts: this.options.hasTts?.() ?? false,
      },
      effectiveConfigRevision: this.options.getConfigRevision(),
      status: (this.activeTurnId || this.options.isBusy?.()) ? 'busy' : 'idle',
    };
  }

  async submitTurn(input: PlaygroundTurnSubmitInput): Promise<PlaygroundTurnView> {
    const text = String(input.text || '').trim();
    if (!text) {
      throw new ManagementError('invalid_request', '提交文本不能为空。');
    }
    const opId = String(input.operationId || '').trim();
    if (!opId) {
      throw new ManagementError('invalid_request', '缺少 operationId。');
    }

    // Idempotency: return existing turn if already processed
    const existing = this.turnsByOpId.get(opId);
    if (existing && existing.status !== 'running') {
      return existing;
    }

    // Register placeholder
    const placeholder: PlaygroundTurnView = {
      turnId: existing?.turnId || '',
      operationId: opId,
      status: 'running',
      text,
      reply: null,
      traceRef: null,
      startedAt: new Date().toISOString(),
    };
    this.turnsByOpId.set(opId, placeholder);

    const turnPromise = new Promise<PlaygroundTurnView>((resolve, reject) => {
      const timer = setTimeout(() => {
        placeholder.status = 'failed';
        placeholder.error = '轮次执行超时（超过 60 秒未响应）';
        placeholder.completedAt = new Date().toISOString();
        if (placeholder.turnId) this.pendingWaiters.delete(placeholder.turnId);
        resolve(placeholder);
      }, 60000);

      const waiterObj = { resolve, reject, timer };
      const checkTurnInterval = setInterval(() => {
        if (placeholder.turnId && !this.pendingWaiters.has(placeholder.turnId)) {
          this.pendingWaiters.set(placeholder.turnId, waiterObj);
          clearInterval(checkTurnInterval);
        }
        if (placeholder.status !== 'running') {
          clearInterval(checkTurnInterval);
          clearTimeout(timer);
          resolve(placeholder);
        }
      }, 20);
    });

    try {
      await this.options.sendCommand({
        type: 'submit_text',
        text,
        clientRequestId: opId,
      });
    } catch (err) {
      placeholder.status = 'failed';
      placeholder.error = err instanceof Error ? err.message : String(err);
      placeholder.completedAt = new Date().toISOString();
      return placeholder;
    }

    return turnPromise;
  }

  getTurn(turnId: string): PlaygroundTurnView | null {
    const memoryTurn = this.turns.get(turnId);
    if (memoryTurn) return memoryTurn;

    if (this.options.traceStore) {
      const trace = this.options.traceStore.list({ limit: 100 }).traces.find((t: RuntimeTrace) => t.turnId === turnId);
      if (trace) {
        const turnView: PlaygroundTurnView = {
          turnId: trace.turnId,
          operationId: trace.turnId,
          status: trace.status === 'ok' ? 'completed' : 'failed',
          text: trace.userText,
          reply: trace.replyText,
          traceRef: trace.traceId,
          startedAt: trace.createdAt,
          completedAt: trace.createdAt,
        };
        this.turns.set(turnId, turnView);
        return turnView;
      }
    }

    return null;
  }

  async cancelTurn(turnId: string): Promise<{ cancelled: boolean; turnId: string }> {
    const turn = this.turns.get(turnId);
    if (turn && turn.status === 'running') {
      turn.status = 'cancelled';
      turn.completedAt = new Date().toISOString();
      await this.options.cancelCurrent();
      this.settleTurn(turnId, turn);
      this.activeTurnId = null;
      return { cancelled: true, turnId };
    }
    if (this.activeTurnId === turnId) {
      await this.options.cancelCurrent();
      this.activeTurnId = null;
      return { cancelled: true, turnId };
    }
    return { cancelled: false, turnId };
  }
}
