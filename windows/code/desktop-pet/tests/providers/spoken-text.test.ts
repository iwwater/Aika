import test from 'node:test';
import assert from 'node:assert/strict';
import type { DialogueRequest, TurnScope } from '../../contracts/index.js';
import { DIALOGUE_RESPONSE_RULES } from '../../companion/dialogue-rules.js';
import { QwenDialogueProvider } from '../../providers/qwen-dialogue.js';
import { ProviderTransport } from '../../providers/transport.js';

const scope: TurnScope = { characterId: 'companion', sessionId: 'spoken-fixture', turnId: 'turn-1', generation: 1 };
const expression = { emotion: 'warm', intensity: .4, delivery: '自然温和', gesture: null };
function harness(text: string, afterRequest?: () => void) {
  const requests: { messages: { role: string; content: string }[]; model: string }[] = [];
  const provider = new QwenDialogueProvider({ model: 'qwen-plus-2025-12-01', endpoint: 'https://controlled.invalid/chat/completions',
    apiKey: () => 'synthetic-only', authorizer: { async authorize() { return { async settle() {} }; } } },
  new ProviderTransport(async (_url, init) => {
    requests.push(JSON.parse(String(init?.body))); afterRequest?.();
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ text, expression }) } }] });
  }));
  return { provider, requests };
}
function input(text = '怎么出现蓝框了？'): DialogueRequest {
  return { scope, text, context: { scope, characterPrompt: '用户保存的人设：亲近、坦率，喜欢轻松聊天。',
    recent: [], memories: [], summary: '', perception: null, inputTokenBudget: 32768 } };
}
const signal = () => new AbortController().signal;

const screenshotReply = '蓝框？听起来像是界面调试时的小彩蛋～要不要我帮你一起看看是哪段代码悄悄冒出来的？（托腮）不过提醒你：上次你说要“顺手修个bug”，结果晚饭点了三回外卖……';
const reportedLaughReply = '哇，一点半啦？你这生物钟比我养的仙人掌还倔——它至少每周会偷偷开一次花，你却总在深夜和代码/邮件/蓝框较劲～（轻笑）不过说真的，快去睡吧，明天睁眼要是顶着熊猫眼来上班，我可要拍照存档了。';
test('exact reported wave-separated laugh is removed before reply consumers', async () => {
  const run = harness(reportedLaughReply), result = await run.provider.reply(input('已经一点半了'), signal());
  assert.equal(result.text, reportedLaughReply.replace('（轻笑）', ''));
  assert.deepEqual(result.expression, expression);
  assert.equal(run.requests.length, 1);
});
test('reported stage aside leaves the one returned spoken text before any UI/storage/TTS consumer', async t => {
  const run = harness(screenshotReply), result = await run.provider.reply(input(), signal());
  assert.equal(result.text, screenshotReply.replace('（托腮）', ''));
  assert.deepEqual(result.expression, expression); assert.deepEqual(result.scope, scope);
  assert.equal(run.requests.length, 1);
  t.diagnostic('Controlled replay only: invented takeaway history remains a semantic failure, not rewritten or accepted as fact by this formatting test.');
});

for (const [raw, expected] of [
  ['（轻轻托腮）我在听。', '我在听。'],
  ['（托腮）可以一起看看这个蓝框（先不用重启）。', '可以一起看看这个蓝框（先不用重启）。'],
  ['（脸红）被你这么一说，有点不好意思了。', '被你这么一说，有点不好意思了。'],
  ['我在。 (微笑) 继续说吧。', '我在。  继续说吧。'],
  ['*歪头* 今天过得怎么样？', '今天过得怎么样？'],
  ['**轻轻点头**\n慢慢来。\n（眨了眨眼）', '慢慢来。'],
  ['（歪了歪头，眨了眨眼）你好。', '你好。'],
  ['晚安～（轻笑）明天见。', '晚安～明天见。'],
  ['晚安~ (轻笑) 明天见。', '晚安~  明天见。'],
  ['我在听，（点头）慢慢说。', '我在听，慢慢说。'],
  ['慢慢说, **微笑** 我在。', '慢慢说,  我在。'],
  ['别着急；（微微点头）一起想办法。', '别着急；一起想办法。'],
  ['先休息; *挥手* 明天见。', '先休息;  明天见。'],
] as const) test(`clear stage wrappers are removed: ${raw}`, async () => {
  const run = harness(raw), result = await run.provider.reply(input('你好'), signal());
  assert.equal(result.text, expected); assert.deepEqual(result.expression, expression);
});

