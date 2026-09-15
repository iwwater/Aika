import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PET_HIT_TARGET = '[data-testid="pet-hit-target"]';
/** Live2D 首次加载要拉 Core + 模型 + 贴图，真机上给足时间；不假装零耗时。 */
const SWITCH_TIMEOUT = 90_000;
const SCREENSHOT_DIR = process.env.PETSHELL_DEVICE_SHOTS ?? path.join(os.tmpdir(), 'petshell-verify');

describe('PetShell Tauri desktop window', () => {
  it('boots the native pet window and opens its context menu', async () => {
    await switchToPetWindow();

    const route = await browser.execute(() => new URLSearchParams(window.location.search).get('window'));
    expect(route).toBe('pet');

    const hitTarget = await $(PET_HIT_TARGET);
    await expect(hitTarget).toBeDisplayed();

    await hitTarget.click();
    await openContextMenu(hitTarget);

    const menu = await $('[role="menu"]');
    await expect(menu).toBeDisplayed();

    const menuText = await menu.getText();
    expect(menuText).toMatch(/Open settings|打开设置/);
  });

  // MVP-11 真机证据链：真实 WebView2 + 真实模型资产 + 真实 IPC + 真实右键菜单。
  // 全程不 mock：设置经 Tauri 命令归一化并落盘广播，换装点的是用户能点到的那一项。
  //
  // 等待一律读宿主状态（`__petSlots`）而不是查 DOM 元素：真机上 WebDriver 的元素
  // 查找是这里最脆的一环——一次没回来的查找会把「确定失败」盖成一句用例超时。
  it('renders a real Live2D model after a real settings change, and switches appearance from the menu', async () => {
    step('switch to the pet window');
    await switchToPetWindow();

    // 上一个用例把右键菜单留在了打开状态，先收掉，免得状态互相污染。
    await browser.keys(['Escape']).catch(() => {});

    // 1) 先落到 sprite 这个默认出口，再切走：顺带验一次真机上的
    //    sprite→Live2D 切换，而不是只对「恰好已经在的状态」下断言。
    step('force the sprite output: invoke update_settings(renderer=sprite)');
    await withTimeout(setRenderer('sprite'), 30_000, 'update_settings(renderer=sprite)');
    await waitForSlots((slots) => slots?.activeRenderer === 'sprite', 'Expected the sprite output first.');
    // 上一轮留下的 live2d 设置会让应用带着一次启动期 prepare 起跑，等它退干净，
    // 不要在「正在收尾」的瞬间断言。
    await waitForCondition(
      async () => (await countElements('.pet-live2d')) === 0,
      'Expected Live2D to be inactive at first.',
    );

    // 2) 真实设置改动：invoke update_settings → Rust 归一化 + 落盘 + 广播 pet-settings。
    step('switch the output to live2d: invoke update_settings(renderer=live2d)');
    await withTimeout(setRenderer('live2d'), 30_000, 'update_settings(renderer=live2d)');
    step('  accepted; wait for the live2d output');
    await waitForLive2dOutput();
    await waitForCondition(
      async () => (await countElements('.pet-sprite')) === 0,
      'Expected the old renderer to yield its output.',
    );

    // 3) 真机上确实画出了东西：读默认帧缓冲，而不是信「元素存在」。
    step('read back the first frame');
    await waitForOpaquePixels();
    const hiyori = await samplePixels();
    if (hiyori.error) throw new Error(`live2d canvas sample failed: ${hiyori.error}`);
    expect(hiyori.width).toBeGreaterThan(0);
    expect(hiyori.colors).toBeGreaterThan(50);
    // 桌宠窗口是透明的：真机合成下大部分画布必须保持透明。
    expect(hiyori.transparent).toBeGreaterThan(hiyori.opaque);

    const before = await readSlots();
    expect(before.activeRenderer).toBe('live2d');
    expect(before.capabilities?.costumes).toBe(true);
    expect(before.diagnostics?.appearance).toBe('hiyori');
    // 可播清单直接来自真机加载到的 manifest：未知动作不会出现。
    expect(before.diagnostics?.playable).toEqual([
      'failed',
      'idle',
      'jumping',
      'review',
      'running',
      'waiting',
      'waving',
    ]);
    expect(before.diagnostics?.motionGroups).toEqual(['Idle', 'TapBody']);
    expect(before.diagnostics?.expressions).toEqual([]);
    // 真机上 WebGL 渲染循环必须真的在跑，而不是画完一帧就停。
    expect(before.diagnostics?.renderLoopRunning).toBe(true);
    await saveDeviceScreenshot('device-live2d-hiyori.png');

    // 4) 换装：点用户能点到的那一项，而不是直接改内部状态。
    step('switch the appearance from the context menu');
    await openContextMenu(await $(PET_HIT_TARGET));
    const maoEntry = await $('//*[@role="menuitem"][normalize-space(.)="Mao"]');
    await maoEntry.waitForExist({ timeout: 10_000 });
    await maoEntry.click();

    await waitForSlots(
      (slots) => slots?.diagnostics?.appearance === 'mao',
      'Expected the appearance to become mao after the menu switch.',
    );
    step('  appearance is mao; read back the second frame');

    const after = await readSlots();
    expect(after.diagnostics?.switched).toBeGreaterThanOrEqual(1);
    expect(after.diagnostics?.failedSwitches).toBe(0);
    // Mao 的 manifest 不同：表情存在，Idle 组只有 2 段。
    expect(after.diagnostics?.expressions).toHaveLength(8);

    await waitForOpaquePixels();
    const mao = await samplePixels();
    if (mao.error) throw new Error(`live2d canvas sample failed: ${mao.error}`);
    // 画面确实换了：两套外观的像素指纹不可能相同。
    expect(mao.signature).not.toBe(hiyori.signature);
    await saveDeviceScreenshot('device-live2d-mao.png');

    // 5) 单一输出：真机上任一时刻只有一个 renderer 的 DOM、一个 hit target。
    expect(await countElements('.pet-live2d')).toBe(1);
    expect(await countElements('.pet-sprite')).toBe(0);
    expect(await countElements(PET_HIT_TARGET)).toBe(1);

    // 6) 切回默认，顺带验证反向切换也不会留下残骸，并把本机设置还原。
    step('switch back to the default output');
    await withTimeout(
      setRendererSettings({ renderer: 'sprite', live2dAppearance: 'hiyori' }),
      30_000,
      'update_settings(renderer=sprite, appearance=hiyori)',
    );
    await waitForSlots((slots) => slots?.activeRenderer === 'sprite', 'Expected the sprite output back.');
    await waitForCondition(
      async () => (await countElements('.pet-live2d')) === 0,
      'Expected the Live2D stage to be released.',
    );
  });
});

