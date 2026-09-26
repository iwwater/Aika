// FIX61-03 03-D: drives the real desktop page in Windows Chromium. The scenario module is injected
// before the production bundle and replaces the native shell bridge with a recording harness, so the
// production view code runs against scripted connection states without spawning a backend.
const checks = [];
const check = (name, condition, detail) => { checks.push({ name, ok: !!condition, detail }); };

function finish() {
  const result = document.createElement('script');
  result.type = 'application/json';
  result.id = 'startup-result';
  result.dataset.complete = 'true';
  result.textContent = JSON.stringify({ passed: checks.filter(c => c.ok).length, failed: checks.filter(c => !c.ok).length, checks });
  document.body.append(result);
}

const posted = [];
window.desktopHost = {
  postMessage(name, value) { posted.push({ name, value }); },
  subscribe() {}
};
window.__STARTUP_TEST__ = { posted, deliver: (method, ...args) => window.petBridge?.[method]?.(...args) };
window.addEventListener('error', event => check('no script error', false, String(event.message)));
window.addEventListener('unhandledrejection', event => check('no promise rejection', false, String(event.reason)));

const wait = ms => new Promise(done => setTimeout(done, ms));
const status = () => document.getElementById('status')?.textContent ?? '';
const cancelButton = () => document.getElementById('startup-cancel');

async function scenario() {
  // The page must boot against the fake shell and ask it to start the backend.
  for (let attempt = 0; attempt < 100 && !posted.some(p => p.name === 'shell' && p.value?.type === 'ready'); attempt++) await wait(50);
  check('page sends shell ready to the native host', posted.some(p => p.name === 'shell' && p.value?.type === 'ready'), JSON.stringify(posted));

  // Startup progress is rendered: phase, numbers and elapsed time reach the status line.
  window.__STARTUP_TEST__.deliver('connectionChanged', { generation: 1, state: 'connecting', canRetry: true,
    phase: 'verifying', sequence: 2, completed: 20, total: 80, elapsedMs: 1800 });
  await wait(80);
  check('verifying progress is visible with numbers', status().includes('校验') && status().includes('20/80'), status());
  check('startup cancel is offered while connecting', !!cancelButton() && cancelButton().hidden === false,
    cancelButton() ? 'hidden=' + cancelButton().hidden : 'missing');

  // A repeated heartbeat never changes the displayed counters.
  window.__STARTUP_TEST__.deliver('connectionChanged', { generation: 1, state: 'connecting', canRetry: true,
    phase: 'verifying', sequence: 2, completed: 20, total: 80, elapsedMs: 1900 });
  await wait(80);
  check('repeated heartbeat keeps the same counters', status().includes('20/80'), status());

  // The next real phase replaces the displayed one.
  window.__STARTUP_TEST__.deliver('connectionChanged', { generation: 1, state: 'connecting', canRetry: true,
    phase: 'initializing', sequence: 3, completed: 45, total: 80, elapsedMs: 2600 });
  await wait(80);
  check('initializing progress replaces verifying', status().includes('装配') && status().includes('45/80'), status());

  // Cancelling startup asks the shell for the typed cancel.
  cancelButton()?.click();
  await wait(50);
  check('cancel posts cancel_startup to the shell', posted.some(p => p.name === 'shell' && p.value?.type === 'cancel_startup'), JSON.stringify(posted));

  // A stall stays diagnosable: the reason is named and the retry entry is offered.
  window.__STARTUP_TEST__.deliver('connectionChanged', { generation: 1, state: 'failed', reason: 'stalled', canRetry: true });
  await wait(80);
  check('stalled failure names the reason', status().includes('停滞') || status().includes('无进展'), status());
  check('failed startup hides the cancel entry', !cancelButton() || cancelButton().hidden === true, status());
  const reconnect = document.getElementById('reconnect');
  check('failed startup offers retry', !!reconnect && reconnect.hidden === false, reconnect ? 'hidden=' + reconnect.hidden : 'missing');
  reconnect?.click();
  await wait(50);
  check('retry asks the shell to reconnect', posted.some(p => p.name === 'shell' && p.value?.type === 'reconnect'), JSON.stringify(posted));

  // A successful retry restores the text and voice entries.
  window.__STARTUP_TEST__.deliver('connectionChanged', { generation: 2, state: 'connecting', canRetry: true, phase: 'ready' });
  await wait(50);
  window.__STARTUP_TEST__.deliver('receive', { channel: 'backend_ready', bridgeVersion: '0.7.0', characterId: 'companion', sessionId: 'session-1' }, 2);
  await wait(80);
  const send = document.getElementById('send'), voice = document.getElementById('voice');
  check('ready state is displayed', status().includes('我在这里') || status().includes('连接'), status());
  check('text entry works again after retry', !!send && send.disabled === false, 'disabled=' + send?.disabled);
  check('voice entry works again after retry', !!voice && voice.disabled === false, 'disabled=' + voice?.disabled);
  finish();
}
window.addEventListener('load', () => { void scenario(); });
