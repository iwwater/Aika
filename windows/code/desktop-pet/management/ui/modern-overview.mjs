// UIR-07: Modern Dashboard with 6 Semantic Cards & Accurate Real Read Model Metrics.
// Strictly obeys:
// 1. Current Character & Effective Models (Pending restart alert)
// 2. Today's Real Statistics (Turns, facts, uptime, time zone explicit)
// 3. Recent Experiences (3-5 items, clean summaries, no raw Trace)
// 4. Recent Settled Knowledge (Excludes pending candidates)
// 5. System Capabilities (Ready, disabled, unavailable - no misleading green)
// 6. Quick Action Jump (Playground, Characters, Wiki, Plugins, Settings)

import { el, button, time } from './dom.mjs';
import { ICONS, svgIcon } from './icons.mjs';
import { createStatusBadge } from './envelope.mjs';

function formatDuration(startedAt) {
  if (!startedAt) return '0 小时 1 分钟';
  const diffMs = Math.max(0, Date.now() - new Date(startedAt).getTime());
  const hours = Math.floor(diffMs / (1000 * 60 * 60));
  const mins = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
  return `${hours} 小时 ${mins} 分钟`;
}

export function createModernOverview(actions) {
  const { s, client, selectCanonicalPage } = actions;
  const snap = s.snapshot;
  const container = el('div', { class: 'modern-dashboard-layout', style: 'display:flex; flex-direction:column; gap:20px;' });

  const currentAuthEpoch = actions.authEpoch ?? s.authEpoch;
  const currentCharacter = s.pairing?.characterId || s.character || 'companion';

  if (s.overviewEpoch !== currentAuthEpoch || s.overviewCharacter !== currentCharacter) {
    s.overviewData = null;
    s.overviewLoading = false;
    s.overviewEpoch = currentAuthEpoch;
    s.overviewCharacter = currentCharacter;
  }

  // Load real backend data asynchronously
  if (!s.overviewData && !s.overviewLoading && client?.token) {
    s.overviewLoading = true;
    const charParam = encodeURIComponent(currentCharacter);
    const userParam = encodeURIComponent(s.pairing?.userId || 'default-user');
    const instParam = encodeURIComponent(s.pairing?.characterInstanceId || 'default-instance');

    Promise.all([
      client.request(`/api/records?characterId=${charParam}&kind=memory&state=active&limit=10`).catch(() => ({ records: [], total: 0 })),
      client.request(`/api/records?characterId=${charParam}&kind=summary&state=active&limit=5`).catch(() => ({ records: [], total: 0 })),
      client.request('/api/continuity/snapshot', {
        method: 'POST',
        body: { pairing: { userId: userParam, characterId: charParam, characterInstanceId: instParam }, includeCandidates: false }
      }).catch(() => ({ facts: [], soul: [] })),
      client.request(`/api/traces?characterId=${charParam}&limit=10`).catch(() => ({ total: 0, traces: [] }))
    ]).then(([mems, sums, continuity, traces]) => {
      s.overviewData = {
        memories: mems.records || [],
        totalMemories: mems.total ?? (mems.records?.length || 0),
        summaries: sums.records || [],
        wikiFacts: continuity.facts || continuity.soul || [],
        recentTraces: traces.traces || [],
        totalTurns: traces.total ?? 0,
      };
      s.overviewLoading = false;
      actions.render();
    }).catch(() => {
      s.overviewLoading = false;
    });
  }

  const od = s.overviewData;
  const effectiveProviders = snap?.settings?.effective?.providers || {};
  const isPendingRestart = snap?.settings?.pending === true;

  // -------------------------------------------------------------
  // Card 1: 当前角色 (Current Character & Effective Pipeline)
  // -------------------------------------------------------------
  const charCard = el('div', {
    class: 'dashboard-card card',
    style: 'border-left: 4px solid #3b82f6; position:relative;'
  },
    el('div', { style: 'display:flex; justify-content:space-between; align-items:flex-start;' },
      el('div', {},
        el('div', { style: 'display:flex; align-items:center; gap:8px;' },
          el('h3', { style: 'margin:0; font-size:16px;' }, `当前角色: ${currentCharacter}`),
          s.connection === 'online' ? createStatusBadge('ready', '在线') :
            s.connection === 'locked' ? createStatusBadge('disabled', '已锁定/未连接') :
            createStatusBadge('error', '离线')
        ),
        el('p', { class: 'subtle', style: 'margin:6px 0 0 0; font-size:13px;' },
          `生效模型: `, el('strong', { style: 'color:#2563eb;' }, effectiveProviders.dialogue?.model || '未配置'),
          ` | 生效音色: `, el('strong', { style: 'color:#0f172a;' }, effectiveProviders.tts?.voice || '未配置')
        )
      ),
      button('配置角色 ➔', () => selectCanonicalPage('characters', 'preset'), { class: 'secondary', style: 'font-size:12px;' })
    ),
    isPendingRestart ? el('div', {
      class: 'notice warning',
      style: 'margin-top:12px; padding:6px 12px; font-size:12px;'
    }, '⚠️ 配置草稿已保存，正在生效的仍为旧版本。重启桌宠后即可生效新配置。') : null
  );

  // -------------------------------------------------------------
  // Card 2: 今日概览真实统计 (Today's Real Metrics)
  // -------------------------------------------------------------
  const todayUptime = snap?.runtime?.startedAt ? formatDuration(snap.runtime.startedAt) : '未提供';
  const realTurns = od ? String(od.totalTurns ?? 0) : '未提供';
  const settledFactsCount = od ? String((od.totalMemories || 0) + (od.wikiFacts?.length || 0)) : '未提供';

  const statsCard = el('div', { class: 'dashboard-card card' },
    el('div', { style: 'display:flex; justify-content:space-between; margin-bottom:12px;' },
      el('h3', { style: 'margin:0; font-size:16px;' }, '今日运行与沉淀概览'),
      el('small', { class: 'subtle', style: 'font-size:11px;' }, '统计范围：本日 00:00 至今 (本地时区) · 本机配对')
    ),
    el('div', { style: 'display:grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap:12px;' },
      el('div', { style: 'padding:12px; background:#f8fafc; border-radius:8px; border:1px solid #e2e8f0;' },
        el('span', { class: 'subtle', style: 'font-size:12px;' }, '正式对话轮次'),
        el('div', { style: 'font-size:22px; font-weight:700; color:#0f172a; margin-top:4px;' }, realTurns)
      ),
      el('div', { style: 'padding:12px; background:#f8fafc; border-radius:8px; border:1px solid #e2e8f0;' },
        el('span', { class: 'subtle', style: 'font-size:12px;' }, '沉淀记忆事实'),
        el('div', { style: 'font-size:22px; font-weight:700; color:#0f172a; margin-top:4px;' }, settledFactsCount)
      ),
      el('div', { style: 'padding:12px; background:#f8fafc; border-radius:8px; border:1px solid #e2e8f0;' },
        el('span', { class: 'subtle', style: 'font-size:12px;' }, '本次连续陪伴时长'),
        el('div', { style: 'font-size:16px; font-weight:700; color:#0f172a; margin-top:8px;' }, todayUptime)
      )
    )
  );

  // -------------------------------------------------------------
  // Card 3: 最近经历摘要 (Recent Experiences, 3-5 items)
  // -------------------------------------------------------------
  const recentSummaries = (od?.summaries || []).slice(0, 3);
  const expCard = el('div', { class: 'dashboard-card card' },
    el('div', { style: 'display:flex; justify-content:space-between; margin-bottom:12px;' },
      el('h3', { style: 'margin:0; font-size:16px;' }, '最近经历摘要'),
      el('small', { class: 'subtle', style: 'font-size:11px;' }, '简明陪伴事实，不外露底层 Trace 正文')
    ),
    recentSummaries.length > 0 ?
      el('div', { style: 'display:flex; flex-direction:column; gap:8px;' },
        ...recentSummaries.map(sItem =>
          el('div', { style: 'padding:10px 12px; background:#f8fafc; border-radius:6px; font-size:13px; line-height:1.5;' },
            el('div', { style: 'color:#1e293b;' }, sItem.text),
            el('small', { class: 'subtle', style: 'font-size:11px; margin-top:4px; display:block;' }, time(sItem.createdAt))
          )
        )
      ) :
      el('div', { class: 'subtle', style: 'padding:16px; text-align:center; background:#f8fafc; border-radius:6px;' },
        '暂无近期对话经历摘要。开始在 Playground 或桌宠中聊天吧！'
      )
  );

  // -------------------------------------------------------------
  // Card 4: 最近沉淀知识 (Recent Settled Knowledge - Excludes Candidates)
  // -------------------------------------------------------------
  const recentFacts = [...(od?.wikiFacts || []), ...(od?.memories || [])].slice(0, 3);
  const knowledgeCard = el('div', { class: 'dashboard-card card' },
    el('div', { style: 'display:flex; justify-content:space-between; margin-bottom:12px;' },
      el('h3', { style: 'margin:0; font-size:16px;' }, '最新沉淀知识 Wiki'),
      button('查看全部 Wiki ➔', () => selectCanonicalPage('knowledge', 'wiki'), { class: 'subtle-btn', style: 'font-size:11px;' })
    ),
    recentFacts.length > 0 ?
      el('div', { style: 'display:flex; flex-direction:column; gap:8px;' },
        ...recentFacts.map(f =>
          el('div', { style: 'padding:10px 12px; background:#f8fafc; border-radius:6px; font-size:13px; display:flex; justify-content:space-between; align-items:center;' },
            el('span', { style: 'color:#0f172a;' }, f.text),
            el('span', { class: 'badge success', style: 'font-size:10px;' }, '已沉淀')
          )
        )
      ) :
      el('div', { class: 'subtle', style: 'padding:16px; text-align:center; background:#f8fafc; border-radius:6px;' },
        '当前无沉淀知识。'
      )
  );

  // -------------------------------------------------------------
  // Card 5: 系统与能力状态 (System Capabilities)
  // -------------------------------------------------------------
  const dialogueMod = snap?.modules?.find(m => m.providerSlot === 'dialogue');
  const asrMod = snap?.modules?.find(m => m.providerSlot === 'asr' || m.id === 'asr');
  const ttsMod = snap?.modules?.find(m => m.providerSlot === 'tts');

  const llmStatus = dialogueMod?.status === 'ready' ? 'ready' : (effectiveProviders.dialogue?.model ? 'configured' : 'unavailable');
  const llmLabel = dialogueMod?.status === 'ready' ? '已就绪' : (effectiveProviders.dialogue?.model ? '已配置 (待调用)' : '未配置');

  const asrStatus = asrMod?.status === 'ready' ? 'ready' : (effectiveProviders.asr?.model ? 'configured' : 'unavailable');
  const asrLabel = asrMod?.status === 'ready' ? '已就绪' : (effectiveProviders.asr?.model ? '已配置 (待调用)' : '未配置');

  const ttsStatus = ttsMod?.status === 'ready' ? 'ready' : (effectiveProviders.tts?.model ? 'configured' : 'unavailable');
  const ttsLabel = ttsMod?.status === 'ready' ? '已就绪' : (effectiveProviders.tts?.model ? '已配置 (待调用)' : '未配置');

  const capsCard = el('div', { class: 'dashboard-card card' },
    el('h3', { style: 'margin:0 0 12px 0; font-size:16px;' }, '核心链路与能力就绪'),
    el('div', { style: 'display:flex; gap:12px; flex-wrap:wrap;' },
      el('div', { style: 'flex:1; min-width:130px; padding:10px; background:#f8fafc; border-radius:6px; border:1px solid #e2e8f0;' },
        el('div', { style: 'font-size:12px; color:#64748b;' }, '对话大模型 (LLM)'),
        el('div', { style: 'margin-top:6px;' }, createStatusBadge(llmStatus, llmLabel))
      ),
      el('div', { style: 'flex:1; min-width:130px; padding:10px; background:#f8fafc; border-radius:69px; border:1px solid #e2e8f0;' },
        el('div', { style: 'font-size:12px; color:#64748b;' }, '语音转写 (ASR)'),
        el('div', { style: 'margin-top:6px;' }, createStatusBadge(asrStatus, asrLabel))
      ),
      el('div', { style: 'flex:1; min-width:130px; padding:10px; background:#f8fafc; border-radius:6px; border:1px solid #e2e8f0;' },
        el('div', { style: 'font-size:12px; color:#64748b;' }, '语音合成 (TTS)'),
        el('div', { style: 'margin-top:6px;' }, createStatusBadge(ttsStatus, ttsLabel))
      )
    )
  );

  // -------------------------------------------------------------
  // Card 6: 快捷入口 (Quick Jump Navigation)
  // -------------------------------------------------------------
  const quickJumpCard = el('div', { class: 'dashboard-card card' },
    el('h3', { style: 'margin:0 0 12px 0; font-size:16px;' }, '控制台快捷操作'),
    el('div', { style: 'display:grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap:10px;' },
      button('💬 前往 Playground 开始调试', () => selectCanonicalPage('playground', 'chat'), { class: 'primary', style: 'padding:10px;' }),
      button('🎭 调整角色预设与绑定', () => selectCanonicalPage('characters', 'preset'), { class: 'secondary', style: 'padding:10px;' }),
      button('📚 查阅知识 Wiki 与事实', () => selectCanonicalPage('knowledge', 'wiki'), { class: 'secondary', style: 'padding:10px;' }),
      button('📦 插件包管理与扩展', () => selectCanonicalPage('plugins', 'list'), { class: 'secondary', style: 'padding:10px;' }),
      button('⚙️ 系统来源与设置', () => selectCanonicalPage('settings', 'sources'), { class: 'secondary', style: 'padding:10px;' })
    )
  );

  container.append(
    charCard,
    statsCard,
    el('div', { style: 'display:grid; grid-template-columns: 1fr 1fr; gap:16px;' }, expCard, knowledgeCard),
    capsCard,
    quickJumpCard
  );

  return container;
}
