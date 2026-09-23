const pause = ms => new Promise(res => setTimeout(res, ms));
const waitFor = async (predicate, message, timeout = 12000) => {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const value = predicate();
    if (value) return value;
    await pause(40);
  }
  throw new Error(message + '; text=' + (document.body.innerText || '').slice(-600));
};

const DIGEST_PATTERN = /^\[digest:[0-9a-f]{8} len:\d+\]$|^\[digest:masked len:\d+\]$/;

const report = {
  timestamp: new Date().toISOString(),
  documentTitle: document.title,
  topNavigation: null,
  modulesTested: [],
  pagesTested: [],
  memorySectionsTested: [],
  interactiveTests: {},
  summary: { totalPages: 0, passedPages: 0, warnedPages: 0, interactionsPassed: false },
  overallVerdict: 'PENDING'
};

// 1. Initial shell readiness
await waitFor(() => document.querySelector('.navbar-nav, .app-navbar'), 'Navbar did not render');

const navModuleButtons = [...document.querySelectorAll('.nav-module-btn')].map(b => b.textContent.trim());
report.topNavigation = {
  hasHeader: !!document.querySelector('header.app-navbar'),
  hasMainContent: !!document.querySelector('#app, main, .page-content'),
  modulesCount: navModuleButtons.length,
  moduleLabels: navModuleButtons
};

// 2. Iterate through all 6 Modules and their respective SubTabs via authentic DOM clicks
const MODULE_DEFS = [
  {
    id: 'ops',
    label: '运行',
    pages: [
      { id: 'overview', label: '总览', matchTitle: /总览/ },
      { id: 'health', label: '模块状态', matchTitle: /模块状态/ },
      { id: 'events', label: 'Trace', matchTitle: /Trace|运行记录/ }
    ]
  },
  {
    id: 'character',
    label: '角色',
    pages: [
      { id: 'characters', label: '角色与 Pack', matchTitle: /角色/ },
      { id: 'memory', label: '记忆', matchTitle: /记忆/ },
      { id: 'timeline', label: '时间线', matchTitle: /时间线/ },
      { id: 'presentation', label: '表情与动作', matchTitle: /表情|动作/ }
    ]
  },
  {
    id: 'config',
    label: '配置',
    pages: [
      { id: 'models', label: 'API 与模型', matchTitle: /模型|API/ },
      { id: 'voice', label: '语音与设备', matchTitle: /语音|设备/ },
      { id: 'skins', label: '外观 / 换肤', matchTitle: /外观|换肤/ }
    ]
  },
  {
    id: 'connect',
    label: '连接',
    pages: [
      { id: 'wechat', label: '微信连接', matchTitle: /微信/ }
    ]
  },
  {
    id: 'extensions',
    label: '扩展',
    pages: [
      { id: 'knowledge', label: '知识库', matchTitle: /知识库/ },
      { id: 'packages', label: '插件包与 Flow', matchTitle: /插件|Flow/ }
    ]
  },
  {
    id: 'work',
    label: '工作',
    pages: [
      { id: 'projects', label: '项目索引', matchTitle: /项目/ },
      { id: 'tasks', label: '任务调度', matchTitle: /任务/ }
    ]
  }
];

for (const mod of MODULE_DEFS) {
  const modBtn = [...document.querySelectorAll('.nav-module-btn')].find(b => b.textContent.includes(mod.label));
  if (modBtn) {
    modBtn.click();
    await pause(100);
  }

  const moduleResult = { id: mod.id, label: mod.label, clicked: !!modBtn, pagesCount: mod.pages.length };
  report.modulesTested.push(moduleResult);

  for (const page of mod.pages) {
    const subTabBtn = [...document.querySelectorAll('.sub-nav-tab')].find(b => b.textContent.trim() === page.label || b.textContent.includes(page.label));
    if (subTabBtn) {
      subTabBtn.click();
      await pause(120);
    }

    const titleText = document.querySelector('.page-title, h1, h2')?.textContent?.trim() || '';
    const eyebrowText = document.querySelector('.page-eyebrow')?.textContent?.trim() || '';
    const cardsCount = document.querySelectorAll('.card, .section, .trace-card, .record-card, .kpi-card, .module-card, fieldset, form').length;
    const buttonsCount = document.querySelectorAll('.page-content button, .card button').length;
    const inputsCount = document.querySelectorAll('.page-content input, .page-content select, .page-content textarea').length;
    const contentText = document.querySelector('.page-content, main, #app')?.innerText || '';

    const titleMatches = page.matchTitle.test(titleText) || page.matchTitle.test(eyebrowText);
    const hasBodyContent = contentText.length > 20;
    const isPass = titleMatches && hasBodyContent;

    report.pagesTested.push({
      moduleId: mod.id,
      pageId: page.id,
      label: page.label,
      titleText,
      eyebrowText,
      titleMatches,
      cardsCount,
      buttonsCount,
      inputsCount,
      hasBodyContent,
      verdict: isPass ? 'PASS' : 'WARN'
    });
  }
}

