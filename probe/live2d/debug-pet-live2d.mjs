/** Temporary diagnostic for the Live2D renderer inside the real pet window. */
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from '@playwright/test';

const PORT = 4175;
const URL = `http://127.0.0.1:${PORT}/?window=pet`;
/** `--appearance=mao` loads that model directly, with no switch at all. */
const INITIAL_APPEARANCE =
  process.argv.find((arg) => arg.startsWith('--appearance='))?.split('=')[1] ?? 'hiyori';
const SKIP_SWITCH = process.argv.includes('--no-switch');

const server = spawn(`pnpm exec vite --host 127.0.0.1 --port ${PORT} --strictPort --mode browser`, {
  cwd: process.cwd(),
  shell: true,
  stdio: 'ignore',
});

const SETTINGS = {
  language: 'en',
  scale: 1,
  reducedMotion: false,
  autonomousWalking: false,
  live2dAppearance: INITIAL_APPEARANCE,
  renderer: 'live2d',
  hoverPause: true,
  activePetId: 'nia',
  clickActionMode: 'fixed',
  clickAction: 'waving',
  clickActionPool: ['waving'],
  eventReactions: true,
  eventBubbles: true,
  eventBubbleTtlMs: 4000,
  bubbleStyle: 'soft',
  bubbleFontFamily: 'Aptos Display',
  bubbleFontSizePx: 14,
  bubbleMaxWidthPx: 292,
  idleSelfPlay: false,
  idleThresholdMs: 45000,
  idleActionFrequencyMs: 30000,
  idleAction: 'random',
  walkingSpeedPx: 8,
  petStoragePreset: 'codex-custom',
  customPetStorageDir: null,
};

