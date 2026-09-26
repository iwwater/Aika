// N075-01 / UIR-01: Console routing and deep-link mapper.
// Resolves page/section/token/scope from URL hash, cleans sensitive tokens from address,
// and bridges legacy right-click targets and old pages to the modern 6-entry console + Developer partition.

export const PRIMARY_PAGES = Object.freeze([
  'dashboard',
  'knowledge',
  'characters',
  'playground',
  'plugins',
  'settings',
]);

export const DEVELOPER_PAGE = 'developer';

export const CONSOLE_PAGES = Object.freeze([
  ...PRIMARY_PAGES,
  DEVELOPER_PAGE,
  'overview',     // 运行总览 (兼容)
  'models',       // API 与模型配置 (兼容)
  'voice',        // 语音与设备设置 (兼容)
  'skins',        // 外观与换肤 (兼容)
  'memory',       // 记忆操作与纠正 (兼容)
  'timeline',     // 双时间线与 Wiki、Context (兼容)
  'packages',     // 插件包与 Flow 管理 (兼容)
  'health',       // 模块状态与就绪监控 (兼容)
  'events',       // 运行记录与日志诊断 (兼容)
  'projects',     // 项目与工作任务 (兼容)
  'tasks',        // 任务调度中心 (兼容)
  'wechat',       // 微信连接 (兼容)
  'presentation', // 表情与动作策略 (兼容)
  'proactive',    // 主动陪伴策略 (兼容)
  'perception',   // 授权感知 (兼容)
]);

export const DEFAULT_PAGE = 'overview';
export const DEFAULT_CANONICAL_PAGE = 'dashboard';

/**
 * Maps legacy page/section and query parameters into canonical 6-entry + developer navigation.
 */
export function resolveCanonicalRoute(rawPage, rawSection, params = new URLSearchParams()) {
  const p = (rawPage || '').toLowerCase();
  const s = (rawSection || '').toLowerCase();
  const type = (params.get('type') || '').toLowerCase();

  // 1. Direct Canonical Pages
  if (PRIMARY_PAGES.includes(p)) {
    return {
      canonicalPage: p,
      canonicalSection: rawSection || (p === 'knowledge' ? 'wiki' : null),
      isDeveloperRoute: false,
    };
  }

  if (p === DEVELOPER_PAGE) {
    return {
      canonicalPage: DEVELOPER_PAGE,
      canonicalSection: rawSection || 'llm',
      isDeveloperRoute: true,
    };
  }

  // 2. Legacy overview -> dashboard
  if (p === 'overview') {
    return { canonicalPage: 'dashboard', canonicalSection: null, isDeveloperRoute: false };
  }

  // 3. Characters sub-domains
  if (p === 'models') {
    return { canonicalPage: 'characters', canonicalSection: 'models', isDeveloperRoute: false };
  }
  if (p === 'voice') {
    return { canonicalPage: 'characters', canonicalSection: 'voice', isDeveloperRoute: false };
  }
  if (p === 'skins' || p === 'presentation') {
    return { canonicalPage: 'characters', canonicalSection: 'appearance', isDeveloperRoute: false };
  }
  if (p === 'characters') {
    return { canonicalPage: 'characters', canonicalSection: rawSection || 'general', isDeveloperRoute: false };
  }

  // 4. Memory routing (dispatches across Knowledge, Developer, Characters, Playground)
  if (p === 'memory') {
    if (s === 'records') {
      if (type === 'chat' || params.get('scope') === 'chat') {
        return { canonicalPage: 'developer', canonicalSection: 'llm', isDeveloperRoute: true };
      }
      return { canonicalPage: 'knowledge', canonicalSection: 'facts', isDeveloperRoute: false };
    }
    if (s === 'prompt') {
      return { canonicalPage: 'characters', canonicalSection: 'persona', isDeveloperRoute: false };
    }
    if (s === 'context') {
      return { canonicalPage: 'playground', canonicalSection: 'context', isDeveloperRoute: false };
    }
    if (s === 'dynamics' || s === 'fragments') {
      return { canonicalPage: 'knowledge', canonicalSection: s, isDeveloperRoute: false };
    }
    if (s === 'import') {
      return { canonicalPage: 'knowledge', canonicalSection: 'import', isDeveloperRoute: false };
    }
    if (s === 'emotion') {
      return { canonicalPage: 'characters', canonicalSection: 'emotion', isDeveloperRoute: false };
    }
    return { canonicalPage: 'knowledge', canonicalSection: 'facts', isDeveloperRoute: false };
  }

  // 5. Knowledge (default Wiki, legacy reference library)
  if (p === 'knowledge') {
    const sec = (s === 'reference' || s === 'library' || params.has('doc')) ? 'reference' : (s || 'wiki');
    return { canonicalPage: 'knowledge', canonicalSection: sec, isDeveloperRoute: false };
  }

  // 6. Developer sub-domains
  if (p === 'timeline') {
    return { canonicalPage: 'developer', canonicalSection: 'timeline', isDeveloperRoute: true };
  }
  if (p === 'events') {
    return { canonicalPage: 'developer', canonicalSection: 'logs', isDeveloperRoute: true };
  }

  // 7. Plugins & Packages
  if (p === 'packages' || p === 'plugins') {
    return { canonicalPage: 'plugins', canonicalSection: s || 'list', isDeveloperRoute: false };
  }

  // 8. Settings sub-domains
  if (p === 'health') {
    return { canonicalPage: 'settings', canonicalSection: 'diagnostics', isDeveloperRoute: false };
  }
  if (p === 'projects' || p === 'tasks') {
    return { canonicalPage: 'settings', canonicalSection: 'work', isDeveloperRoute: false };
  }
  if (p === 'wechat') {
    return { canonicalPage: 'settings', canonicalSection: 'integrations', isDeveloperRoute: false };
  }
  if (p === 'proactive' || p === 'perception') {
    return { canonicalPage: 'settings', canonicalSection: 'privacy', isDeveloperRoute: false };
  }
  if (p === 'settings') {
    return { canonicalPage: 'settings', canonicalSection: rawSection || 'general', isDeveloperRoute: false };
  }

  // 9. Playground
  if (p === 'playground') {
    return { canonicalPage: 'playground', canonicalSection: rawSection || null, isDeveloperRoute: false };
  }

  // Default fallback
  return { canonicalPage: DEFAULT_CANONICAL_PAGE, canonicalSection: null, isDeveloperRoute: false };
}

