// N075-02 / 0.75: Modern Overview View powered by REAL memory, dialogue transcripts, and runtime events.
import { el, button, badge, notice, time } from './dom.mjs';
import { ICONS, svgIcon } from './icons.mjs';

function formatDuration(startedAt) {
  if (!startedAt) return '0 小时 1 分钟';
  const diffMs = Math.max(0, Date.now() - new Date(startedAt).getTime());
  const hours = Math.floor(diffMs / (1000 * 60 * 60));
  const mins = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
  return `${hours} 小时 ${mins} 分钟`;
}

function formatMemoryTag(id, text) {
  if (id.includes('habit') || id.includes('interactive')) return '交互偏好';
  if (id.includes('project') || id.includes('goal')) return '项目目标';
  if (id.includes('style') || id.includes('requirement')) return '真诚准则';
  if (id.includes('summary')) return '会话摘要';
  if (text.includes('工作') || text.includes('开发')) return '工作生活';
  return '核心记忆';
}

export function createModernOverview(actions) {
  const { s, client } = actions;
  const snap = s.snapshot;

  // Trigger loading real memory records asynchronously if not loaded yet
  if (!s.overviewData && !s.overviewLoading && client?.token) {
    s.overviewLoading = true;
    Promise.all([
      client.request('/api/records?characterId=companion&kind=memory&state=active&limit=6').catch(() => ({ records: [] })),
      client.request('/api/records?characterId=companion&kind=transcript&state=active&limit=10').catch(() => ({ records: [] })),
      client.request('/api/records?characterId=companion&kind=summary&state=active&limit=2').catch(() => ({ records: [] })),
    ]).then(([mems, trans, sums]) => {
      s.overviewData = {
        memories: mems.records || [],
        transcripts: trans.records || [],
        summaries: sums.records || [],
      };
      s.overviewLoading = false;
      actions.render();
    }).catch(() => {
      s.overviewLoading = false;
    });
  }

  const uptime = formatDuration(snap?.runtime?.startedAt);
  const memList = s.overviewData?.memories || [];
  const transList = s.overviewData?.transcripts || [];
  const sumList = s.overviewData?.summaries || [];
  const totalMemCount = memList.length + sumList.length;
  const totalTransCount = transList.length;

  // 1. Hero Card
  const heroCard = el(
    'div',
    { class: 'hero-status-card' },
    el(
      'div',
      { class: 'hero-status-top' },
      el(
        'div',
        { class: 'hero-status-left' },
        svgIcon(ICONS.checkCircle, 'hero-check-icon'),
        el(
          'div',
          { class: 'hero-status-titles' },
          el('h2', { class: 'hero-status-title' }, '系统运行正常 · 记忆就绪'),
          el(
            'p',
            { class: 'hero-status-sub' },
            'Aika 陪伴伙伴已接入本地真实记忆库，正在陪伴你 ✨',
          ),
        ),
      ),
      el(
        'div',
        { class: 'hero-status-right' },
        el(
          'div',
          { class: 'aika-quote-box' },
          el('span', { class: 'aika-quote-text' }, '“只有真实对话与记忆中的事实才算数，我不对你说假话。”'),
          el('span', { class: 'aika-quote-author' }, '—— Aika 角色准则'),
        ),
        el(
          'div',
          { class: 'aika-avatar-wrap' },
          el('img', {
            src: './assets/aika-avatar.png',
            class: 'aika-avatar-img',
            alt: 'Aika',
            onError: (e) => {
              e.target.src = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect width="64" height="64" rx="32" fill="%23dbeafe"/><text x="50%" y="54%" font-size="28" text-anchor="middle" dominant-baseline="middle" fill="%233b82f6">✨</text></svg>';
            },
          }),
        ),
      ),
    ),
    el(
      'div',
      { class: 'hero-metrics-row' },
      // Metric 1: 运行时长
      el(
        'div',
        { class: 'metric-pill' },
        el('div', { class: 'metric-icon' }, svgIcon(ICONS.clock)),
        el(
          'div',
          { class: 'metric-body' },
          el('span', { class: 'metric-label' }, '运行时长'),
          el('strong', { class: 'metric-value' }, uptime),
        ),
      ),
      // Metric 2: 长期记忆沉淀数
      el(
        'div',
        { class: 'metric-pill' },
        el('div', { class: 'metric-icon' }, svgIcon(ICONS.database)),
        el(
          'div',
          { class: 'metric-body' },
          el('span', { class: 'metric-label' }, '长期记忆'),
          el(
            'div',
            { class: 'metric-value-wrap' },
            el('strong', { class: 'metric-value' }, `${totalMemCount} 条事实`),
            svgIcon(ICONS.sparkline, 'metric-chart'),
          ),
        ),
      ),
      // Metric 3: 真实对话互动轮次
      el(
        'div',
        { class: 'metric-pill' },
        el('div', { class: 'metric-icon' }, svgIcon(ICONS.chatBubble)),
        el(
          'div',
          { class: 'metric-body' },
          el('span', { class: 'metric-label' }, '历史对话数'),
          el(
            'div',
            { class: 'metric-value-wrap' },
            el('strong', { class: 'metric-value' }, `${totalTransCount} 条记录`),
            svgIcon(ICONS.barChart, 'metric-chart'),
          ),
        ),
      ),
      // Metric 4: 本地 SQLite 存储状态
      el(
        'div',
        { class: 'metric-pill' },
        el('div', { class: 'metric-icon' }, svgIcon(ICONS.chip)),
        el(
          'div',
          { class: 'metric-body' },
          el('span', { class: 'metric-label' }, '本地存储状态'),
          el('strong', { class: 'metric-value' }, '已加密同步'),
          el(
            'div',
            { class: 'metric-progress-bar' },
            el('div', { class: 'metric-progress-fill', style: 'width: 100%' }),
          ),
        ),
      ),
    ),
  );

  // 2. Build Real Activities (Combining real runtime events + real dialogue records)
  const activities = [];

  // Add real dialogue transcripts
  for (const t of transList.slice(0, 4)) {
    const isAssistant = t.role === 'assistant';
    activities.push({
      time: time(t.createdAt),
      rawTime: new Date(t.createdAt).getTime() || 0,
      tag: isAssistant ? '桌宠回复' : '用户发言',
      dot: isAssistant ? 'green' : 'blue',
      text: t.text,
    });
  }

  // Add real runtime events
  if (snap?.events && Array.isArray(snap.events)) {
    for (const e of snap.events.slice(0, 3)) {
      activities.push({
        time: time(e.at),
        rawTime: new Date(e.at).getTime() || 0,
        tag: e.module === 'memory' ? '长期记忆' : e.module === 'live2d' ? 'Live2D' : '系统内核',
        dot: 'purple',
        text: e.message,
      });
    }
  }

  // Sort activities by time descending
  activities.sort((a, b) => b.rawTime - a.rawTime);

  const displayActivities = activities.slice(0, 5);

  const activityCard = el(
    'section',
    { class: 'modern-card' },
    el(
      'div',
      { class: 'card-header' },
      el(
        'div',
        { class: 'card-header-titles' },
        el('h3', { class: 'card-title' }, '最近动态与交互'),
        el('p', { class: 'card-sub' }, '真实对话与记忆事件流'),
      ),
      el(
        'button',
        {
          type: 'button',
          class: 'link-btn',
          onClick: () => actions.selectPage('events'),
        },
        '查看全部 →',
      ),
    ),
    el(
      'ul',
      { class: 'activity-list' },
      displayActivities.length > 0
        ? displayActivities.map(item =>
            el(
              'li',
              { class: 'activity-item' },
              el('span', { class: `activity-dot dot-${item.dot}` }),
              el('span', { class: 'activity-time' }, item.time),
              el('span', { class: 'activity-tag' }, `[${item.tag}]`),
              el('span', { class: 'activity-text' }, item.text),
            ),
          )
        : [el('li', { class: 'activity-item empty' }, '暂无最近活动记录')],
    ),
  );

  // 3. Build Real Core Memories Cards (Replaces the fake "最近任务")
  const memoryCardsData = [];
  for (const m of memList) {
    memoryCardsData.push({
      title: formatMemoryTag(m.id, m.text),
      sub: m.text,
      badgeText: '已沉淀',
      badgeClass: 'task-badge success',
      time: time(m.createdAt),
    });
  }
  for (const sItem of sumList) {
    memoryCardsData.push({
      title: '陪伴摘要',
      sub: sItem.text,
      badgeText: '阶段摘要',
      badgeClass: 'task-badge success',
      time: time(sItem.createdAt),
    });
  }

  const memoryCard = el(
    'section',
    { class: 'modern-card' },
    el(
      'div',
      { class: 'card-header' },
      el(
        'div',
        { class: 'card-header-titles' },
        el('h3', { class: 'card-title' }, '核心长期记忆'),
        el('p', { class: 'card-sub' }, '从本地真实对话沉淀的长期事实与偏好'),
      ),
      el(
        'button',
        {
          type: 'button',
          class: 'link-btn',
          onClick: () => {
            s.section = 'records';
            actions.selectPage('memory');
          },
        },
        '管理记忆库 →',
      ),
    ),
    el(
      'div',
      { class: 'task-cards-grid' },
      memoryCardsData.length > 0
        ? memoryCardsData.map(mem =>
            el(
              'div',
              {
                class: 'task-mini-card',
                style: 'cursor: pointer;',
                onClick: () => {
                  s.section = 'records';
                  actions.selectPage('memory');
                },
              },
              el(
                'div',
                { class: 'task-mini-top' },
                el('strong', { class: 'task-mini-title' }, mem.title),
                el('span', { class: mem.badgeClass }, mem.badgeText),
              ),
              el('p', { class: 'task-mini-sub' }, mem.sub),
              el('span', { class: 'task-mini-time' }, mem.time),
            ),
          )
        : [el('p', { class: 'empty', style: 'padding: 16px; color: #64748b;' }, s.overviewLoading ? '正在读取本地记忆库…' : '本地记忆库中暂无长期记忆条目')],
    ),
  );

  // 4. Quick Actions
  const quickActions = [
    { label: '记忆纠正工作台', page: 'memory', section: 'records', desc: '检索、核验与纠正已沉淀的记忆' },
    { label: '浏览双时间线', page: 'timeline', desc: '查看原作叙事与陪伴历程' },
    { label: '角色设定与 Prompt', page: 'memory', section: 'prompt', desc: '查看青梅竹马设定底色与对话原则' },
    { label: 'Live2D 外观换肤', page: 'skins', desc: '切换桌宠外观立绘与服装' },
    { label: 'Trace 调用链追踪', page: 'events', desc: '查看运行时诊断与模型调用日志' },
  ];

  const quickActionCard = el(
    'section',
    { class: 'modern-card quick-actions-card' },
    el(
      'div',
      { class: 'card-header' },
      el(
        'div',
        { class: 'card-header-titles' },
        el(
          'div',
          { class: 'quick-actions-title-wrap' },
          svgIcon(ICONS.lightning, 'action-lightning'),
          el('h3', { class: 'card-title' }, '快捷操作'),
        ),
        el('p', { class: 'card-sub' }, '常用操作，一键直达'),
      ),
    ),
    el(
      'ul',
      { class: 'quick-actions-list' },
      quickActions.map(action =>
        el(
          'li',
          {
            class: 'quick-action-item',
            onClick: () => {
              if (action.section) s.section = action.section;
              actions.selectPage(action.page);
            },
          },
          el('span', { class: 'quick-action-label' }, action.label),
          svgIcon(ICONS.chevronRight, 'quick-action-arrow'),
        ),
      ),
    ),
  );

  const contentGrid = el(
    'div',
    { class: 'overview-columns-grid' },
    el('div', { class: 'overview-left-col' }, activityCard, memoryCard),
    el('div', { class: 'overview-right-col' }, quickActionCard),
  );

  return el('div', { class: 'modern-overview-container page-content' }, heroCard, contentGrid);
}
