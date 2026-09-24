import test from 'node:test';
import assert from 'node:assert/strict';

class FakeNode {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.attributes = new Map();
    this.listeners = new Map();
    this.dataset = {};
    this.className = '';
    this.value = '';
    this.disabled = false;
    this.text = '';
  }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
  set innerHTML(value) { this.html = String(value); }
  addEventListener(type, listener) {
    if (typeof listener !== 'function') throw new TypeError(`Listener for ${type} must be callable`);
    this.listeners.set(type, listener);
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = String(value);
  }
  removeAttribute(name) { this.attributes.delete(name); }
  append(...nodes) { for (const node of nodes) { node.parentNode = this; this.children.push(node); } }
  click() { this.listeners.get('click')?.({ target: this, currentTarget: this, key: undefined }); }
}

globalThis.Node = FakeNode;
globalThis.document = {
  createElement: tag => new FakeNode(tag),
  createTextNode: text => { const node = new FakeNode('#text'); node.textContent = text; return node; },
  addEventListener() {},
};
globalThis.window = { addEventListener() {} };

const { createModernTimelineView } = await import('../../management/ui/modern-timeline-view.mjs');

function find(node, predicate) {
  if (predicate(node)) return node;
  for (const child of node.children) {
    const result = find(child, predicate);
    if (result) return result;
  }
  return null;
}

function fixture(request) {
  const s = { character: 'companion', snapshot: { runtime: { instanceId: 'instance-1' } }, connection: 'online' };
  const selectedPages = [];
  const actions = {
    s,
    client: { token: 'loopback-token', request },
    render() {},
    selectPage(page) { selectedPages.push(page); },
  };
  return { s, actions, selectedPages };
}

test('会话历史读取真实 records/Trace，隐藏失效正文并跳转到对应 Trace', async () => {
  const requests = [];
  const api = fixture(async path => {
    requests.push(path);
    if (path.startsWith('/api/records?')) return {
      characterId: 'companion',
      total: 3,
      records: [
        { id: 'turn-001:user', role: 'user', state: 'active', text: '这是一条真实问题', createdAt: '2026-09-24T01:02:00.000Z', version: 1 },
        { id: 'turn-001:assistant', role: 'assistant', state: 'active', text: '这是 Aika 的真实回复', createdAt: '2026-09-24T01:02:03.000Z', version: 1 },
        { id: 'turn-002:user', role: 'user', state: 'invalidated', text: '不可见的失效正文', createdAt: '2026-09-23T09:00:00.000Z', version: 2 },
      ],
    };
    return { traces: [{ traceId: 'trace-1', turnId: 'turn-001' }], summary: { totalCount: 1 } };
  });

  const initial = createModernTimelineView(api.actions);
  await new Promise(resolve => setImmediate(resolve));
  const page = createModernTimelineView(api.actions);
  const content = page.textContent;
  assert.ok(content.includes('这是一条真实问题'));
  assert.ok(content.includes('这是 Aika 的真实回复'));
  assert.ok(content.includes('正文已隐藏 · 已失效'));
  assert.ok(!content.includes('不可见的失效正文'));
  assert.ok(requests.some(path => path.includes('kind=transcript') && path.includes('state=all')));
  assert.ok(requests.some(path => path.startsWith('/api/traces?')));
  assert.equal(api.s.timelineViewState.traces.length, 1, 'Trace data must be present before testing its link');

  const traceButton = find(page, node => node.tagName === 'BUTTON' && node.textContent.includes('查看 Trace'));
  assert.ok(traceButton, 'The matching turn exposes its actual Trace link');
  traceButton.click();
  assert.deepEqual(api.selectedPages, ['events']);
  assert.equal(api.s.traceFocusTurnId, 'turn-001');
  void initial;
});

test('空/错误历史加载只显示错误态，不会在重新渲染时自动重复请求', async () => {
  let count = 0;
  const api = fixture(async path => {
    count++;
    if (path.startsWith('/api/records?')) throw new Error('暂时不可用');
    return { traces: [] };
  });

  createModernTimelineView(api.actions);
  await new Promise(resolve => setImmediate(resolve));
  const page = createModernTimelineView(api.actions);
  assert.ok(page.textContent.includes('无法读取会话历史'));
  assert.equal(count, 2, 'One records request and one trace request are issued for the initial load');
  createModernTimelineView(api.actions);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(count, 2, 'Re-rendering an error state does not create a retry loop');
});

function timelineItem(domain, eventId, summary, extra = {}) {
  return { eventId, domain, type: `${domain}.test.event`, occurredAt: '2026-09-24T08:00:00.000Z', summary,
    sourceRef: { id: `source-${eventId}`, version: 1 }, ...extra };
}