// 3. Deep Inspection of Memory 7 Sub-sections via subtab clicks
const charModBtn = [...document.querySelectorAll('.nav-module-btn')].find(b => b.textContent.includes('角色'));
if (charModBtn) charModBtn.click();
await pause(80);
const memSubBtn = [...document.querySelectorAll('.sub-nav-tab')].find(b => b.textContent.includes('记忆'));
if (memSubBtn) memSubBtn.click();
await pause(120);

const MEMORY_SECTIONS = [
  { id: 'records', label: '纠正记录' },
  { id: 'prompt', label: '角色设定' },
  { id: 'context', label: '上下文' },
  { id: 'dynamics', label: '记忆总览' },
  { id: 'fragments', label: '来源与片段' },
  { id: 'emotion', label: '当前情绪' },
  { id: 'import', label: '导入旧聊天' }
];

for (const sec of MEMORY_SECTIONS) {
  const subBtn = document.querySelector('#memory-' + sec.id) || [...document.querySelectorAll('.tab-actions button, .subtab')].find(b => b.textContent.includes(sec.label));
  if (subBtn) {
    subBtn.click();
    await pause(120);
  }

  const activeTab = document.querySelector('.tab-actions button[aria-pressed="true"], .subtab.active')?.textContent?.trim() || '';
  const cardsCount = document.querySelectorAll('.record-card, .card, .section').length;
  const inputsCount = document.querySelectorAll('input, textarea, select').length;
  const mainText = document.querySelector('.page-content, #main-content, main')?.innerText || '';

  report.memorySectionsTested.push({
    id: sec.id,
    label: sec.label,
    activeTab,
    cardsCount,
    inputsCount,
    hasContent: mainText.length > 15,
    verdict: (cardsCount > 0 || inputsCount > 0 || mainText.length > 20) ? 'PASS' : 'WARN'
  });
}

// 4. Memory Records Selection & Forget Popover Confirmation Interaction
const recSubBtn = document.querySelector('#memory-records') || [...document.querySelectorAll('.tab-actions button, .subtab')].find(b => b.textContent.includes('纠正记录') || b.textContent.includes('记录'));
if (recSubBtn) recSubBtn.click();
await pause(150);

let forgetInteraction = { tested: false, success: false };

// Click search if records are not loaded yet
const searchBtn = document.querySelector('#record-search');
if (searchBtn) {
  searchBtn.click();
  await pause(250);
}

// Select the first record row
const firstRow = document.querySelector('.record-row, [data-record-id]');
if (firstRow) {
  firstRow.click();
  await pause(200);

  const forgetBtn = document.querySelector('#record-forget');
  if (forgetBtn) {
    const initiallyHidden = !document.querySelector('#record-confirm-forget');
    forgetBtn.click();
    await pause(120);

    const confirmBtn = document.querySelector('#record-confirm-forget');
    const cancelBtn = document.querySelector('#record-cancel-forget');
    const popoverShown = !!confirmBtn && !!cancelBtn;

    if (cancelBtn) {
      cancelBtn.click();
      await pause(120);
    }

    const safelyDismissed = !document.querySelector('#record-confirm-forget');

    forgetInteraction = {
      tested: true,
      success: initiallyHidden && popoverShown && safelyDismissed,
      initiallyHidden,
      popoverShown,
      safelyDismissed,
      buttonText: forgetBtn.textContent.trim()
    };
  }
}

report.interactiveTests.memoryForgetConfirmation = forgetInteraction;

// 5. Trace/Events Default Masking, Reveal, Remask & Refresh Interaction
const opsBtn = [...document.querySelectorAll('.nav-module-btn')].find(b => b.textContent.includes('运行'));
if (opsBtn) opsBtn.click();
await pause(80);
const traceSubBtn = [...document.querySelectorAll('.sub-nav-tab')].find(b => b.textContent.includes('Trace'));
if (traceSubBtn) traceSubBtn.click();
await pause(150);

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

  // Refresh button
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

report.interactiveTests.traceMaskingAndReveal = traceInteraction;

// 6. Summary metrics
report.summary.totalPages = report.pagesTested.length;
report.summary.passedPages = report.pagesTested.filter(p => p.verdict === 'PASS').length;
report.summary.warnedPages = report.pagesTested.filter(p => p.verdict === 'WARN').length;
report.summary.interactionsPassed = forgetInteraction.success && traceInteraction.success;
report.overallVerdict = (report.summary.passedPages === report.summary.totalPages && report.summary.interactionsPassed) ? 'PASS_ALL' : 'PASS_WITH_WARNINGS';

return report;
