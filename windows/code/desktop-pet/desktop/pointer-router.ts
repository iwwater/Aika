// FIX61-04: pointer button routing for the desktop character, plus the function-panel entry catalog.
//
// Why this is a separate module: the old handler was one line inside main.mjs
// (`onpointerup = () => { if (pointer && !pointer.moved) panel(!panelOpen); pointer = null; }`), which made
// every button open the chat drawer and made "stroke vs drag vs panel" untestable. Keeping the routing
// decision pure lets the real renderer call it while the tests drive the same production object.

/** Movement below this many device-independent pixels is a tap, not a drag. */
export const TAP_SLOP_PX = 3;

export interface PointerSample {
  readonly button?: number;
  readonly pointerId?: number;
  readonly screenX?: number;
  readonly screenY?: number;
  readonly target?: { readonly id?: string } | null;
}
export interface PointerHandlers {
  /** Toggle the chat drawer. The router owns only the routing decision, never the drawer state. */
  readonly panel: (open: boolean) => void;
  /** Local stroke feedback. Must never reach the backend, Memory or the model. */
  readonly stroke: (at: { readonly x: number; readonly y: number; readonly side: 'left' | 'right' }) => void;
  /** Window drag through the shell channel. */
  readonly drag: (dx: number, dy: number) => void;
  /** Read the current drawer state so the right button toggles rather than always opening. */
  readonly panelOpen?: () => boolean;
}

const onCharacter = (target: PointerSample['target']): boolean => target?.id === 'character';

interface ActivePointer { readonly id: number | undefined; x: number; y: number; moved: boolean; readonly button: number }

/**
 * Routes pointer events on the character. The right button opens the function panel exactly once per
 * press; the left button strokes on a short tap and drags otherwise; a cancelled pointer does nothing.
 */
export class CharacterPointerRouter {
  #pointer: ActivePointer | null = null;
  /** Set while a right press is being consumed, so its pointerup cannot toggle the panel a second time. */
  #rightConsumed = false;
  // A plain field instead of a constructor parameter property: Node's strip-only TS loader and the
  // browser bundle both execute this module, and parameter properties are not strippable syntax.
  readonly handlers: PointerHandlers;
  constructor(handlers: PointerHandlers) { this.handlers = handlers; }

  pointerDown(event: PointerSample): void {
    this.#pointer = { id: event.pointerId, x: event.screenX ?? 0, y: event.screenY ?? 0, moved: false, button: event.button ?? 0 };
    this.#rightConsumed = false;
  }

  pointerMove(event: PointerSample): void {
    const pointer = this.#pointer;
    if (!pointer || event.pointerId !== pointer.id) return;
    const dx = (event.screenX ?? 0) - pointer.x, dy = (event.screenY ?? 0) - pointer.y;
    if (Math.abs(dx) + Math.abs(dy) > TAP_SLOP_PX || pointer.moved) {
      // A right-button drag is not a window drag: the right button owns the panel, not the window.
      if (pointer.button !== 2) { pointer.moved = true; this.handlers.drag(dx, dy); }
      pointer.x = event.screenX ?? 0; pointer.y = event.screenY ?? 0;
    }
  }

  pointerCancel(event: PointerSample = {}): void {
    if (!this.#pointer || (event.pointerId !== undefined && event.pointerId !== this.#pointer.id)) return;
    this.#pointer = null;
  }

  pointerUp(event: PointerSample): void {
    const pointer = this.#pointer;
    this.#pointer = null;
    if (!pointer) return;
    // The right button was already handled by contextmenu; consuming its release prevents a double toggle.
    if (pointer.button === 2 || this.#rightConsumed) { this.#rightConsumed = false; return; }
    if (pointer.moved) return;
    // Only the primary button strokes. Middle/back/forward buttons stay inert.
    if (pointer.button !== 0) return;
    this.handlers.stroke({ x: event.screenX ?? pointer.x, y: event.screenY ?? pointer.y, side: 'left' });
  }

  /**
   * The right button's primary event. Chromium delivers `contextmenu` for the right press, so the panel
   * is toggled here and the pointerup for that same press is swallowed above.
   */
  contextMenu(event: PointerSample): void {
    if (!onCharacter(event.target)) return;
    this.#rightConsumed = true;
    this.#pointer = null;
    this.handlers.panel(!(this.handlers.panelOpen?.() ?? false));
  }
}

export interface StrokeCapabilities {
  readonly head?: boolean;
  readonly body?: boolean;
  readonly blink?: boolean;
  readonly reducedMotion?: boolean;
}
export interface StrokePlan {
  readonly applicable: boolean;
  readonly reason: string;
  readonly values: { readonly yaw: number; readonly pitch: number; readonly roll: number; readonly body: number };
}

/**
 * A model without the interaction parameters must not throw: it reports "not applicable" with a reason
 * so the UI can say why nothing moved. Reduced motion suppresses the movement entirely.
 */
export function strokePlan(capabilities: StrokeCapabilities): StrokePlan {
  const zero = { yaw: 0, pitch: 0, roll: 0, body: 0 };
  if (capabilities.reducedMotion) return { applicable: false, reason: '已开启减少动态效果，抚摸不产生动作。', values: zero };
  if (!capabilities.head && !capabilities.body) return { applicable: false, reason: '当前模型没有登记头部或身体参数，抚摸不产生动作。', values: zero };
  return { applicable: true, reason: '', values: {
    yaw: capabilities.head ? 1 : 0, pitch: capabilities.head ? 12 : 0, roll: capabilities.head ? 2 : 0, body: capabilities.body ? 1.8 : 0,
  } };
}

export type PanelEntryKind = 'view' | 'shell' | 'console';
export interface PanelEntry {
  readonly id: string;
  readonly label: string;
  readonly kind: PanelEntryKind;
  readonly target?: string;
  readonly action?: string;
  readonly note?: string;
}

/**
 * The function panel's entry catalog. Every entry resolves to a real target: a desktop view, a shell
 * action, or a local console section. There is deliberately no entry that silently does nothing.
 */
export const PANEL_ENTRIES: readonly PanelEntry[] = Object.freeze([
  { id: 'chat', label: '聊天', kind: 'shell', action: 'open_chat' },
  { id: 'skin', label: '外观 / 换肤', kind: 'view', target: 'skin', note: '更换外观不会改变角色人格、记忆或知识库。' },
  { id: 'knowledge', label: '知识库', kind: 'console', target: '/knowledge-view.mjs' },
  { id: 'settings', label: '配置', kind: 'shell', action: 'open_management' },
  { id: 'memory', label: '记忆', kind: 'console', target: '/#section=records' },
  { id: 'timeline', label: 'Timeline', kind: 'console', target: '/#section=timeline' },
  { id: 'diagnostics', label: '日志 / 诊断', kind: 'console', target: '/#section=diagnostics' },
  { id: 'microphone', label: '麦克风', kind: 'view', target: 'microphone', note: '可选择输入设备并本地试录回放；不会上传录音。' },
  { id: 'status', label: '模块状态', kind: 'console', target: '/#section=runtime' },
]);