let browser;
try {
  for (let i = 0; i < 60; i += 1) {
    try {
      const response = await fetch(URL);
      if (response.ok) break;
    } catch {
      /* keep waiting */
    }
    await delay(1000);
  }

  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 480, height: 560 } });
  page.on('pageerror', (error) => console.log('[pageerror]', error.message));
  page.on('console', (message) => console.log(`[console.${message.type()}]`, message.text().slice(0, 300)));
  page.on('response', (response) => {
    if (response.status() >= 400) console.log('[http]', response.status(), response.url());
  });
  page.on('requestfailed', (request) =>
    console.log('[requestfailed]', request.url(), request.failure()?.errorText),
  );

  await page.addInitScript((settings) => {
    let nextCallbackId = 1;
    const snapshot = {
      settings,
      activePet: {
        id: 'nia',
        displayName: 'Nia',
        description: 'sample',
        spritesheetPath: 'spritesheet.webp',
        spritesheetUrl: '/pets/nia/spritesheet.webp',
        imported: false,
      },
      petCatalog: [],
      petStorage: { preset: 'codex-custom', customDir: null, activeDir: '.', appDataDir: '.', codexDir: '.' },
      apiBaseUrl: 'http://127.0.0.1:17321',
      configuredListenAddress: '127.0.0.1',
      configuredPort: 17321,
      listenAddress: '127.0.0.1',
      port: 17321,
      apiListening: true,
      apiError: null,
      apiRestartRequired: false,
      petVisible: true,
      lastAction: null,
      bubbleText: null,
      recentEvents: [],
      startedAtMs: 0,
    };
    Object.defineProperty(window, '__TAURI_EVENT_PLUGIN_INTERNALS__', {
      configurable: true,
      value: { unregisterListener: () => {} },
    });
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {
        callbacks: {},
        convertFileSrc: (filePath) => filePath,
        invoke: async (cmd, args) => {
          if (cmd === 'plugin:event|listen') return nextCallbackId++;
          if (cmd === 'plugin:event|unlisten') return null;
          if (cmd.startsWith('plugin:window|')) {
            if (cmd.endsWith('available_monitors')) return [];
            if (cmd.endsWith('cursor_position')) return { x: 0, y: 0 };
            if (cmd.endsWith('inner_position')) return { x: 0, y: 0 };
            if (cmd.endsWith('scale_factor')) return 1;
            if (cmd.endsWith('current_monitor') || cmd.endsWith('primary_monitor')) return null;
            return null;
          }
          if (cmd === 'get_runtime_snapshot') return snapshot;
          if (cmd === 'update_settings') return { ...snapshot, settings: args?.settings ?? settings };
          throw new Error(`Unhandled mocked Tauri command: ${cmd}`);
        },
        metadata: { currentWebview: { label: 'pet' }, currentWindow: { label: 'pet' } },
        transformCallback: () => nextCallbackId++,
        unregisterCallback: () => {},
      },
    });
  }, SETTINGS);

  await page.goto(URL, { waitUntil: 'load' });
  await delay(20000);

  const snapshotOnce = async (label) => {
    const data = await page.evaluate(() => {
      const canvas = document.querySelector('.pet-live2d-canvas');
      let grid = null;
      if (canvas) {
        const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
        const rows = 10;
        const columns = 10;
        grid = [];
        for (let row = 0; row < rows; row += 1) {
          let line = '';
          for (let column = 0; column < columns; column += 1) {
            const x = Math.floor(((column + 0.5) / columns) * canvas.width);
            const y = Math.floor((1 - (row + 0.5) / rows) * canvas.height);
            const out = new Uint8Array(4);
            gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, out);
            line += out[3] > 128 ? '#' : out[3] > 16 ? '+' : '.';
          }
          grid.push(line);
        }
      }
      const slots = window.__petSlots ? window.__petSlots() : null;
      return {
        appearance: slots?.diagnostics?.appearance ?? null,
        scale: slots?.diagnostics?.scale ?? null,
        measured: slots?.diagnostics?.measured ?? null,
        renderLoopRunning: slots?.diagnostics?.renderLoopRunning ?? null,
        visible: slots?.diagnostics?.visible ?? null,
        lastError: slots?.diagnostics?.lastError ?? null,
        failedSwitches: slots?.diagnostics?.failedSwitches ?? null,
        canvasCount: document.querySelectorAll('.pet-live2d-canvas').length,
        modelCount: document.querySelectorAll('.pet-live2d').length,
        grid,
      };
    });
    console.log(label, JSON.stringify(data));
  };

  await snapshotOnce('[before-switch]');
  await page
    .locator('[data-testid="pet-live2d"]')
    .screenshot({ path: 'probe/live2d/shot-initial.png' })
    .catch((error) => console.log('[screenshot]', error.message));

  if (!SKIP_SWITCH) {
    await page.locator('[data-testid="pet-live2d"]').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Mao' }).click();
    await delay(8000);
    await snapshotOnce('[after-switch] ');
    await page
      .locator('[data-testid="pet-live2d"]')
      .screenshot({ path: 'probe/live2d/shot-after-switch.png' })
      .catch((error) => console.log('[screenshot]', error.message));
  }

  const dump = await page.evaluate(() => {
    const canvas = document.querySelector('.pet-live2d-canvas');
    let sample = null;
    let contextAttributes = null;
    if (canvas) {
      const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
      contextAttributes = gl ? gl.getContextAttributes() : { error: 'no gl context' };
      const copy = document.createElement('canvas');
      copy.width = canvas.width;
      copy.height = canvas.height;
      const context = copy.getContext('2d');
      context.drawImage(canvas, 0, 0);
      const { data } = context.getImageData(0, 0, copy.width, copy.height);
      let opaque = 0;
      let transparent = 0;
      const colors = new Set();
      let minAlpha = 255;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] <= 16) transparent += 1;
        else {
          opaque += 1;
          colors.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
        }
        if (data[i + 3] < minAlpha) minAlpha = data[i + 3];
      }
      sample = {
        size: `${copy.width}x${copy.height}`,
        opaque,
        transparent,
        colors: colors.size,
        minAlpha,
        firstPixel: [data[0], data[1], data[2], data[3]],
        centerPixel: [
          data[(Math.floor(copy.height / 2) * copy.width + Math.floor(copy.width / 2)) * 4],
          data[(Math.floor(copy.height / 2) * copy.width + Math.floor(copy.width / 2)) * 4 + 1],
          data[(Math.floor(copy.height / 2) * copy.width + Math.floor(copy.width / 2)) * 4 + 2],
          data[(Math.floor(copy.height / 2) * copy.width + Math.floor(copy.width / 2)) * 4 + 3],
        ],
      };
      // Ground truth: read the default framebuffer directly, bypassing drawImage.
      const gl2 = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
      const readPixel = (x, y) => {
        const out = new Uint8Array(4);
        gl2.readPixels(x, y, 1, 1, gl2.RGBA, gl2.UNSIGNED_BYTE, out);
        return [out[0], out[1], out[2], out[3]];
      };
      sample.glCorner = readPixel(2, 2);
      sample.glCenter = readPixel(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2));
      sample.drawingBufferSize = [gl2.drawingBufferWidth, gl2.drawingBufferHeight];

      // Coarse alpha map: where does the model actually sit?
      const columns = 12;
      const rows = 12;
      const grid = [];
      for (let row = 0; row < rows; row += 1) {
        let line = "";
        for (let column = 0; column < columns; column += 1) {
          const x = Math.floor(((column + 0.5) / columns) * canvas.width);
          // GL reads bottom-up; flip so the printed map matches the screen.
          const y = Math.floor((1 - (row + 0.5) / rows) * canvas.height);
          const alpha = readPixel(x, y)[3];
          line += alpha > 128 ? "#" : alpha > 16 ? "+" : ".";
        }
        grid.push(line);
      }
      sample.alphaGrid = grid;
      sample.modelTransform = null;
    }
    return {
      slots: window.__petSlots ? window.__petSlots() : null,
      hasCore: typeof window.Live2DCubismCore !== 'undefined',
      coreScriptTag: Boolean(document.querySelector('script[data-live2d-core]')),
      contextAttributes,
      sample,
    };
  });
  console.log(JSON.stringify(dump, null, 2));
} finally {
  if (browser) await browser.close();
  server.kill();
}
