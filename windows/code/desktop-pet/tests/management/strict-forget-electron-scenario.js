const errors = [];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const waitFor = async (selector, timeout = 8000) => {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const element = document.querySelector(selector);
    if (element) return element;
    await pause(25);
  }
  throw new Error('Timed out waiting for ' + selector + '; page=' + document.body.innerText.slice(-1200));
};
const fill = (selector, value) => {
  const element = document.querySelector(selector);
  if (!element) throw new Error('Missing form field ' + selector);
  element.value = value;
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
};
window.addEventListener('error', event => errors.push(event.message));
await waitFor('[data-md-record="tea"]');
const initial = document.body.innerText;
if (!initial.includes('喜欢红茶')) throw new Error('Initial SQLite memory record was not rendered');
const hasStaleNotice = () => [...document.querySelectorAll('.memory-dynamics .notice')].some(element => element.textContent.includes('上次读取'));
if (hasStaleNotice()) document.querySelector('#md-search').click();
const freshUntil = Date.now() + 8000;
while (Date.now() < freshUntil && hasStaleNotice()) await pause(25);
if (hasStaleNotice()) throw new Error('Memory snapshot remained stale after a GET refresh');

document.querySelector('#memory-policy').click();
await waitFor('#md-preview-query');
const policyFreshUntil = Date.now() + 8000;
while (Date.now() < policyFreshUntil && hasStaleNotice()) await pause(25);
if (hasStaleNotice()) throw new Error('Policy snapshot remained stale after entering the policy page');
fill('#md-preview-query', '红茶');
const previewButton = document.querySelector('#md-preview-run');
if (!previewButton || previewButton.disabled) throw new Error('Preview action unavailable; query=' + document.querySelector('#md-preview-query')?.value + '; section=' + document.querySelector('.memory-dynamics')?.innerText.slice(0, 500));
previewButton.click();
const previewUntil = Date.now() + 8000;
while (Date.now() < previewUntil && !document.querySelector('#md-preview-result') && !document.querySelector('.memory-dynamics .notice.error')) await pause(25);
if (!document.querySelector('#md-preview-result')) throw new Error('Preview did not finish; query=' + document.querySelector('#md-preview-query')?.value + '; error=' + document.querySelector('.memory-dynamics .notice.error')?.innerText);
const previewWasPure = !!document.querySelector('#md-preview-result');

document.querySelector('#memory-dynamics').click();
await waitFor('[data-md-record="tea"]');
const dynamicsFreshUntil = Date.now() + 8000;
while (Date.now() < dynamicsFreshUntil && hasStaleNotice()) await pause(25);
if (hasStaleNotice()) throw new Error('Memory snapshot remained stale after returning to the details page');
const row = document.querySelector('[data-md-record="tea"]');
row.click();
await waitFor('[data-detail-id="tea"]');
fill('#md-reason', '请遗忘红茶');
const forgetAction = document.querySelector('#md-record-action');
if (!forgetAction || forgetAction.disabled) throw new Error('Forget action unavailable; reason=' + document.querySelector('#md-reason')?.value + '; stale=' + hasStaleNotice());
forgetAction.click();
const confirm = await waitFor('#md-confirm-record');
if (confirm.textContent.trim() !== '确认遗忘') throw new Error('Forget confirmation was not explicit');
confirm.click();
const until = Date.now() + 8000;
while (Date.now() < until && !document.body.innerText.includes('遗忘已确认')) await pause(25);
if (!document.body.innerText.includes('遗忘已确认')) throw new Error('The page did not report a confirmed forget result');
if (!previewWasPure || errors.length) throw new Error('Preview or page error: ' + errors.join('; '));
return { passed: 1, previewWasPure, errors };
