// UIR-05: Integrated Developer View
// Provides four dedicated developer sub-panels:
// 1. LLM Chat Trace (Requests, responses, tokens, latency, model parameters)
// 2. Knowledge Ingest Trace (Batch operations, candidates, accepted/rejected Wiki entries)
// 3. Timeline Companion Trace (Dual timeline, companion event inspections)
// 4. Runtime Logs (Raw events and system diagnostics)

import { el, button, field, notice, card, time } from './dom.mjs';
import { ICONS, svgIcon } from './icons.mjs';
import { eventsView } from './views.mjs';
import { createModernTimelineView } from './modern-timeline-view.mjs';

export function createDeveloperView(actions) {
  const { s, client, selectCanonicalPage } = actions;
  const container = el('div', { class: 'developer-view-container' });

  if (!s.developerState) {
    s.developerState = {
      subTab: s.canonicalSection || 'llm', // 'llm' | 'ingest' | 'timeline' | 'logs'
      ingestBatches: [],
      ingestLoading: false,
      selectedBatch: null,
      runtimeLogs: [],
      logsFilter: 'all',
    };
  }
  const ds = s.developerState;
  if (s.canonicalSection && s.canonicalSection !== ds.subTab) {
    ds.subTab = s.canonicalSection;
  }

  // 1. Sub-tab strip
  const tabs = [
    { id: 'llm', label: '⚡ LLM / Chat Trace' },
    { id: 'ingest', label: '🧠 Knowledge Ingest Trace' },
    { id: 'timeline', label: '⏳ Timeline Companion' },
    { id: 'logs', label: '📋 Runtime Logs' }
  ];

  const tabStrip = el('div', {
    class: 'developer-tab-strip',
    style: 'display:flex; gap:8px; border-bottom:1px solid #e2e8f0; padding-bottom:12px; margin-bottom:16px;'
  },
    ...tabs.map(t =>
      button(t.label, () => {
        ds.subTab = t.id;
        selectCanonicalPage('developer', t.id);
      }, {
        class: ds.subTab === t.id ? 'primary' : 'secondary',
        style: 'font-size:13px; padding:6px 14px;'
      })
    )
  );

  const contentArea = el('div', { class: 'developer-subtab-content' });

  // 2. Sub-tab 1: LLM / Chat Trace
  if (ds.subTab === 'llm') {
    s.eventTab = 'traces';
    contentArea.append(eventsView(actions));
  }

  // 3. Sub-tab 2: Knowledge Ingest Trace
  else if (ds.subTab === 'ingest') {
    const ingestContainer = el('div', { class: 'ingest-trace-view' });

    // Query real background maintenance events from snapshot
    const realBatches = (s.snapshot?.events || []).filter(e => e.moduleId === 'memory_turn' || e.moduleId === 'memory_queue' || e.moduleId === 'summary');

    ingestContainer.append(
      el('h3', { style: 'margin-top:0;' }, '知识整理与沉淀批次流水 (Ingest Trace)'),
      el('p', { class: 'subtle' }, '追踪每一次后台记忆维护批次。严格记录候选提炼、准入决策与最终入库关联，禁止伪造 Trace。'),
      realBatches.length > 0 ?
        el('div', { class: 'ingest-batch-list', style: 'display:flex; flex-direction:column; gap:12px; margin-top:16px;' },
          ...realBatches.map(b =>
            el('div', {
              style: 'padding:14px; border:1px solid #e2e8f0; border-radius:8px; background:#f8fafc;'
            },
              el('div', { style: 'display:flex; justify-content:space-between; margin-bottom:6px;' },
                el('strong', { style: 'color:#0f172a;' }, `事件 #${b.id} · ${b.moduleId}`),
                el('span', { class: `badge ${b.kind === 'failed' ? 'error' : 'success'}` }, b.kind === 'failed' ? '失败' : '正常')
              ),
              el('p', { style: 'margin:4px 0; font-size:13px; color:#334155;' }, b.message),
              el('div', { style: 'font-size:12px; color:#64748b; line-height:1.5;' },
                el('div', {}, `记录时间: ${time(b.at)} ${b.elapsedMs ? ` · 耗时: ${b.elapsedMs}ms` : ''}`)
              )
            )
          )
        ) :
        el('div', { class: 'subtle', style: 'padding:24px; text-align:center; background:#f8fafc; border-radius:8px; margin-top:16px;' },
          '当前无后台记忆整理与沉淀批次记录。'
        )
    );
    contentArea.append(ingestContainer);
  }

  // 4. Sub-tab 3: Timeline Companion Trace
  else if (ds.subTab === 'timeline') {
    contentArea.append(createModernTimelineView(actions));
  }

  // 5. Sub-tab 4: Runtime Logs
  else if (ds.subTab === 'logs') {
    s.eventTab = 'raw';
    contentArea.append(eventsView(actions));
  }

  container.append(
    el('div', { style: 'margin-bottom:8px;' },
      el('h2', { style: 'margin:0; font-size:18px;' }, '开发者调试中心 (Developer Mode)'),
      el('p', { class: 'subtle', style: 'margin:4px 0 16px 0;' }, '包含完整的全链路请求追踪、记忆提炼批次、叙事时间线与系统运行日志。')
    ),
    tabStrip,
    contentArea
  );

  return container;
}
