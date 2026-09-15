/**
 * Loads the Cubism Core runtime script exactly once (MVP-11).
 *
 * The engine reads `window.Live2DCubismCore` at module-evaluation time, so the script
 * must be on the page **before** the engine is imported. Loading it here keeps that
 * ordering in one place instead of relying on whoever writes the HTML.
 *
 * A failed load is not cached: a transient failure must not permanently disable Live2D
 * for the rest of the session.
 */

declare global {
  interface Window {
    Live2DCubismCore?: unknown;
  }
}

let pending: Promise<void> | null = null;

export function isLive2dCoreLoaded(): boolean {
  return typeof window !== "undefined" && window.Live2DCubismCore !== undefined;
}

export function ensureLive2dCore(scriptUrl: string): Promise<void> {
  if (isLive2dCoreLoaded()) return Promise.resolve();
  if (pending) return pending;

  pending = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = scriptUrl;
    script.async = true;
    script.dataset.live2dCore = "true";
    script.onload = () => {
      if (isLive2dCoreLoaded()) resolve();
      else reject(new Error(`${scriptUrl} loaded but Live2DCubismCore is missing`));
    };
    script.onerror = () => reject(new Error(`failed to load ${scriptUrl}`));
    document.head.appendChild(script);
  }).catch((error: unknown) => {
    pending = null;
    throw error;
  });

  return pending;
}
