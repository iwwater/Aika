/** Owns the renderer-side 40-second thinking timeout for one active text turn. */
export class ThinkingTimeout {
  #timer = null;
  #generation = 0;

  constructor({ timeoutMs = 40000, setTimer = (fn, ms) => globalThis.setTimeout(fn, ms), clearTimer = id => globalThis.clearTimeout(id) } = {}) {
    this.timeoutMs = timeoutMs;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
  }

  start(isCurrent, onTimeout) {
    this.stop();
    const generation = this.#generation;
    let fired = false;
    this.#timer = this.setTimer(() => {
      if (fired || generation !== this.#generation) return;
      fired = true;
      this.#timer = null;
      if (isCurrent()) onTimeout();
    }, this.timeoutMs);
  }

  stop() {
    this.#generation++;
    if (this.#timer !== null) this.clearTimer(this.#timer);
    this.#timer = null;
  }
}