test('统一时间线通过正式 API 读取三个领域，并允许组合筛选', async () => {
  const unifiedQueries = [];
  const api = fixture(async path => {
    if (path.startsWith('/api/records?')) return { characterId: 'companion', total: 0, records: [] };
    if (path.startsWith('/api/traces?')) return { traces: [], summary: { totalCount: 0 } };
    if (!path.startsWith('/api/unified-timeline?')) throw new Error(`unexpected request: ${path}`);
    const params = new URL('http://localhost' + path).searchParams;
    unifiedQueries.push(params);
    const domains = params.get('domains').split(',');
    const events = [
      timelineItem('canon', 'canon-1', '角色设定事件', { canonDetails: { scene: '第一章', awareness: '角色已知' } }),
      timelineItem('companion', 'chat-1', '对话保存事件', { companionDetails: { userText: '用户原话', assistantText: '助手回复', sourceIds: ['history:chat-1'] } }),
      timelineItem('companion', 'invite-dismissed-1', '暂不接受这条主动陪伴邀请', { companionActivityDetails: { invitationId: 'invite-1', actionKind: 'voice_start', status: 'dismissed' } }),
      timelineItem('work', 'work-1', '工作任务完成', { workDetails: { executorId: 'fixture', status: 'succeeded', targetTitle: '任务', instruction: '已确认的任务说明' } }),
    ].filter(item => domains.includes(item.domain));
    return { items: events, totalMatching: events.length, nextCursor: null };
  });

  createModernTimelineView(api.actions);
  await new Promise(resolve => setImmediate(resolve));
  let page = createModernTimelineView(api.actions);
  find(page, node => node.tagName === 'BUTTON' && node.textContent === '统一时间线').click();
  createModernTimelineView(api.actions);
  await new Promise(resolve => setImmediate(resolve));
  page = createModernTimelineView(api.actions);

  assert.ok(unifiedQueries[0], 'the unified timeline endpoint is requested after opening its tab');
  assert.deepEqual(unifiedQueries[0].get('domains').split(','), ['canon', 'companion', 'work']);
  assert.ok(page.textContent.includes('角色设定事件'));
  assert.ok(page.textContent.includes('用户原话'));
  assert.ok(page.textContent.includes('邀请已忽略 · 原动作：开始语音对话'));
  assert.ok(page.textContent.includes('已确认的任务说明'));
  assert.ok(page.textContent.includes('事件来源'));

  const domainGroup = find(page, node => node.attributes.get('aria-label') === '按事件领域筛选');
  find(domainGroup, node => node.tagName === 'BUTTON' && node.textContent === 'Work').click();
  await new Promise(resolve => setImmediate(resolve));
  page = createModernTimelineView(api.actions);
  assert.deepEqual(unifiedQueries[1].get('domains').split(','), ['canon', 'companion']);
  assert.ok(page.textContent.includes('角色设定事件'));
  assert.ok(!page.textContent.includes('工作任务完成'));
});

test('统一时间线使用游标加载后续页', async () => {
  const requests = [];
  const api = fixture(async path => {
    if (path.startsWith('/api/records?')) return { characterId: 'companion', total: 0, records: [] };
    if (path.startsWith('/api/traces?')) return { traces: [], summary: { totalCount: 0 } };
    requests.push(path);
    const params = new URL('http://localhost' + path).searchParams;
    if (!params.has('cursor')) return { items: [timelineItem('companion', 'event-1', '第一页活动')], totalMatching: 2, nextCursor: 'event-1' };
    assert.equal(params.get('cursor'), 'event-1');
    return { items: [timelineItem('work', 'event-2', '第二页活动')], totalMatching: 2, nextCursor: null };
  });

  createModernTimelineView(api.actions);
  await new Promise(resolve => setImmediate(resolve));
  let page = createModernTimelineView(api.actions);
  find(page, node => node.tagName === 'BUTTON' && node.textContent === '统一时间线').click();
  createModernTimelineView(api.actions);
  await new Promise(resolve => setImmediate(resolve));
  page = createModernTimelineView(api.actions);
  const more = find(page, node => node.tagName === 'BUTTON' && node.textContent.includes('加载更晚活动'));
  assert.ok(more);
  more.click();
  await new Promise(resolve => setImmediate(resolve));
  page = createModernTimelineView(api.actions);
  assert.equal(requests.length, 2);
  assert.ok(page.textContent.includes('第一页活动'));
  assert.ok(page.textContent.includes('第二页活动'));
  assert.ok(!page.textContent.includes('加载更晚活动'));
});

test('统一时间线失败显示可重试错误，不会在重渲染时重复请求', async () => {
  let unifiedRequests = 0;
  const api = fixture(async path => {
    if (path.startsWith('/api/records?')) return { characterId: 'companion', total: 0, records: [] };
    if (path.startsWith('/api/traces?')) return { traces: [], summary: { totalCount: 0 } };
    unifiedRequests++;
    throw new Error('timeline unavailable');
  });

  createModernTimelineView(api.actions);
  await new Promise(resolve => setImmediate(resolve));
  let page = createModernTimelineView(api.actions);
  find(page, node => node.tagName === 'BUTTON' && node.textContent === '统一时间线').click();
  createModernTimelineView(api.actions);
  await new Promise(resolve => setImmediate(resolve));
  page = createModernTimelineView(api.actions);
  assert.ok(page.textContent.includes('无法读取统一时间线'));
  assert.ok(page.textContent.includes('timeline unavailable'));
  createModernTimelineView(api.actions);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(unifiedRequests, 1, 'rerender does not create an automatic retry loop');

  page = createModernTimelineView(api.actions);
  find(page, node => node.tagName === 'BUTTON' && node.textContent === '重试').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(unifiedRequests, 2, 'a deliberate retry issues one new request');
});
