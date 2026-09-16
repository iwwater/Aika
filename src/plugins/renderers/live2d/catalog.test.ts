import { describe, expect, it } from 'vitest';
import {
  LIVE2D_APPEARANCES,
  LIVE2D_CORE_SCRIPT,
  LIVE2D_MODELS_ROUTE,
  getLive2dAppearance,
  live2dManifestUrl,
} from './catalog';

function appearance(id: 'hiyori' | 'mao') {
  const found = getLive2dAppearance(id);
  if (!found) throw new Error(`missing appearance '${id}'`);
  return found;
}

/**
 * 模型与 Core 的分发边界不同（MVP-14 / DEF-1）：模型不入包、走回环 API，
 * Core 留在包内、走同源。这一组断言把「两者别混」钉住。
 */
describe('Live2D 资源地址', () => {
  it('把模型指向回环 API 的绝对地址', () => {
    expect(live2dManifestUrl(appearance('hiyori'), 'http://127.0.0.1:17321')).toBe(
      'http://127.0.0.1:17321/live2d/models/hiyori/Hiyori.model3.json',
    );
    expect(live2dManifestUrl(appearance('mao'), 'http://127.0.0.1:17321')).toBe(
      'http://127.0.0.1:17321/live2d/models/mao/Mao.model3.json',
    );
  });

  it('基址末尾的斜杠不产生双斜杠', () => {
    expect(live2dManifestUrl(appearance('hiyori'), 'http://127.0.0.1:17321///')).toBe(
      'http://127.0.0.1:17321/live2d/models/hiyori/Hiyori.model3.json',
    );
    expect(live2dManifestUrl(appearance('hiyori'), '  http://127.0.0.1:17321  ')).toBe(
      'http://127.0.0.1:17321/live2d/models/hiyori/Hiyori.model3.json',
    );
  });

  it('基址为空时不退化成同源相对路径', () => {
    // 模型不入包：相对路径必然 404。宁可返回空串让调用方按「模型不可用」处理，
    // 也不要给一个看起来能用、实际取不到的地址。
    expect(live2dManifestUrl(appearance('hiyori'), '')).toBe('');
    expect(live2dManifestUrl(appearance('hiyori'), '   ')).toBe('');
  });

  it('Core 仍是同源路径：它留在包内，不放宽 CSP', () => {
    expect(LIVE2D_CORE_SCRIPT.startsWith('/')).toBe(true);
    expect(LIVE2D_CORE_SCRIPT).not.toContain('127.0.0.1');
    expect(LIVE2D_CORE_SCRIPT).toContain('/core/');
    expect(LIVE2D_MODELS_ROUTE.startsWith('/')).toBe(true);
  });

  it('每套外观都落到模型路由，且彼此不同', () => {
    const urls = LIVE2D_APPEARANCES.map((item) =>
      live2dManifestUrl(item, 'http://127.0.0.1:17321'),
    );
    expect(urls.length).toBeGreaterThan(1);
    for (const url of urls) expect(url).toContain(`${LIVE2D_MODELS_ROUTE}/`);
    expect(new Set(urls).size).toBe(urls.length);
  });
});