afterEach(async function () {
  if (this.currentTest?.state === 'failed') {
    await dumpDiagnostics();
  }
});

async function switchToPetWindow() {
  await browser.waitUntil(
    async () => {
      const handles = await browser.getWindowHandles();

      for (const handle of handles) {
        await browser.switchToWindow(handle);

        const hitTarget = await $(PET_HIT_TARGET);
        if (await hitTarget.isExisting()) {
          return true;
        }
      }

      return false;
    },
    {
      timeout: 20_000,
      interval: 500,
      timeoutMsg: 'Expected the PetShell pet window to be available to WebDriver.',
    },
  );
}

async function openContextMenu(hitTarget) {
  await hitTarget.click({ button: 'right' });

  const menu = await $('[role="menu"]');
  if (await menu.isDisplayed().catch(() => false)) {
    return;
  }

  // WebKitGTK under Xvfb can miss WebDriver's synthesized secondary-button
  // click even though the native Tauri webview booted successfully. Keep the
  // native WebDriver session, but fall back to dispatching the same DOM
  // contextmenu event so the test remains focused on the menu behavior.
  await browser.execute((selector) => {
    const target = document.querySelector(selector);
    if (!target) throw new Error(`Unable to find ${selector}`);
    const rect = target.getBoundingClientRect();
    target.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        button: 2,
        buttons: 2,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
        view: window,
      }),
    );
  }, PET_HIT_TARGET);
}

/** 走真实 Tauri 命令：Rust 侧归一化 + 落盘 + 广播 pet-settings。 */
async function setRendererSettings(patch) {
  return browser.execute(async (next) => {
    const { invoke } = window.__TAURI_INTERNALS__;
    const snapshot = await invoke('get_runtime_snapshot');
    const updated = await invoke('update_settings', {
      settings: { ...snapshot.settings, ...next },
    });
    return updated.settings;
  }, patch);
}

async function setRenderer(renderer) {
  const settings = await setRendererSettings({ renderer });

  if (settings?.renderer !== renderer) {
    throw new Error(
      `update_settings did not accept renderer=${renderer}; got ${JSON.stringify(settings?.renderer)}`,
    );
  }
}

async function readSlots() {
  return browser.execute(() => {
    const hook = window.__petSlots;
    return typeof hook === 'function' ? hook() : null;
  });
}

