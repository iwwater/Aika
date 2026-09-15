import { expect, test } from '@playwright/test';

test.describe('OpenPet browser preview', () => {
  test('settings expose the main configuration tabs', async ({ page }) => {
    await page.goto('/');

    await expect(
      page.getByRole('heading', { name: 'Settings, pets, and tiny companion behavior.' }),
    ).toBeVisible();
    await expect(
      page.getByText('Browser preview only. Open the Tauri desktop app to control the pet.'),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'General' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    await page.getByRole('button', { name: 'Bubble' }).click();
    await expect(page.getByRole('heading', { name: 'Speech bubble' })).toBeVisible();
    const bubbleText = page.getByRole('textbox', { name: 'Bubble text', exact: true });
    await bubbleText.fill('Hello from browser e2e.');
    await expect(bubbleText).toHaveValue('Hello from browser e2e.');

    await page.getByRole('button', { name: 'API / Host' }).click();
    await expect(page.getByRole('heading', { name: 'Endpoint and host integration' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'HTTP API endpoint' })).toBeVisible();
    await expect(page.getByText('http://127.0.0.1:17321').first()).toBeVisible();
    // Runtime status must surface the real product identity and the protocol-exit state.
    await expect(page.getByText('PetShell 0.6.0')).toBeVisible();
    await expect(page.getByText('OpenPet v0.1.6 (GPL-3.0-or-later)')).toBeVisible();
  });

  test('pet route supports click and context-menu interactions', async ({ page }) => {
    await page.goto('/?window=pet');

    await expect(
      page.getByRole('button', { name: 'PetShell desktop pet window' }),
    ).toBeVisible();

    const hitTarget = page.getByTestId('pet-hit-target');
    await expect(hitTarget).toBeVisible();
    await hitTarget.click();
    await hitTarget.click({ button: 'right' });

    await expect(page.getByRole('menu', { name: 'Pet actions' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Open settings' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Wave' })).toBeVisible();

    await page.getByRole('menuitem', { name: 'Let me roam' }).click();
    await expect(page.getByRole('menu', { name: 'Pet actions' })).toBeHidden();

    await hitTarget.click({ button: 'right' });
    await expect(page.getByRole('menuitem', { name: 'Pause walking' })).toBeVisible();
  });

  test('live2d renderer draws a model, switches appearance, and keeps a single output', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      const calls: Array<{ cmd: string; args?: unknown }> = [];
      let nextCallbackId = 1;

      const settings = {
        language: 'en',
        scale: 1,
        reducedMotion: false,
        autonomousWalking: false,
        live2dAppearance: 'hiyori',
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
        // Self-play off: this test is about the renderer, not about idle actions.
        idleSelfPlay: false,
        idleThresholdMs: 45000,
        idleActionFrequencyMs: 30000,
        idleAction: 'random',
        walkingSpeedPx: 8,
        petStoragePreset: 'codex-custom',
        customPetStorageDir: null,
      };
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
        petStorage: {
          preset: 'codex-custom',
          customDir: null,
          activeDir: '.',
          appDataDir: '.',
          codexDir: '.',
        },
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

      Object.defineProperty(window, '__openPetTauriCalls', { configurable: true, value: calls });
      Object.defineProperty(window, '__TAURI_EVENT_PLUGIN_INTERNALS__', {
        configurable: true,
        value: { unregisterListener: () => {} },
      });
      Object.defineProperty(window, '__TAURI_INTERNALS__', {
        configurable: true,
        value: {
          callbacks: {},
          convertFileSrc: (filePath: string) => filePath,
          invoke: async (cmd: string, args?: unknown) => {
            calls.push({ cmd, args });
            if (cmd === 'plugin:event|listen') return nextCallbackId++;
            if (cmd === 'plugin:event|unlisten') return null;
            if (cmd === 'plugin:window|available_monitors') return [];
            if (cmd === 'plugin:window|current_monitor') return null;
            if (cmd === 'plugin:window|primary_monitor') return null;
            if (cmd === 'plugin:window|cursor_position') return { x: 0, y: 0 };
            if (cmd === 'plugin:window|inner_position') return { x: 0, y: 0 };
            if (cmd === 'plugin:window|scale_factor') return 1;
            if (cmd === 'plugin:window|set_ignore_cursor_events') return null;
            if (cmd === 'plugin:window|set_position') return null;
            if (cmd === 'plugin:window|set_size') return null;
            if (cmd === 'plugin:window|start_dragging') return null;
            if (cmd === 'get_runtime_snapshot') return snapshot;
            // Echo the update back so the window's state machine runs for real.
            if (cmd === 'update_settings') {
              const next = (args as { settings?: unknown } | undefined)?.settings;
              return { ...snapshot, settings: next ?? settings };
            }
            throw new Error(`Unhandled mocked Tauri command: ${cmd}`);
          },
          metadata: { currentWebview: { label: 'pet' }, currentWindow: { label: 'pet' } },
          transformCallback: () => nextCallbackId++,
          unregisterCallback: () => {},
        },
      });
    });

    await page.goto('/?window=pet');

    const surface = page.getByTestId('pet-live2d');
    // Live2D loads its runtime, model and textures on first use; give it room.
    await expect(surface).toBeVisible({ timeout: 60_000 });

    type Slots = {
      activeRenderer: string | null;
      capabilities: { costumes: boolean; actions: string[] } | null;
      diagnostics: {
        appearance: string | null;
        playable: string[];
        switched: number;
        failedSwitches: number;
        discardedLoads: number;
        renderLoopRunning: boolean;
        motionGroups: string[];
        expressions: string[];
      } | null;
    };
    const readSlots = () =>
      page.evaluate(() => (window as unknown as { __petSlots: () => unknown }).__petSlots()) as Promise<Slots>;

    // 1) A real model is on screen.
    //
    // Read the default framebuffer with `readPixels`, **不是** `drawImage` 到 2D
    // 画布：后者在带 CSS filter 的合成上下文里回来的是不透明结果（整帧 alpha=255），
    // 会把「模型其实画好了、背景也是透明的」误判成「整块不透明」。
    const samplePixels = () =>
      page.evaluate(() => {
        const canvas = document.querySelector<HTMLCanvasElement>('.pet-live2d-canvas');
        if (!canvas) {
          const root = document.querySelector('.pet-live2d');
          return {
            error: `no canvas; root=${root ? root.outerHTML.slice(0, 300) : 'missing'}`,
          };
        }
        const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
        if (!gl) return { error: 'no webgl context' };
        const width = gl.drawingBufferWidth;
        const height = gl.drawingBufferHeight;
        const data = new Uint8Array(width * height * 4);
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, data);
        let opaque = 0;
        let transparent = 0;
        let signature = 0;
        const colors = new Set<number>();
        for (let i = 0; i < data.length; i += 4) {
          if (data[i + 3] <= 16) {
            transparent += 1;
            continue;
          }
          opaque += 1;
          colors.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
          // Cheap order-sensitive checksum: enough to tell two models apart.
          signature = (signature * 31 + data[i] + data[i + 1] * 3 + data[i + 2] * 7) % 2_147_483_647;
        }
        return { opaque, transparent, colors: colors.size, width, height, signature };
      });

    // 渲染是逐帧的：resize/换模型之后要等下一帧才有内容，不能采一次就下结论。
    const opaquePixels = async () => {
      const sample = await samplePixels();
      return 'opaque' in sample ? sample.opaque : 0;
    };
    await expect.poll(opaquePixels, { timeout: 30_000 }).toBeGreaterThan(1_000);

    const hiyori = await samplePixels();
    // 让失败自带原因：采样失败与「模型没画出来」是两件事。
    if ('error' in hiyori) throw new Error(`live2d canvas sample failed: ${hiyori.error}`);
    expect(hiyori.width).toBeGreaterThan(0);
    expect(hiyori.colors).toBeGreaterThan(50);
    // 桌宠窗口是透明的：大部分画布必须保持透明。
    expect(hiyori.transparent).toBeGreaterThan(hiyori.opaque);

    const beforeSwitch = await readSlots();
    expect(beforeSwitch.activeRenderer).toBe('live2d');
    expect(beforeSwitch.capabilities?.costumes).toBe(true);
    expect(beforeSwitch.diagnostics?.appearance).toBe('hiyori');
    // 未知动作绝不会出现在可播清单里：清单直接来自 manifest。
    expect(beforeSwitch.diagnostics?.playable).toEqual([
      'failed', 'idle', 'jumping', 'review', 'running', 'waiting', 'waving',
    ]);
    expect(beforeSwitch.diagnostics?.motionGroups).toEqual(['Idle', 'TapBody']);
    expect(beforeSwitch.diagnostics?.expressions).toEqual([]);

    // 2) 换装：菜单入口来自 renderer 的能力声明，先加载再提交。
    await surface.click({ button: 'right' });
    await expect(page.getByRole('menu', { name: 'Pet actions' })).toBeVisible();
    expect(await page.getByRole('menuitem').allTextContents()).toEqual([
      'Open settings', 'Wave', 'Let me roam', 'Hide pet', '• Hiyori', 'Mao',
    ]);
    await page.getByRole('menuitem', { name: 'Mao' }).click();

    await expect
      .poll(async () => (await readSlots()).diagnostics?.appearance, { timeout: 60_000 })
      .toBe('mao');

    const afterSwitch = await readSlots();
    expect(afterSwitch.diagnostics?.switched).toBeGreaterThanOrEqual(1);
    expect(afterSwitch.diagnostics?.failedSwitches).toBe(0);
    // Mao 的清单不同：表情存在，且 Idle 组只有 2 段。
    expect(afterSwitch.diagnostics?.expressions).toHaveLength(8);

    await expect.poll(opaquePixels, { timeout: 30_000 }).toBeGreaterThan(1_000);
    const mao = await samplePixels();
    if ('error' in mao) throw new Error(`live2d canvas sample failed: ${mao.error}`);
    // 画面确实换了：两套外观的像素指纹不可能相同。
    expect(mao.signature).not.toBe(hiyori.signature);

    // 3) 单一输出：任一时刻只有一个 renderer 的 DOM 在场。
    await expect(page.locator('.pet-live2d')).toHaveCount(1);
    await expect(page.locator('.pet-sprite')).toHaveCount(0);
    await expect(page.getByTestId('pet-hit-target')).toHaveCount(1);
  });

  test('mocked Tauri pet drag starts only after movement threshold', async ({ page }) => {
    await page.addInitScript(() => {
      const calls: Array<{ cmd: string; args?: unknown }> = [];
      let nextCallbackId = 1;

      Object.defineProperty(window, '__openPetTauriCalls', {
        configurable: true,
        value: calls,
      });

      Object.defineProperty(window, '__TAURI_EVENT_PLUGIN_INTERNALS__', {
        configurable: true,
        value: {
          unregisterListener: () => {},
        },
      });

      Object.defineProperty(window, '__TAURI_INTERNALS__', {
        configurable: true,
        value: {
          callbacks: {},
          convertFileSrc: (filePath: string) => filePath,
          invoke: async (cmd: string, args?: unknown) => {
            calls.push({ cmd, args });

            if (cmd === 'plugin:event|listen') return nextCallbackId++;
            if (cmd === 'plugin:event|unlisten') return null;
            if (cmd === 'plugin:window|available_monitors') return [];
            if (cmd === 'plugin:window|current_monitor') return null;
            if (cmd === 'plugin:window|primary_monitor') return null;
            if (cmd === 'plugin:window|cursor_position') return { x: 0, y: 0 };
            if (cmd === 'plugin:window|inner_position') return { x: 0, y: 0 };
            if (cmd === 'plugin:window|scale_factor') return 1;
            if (cmd === 'plugin:window|set_ignore_cursor_events') return null;
            if (cmd === 'plugin:window|set_position') return null;
            if (cmd === 'plugin:window|set_size') return null;
            if (cmd === 'plugin:window|start_dragging') return null;

            throw new Error(`Unhandled mocked Tauri command: ${cmd}`);
          },
          metadata: {
            currentWebview: { label: 'pet' },
            currentWindow: { label: 'pet' },
          },
          transformCallback: () => nextCallbackId++,
          unregisterCallback: () => {},
        },
      });
    });
    await page.goto('/?window=pet');

    const hitTarget = page.getByTestId('pet-hit-target');
    await expect(hitTarget).toBeVisible();

    await hitTarget.click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as typeof window & { __openPetTauriCalls: Array<{ cmd: string }> })
              .__openPetTauriCalls.filter((call) => call.cmd === 'plugin:window|start_dragging')
              .length,
        ),
      )
      .toBe(0);

    const box = await hitTarget.boundingBox();
    expect(box).not.toBeNull();
    const x = box!.x + box!.width / 2;
    const y = box!.y + box!.height / 2;

    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 12, y);
    await page.mouse.up();

    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as typeof window & { __openPetTauriCalls: Array<{ cmd: string }> })
              .__openPetTauriCalls.filter((call) => call.cmd === 'plugin:window|start_dragging')
              .length,
        ),
      )
      .toBeGreaterThan(0);
  });
});
