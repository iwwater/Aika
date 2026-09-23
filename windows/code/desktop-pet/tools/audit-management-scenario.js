const pause = ms => new Promise(res => setTimeout(res, ms));
const waitFor = async (predicate, message, timeout = 10000) => {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const value = predicate();
    if (value) return value;
    await pause(35);
  }
  throw new Error(message + '; page=' + (document.body.innerText || '').slice(-600));
};

const DIGEST_PATTERN = /^\[digest:[0-9a-f]{8} len:\d+\]$|^\[digest:masked len:\d+\]$/;

const report = {
  timestamp: new Date().toISOString(),
  documentTitle: document.title,
  topNavigation: null,
  pages: [],
  memorySections: [],
  interactions: {},
  consoleErrors: window.__auditConsoleErrors || [],
  summary: { totalPages: 0, passedPages: 0, warnedPages: 0, interactionsPassed: false }
};

// 1. Audit Shell & Top Navigation
await waitFor(() => document.querySelector('#main-nav, nav'), 'Top navigation did not render');
const navButtons = [...document.querySelectorAll('#main-nav button, .nav-tab, nav button')].map(b => ({
  id: b.id || b.getAttribute('data-module') || b.textContent.trim(),
  label: b.textContent.trim(),
  active: b.classList.contains('active')
}));

report.topNavigation = {
  hasHeader: !!document.querySelector('header'),
  hasMainContent: !!document.querySelector('#main-content, main, .app-content'),
  modulesCount: navButtons.length,
  modules: navButtons
};

// 2. Comprehensive 15 Pages Audit
const PAGES_TO_TEST = [
  { id: 'overview', title: '运行 / 总览', match: /总览/, required: ['.card, .kpi-card, .metric-card, .hero-kpi, .section'] },
  { id: 'health', title: '运行 / 模块状态', match: /模块状态/, required: ['.health-card, .module-card, .card, .status-item, button'] },
  { id: 'events', title: '运行 / Trace 调用链追踪', match: /Trace|调用链|运行记录/, required: ['.trace-card, .card, .kpis, .trace-kpi-card'] },
  { id: 'characters', title: '角色 / 角色与 Pack 管理', match: /角色/, required: ['.character-card, .card, .section, form, select'] },
  { id: 'memory', title: '角色 / 记忆记录与维护', match: /记忆/, required: ['.memory-subtabs, .subtabs, nav, .record-card, .card'] },
  { id: 'timeline', title: '角色 / 双时间线 (Canon vs Companion)', match: /时间线/, required: ['.timeline-view, .timeline, .card, .section, .empty'] },
  { id: 'presentation', title: '角色 / 表情与动作策略', match: /表情|动作/, required: ['.presentation-view, .card, .section, select, button'] },
  { id: 'models', title: '配置 / API 与模型绑定', match: /模型|API/, required: ['form, .model-card, .card, .field, select'] },
  { id: 'voice', title: '配置 / 语音与设备设置', match: /语音|设备/, required: ['.voice-card, .field, .card, select, input'] },
  { id: 'skins', title: '配置 / 外观与换肤', match: /外观|换肤/, required: ['.skin-card, .card, .grid, .section'] },
  { id: 'wechat', title: '连接 / 微信连接与通知', match: /微信/, required: ['.wechat-card, .card, .section, button'] },
  { id: 'knowledge', title: '扩展 / 知识库与文档管理', match: /知识库/, required: ['.knowledge-view, .card, .section, .categories, .empty'] },
  { id: 'packages', title: '扩展 / 插件包与 Flow 流程', match: /插件|Flow/, required: ['.packages-view, .card, .section, .empty, .placeholder'] },
  { id: 'projects', title: '工作 / 项目工作区索引', match: /项目/, required: ['.projects-view, .card, .section, .empty, table, ul, .list'] },
  { id: 'tasks', title: '工作 / 任务调度中心', match: /任务/, required: ['.tasks-view, .card, .section, .empty, table, ul, .list'] },
];

for (const p of PAGES_TO_TEST) {
  // Navigate via hash change
  window.location.hash = `#page=${p.id}`;
  await pause(120);

  const headerTitle = document.querySelector('.page-title, h1, h2')?.textContent?.trim() || '';
  const headerDesc = document.querySelector('.page-desc, .subtle, p')?.textContent?.trim() || '';
  const bodyText = document.body.innerText || '';
  const buttons = [...document.querySelectorAll('button:not([disabled])')].map(b => b.textContent.trim()).filter(Boolean);
  const inputs = document.querySelectorAll('input, select, textarea').length;
  const cards = document.querySelectorAll('.card, .section, .trace-card, .record-card, .kpi-card, .module-card, fieldset, form').length;

  const titlePass = p.match.test(headerTitle);
  const elementsPresent = cards > 0 || buttons.length > 0;
  const isPass = titlePass && elementsPresent && bodyText.length > 20;

  report.pages.push({
    id: p.id,
    expectedTitle: p.title,
    actualTitle: headerTitle,
    titleMatch: titlePass,
    elements: {
      cardsCount: cards,
      buttonsCount: buttons.length,
      sampleButtons: buttons.slice(0, 5),
      inputsCount: inputs
    },
    verdict: isPass ? 'PASS' : 'WARN'
  });
}

