import { el, button, card, notice } from './dom.mjs';
import { createPerceptionSession } from './perception-session.mjs';
export { createPerceptionSession } from './perception-session.mjs';

export function createPerceptionView(client, render, context) {
  let status = null, loadError = '', loadPending = false;
  const session = createPerceptionSession({ client, onChange: render });
  const refresh = async () => {
    const c = context();
    if (c.connection !== 'online' || c.page !== 'perception' || loadPending) return;
    loadPending = true; loadError = ''; render();
    try { status = await client.request('/api/perception'); }
    catch (error) { loadError = safeError(error, '无法读取授权感知状态。'); }
    finally { loadPending = false; render(); }
  };
  const freezeFromVideo = async video => {
    if (!video.videoWidth || !video.videoHeight) throw new Error('所选窗口尚未提供可预览画面。');
    const scale = Math.min(1, 1280 / video.videoWidth, 720 / video.videoHeight);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale)); canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    const context2d = canvas.getContext('2d', { alpha: false });
    if (!context2d) throw new Error('浏览器无法创建本地预览。');
    context2d.drawImage(video, 0, 0, canvas.width, canvas.height);
    const frame = await new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('无法生成预览帧。')), 'image/jpeg', .72));
    canvas.width = 0; canvas.height = 0;
    session.freeze(frame);
  };
  return {
    refresh,
    dispose: () => session.dispose(),
    leave: () => session.leave(),
    view() {
      const c = context(), state = session.state;
      const actions = [];
      if (loadError) actions.push(notice(loadError, 'error'));
      actions.push(notice('默认不采集。系统窗口选择器打开后，画面只在此页本地预览；定格后再单独确认是否将这一帧发送到已登记的云端视觉模型。截图不会写入历史，Observation 最多附加到下一轮并在两分钟后失效。', 'warning'));
      actions.push(card('当前能力',
        el('p', { class: 'subtle' }, loadPending ? '正在读取服务能力…' : status?.capabilities?.cloud ? '云端视觉模型：已配置（本次请求仍需单独确认）' : '云端视觉模型：不可用'),
        el('p', { class: 'subtle' }, '本地 OCR/VLM：未配置；屏幕选择器是否可用取决于当前浏览器和 Windows 桌面环境。')));
      if (state.error) actions.push(notice(state.error, 'error'));
      if (state.phase === 'streaming') {
        const video = el('video', { class: 'perception-live-preview', autoplay: true, muted: true, playsInline: true,
          onLoadedMetadata: event => { void event.currentTarget.play().catch(() => {}); } });
        video.srcObject = state.stream;
        actions.push(card('所选来源预览', video,
          el('p', { class: 'subtle' }, '来源由系统选择器提供。点“定格预览”后会立即停止采集轨道。'),
          button('定格预览', () => { void freezeFromVideo(video).catch(error => { state.error = safeError(error, '定格失败。'); render(); }); }, { class: 'primary' }),
          button('停止采集', () => { void session.clear(); })));
      } else if (state.phase === 'preview' && state.frameUrl) {
        actions.push(card('本地截图预览', el('img', { class: 'perception-frame-preview', src: state.frameUrl, alt: '待处理的本地截图预览' }),
          el('p', { class: 'subtle' }, '画面尚未上传。勾选并点击确认后，才会把这一帧发送到云端模型。'),
          el('label', { class: 'perception-consent' }, el('input', { type: 'checkbox', id: 'perception-cloud-consent' }),
            el('span', {}, '我确认将这张截图发送到已配置的云端视觉模型进行分析。')),
          button('确认并发送这一帧', () => { const confirmed = document.getElementById('perception-cloud-consent')?.checked === true;
            void session.sendToCloud(confirmed).catch(error => { state.error = safeError(error, '上传或分析失败。'); render(); }); },
          { class: 'primary', disabled: !status?.capabilities?.cloud }),
          button('丢弃截图', () => { void session.clear(); })));
      } else if (state.phase === 'uploading') {
        actions.push(card('正在处理', el('p', {}, '授权有效期为单次。可以立即撤销；撤销会中止云端请求并清除临时结果。'), button('撤销并清除', () => { void session.clear(); })));
      } else if (state.phase === 'selecting') {
        actions.push(card('等待系统选择', el('p', {}, '请在系统对话框中选择一个窗口或显示器；尚未向服务发送画面。'), button('取消', () => { void session.leave(); })));
      } else if (state.observation) {
        actions.push(card(state.attached ? '已附加到下一轮' : '本次观察结果',
          el('p', { class: 'subtle' }, `系统选择器 · ${new Date(state.observation.capturedAt).toLocaleString('zh-CN')}`),
          state.observation.vlm?.summary ? el('p', {}, state.observation.vlm.summary) : null,
          ...(state.observation.vlm?.visualElements ?? []).map(item => el('span', { class: 'badge muted' }, item)),
          state.observation.vlm?.uncertaintyNote ? notice(state.observation.vlm.uncertaintyNote, 'warning') : null,
          state.attached ? notice('已排队。现在回到桌宠发送下一条消息即可；该画面只用于那一轮，不进入聊天历史。', 'success')
            : button('附加到下一条桌宠消息', () => { void session.attachToNextTurn(true).catch(error => { state.error = safeError(error, '附加失败。'); render(); }); }, { class: 'primary' }),
          button('清除观察', () => { void session.clear(); })));
      }
      if (!['selecting', 'streaming', 'preview', 'uploading', 'observed', 'attached'].includes(state.phase)) {
        actions.push(card('选择来源',
          el('p', { class: 'subtle' }, '每次只选择一个窗口或显示器，不录制、不保存视频。系统会要求你确认共享来源。'),
          button('打开系统来源选择器', () => { void session.selectSource().catch(() => {}); }, { class: 'primary', disabled: c.connection !== 'online' || loadPending })));
      }
      return el('div', { class: 'page-content perception-page' }, ...actions);
    },
  };
}

function safeError(error, fallback) {
  if (error?.name === 'AbortError') return '操作已取消。';
  if (typeof error?.message === 'string' && error.message.length < 180) return error.message;
  return fallback;
}
