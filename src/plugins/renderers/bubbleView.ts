import { type BubbleStyle, type PetSettings } from '../../pet/settings';

/**
 * 气泡的 DOM 与 TTL 语义。
 *
 * 抽出来是因为 sprite 与 Live2D 两个 renderer 都要用它：气泡属于窗口表现，而不属于
 * 某一种渲染方式。两份拷贝迟早会在样式或 TTL 上漂移，而回归测试只覆盖得到其中一份。
 */

const BUBBLE_STYLES = ['soft', 'comic', 'glass', 'terminal'] as const satisfies readonly BubbleStyle[];
const DEFAULT_TTL_MS = 4_000;
/** TTL 下限：再短就没人读得完，等于没显示。 */
const MIN_TTL_MS = 500;

function bubbleStyleClass(style: BubbleStyle): string {
  return BUBBLE_STYLES.includes(style) ? `pet-bubble-${style}` : 'pet-bubble-soft';
}

export class BubbleView {
  private readonly element: HTMLDivElement;
  private timerId: number | null = null;
  private disposed = false;

  constructor(ownerId: string) {
    const element = document.createElement('div');
    element.className = 'pet-bubble pet-bubble-soft';
    element.hidden = true;
    element.dataset.renderer = ownerId;
    this.element = element;
  }

  get node(): HTMLElement {
    return this.element;
  }

  applySettings(settings: PetSettings): void {
    const element = this.element;
    element.className = `pet-bubble ${bubbleStyleClass(settings.bubbleStyle)}`;
    element.style.fontFamily = settings.bubbleFontFamily;
    element.style.fontSize = `${settings.bubbleFontSizePx}px`;
    element.style.maxWidth = `min(${settings.bubbleMaxWidthPx}px, calc(100vw - 24px))`;
  }

  show(text: string | null, ttlMs: number): void {
    if (this.disposed) return;
    if (this.timerId !== null) {
      window.clearTimeout(this.timerId);
      this.timerId = null;
    }
    const trimmed = (text ?? '').trim();
    if (trimmed.length === 0) {
      this.clear();
      return;
    }
    this.element.textContent = trimmed;
    this.element.hidden = false;
    this.timerId = window.setTimeout(() => {
      this.timerId = null;
      this.clear();
    }, Math.max(MIN_TTL_MS, ttlMs || DEFAULT_TTL_MS));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timerId !== null) {
      window.clearTimeout(this.timerId);
      this.timerId = null;
    }
    this.element.remove();
  }

  private clear(): void {
    this.element.hidden = true;
    this.element.textContent = '';
  }
}
