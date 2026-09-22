// N075-01: Console routing and deep-link mapper.
// Resolves page/section/token/scope from URL hash, cleans sensitive tokens from address,
// and bridges legacy right-click targets to unified 0.75 console pages.

export const CONSOLE_PAGES = Object.freeze([
  'overview',     // 运行总览 (N075-12)
  'models',       // API 与模型配置 (N075-04)
  'voice',        // 语音与设备设置 (N075-05)
  'skins',        // 外观与换肤 (N075-06)
  'characters',   // 角色与 Character Pack (N075-07)
  'memory',       // 记忆操作与纠正 (N075-08)
  'timeline',     // 双时间线与 Wiki、Context (N075-09)
  'knowledge',    // 知识库与文档管理 (N075-10)
  'packages',     // 插件包与 Flow 管理 (N075-11)
  'health',       // 模块状态与就绪监控 (N075-12)
  'events',       // 运行记录与日志诊断 (N075-12)
  'projects',     // 项目与工作任务 (N075-13)
  'tasks',        // 任务调度中心 (N075-13)
  'wechat',       // 微信连接 (N075-14)
  'presentation', // 表情与动作策略 (N075-14)
]);

export const DEFAULT_PAGE = 'overview';

export function parseConsoleRoute(hashStr, sessionToken = '') {
  const cleanHash = (hashStr || '').replace(/^#/, '');
  const params = new URLSearchParams(cleanHash);

  const rawToken = params.get('token');
  const token = rawToken || sessionToken;

  const rawPage = params.get('page');
  const rawSection = params.get('section');
  const userId = params.get('user') || 'default-user';
  const characterId = params.get('character') || 'companion';
  const instanceId = params.get('instance') || 'default-instance';

  let page = DEFAULT_PAGE;
  let section = rawSection || null;

  // Bridge legacy section targets (FE75-02)
  if (rawSection === 'timeline') {
    page = 'timeline';
    section = null;
  } else if (rawSection === 'diagnostics') {
    page = 'events';
    section = null;
  } else if (rawSection === 'runtime') {
    page = 'health';
    section = null;
  } else if (['records', 'prompt', 'context', 'dynamics', 'fragments', 'emotion', 'import'].includes(rawSection)) {
    page = 'memory';
    section = rawSection;
  } else if (rawPage && CONSOLE_PAGES.includes(rawPage)) {
    page = rawPage;
  }

  // Preserve route while stripping token from URL bar
  const queryParams = new URLSearchParams();
  if (page !== DEFAULT_PAGE) queryParams.set('page', page);
  if (section) queryParams.set('section', section);
  if (characterId !== 'companion') queryParams.set('character', characterId);
  if (instanceId !== 'default-instance') queryParams.set('instance', instanceId);

  const targetHash = queryParams.toString() ? `#${queryParams.toString()}` : '';

  return Object.freeze({
    page,
    section,
    token,
    pairing: Object.freeze({
      userId,
      characterId,
      characterInstanceId: instanceId,
    }),
    hasTokenInUrl: !!rawToken,
    targetHash,
  });
}