/** DOM 计数同样走页面内查询，避免 WebDriver 的元素查找。 */
async function countElements(selector) {
  return browser.execute((value) => document.querySelectorAll(value).length, selector);
}

async function waitForCondition(condition, message, timeout = SWITCH_TIMEOUT) {
  await browser.waitUntil(condition, { timeout, interval: 500, timeoutMsg: message });
}

async function waitForSlots(predicate, message) {
  await waitForCondition(async () => predicate(await readSlots()), message);
}

/**
 * 读默认帧缓冲，而不是 `drawImage` 到 2D 画布：带 CSS filter 的合成会回来不透明
 * 结果（整帧 alpha=255），把「模型画好了、背景也透明」误判成「整块不透明」。
 * 渲染器为此显式开了 `preserveDrawingBuffer`。
 */
async function samplePixels() {
  return browser.execute(() => {
    const canvas = document.querySelector('.pet-live2d-canvas');
    if (!canvas) return { error: 'no .pet-live2d-canvas' };
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    if (!gl) return { error: 'no webgl context' };

    const width = gl.drawingBufferWidth;
    const height = gl.drawingBufferHeight;
    const data = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, data);

    let opaque = 0;
    let transparent = 0;
    let signature = 0;
    const colors = new Set();

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
}

async function waitForOpaquePixels() {
  // 渲染是逐帧的：换模型/换外观之后要等下一帧才有内容，不能采一次就下结论。
  await waitForCondition(
    async () => (await samplePixels()).opaque > 1_000,
    'Expected the Live2D canvas to hold a drawn model.',
    30_000,
  );
}

async function saveDeviceScreenshot(name) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  await browser.saveScreenshot(path.join(SCREENSHOT_DIR, name));
}

/** 真机跑得慢，失败时要能一眼看出停在哪一步，而不是只看到一句超时。 */
function step(message) {
  console.log(`[device] ${message}`);
}

/**
 * 给 WebDriver 命令套一个上限：真机上「命令根本没回来」和「结果不对」是两种
 * 完全不同的故障，前者不该被 Mocha 的用例超时盖成一句「跑太久」。
 */
async function withTimeout(promise, ms, label) {
  let timer;

  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not return within ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 等 Live2D 真的接管：
 * - 宿主降级是**确定**的失败，不必等到超时，把 lastError 带出来早点报；
 * - 只有走到 timeoutMsg 才说明「既没接管也没降级」。
 */
async function waitForLive2dOutput() {
  await waitForCondition(async () => {
    const slots = await readSlots();

    if (slots?.activeRenderer === 'live2d') {
      return true;
    }

    if (slots?.status === 'degraded' || slots?.status === 'unavailable') {
      throw new Error(
        `Live2D did not take over: status=${slots.status} lastError=${slots.lastError ?? 'none'}`,
      );
    }

    return false;
  }, 'Expected the Live2D renderer to take over after a real settings change.');
}

async function dumpDiagnostics() {
  try {
    console.log(`[device] slots: ${JSON.stringify(await readSlots())}`);
  } catch (error) {
    console.log(`[device] slots unavailable: ${error.message}`);
  }

  // 泄漏现场：残留的 renderer DOM 挂在谁下面、长什么样。
  try {
    const probe = await browser.execute(() => {
      const describe = (node) => ({
        parent: node.parentElement?.className ?? null,
        connected: node.isConnected,
        hidden: node.hidden,
        html: node.outerHTML.slice(0, 140),
      });
      return {
        live2d: [...document.querySelectorAll('.pet-live2d')].map(describe),
        sprite: [...document.querySelectorAll('.pet-sprite')].map(describe),
        containerChildren: [...(document.querySelector('.pet-renderer-container')?.children ?? [])]
          .map((node) => node.className),
      };
    });
    console.log(`[device] dom: ${JSON.stringify(probe)}`);
  } catch (error) {
    console.log(`[device] dom probe unavailable: ${error.message}`);
  }

  // 失败现场的画面比日志更能说明问题：是「没画出来」还是「画了但状态不对」。
  try {
    await saveDeviceScreenshot('device-failure.png');
  } catch (error) {
    console.log(`[device] failure screenshot unavailable: ${error.message}`);
  }

  try {
    const logs = await browser.getLogs('browser');
    for (const entry of logs ?? []) {
      if (entry.level === 'SEVERE' || entry.level === 'WARNING') {
        console.log(`[device] console ${entry.level}: ${entry.message}`);
      }
    }
  } catch (error) {
    console.log(`[device] console logs unavailable: ${error.message}`);
  }
}
