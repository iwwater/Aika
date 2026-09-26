export function validVoiceKey(code: unknown): code is string {
  return typeof code === 'string' && /^(Arrow(Up|Down|Left|Right)|Key[A-Z]|Digit[0-9]|F([1-9]|1[0-9]|20)|Space|Enter|Backspace|Delete|Home|End|PageUp|PageDown|Comma|Period|Slash|Semicolon|Quote|BracketLeft|BracketRight|Backslash|Minus|Equal|Backquote)$/.test(code);
}
/** Shared hold/release logic; event delivery scope is selected by the native shell. */
export class PressToTalk {
  binding: string | null = null;
  private held = false;
  private recording = false;
  constructor(private readonly actions: { start(): boolean; finish(): void; cancel(early: boolean): void }) {}
  configure(code: unknown): boolean {
    if (code !== null && !validVoiceKey(code)) return false;
    this.cancel(); this.binding = code; return true;
  }
  down(code: string, repeat = false): boolean {
    if (code !== this.binding) return false;
    if (this.held || repeat) return true;
    if (!this.actions.start()) return false;
    this.held = true; this.recording = false; return true;
  }
  ready(): void { if (this.held) this.recording = true; }
  up(code: string): boolean {
    if (!this.held || code !== this.binding) return false;
    const ready = this.recording; this.held = false; this.recording = false;
    if (ready) this.actions.finish(); else this.actions.cancel(true);
    return true;
  }
  cancel(): void {
    if (!this.held) return;
    this.held = false; this.recording = false; this.actions.cancel(false);
  }
  clear(): void { this.held = false; this.recording = false; }
}