// 3. Deep Inspection of Memory 7 Sub-sections
const MEMORY_SECTIONS = ['records', 'prompt', 'context', 'dynamics', 'fragments', 'emotion', 'import'];

for (const sec of MEMORY_SECTIONS) {
  window.location.hash = `#page=memory&section=${sec}`;
  await pause(120);

  const activeTab = document.querySelector('.subtab.active, .memory-subtabs button.active, nav button.active')?.textContent?.trim() || '';
  const cardsCount = document.querySelectorAll('.record-card, .card, .section').length;
  const inputsCount = document.querySelectorAll('input, textarea, select').length;
  const sectionText = document.querySelector('#main-content, main, .content, #memory')?.innerText || '';

  report.memorySections.push({
    section: sec,
    activeTab,
    cardsCount,
    inputsCount,
    hasContent: sectionText.length > 15,
    verdict: (cardsCount > 0 || inputsCount > 0 || sectionText.length > 20) ? 'PASS' : 'WARN'
  });
}

// 4. Memory Records Forget Button & Secondary Confirmation Interaction
window.location.hash = '#page=memory&section=records';
await pause(150);

let forgetInteraction = { tested: false, success: false };
const firstCard = document.querySelector('.record-card, .card');
const forgetBtn = document.querySelector('#record-forget, button.danger');

if (firstCard && forgetBtn) {
  const initiallyHidden = !document.querySelector('#record-confirm-forget');
  forgetBtn.click();
  await pause(100);

  const confirmBtn = document.querySelector('#record-confirm-forget');
  const cancelBtn = document.querySelector('#record-cancel-forget');
  const popoverShown = !!confirmBtn && !!cancelBtn;

  if (cancelBtn) {
    cancelBtn.click();
    await pause(100);
  }

  const dismissedSafely = !document.querySelector('#record-confirm-forget');

  forgetInteraction = {
    tested: true,
    success: initiallyHidden && popoverShown && dismissedSafely,
    initiallyHidden,
    popoverShown,
    dismissedSafely,
    buttonText: forgetBtn.textContent.trim()
  };
}

report.interactions.memoryForgetConfirmation = forgetInteraction;

// 5. Trace/Events Default Masking, Reveal, Remask & Refresh Interaction
window.location.hash = '#page=events';
await pause(180);

let traceInteraction = { tested: false, success: false };
const traceCards = [...document.querySelectorAll('.trace-card')];

if (traceCards.length > 0) {
  let totalFields = 0;
  let maskedFields = 0;

  for (const c of traceCards) {
    const u = c.querySelector('.trace-msg-user')?.textContent?.replace(/^用户：/, '').trim() || '';
    const a = c.querySelector('.trace-msg-asst')?.textContent?.replace(/^Aika：/, '').trim() || '';
    totalFields += 2;
    if (DIGEST_PATTERN.test(u)) maskedFields++;
    if (DIGEST_PATTERN.test(a)) maskedFields++;
  }

  const allMaskedByDefault = totalFields > 0 && maskedFields === totalFields;

  // Reveal Card 1
  const card1 = traceCards[0];
  const revealBtn = [...card1.querySelectorAll('.actions button')].find(b => b.textContent.includes('查看本机历史正文'));
  let revealWorks = false;
  let remaskWorks = false;

  if (revealBtn) {
    revealBtn.click();
    await pause(150);

    const cardAfterReveal = document.querySelectorAll('.trace-card')[0];
    const hideBtn = [...cardAfterReveal.querySelectorAll('.actions button')].find(b => b.textContent.includes('隐藏正文'));
    revealWorks = !!hideBtn;

    if (hideBtn) {
      hideBtn.click();
      await pause(150);
      const cardAfterHide = document.querySelectorAll('.trace-card')[0];
      const restoredBtn = [...cardAfterHide.querySelectorAll('.actions button')].find(b => b.textContent.includes('查看本机历史正文'));
      const userText = cardAfterHide.querySelector('.trace-msg-user')?.textContent?.replace(/^用户：/, '').trim() || '';
      remaskWorks = !!restoredBtn && DIGEST_PATTERN.test(userText);
    }
  }

  // Refresh Button
  const refreshBtn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('刷新 Trace'));
  let refreshWorks = false;
  if (refreshBtn) {
    refreshBtn.click();
    await pause(150);
    refreshWorks = document.querySelectorAll('.trace-card').length === traceCards.length;
  }

  traceInteraction = {
    tested: true,
    success: allMaskedByDefault && revealWorks && remaskWorks && refreshWorks,
    totalCards: traceCards.length,
    totalFields,
    maskedFields,
    allMaskedByDefault,
    revealWorks,
    remaskWorks,
    refreshWorks
  };
}

report.interactions.traceMaskingAndReveal = traceInteraction;

// 6. Summary metrics
report.summary.totalPages = report.pages.length;
report.summary.passedPages = report.pages.filter(p => p.verdict === 'PASS').length;
report.summary.warnedPages = report.pages.filter(p => p.verdict === 'WARN').length;
report.summary.interactionsPassed = forgetInteraction.success && traceInteraction.success;

return report;
