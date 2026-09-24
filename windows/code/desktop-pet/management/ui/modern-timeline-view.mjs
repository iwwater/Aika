import { el, button, badge, notice, time } from './dom.mjs';
import { ICONS, svgIcon } from './icons.mjs';

const PAGE_SIZE = 50;
const stateLabels = {
  invalidated: '已失效',
  deleted: '已删除',
  expired: '已过期',
  purged: '已清理',
};

function dateKey(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'unknown';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function dateLabel(value) {
  if (value === 'unknown') return '时间未知';
  const [year, month, day] = value.split('-').map(Number);
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' })
    .format(new Date(year, month - 1, day));
}

function turnKey(record) {
  const match = /^(.*):(user|assistant)$/.exec(record.id || '');
  return match ? match[1] : `record:${record.id}`;
}

function groupTurns(records) {
  const grouped = new Map();
  for (const record of records) {
    const key = turnKey(record);
    let turn = grouped.get(key);
    if (!turn) {
      turn = { key, user: null, assistant: null, other: [], latestAt: record.createdAt };
      grouped.set(key, turn);
    }
    if (record.createdAt && (!turn.latestAt || Date.parse(record.createdAt) > Date.parse(turn.latestAt))) turn.latestAt = record.createdAt;
    if (record.role === 'user' && !turn.user) turn.user = record;
    else if (record.role === 'assistant' && !turn.assistant) turn.assistant = record;
    else turn.other.push(record);
  }
  return [...grouped.values()].sort((a, b) => Date.parse(b.latestAt || 0) - Date.parse(a.latestAt || 0));
}

function localClock(value) {
  if (!value || !Number.isFinite(Date.parse(value))) return '时间未知';
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value));
}

function encodedQuery(values) {
  return new URLSearchParams(values).toString();
}

function ensureState(s) {
  s.timelineViewState ??= {
    activeTab: 'history',
    records: [],
    total: 0,
    traces: [],
    traceResult: null,
    traceError: '',
    query: '',
    searchDraft: '',
    roleFilter: 'all',
    dayFilter: 'all',
    loading: false,
    loadingMore: false,
    loaded: false,
    error: '',
    loadMoreError: '',
    scopeKey: '',
    requestId: 0,
    controller: null,
    activityItems: [],
    activityTotal: 0,
    activityNextCursor: null,
    activityDomains: ['canon', 'companion', 'work'],
    activityLoaded: false,
    activityLoading: false,
    activityLoadingMore: false,
    activityError: '',
    activityController: null,
    activityRequestId: 0,
  };
  s.timelineViewState.activityItems ??= [];
  s.timelineViewState.activityDomains ??= ['canon', 'companion', 'work'];
  s.timelineViewState.activityRequestId ??= 0;
  return s.timelineViewState;
}

const activityDomainLabels = { canon: 'Canon', companion: 'Companion', work: 'Work' };
const workStatusLabels = { prepared: '待确认', dispatched: '已派发', running: '执行中', succeeded: '已完成', failed: '失败', uncertain: '结果待核对', cancelled: '已取消' };

function isTimelineItem(item) {
  return !!item && typeof item.eventId === 'string' && !!item.eventId
    && ['canon', 'companion', 'work'].includes(item.domain)
    && typeof item.type === 'string' && typeof item.summary === 'string'
    && typeof item.occurredAt === 'string' && Number.isFinite(Date.parse(item.occurredAt))
    && !!item.sourceRef && typeof item.sourceRef.id === 'string'
    && Number.isSafeInteger(item.sourceRef.version) && item.sourceRef.version >= 1;
}

