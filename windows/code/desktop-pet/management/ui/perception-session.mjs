const MAX_FRAME_BYTES = 1_500_000;

export function createPerceptionSession({ client, mediaDevices = globalThis.navigator?.mediaDevices,
  encodeFrame = blobToBase64, onChange = () => {} }) {
  const state = { phase: 'idle', stream: null, scopeType: null, frame: null, frameUrl: null,
    grantId: null, observation: null, attached: false, error: '', busy: false };
  let activeRequest = null;
  const changed = () => onChange(state);
  const stopTracks = () => {
    for (const track of state.stream?.getTracks?.() ?? []) { try { track.stop(); } catch {} }
    state.stream = null;
  };
  const releaseFrame = () => {
    state.frame = null;
    if (state.frameUrl) URL.revokeObjectURL(state.frameUrl);
    state.frameUrl = null;
  };
  return {
    state,
    async selectSource() {
      if (!mediaDevices?.getDisplayMedia) throw new Error('当前浏览器不支持系统屏幕选择。');
      if (state.busy || state.phase === 'streaming' || state.phase === 'selecting') return;
      state.error = ''; state.phase = 'selecting'; changed();
      try {
        const stream = await mediaDevices.getDisplayMedia({ audio: false, video: { frameRate: { ideal: 5, max: 10 } } });
        if (state.phase !== 'selecting') { for (const track of stream.getTracks()) track.stop(); return; }
        const track = stream.getVideoTracks?.()[0] ?? stream.getTracks?.()[0];
        if (!track) { for (const item of stream.getTracks()) item.stop(); throw new Error('系统未提供可预览的视频来源。'); }
        const surface = track.getSettings?.().displaySurface;
        state.scopeType = surface === 'window' || surface === 'browser' ? 'window' : 'screen';
        state.stream = stream; state.phase = 'streaming';
        track.addEventListener?.('ended', () => {
          if (state.stream !== stream) return;
          stopTracks(); state.phase = 'idle'; state.error = '屏幕来源已停止。'; changed();
        }, { once: true });
        changed();
      } catch (error) {
        state.phase = 'idle'; state.error = safeError(error, '无法打开系统屏幕选择。'); changed(); throw error;
      }
    },
    freeze(frame) {
      if (state.phase !== 'streaming' || !(frame instanceof Blob) || !frame.size || frame.size > MAX_FRAME_BYTES) throw new Error('预览帧无效或超过 1.5 MB。');
      stopTracks(); releaseFrame();
      state.frame = frame; state.frameUrl = URL.createObjectURL(frame); state.phase = 'preview'; state.error = ''; changed();
    },
    async sendToCloud(confirmed) {
      if (confirmed !== true) throw new Error('请先确认本帧将发送至云端视觉模型。');
      if (state.phase !== 'preview' || !state.frame || state.busy) throw new Error('请先选取并预览一帧。');
      state.busy = true; state.phase = 'uploading'; state.error = ''; changed();
      const controller = new AbortController(); activeRequest = controller;
      const frame = state.frame;
      let imageBase64 = '';
      try {
        if (frame.type !== 'image/png' && frame.type !== 'image/jpeg') throw new Error('只支持 PNG 或 JPEG 图像。');
        imageBase64 = await encodeFrame(frame);
        if (!imageBase64 || imageBase64.length > Math.ceil(MAX_FRAME_BYTES * 4 / 3) + 4) throw new Error('截图超过上传上限。');
        const issued = await client.request('/api/perception/grants', { method: 'POST', signal: controller.signal,
          body: { scopeType: state.scopeType, destination: 'cloud', userConfirmed: true } });
        const grantId = issued.grant?.grantId;
        if (!grantId) throw new Error('服务没有返回单次授权。');
        if (controller.signal.aborted) {
          await client.request(`/api/perception/grants/${encodeURIComponent(grantId)}`, { method: 'DELETE' }).catch(() => {});
          return null;
        }
        state.grantId = grantId;
        const result = await client.request('/api/perception/captures', { method: 'POST', signal: controller.signal,
          body: { grantId, mimeType: frame.type, imageBase64 } });
        if (controller.signal.aborted) {
          if (result.observation?.observationId) await client.request(`/api/perception/observations/${encodeURIComponent(result.observation.observationId)}`, { method: 'DELETE' }).catch(() => {});
          return null;
        }
        state.observation = result.observation; state.phase = 'observed'; state.attached = false;
        releaseFrame();
        return state.observation;
      } catch (error) {
        if (controller.signal.aborted) return null;
        state.phase = state.frame ? 'preview' : 'idle'; state.error = safeError(error, '这次屏幕分析没有完成。'); throw error;
      } finally {
        imageBase64 = '';
        if (activeRequest === controller) { activeRequest = null; state.busy = false; changed(); }
      }
    },
    async attachToNextTurn(confirmed) {
      if (confirmed !== true) throw new Error('请确认只附加到下一轮对话。');
      if (!state.observation || state.busy) throw new Error('当前没有可附加的有效观察。');
      await client.request('/api/perception/attach', { method: 'POST', body: { observationId: state.observation.observationId, userConfirmed: true } });
      state.attached = true; state.phase = 'attached'; changed();
    },
    async clear() {
      activeRequest?.abort(); activeRequest = null;
      state.busy = false; stopTracks(); releaseFrame();
      const grantId = state.grantId, observationId = state.observation?.observationId;
      state.grantId = null; state.observation = null; state.attached = false; state.phase = 'idle'; state.error = '';
      changed();
      const cleanup = [];
      if (grantId) cleanup.push(client.request(`/api/perception/grants/${encodeURIComponent(grantId)}`, { method: 'DELETE' }).catch(() => {}));
      if (observationId) cleanup.push(client.request(`/api/perception/observations/${encodeURIComponent(observationId)}`, { method: 'DELETE' }).catch(() => {}));
      await Promise.all(cleanup);
    },
    async leave() {
      if (state.attached) { stopTracks(); releaseFrame(); return; }
      if (state.phase !== 'idle' || state.observation || state.grantId) await this.clear();
    },
    dispose() {
      activeRequest?.abort(); activeRequest = null; stopTracks(); releaseFrame();
      const attached = state.attached;
      const grantId = state.grantId, observationId = attached ? null : state.observation?.observationId;
      state.grantId = null;
      if (!attached) { state.observation = null; state.attached = false; }
      if (grantId) void client.request(`/api/perception/grants/${encodeURIComponent(grantId)}`, { method: 'DELETE' }).catch(() => {});
      if (observationId) void client.request(`/api/perception/observations/${encodeURIComponent(observationId)}`, { method: 'DELETE' }).catch(() => {});
    },
  };
}

async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  bytes.fill(0);
  return btoa(binary);
}

function safeError(error, fallback) {
  if (error?.name === 'AbortError') return '操作已取消。';
  if (typeof error?.message === 'string' && error.message.length < 180) return error.message;
  return fallback;
}