for (const text of ['（托腮）', ' *微笑* （轻轻点头） ', '（歪头）\n（眨眼）', '（托腮）。', '*微笑* ……', '（轻笑）～', '～（轻笑）']) {
  test(`pure action does not return an empty spoken reply or request another model call: ${text}`, async () => {
    const run = harness(text);
    await assert.rejects(run.provider.reply(input(), signal()), /可朗读|empty spoken/);
    assert.equal(run.requests.length, 1);
  });
}

for (const text of [
  '可以明天再试（如果你有空）。', '（我只是有点担心）先休息一下吧。', '（笑容会让人放松）这也是一种解释。',
  '结果是（2 + 3）× 4 = 20，编号（2026）。', '函数 f(x) 返回 Math.sin(x)。',
  '原文是“（托腮）”，这是动作旁白。', '这里的「（微笑）」不应该被当作我的动作。',
  '字符串 "(微笑)" 长度是4。', "原句 '*歪头*' 是一个例子。", '可以写成 `（托腮）`，或 `*微笑*`。',
  '代码：\n```text\n（托腮）\n```\n以上是原样字符串。', '> （托腮）\n这是一行被引用的内容。',
  '````text\n```\n（托腮）\n```\n````', '~~~text\n（微笑）\n~~~', '``示例 `（托腮）`\n（微笑）``',
  '未闭合代码示例：\n```text\n（托腮）', '他说：“\n（托腮）\n你好。”',
  '（托腮）是常见的舞台说明。', '我说的是（托腮）。', '她（托腮）望着窗外，故事就这样开始了。',
  '公式 *x* 和 **重点** 都应保留。', '相关说明（张三，2026）见正文。',
  '**微笑** 有助于缓解紧张。', '（微笑）会让人放松，但不必强迫自己。',
  '（微笑）可以缓解紧张。',
  '我在听～（如果你愿意）慢慢说。', '先解释一下，（微笑）可以缓解紧张。',
  '动作示例：（轻笑）。', '我说的是，（轻笑）。', '比如，（轻笑）。',
  '（无法确定含义的描述）保留这句原文。', '正文没有旁白，\n空格与换行  原样保留。',
]) test(`legitimate speech is byte-for-byte preserved: ${text.slice(0, 24)}`, async () => {
  const run = harness(text); assert.equal((await run.provider.reply(input('解释一下'), signal())).text, text);
});

test('explicitly requested fiction and literal stage-direction reading retain the requested content', async () => {
  for (const request of ['请写一个以（托腮）开头的小故事。', '请逐字朗读：（托腮）我在听。', '解释（托腮）的写法。']) {
    const text = request.startsWith('请写') ? '（托腮）她望着窗外，想起故事里的朋友。' : '（托腮）我在听。';
    assert.equal((await harness(text).provider.reply(input(request), signal())).text, text);
  }
});

test('negative stage/fiction instructions do not bypass cleanup and quoted examples stay intact', async () => {
  for (const request of ['不要编故事，也不要写（托腮）。', '不要逐字朗读那些动作，请正常说话。']) {
    const text = '（托腮）我会认真听。引用示例：“（微笑）”。';
    assert.equal((await harness(text).provider.reply(input(request), signal())).text, '我会认真听。引用示例：“（微笑）”。');
  }
});

test('quoted region ends before a later actual stage aside', async () => {
  const text = '示例：\n```text\n（托腮）\n```\n（点头）解释到这里。';
  assert.equal((await harness(text).provider.reply(input('解释代码'), signal())).text,
    '示例：\n```text\n（托腮）\n```\n解释到这里。');
});

test('long legitimate explanations are not shortened to make speech easier', async () => {
  const text = '这里保留有意义的解释（包括补充说明），公式为f(x)=x+1。'.repeat(200);
  assert.equal((await harness(text).provider.reply(input('详细解释'), signal())).text, text);
});

test('shared output and grounding rules follow the actual saved persona without mutating it', async () => {
  const request = input('我没说过点三次外卖，你记错了。');
  const before = structuredClone(request), run = harness('是我说错了，我会按你现在说的来理解。');
  await run.provider.reply(request, signal());
  const system = run.requests[0]!.messages[0]!.content;
  assert.ok(system.startsWith(`${request.context.characterPrompt}\n${DIALOGUE_RESPONSE_RULES}\n`));
  assert.equal(system.split(DIALOGUE_RESPONSE_RULES).length, 2); assert.deepEqual(request, before);
  assert.equal(run.requests[0]!.model, 'qwen-plus-2025-12-01');
});

test('a cancelled late reply is rejected before spoken text can be returned', async () => {
  const controller = new AbortController(), run = harness('（托腮）我在听。', () => controller.abort());
  await assert.rejects(run.provider.reply(input(), controller.signal), { name: 'AbortError' });
  assert.equal(run.requests.length, 1);
});
