export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

export function isPointInRect(x: number, y: number, rect: Rect): boolean {
  return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
}

export function isPointInAnyRect(x: number, y: number, rects: readonly Rect[]): boolean {
  for (let i = 0; i < rects.length; i++) {
    if (isPointInRect(x, y, rects[i]!)) return true;
  }
  return false;
}

/**
 * UI-MAN-01: a pointer position arrives from the OS in device-independent pixels relative to the window
 * content box. A window that ignores mouse events still receives forwarded movement, so this hit test is
 * what decides whether the window should temporarily stop ignoring the mouse.
 *
 * `regions` is renderer-reported geometry, so it is NEVER trusted as-is: every rectangle is bounded,
 * rounded and clamped before it can influence an OS-level hit decision.
 */
export function sanitizeRects(rects: unknown, maxBounds: Rect = { x: 0, y: 0, width: 4000, height: 4000 }): Rect[] {
  if (!Array.isArray(rects)) return [];
  const valid: Rect[] = [];
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    if (!r || typeof r !== 'object') continue;
    const x = Number((r as Record<string, unknown>).x);
    const y = Number((r as Record<string, unknown>).y);
    const width = Number((r as Record<string, unknown>).width);
    const height = Number((r as Record<string, unknown>).height);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height)) continue;
    if (width <= 0 || height <= 0) continue;
    const left = Math.max(0, Math.round(x));
    const top = Math.max(0, Math.round(y));
    const right = Math.min(maxBounds.width, Math.round(x + width));
    const bottom = Math.min(maxBounds.height, Math.round(y + height));
    // A rectangle that lies entirely outside the window can never receive a click; dropping it also
    // stops an off-window region from permanently capturing the whole desktop.
    if (right - left <= 0 || bottom - top <= 0) continue;
    valid.push({ x: left, y: top, width: right - left, height: bottom - top });
  }
  return valid;
}

/**
 * The single arbitration rule for click-through.
 *
 * - Click-through off  -> the window always receives the mouse.
 * - Click-through on   -> the window receives the mouse only while the pointer sits on a reported UI
 *                         region, and otherwise stays fully transparent to the desktop behind it.
 */
export function shouldIgnoreMouseEvents(clickThrough: boolean, pointer: Point | null, regions: readonly Rect[]): boolean {
  if (!clickThrough) return false;
  if (!pointer) return true;
  return !isPointInAnyRect(pointer.x, pointer.y, regions);
}