export function parseConsoleRoute(hashStr, sessionToken = '') {
  const cleanHash = (hashStr || '').replace(/^#/, '');
  const params = new URLSearchParams(cleanHash);

  const rawToken = params.get('token');
  const token = rawToken || sessionToken;

  const rawPage = params.get('page');
  const rawSection = params.get('section');
  const rawUser = params.get('user');
  const rawCharacter = params.get('character');
  const rawInstance = params.get('instance');

  const userId = rawUser || 'default-user';
  const characterId = rawCharacter || 'companion';
  const instanceId = rawInstance || 'default-instance';

  let legacyPage = DEFAULT_PAGE;
  let legacySection = rawSection || null;

  // Bridge legacy section targets (FE75-02)
  if (rawSection === 'timeline') {
    legacyPage = 'timeline';
    legacySection = null;
  } else if (rawSection === 'diagnostics') {
    legacyPage = 'events';
    legacySection = null;
  } else if (rawSection === 'runtime') {
    legacyPage = 'health';
    legacySection = null;
  } else if (['records', 'prompt', 'context', 'dynamics', 'fragments', 'emotion', 'import'].includes(rawSection)) {
    legacyPage = 'memory';
    legacySection = rawSection;
  } else if (rawPage && CONSOLE_PAGES.includes(rawPage)) {
    legacyPage = rawPage;
  }

  // Canonical mapping for modern 6-entry console
  const canonical = resolveCanonicalRoute(legacyPage, legacySection, params);

  // Preserve route while stripping token from URL bar
  const queryParams = new URLSearchParams();
  if (legacyPage !== DEFAULT_PAGE) queryParams.set('page', legacyPage);
  if (legacySection) queryParams.set('section', legacySection);
  if (characterId !== 'companion') queryParams.set('character', characterId);
  if (instanceId !== 'default-instance') queryParams.set('instance', instanceId);

  const targetHash = queryParams.toString() ? `#${queryParams.toString()}` : '';

  // Canonical hash generator
  const canonicalParams = new URLSearchParams();
  if (canonical.canonicalPage !== DEFAULT_CANONICAL_PAGE) {
    canonicalParams.set('page', canonical.canonicalPage);
  }
  if (canonical.canonicalSection) {
    canonicalParams.set('section', canonical.canonicalSection);
  }
  if (rawCharacter) canonicalParams.set('character', rawCharacter);
  if (rawInstance) canonicalParams.set('instance', rawInstance);
  if (rawUser) canonicalParams.set('user', rawUser);
  const canonicalTargetHash = canonicalParams.toString() ? `#${canonicalParams.toString()}` : '';

  return Object.freeze({
    // Backward compatibility for legacy tests & callers
    page: legacyPage,
    section: legacySection,
    // Modern canonical 6-entry + developer fields
    canonicalPage: canonical.canonicalPage,
    canonicalSection: canonical.canonicalSection,
    isDeveloperRoute: canonical.isDeveloperRoute,
    canonicalTargetHash,
    token,
    hasExplicitUser: !!rawUser,
    hasExplicitCharacter: !!rawCharacter,
    pairing: Object.freeze({
      userId,
      characterId,
      characterInstanceId: instanceId,
    }),
    hasTokenInUrl: !!rawToken,
    targetHash,
  });
}