function activityCard(item) {
  const body = [];
  if (item.domain === 'companion' && item.companionDetails) {
    body.push(
      item.companionDetails.userText && el('section', { class: 'archive-message archive-message-user' },
        el('div', { class: 'archive-message-meta' }, el('span', { class: 'archive-message-author' }, '我')),
        el('p', { class: 'archive-message-text' }, item.companionDetails.userText)),
      item.companionDetails.assistantText && el('section', { class: 'archive-message archive-message-assistant' },
        el('div', { class: 'archive-message-meta' }, el('span', { class: 'archive-message-author' }, 'Aika')),
        el('p', { class: 'archive-message-text' }, item.companionDetails.assistantText)),
    );
  } else if (item.domain === 'companion' && item.companionActivityDetails) {
    const activity = item.companionActivityDetails;
    const action = activity.actionKind === 'voice_start' ? '开始语音对话'
      : activity.actionKind === 'text' ? '打开文字对话' : '查看待确认任务';
    const outcome = activity.status === 'dismissed' ? `邀请已忽略 · 原动作：${action}` : `邀请已接受 · ${action}`;
    body.push(el('p', { class: 'unified-activity-detail' }, outcome));
  } else if (item.domain === 'canon' && item.canonDetails) {
    item.canonDetails.scene && body.push(el('p', { class: 'unified-activity-detail' }, `场景 · ${item.canonDetails.scene}`));
    item.canonDetails.awareness && body.push(el('p', { class: 'unified-activity-detail' }, `角色认知 · ${item.canonDetails.awareness}`));
  } else if (item.domain === 'work' && item.workDetails) {
    body.push(el('p', { class: 'unified-activity-detail' }, `执行者 · ${item.workDetails.executorId} · ${workStatusLabels[item.workDetails.status] || item.workDetails.status}`));
    item.workDetails.instruction && body.push(el('p', { class: 'unified-activity-instruction' }, item.workDetails.instruction));
  }
  return el('article', { class: `unified-activity-card unified-activity-${item.domain}` },
    el('header', { class: 'unified-activity-meta' },
      badge(activityDomainLabels[item.domain], item.domain === 'companion' ? 'success' : 'muted'),
      el('span', {}, time(item.occurredAt)),
      el('span', { class: 'unified-activity-type' }, item.type)),
    el('h2', { class: 'unified-activity-summary' }, item.summary || '（无摘要）'),
    ...body,
    el('details', { class: 'archive-message-source' },
      el('summary', {}, '事件来源'),
      el('dl', {},
        el('dt', {}, '事件 ID'), el('dd', {}, item.eventId),
        el('dt', {}, '来源 ID'), el('dd', {}, item.sourceRef.id),
        el('dt', {}, '来源版本'), el('dd', {}, String(item.sourceRef.version)),
      )),
  );
}

