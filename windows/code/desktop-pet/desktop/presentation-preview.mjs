// One isolated, silent rig per canvas. The management host supplies only its
// fixed same-origin asset/shader routes and loads the official Core first.
import catalog from './assets/local-model/presets.json';
const instances = new WeakMap();
export async function createPresentationPreview({ canvas, onStatus = () => {}, assetBase, shaderBase }) {
  if (!canvas?.getContext) throw new Error('预览画布不可用');
  if (instances.has(canvas)) return instances.get(canvas);
  const pending = initialize(); instances.set(canvas, pending);
  try { return await pending; } catch (error) { instances.delete(canvas); throw error; }

  async function initialize() {
    let renderer, frame = 0, disposed = false, playing = false, settleUntil = 0;
    const status = (state, message, presetId = null) => onStatus({ state, message, presetId });
    const route = value => {
      const url = new URL(value, location.href);
      if (!value || url.origin !== location.origin || url.username || url.password || url.search || url.hash || !url.pathname.endsWith('/')) throw new Error('预览资源地址不可用');
      return url.href;
    };
    try {
      const options = { assetBase: route(assetBase), shaderBase: route(shaderBase) };
      status('loading', '正在加载角色…');
      for (let attempt = 0; ; attempt++) {
        try { globalThis.Live2DCubismCore.Version.csmGetVersion(); break; }
        catch { if (attempt >= 100) throw new Error('角色预览组件尚未就绪'); await new Promise(resolve => setTimeout(resolve, 10)); }
      }
      const { JellyfishRenderer } = await import('./cubism-renderer.mjs');
      renderer = new JellyfishRenderer(canvas, () => {}, options); await renderer.load(); renderer.stopPreview();
      const view = { state:'idle', mouth:0, expression:{ emotion:'neutral', intensity:0, delivery:'', gesture:null } };
      function tick(at) {
        frame = 0; if (disposed) return;
        try { renderer.updateView(view); }
        catch { disposed = true; renderer.dispose(); instances.delete(canvas); status('error', '角色预览暂时不可用'); return; }
        if (playing || at < settleUntil) frame = requestAnimationFrame(tick);
      }
      function schedule() { if (!disposed && !frame) frame = requestAnimationFrame(tick); }
      const api = {
        select(id) {
          if (disposed) throw new Error('预览已关闭');
          renderer.selectPreset(id);
          const category = catalog.items.find(item => item.id === id).category;
          renderer.setFraming(category === 'expression' || category === 'pose' ? 'half' : 'full');
          playing = true; schedule(); status('playing', '正在预览', id);
        },
        stop() {
          if (disposed) return;
          renderer.stopPreview(); playing = false; settleUntil = performance.now() + 1500; schedule(); status('stopped', '预览已停止');
        },
        restore() {
          if (disposed) return;
          renderer.restorePreview(); playing = false; settleUntil = performance.now() + 1500; schedule(); status('restored', '已恢复原样');
        },
        resize() { if (!disposed) { renderer.syncViewport(); schedule(); } },
        dispose() {
          if (disposed) return;
          disposed = true; cancelAnimationFrame(frame); frame = 0; renderer.dispose(); instances.delete(canvas); status('disposed', '预览已关闭');
        }
      };
      settleUntil = performance.now() + 1500; schedule(); status('ready', '选择一个预设查看效果'); return api;
    } catch (error) { cancelAnimationFrame(frame); renderer?.dispose(); status('error', '角色预览暂时不可用'); throw error; }
  }
}
