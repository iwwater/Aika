// The native shell owns saved preferences and screen constraints. These controls
// only express user intent and apply its acknowledgement in logical CSS pixels.
export function installDisplayControls({ get, shell, setFraming }) {
  let config = { mode: 'full', preferredWidth: 360, modelWidth: 360, modelHeight: 340, drawerHeight: 540 };
  let drag = null;
  const handle = get('model-resize');
  const stop = event => { event?.preventDefault?.(); event?.stopPropagation?.(); };
  const release = () => {
    const active = drag; drag = null;
    if (active && handle.hasPointerCapture?.(active.id)) handle.releasePointerCapture(active.id);
    handle.dataset.resizing = 'false';
  };
  function cancel(event) {
    if (!drag) return false;
    stop(event); release(); shell({ type: 'resize_model', phase: 'cancel' }); return true;
  }
  function receive(value) {
    if (!value || !['full', 'half'].includes(value.mode) || !['preferredWidth', 'modelWidth', 'modelHeight', 'drawerHeight'].every(k => Number.isFinite(value[k])) || value.modelWidth <= 0 || value.modelHeight <= 0 || value.drawerHeight < 0) return;
    config = value;
    const pet = get('pet');
    pet.style.height = `${value.modelHeight + 36}px`;
    const positioned = ['petLeft','petTop','petWidth','drawerLeft','drawerTop','drawerWidth'].every(k => Number.isFinite(value[k]));
    if (positioned) {
      // Coordinates live in a fixed screen-sized WK viewport, not the changing
      // clipped NSPanel. Reapplying a panel acknowledgement never moves the model.
      Object.assign(pet.style, { position:'absolute', left:`${value.petLeft}px`, top:`${value.petTop}px`, width:`${value.petWidth}px` });
      Object.assign(get('drawer').style, { position:'absolute', left:`${value.drawerLeft}px`, top:`${value.drawerTop}px`, width:`${value.drawerWidth}px`, margin:'0' });
      get('drawer').dataset.placement = value.placement ?? '';
    }
    get('character').style.width = `${value.modelWidth}px`;
    get('character').style.height = `${value.modelHeight}px`;
    handle.style.right = `calc(50% - ${value.modelWidth / 2}px)`;
    get('drawer').style.maxHeight = `${value.drawerHeight}px`;
    get('drawer').style.height = `${value.drawerHeight}px`;
    for (const mode of ['full', 'half']) get(`view-${mode}`).setAttribute('aria-pressed', String(mode === value.mode));
    setFraming(value.mode);
  }
  for (const mode of ['full', 'half']) {
    const button = get(`view-${mode}`);
    button.onpointerdown = event => event.stopPropagation?.();
    button.onclick = event => { stop(event); cancel(); shell({ type: 'set_display', mode }); };
  }
  handle.onpointerdown = event => {
    stop(event);
    if (event.button !== undefined && event.button !== 0 || drag) return;
    drag = { id: event.pointerId, x: event.screenX, y: event.screenY, width: config.modelWidth, ratio: config.modelHeight / config.modelWidth, value: config.modelWidth, moved: false };
    handle.setPointerCapture(event.pointerId); handle.dataset.resizing = 'true';
    shell({ type: 'resize_model', phase: 'begin' });
  };
  handle.onpointermove = event => {
    if (!drag || drag.id !== event.pointerId) return;
    stop(event);
    const dx = event.screenX - drag.x, dy = event.screenY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) < 3 && !drag.moved) return;
    drag.moved = true;
    drag.value = Math.min(720, Math.max(220, drag.width + (dx + drag.ratio * dy) / (1 + drag.ratio ** 2)));
    shell({ type: 'resize_model', phase: 'update', width: drag.value });
  };
  handle.onpointerup = event => {
    if (!drag || drag.id !== event.pointerId) return;
    stop(event); const { value, moved } = drag; release();
    shell(moved ? { type: 'resize_model', phase: 'commit', width: value } : { type: 'resize_model', phase: 'cancel' });
  };
  handle.onpointercancel = cancel; handle.onlostpointercapture = cancel;
  handle.onclick = stop;
  handle.onkeydown = event => {
    if (event.key === 'Escape') { cancel(event); return }
    const step = ({ ArrowRight: 20, ArrowUp: 20, ArrowLeft: -20, ArrowDown: -20 })[event.key];
    if (!step || event.metaKey || event.ctrlKey || event.altKey) return;
    stop(event); cancel(); shell({ type: 'resize_model', phase: 'begin' });
    shell({ type: 'resize_model', phase: 'commit', width: config.preferredWidth + step });
  };
  receive(config);
  return { receive, cancel, get mode() { return config.mode } };
}