export function createModernTimelineView(actions) {
  const { s, client } = actions;
  const state = ensureState(s);
  const scopeKey = `${s.character || 'companion'}/${s.snapshot?.runtime?.instanceId || 'unknown'}`;

  if (state.scopeKey !== scopeKey) {
    state.controller?.abort();
    state.activityController?.abort();
    Object.assign(state, {
      records: [], total: 0, traces: [], traceResult: null, traceError: '',
      dayFilter: 'all', loading: false, loadingMore: false, loaded: false,
      error: '', loadMoreError: '', scopeKey, controller: null,
      activityItems: [], activityTotal: 0, activityNextCursor: null, activityLoaded: false,
      activityLoading: false, activityLoadingMore: false, activityError: '', activityController: null,
      activityRequestId: state.activityRequestId + 1,
    });
  }

  const load = async (reset = true) => {
    if (state.scopeKey !== scopeKey) return;
    if (!client?.token) {
      state.error = '请从桌宠的本机管理入口打开会话历史。';
      actions.render();
      return;
    }
    if (s.connection !== 'online') {
      state.error = '本机管理服务当前未连接。恢复连接后可以重新读取历史。';
      actions.render();
      return;
    }

    state.controller?.abort();
    const controller = new AbortController();
    const requestId = ++state.requestId;
    state.controller = controller;
    const offset = reset ? 0 : state.records.length;
    if (reset) {
      state.records = [];
      state.total = 0;
      state.traces = [];
      state.traceResult = null;
      state.traceError = '';
      state.dayFilter = 'all';
      state.loadMoreError = '';
    } else state.loadMoreError = '';
    state.loading = reset;
    state.loadingMore = !reset;
    state.error = '';
    actions.render();

    const query = encodedQuery({
      characterId: s.character || 'companion',
      kind: 'transcript',
      state: 'all',
      query: state.query,
      offset: String(offset),
      limit: String(PAGE_SIZE),
    });
    const recordRequest = client.request(`/api/records?${query}`, { signal: controller.signal });
    const traceRequest = reset
      ? client.request(`/api/traces?${encodedQuery({ characterId: s.character || 'companion', limit: '100' })}`, { signal: controller.signal })
      : null;

    const [recordResult, traceResult] = await Promise.all([
      recordRequest.then(value => ({ value }), error => ({ error })),
      traceRequest ? traceRequest.then(value => ({ value }), error => ({ error })) : Promise.resolve(null),
    ]);
    if (requestId !== state.requestId || controller.signal.aborted || state.scopeKey !== scopeKey) return;

    if (recordResult.error) {
      state.loaded = true;
      if (recordResult.error.name !== 'AbortError') {
        const message = recordResult.error.message || '读取会话记录失败，请重试。';
        if (reset) state.error = message;
        else state.loadMoreError = message;
      }
    } else {
      const page = recordResult.value;
      if (page.characterId !== (s.character || 'companion')) {
        state.loaded = true;
        state.error = '服务返回的角色与当前页面不一致，已隐藏这批记录。';
      } else {
        const records = Array.isArray(page.records) ? page.records : [];
        state.records = reset ? records : [...state.records, ...records];
        state.total = Number.isSafeInteger(page.total) ? page.total : state.records.length;
        state.loaded = true;
      }
    }

    if (traceResult?.error) {
      if (traceResult.error.name !== 'AbortError') state.traceError = traceResult.error.message || 'Trace 暂不可用。';
    } else if (traceResult?.value) {
      state.traceResult = traceResult.value;
      state.traces = Array.isArray(traceResult.value.traces) ? traceResult.value.traces : [];
    }

    state.loading = false;
    state.loadingMore = false;
    actions.render();
  };

  const loadActivity = async (reset = true) => {
    if (state.scopeKey !== scopeKey || (!reset && (state.activityLoading || state.activityLoadingMore || !state.activityNextCursor))) return;
    if (!client?.token || s.connection !== 'online') {
      state.activityError = !client?.token
        ? '请从桌宠的本机管理入口打开统一时间线。'
        : '本机管理服务当前未连接。恢复连接后可以刷新活动。';
      state.activityLoaded = true;
      actions.render();
      return;
    }

    state.activityController?.abort();
    const controller = new AbortController();
    const requestId = ++state.activityRequestId;
    state.activityController = controller;
    const domains = [...state.activityDomains];
    const cursor = reset ? null : state.activityNextCursor;
    if (reset) {
      state.activityItems = [];
      state.activityTotal = 0;
      state.activityNextCursor = null;
    }
    state.activityLoading = reset;
    state.activityLoadingMore = !reset;
    state.activityError = '';
    actions.render();

    const params = new URLSearchParams({ limit: String(PAGE_SIZE), domains: domains.join(',') });
    if (cursor) params.set('cursor', cursor);
    try {
      const result = await client.request(`/api/unified-timeline?${params}`, { signal: controller.signal });
      if (requestId !== state.activityRequestId || controller.signal.aborted || state.scopeKey !== scopeKey) return;
      if (!result || !Array.isArray(result.items) || result.items.length > PAGE_SIZE
        || !Number.isSafeInteger(result.totalMatching) || result.totalMatching < 0
        || !(result.nextCursor === null || typeof result.nextCursor === 'string')
        || !result.items.every(isTimelineItem)) throw new Error('统一时间线返回的数据不完整，已隐藏这批活动。');
      if (cursor && result.nextCursor === cursor) throw new Error('时间线分页游标没有前进，请刷新后重试。');
      const existing = new Set(reset ? [] : state.activityItems.map(item => item.eventId));
      state.activityItems = reset ? [...result.items] : [...state.activityItems, ...result.items.filter(item => !existing.has(item.eventId))];
      state.activityTotal = result.totalMatching;
      state.activityNextCursor = result.nextCursor;
      state.activityLoaded = true;
    } catch (error) {
      if (requestId === state.activityRequestId && !controller.signal.aborted && state.scopeKey === scopeKey) {
        state.activityError = error instanceof Error ? error.message : '统一时间线读取失败，请重试。';
        state.activityLoaded = true;
      }
    } finally {
      if (requestId === state.activityRequestId && state.scopeKey === scopeKey) {
        state.activityLoading = false;
        state.activityLoadingMore = false;
        actions.render();
      }
    }
  };

  if (!state.loaded && !state.loading && s.connection === 'online' && client?.token) void load(true);
  if (state.activeTab === 'activity' && !state.activityLoaded && !state.activityLoading && s.connection === 'online' && client?.token) void loadActivity(true);

  const page = el('section', { class: 'conversation-archive', 'aria-labelledby': 'archive-title' });
  const pageHeader = el(
    'header', { class: 'archive-header' },
    el('div', { class: 'archive-title-block' },
      el('p', { class: 'archive-eyebrow' }, 'HISTORY · ', s.character || 'companion'),
      el('h1', { id: 'archive-title' }, '会话历史'),
      el('p', { class: 'archive-subtitle' }, '按轮次查看保存在本机的对话原文，并从真实 Trace 继续追踪。'),
    ),
    el('div', { class: 'archive-header-actions' },
      badge('本机历史', 'muted'),
      button([el('span', { class: 'archive-icon' }, svgIcon(ICONS.refresh)), '刷新'], () => { void load(true); }, {
        class: 'archive-refresh', disabled: state.loading || state.loadingMore || s.connection !== 'online', 'aria-label': '刷新会话历史',
      }),
    ),
  );
  page.append(pageHeader);

  const tabs = el('nav', { class: 'archive-tabs', 'aria-label': '时间线内容' },
    button('会话历史', () => { state.activeTab = 'history'; actions.render(); }, {
      class: state.activeTab === 'history' ? 'archive-tab is-active' : 'archive-tab',
      'aria-pressed': state.activeTab === 'history',
    }),
    button('记忆动态', () => {
      state.activeTab = 'dynamics';
      actions.render();
      actions.memoryDynamics?.load('dynamics');
    }, {
      class: state.activeTab === 'dynamics' ? 'archive-tab is-active' : 'archive-tab',
      'aria-pressed': state.activeTab === 'dynamics',
    }),
    button('统一时间线', () => { state.activeTab = 'activity'; actions.render(); }, {
      class: state.activeTab === 'activity' ? 'archive-tab is-active' : 'archive-tab',
      'aria-pressed': state.activeTab === 'activity',
    }),
  );
  page.append(tabs);

  if (state.activeTab === 'dynamics') {
    page.append(el('div', { class: 'archive-preserved-view' }, actions.memoryDynamics?.view('dynamics') || notice('记忆动态视图暂不可用。', 'warning')));
    return page;
  }

  if (state.activeTab === 'activity') {
    const domainFilters = el('div', { class: 'archive-role-filters', role: 'group', 'aria-label': '按事件领域筛选' },
      Object.entries(activityDomainLabels).map(([domain, label]) => button(label, () => {
        const next = state.activityDomains.includes(domain)
          ? state.activityDomains.filter(value => value !== domain)
          : [...state.activityDomains, domain];
        if (!next.length) return;
        state.activityDomains = next;
        void loadActivity(true);
      }, { class: state.activityDomains.includes(domain) ? 'archive-filter is-active' : 'archive-filter', 'aria-pressed': state.activityDomains.includes(domain) })),
    );
    const toolbar = el('div', { class: 'archive-toolbar' }, domainFilters,
      el('span', { class: 'archive-count', 'aria-live': 'polite' }, state.activityLoading ? '读取中…' : `${state.activityTotal} 项活动`),
      button([el('span', { class: 'archive-icon' }, svgIcon(ICONS.refresh)), '刷新'], () => { void loadActivity(true); }, {
        class: 'archive-refresh', disabled: state.activityLoading || state.activityLoadingMore || s.connection !== 'online',
      }),
    );
    const stream = el('div', { class: 'archive-stream unified-activity-stream', 'aria-live': 'polite' });
    if (state.activityError && !state.activityItems.length) {
      stream.append(el('div', { class: 'archive-state-card archive-error', role: 'alert' },
        el('strong', {}, '无法读取统一时间线'), el('p', {}, state.activityError),
        button('重试', () => { void loadActivity(true); }, { class: 'archive-retry', disabled: s.connection !== 'online' }),
      ));
    } else if (state.activityLoading && !state.activityItems.length) {
      stream.append(el('div', { class: 'archive-state-card' }, el('span', { class: 'archive-loading-mark', 'aria-hidden': 'true' }), el('p', {}, '正在读取跨领域活动…')));
    } else if (!state.activityItems.length) {
      stream.append(el('div', { class: 'archive-state-card archive-empty' },
        el('h2', {}, '还没有统一活动'), el('p', {}, 'Canon、Companion 和 Work 的可追溯事件会显示在这里。')));
    } else {
      state.activityItems.forEach(item => stream.append(activityCard(item)));
      if (state.activityError) stream.append(el('div', { class: 'archive-load-error', role: 'alert' }, state.activityError,
        button('重试加载', () => { void loadActivity(false); }, { class: 'archive-retry' })));
    }
    page.append(toolbar, stream);
    if (state.activityNextCursor) page.append(el('div', { class: 'archive-pagination' },
      el('span', {}, `已读取 ${state.activityItems.length} / ${state.activityTotal} 项`),
      button(state.activityLoadingMore ? '正在读取…' : '加载更晚活动', () => { void loadActivity(false); }, {
        class: 'archive-load-more', disabled: state.activityLoadingMore || state.activityLoading || s.connection !== 'online',
      }),
    ));
    return page;
  }

  const turns = groupTurns(state.records);
  const dayCounts = new Map();
  for (const turn of turns) {
    const key = dateKey(turn.latestAt);
    dayCounts.set(key, (dayCounts.get(key) || 0) + 1);
  }
  const dates = [...dayCounts.keys()].sort((a, b) => b.localeCompare(a));
  const filteredTurns = turns.filter(turn => {
    if (state.dayFilter !== 'all' && dateKey(turn.latestAt) !== state.dayFilter) return false;
    if (state.roleFilter === 'user' && !turn.user) return false;
    if (state.roleFilter === 'assistant' && !turn.assistant) return false;
    return true;
  });
  const groupedByDay = new Map();
  for (const turn of filteredTurns) {
    const key = dateKey(turn.latestAt);
    if (!groupedByDay.has(key)) groupedByDay.set(key, []);
    groupedByDay.get(key).push(turn);
  }

  const search = el('label', { class: 'archive-search' },
    svgIcon(ICONS.search),
    el('input', {
      type: 'search', value: state.searchDraft, maxLength: 1000,
      placeholder: '搜索对话内容', 'aria-label': '搜索对话内容',
      oninput: event => {
        state.searchDraft = event.target.value;
        clearTimeout(state.searchTimer);
        state.searchTimer = setTimeout(() => {
          state.query = state.searchDraft.trim();
          void load(true);
        }, 320);
      },
      onkeydown: event => {
        if (event.key === 'Enter') {
          clearTimeout(state.searchTimer);
          state.query = state.searchDraft.trim();
          void load(true);
        }
      },
    }),
  );

  const roleFilters = el('div', { class: 'archive-role-filters', role: 'group', 'aria-label': '按发言角色筛选' },
    [['all', '全部'], ['user', '我'], ['assistant', 'Aika']].map(([key, label]) => button(label, () => {
      state.roleFilter = key;
      actions.render();
    }, { class: state.roleFilter === key ? 'archive-filter is-active' : 'archive-filter', 'aria-pressed': state.roleFilter === key })),
  );

  const toolbar = el('div', { class: 'archive-toolbar' }, search, roleFilters,
    el('span', { class: 'archive-count', 'aria-live': 'polite' }, state.loading ? '读取中…' : `${state.total} 条记录`),
  );

  const dateNav = el('aside', { class: 'archive-date-panel', 'aria-label': '按日期筛选' },
    el('div', { class: 'archive-panel-heading' }, el('span', {}, '日期'), el('span', {}, state.loaded ? `${state.records.length} / ${state.total}` : '—')),
    button([el('span', {}, '全部日期'), el('span', { class: 'archive-date-count' }, state.records.length)], () => {
      state.dayFilter = 'all';
      actions.render();
    }, { class: state.dayFilter === 'all' ? 'archive-date-option is-active' : 'archive-date-option', 'aria-pressed': state.dayFilter === 'all' }),
    dates.length ? dates.map(date => button([el('span', {}, dateLabel(date)), el('span', { class: 'archive-date-count' }, dayCounts.get(date))], () => {
      state.dayFilter = date;
      actions.render();
    }, { class: state.dayFilter === date ? 'archive-date-option is-active' : 'archive-date-option', 'aria-pressed': state.dayFilter === date }))
      : el('p', { class: 'archive-sidebar-empty' }, state.loading ? '正在读取日期…' : '还没有可浏览的记录。'),
    el('p', { class: 'archive-retention-note' }, '已失效或清理的正文会在这里隐藏。'),
  );

  const stream = el('div', { class: 'archive-stream', 'aria-live': 'polite' });
  if (state.error && !state.records.length) {
    stream.append(el('div', { class: 'archive-state-card archive-error', role: 'alert' },
      el('strong', {}, '无法读取会话历史'),
      el('p', {}, state.error),
      button('重试', () => { void load(true); }, { class: 'archive-retry', disabled: s.connection !== 'online' }),
    ));
  } else if (s.connection !== 'online' && !state.loaded) {
    stream.append(el('div', { class: 'archive-state-card archive-empty' },
      el('h2', {}, '等待连接本机服务'),
      el('p', {}, '连接恢复后，页面会读取当前角色的会话历史。'),
    ));
  } else if (state.loading && !state.records.length) {
    stream.append(el('div', { class: 'archive-state-card' }, el('span', { class: 'archive-loading-mark', 'aria-hidden': 'true' }), el('p', {}, '正在读取本机保存的对话…')));
  } else if (!state.loading && !turns.length) {
    stream.append(el('div', { class: 'archive-state-card archive-empty' },
      el('span', { class: 'archive-empty-icon', 'aria-hidden': 'true' }, svgIcon(ICONS.chatBubble)),
      el('h2', {}, state.query ? '没有找到匹配的对话' : '这里还没有会话记录'),
      el('p', {}, state.query ? '试试更短的关键词。' : '完成的对话会从桌宠会话入口写入本机历史。'),
      state.query && button('清除搜索', () => { state.searchDraft = ''; state.query = ''; void load(true); }, { class: 'archive-retry' }),
    ));
  } else if (!filteredTurns.length) {
    stream.append(el('div', { class: 'archive-state-card archive-empty' },
      el('h2', {}, '这个筛选条件下没有记录'),
      el('p', {}, '选择其他日期或发言角色查看。'),
    ));
  } else {
    for (const [day, dayTurns] of groupedByDay) {
      const daySection = el('section', { class: 'archive-day-section', 'aria-label': dateLabel(day) },
        el('div', { class: 'archive-day-heading' }, el('h2', {}, dateLabel(day)), el('span', {}, `${dayTurns.length} 个回合`)),
      );
      for (const turn of dayTurns) {
        const trace = state.traces.find(item => item.turnId === turn.key);
        const turnCard = el('article', { class: 'archive-turn' },
          el('header', { class: 'archive-turn-meta' },
            el('span', { class: 'archive-turn-time' }, localClock(turn.latestAt)),
            el('span', { class: 'archive-turn-id' }, `回合 ${turn.key.slice(0, 10)}`),
            trace && button([el('span', { class: 'archive-icon' }, svgIcon(ICONS.connect)), '查看 Trace'], () => {
              s.traceResult = state.traceResult;
              s.eventTab = 'traces';
              s.traceFocusTurnId = trace.turnId;
              actions.selectPage('events');
            }, { class: 'archive-trace-link' }),
          ),
          turn.user && messageBlock(turn.user, '我', 'user'),
          turn.assistant && messageBlock(turn.assistant, 'Aika', 'assistant'),
          ...turn.other.map(record => messageBlock(record, '记录', 'other')),
        );
        daySection.append(turnCard);
      }
      stream.append(daySection);
    }
    if (state.loadMoreError) {
      stream.append(el('div', { class: 'archive-load-error', role: 'alert' },
        el('span', {}, state.loadMoreError),
        button('重试加载', () => { state.loadMoreError = ''; void load(false); }, { class: 'archive-retry' }),
      ));
    }
    state.traceError && stream.append(el('p', { class: 'archive-trace-note', role: 'status' }, `Trace 暂不可用：${state.traceError}`));
  }

  const layout = el('div', { class: 'archive-layout' }, dateNav, stream);
  page.append(toolbar, layout);

  if (state.records.length < state.total && !state.error) {
    page.append(el('div', { class: 'archive-pagination' },
      el('span', {}, `已读取 ${state.records.length} / ${state.total} 条`),
      button(state.loadingMore ? '正在读取…' : '加载更早记录', () => { void load(false); }, {
        class: 'archive-load-more', disabled: state.loadingMore || state.loading || s.connection !== 'online',
      }),
    ));
  }

  return page;
}

function messageBlock(record, label, role) {
  const active = record.state === 'active';
  const text = active ? (record.text || '（此条消息没有正文）') : `正文已隐藏 · ${stateLabels[record.state] || '状态不可用'}`;
  const author = el('span', { class: 'archive-message-author' }, label);
  const messageMeta = el('div', { class: 'archive-message-meta' }, author,
    el('span', {}, `${time(record.createdAt)} · v${record.version}`),
    !active && badge(stateLabels[record.state] || '已隐藏', 'muted'),
  );
  return el('section', { class: `archive-message archive-message-${role} ${active ? '' : 'is-redacted'}`, 'aria-label': `${label}发言` },
    messageMeta,
    el('p', { class: 'archive-message-text' }, text),
    el('details', { class: 'archive-message-source' },
      el('summary', {}, '记录来源与状态'),
      el('dl', {},
        el('dt', {}, '记录 ID'), el('dd', {}, record.id),
        el('dt', {}, '版本'), el('dd', {}, String(record.version)),
        el('dt', {}, '保存状态'), el('dd', {}, stateLabels[record.state] || record.state || '未知'),
      ),
    ),
  );
}
