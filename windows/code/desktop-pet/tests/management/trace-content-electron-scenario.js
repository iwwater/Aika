const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const waitFor = async (predicate, message, timeout = 8000) => {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const value = predicate();
    if (value) return value;
    await pause(25);
  }
  throw new Error(message + '; page=' + document.body.innerText.slice(-1000));
};
const card = await waitFor(() => document.querySelector('.trace-card'), 'Trace card did not load');
const body = '我的私密测试内容';
const reply = '这是合成回复';
if (!card.innerText.includes('[digest:') || card.innerText.includes(body) || card.innerText.includes(reply)) throw new Error('Trace body was not masked by default');
const control = () => [...document.querySelectorAll('.trace-card button')].find(button => /查看本机历史正文|隐藏正文/.test(button.textContent));
const reveal = control();
if (!reveal || reveal.textContent.trim() !== '查看本机历史正文') throw new Error('Reveal control is missing');
reveal.click();
await waitFor(() => document.querySelector('.trace-card')?.innerText.includes(body) && document.querySelector('.trace-card')?.innerText.includes(reply), 'History-backed body did not appear on demand');
control().click();
await waitFor(() => {
  const text = document.querySelector('.trace-card')?.innerText ?? '';
  return text.includes('[digest:') && !text.includes(body) && !text.includes(reply);
}, 'Trace body did not return to its masked state');
return { passed: 1, maskedByDefault: true, revealedOnDemand: true, remasked: true };
