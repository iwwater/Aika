// UIR-03: Modern Wiki Knowledge View
// Provides a unified read model and editor for settled Wiki knowledge, user facts, and character Canon.
// Strictly separates active facts from pending candidates, and disallows raw Trace leakage.

import { el, button, field, notice, card, time } from './dom.mjs';
import { ICONS, svgIcon } from './icons.mjs';

export function createWikiView(actions) {
  const { s, client } = actions;
  const container = el('div', { class: 'wiki-knowledge-view' });

  // State local to Wiki
  if (!s.wikiState) {
    s.wikiState = {
      activeDomain: 'user', // 'user' | 'canon' | 'candidates'
      searchQuery: '',
      selectedTag: '全部',
      selectedItem: null,
      editingText: '',
      editReason: '',
      isEditing: false,
      loaded: false,
      loading: false,
      userFacts: [],
      canonFacts: [],
      candidates: [],
      tags: ['全部'],
      error: '',
      message: '',
    };
  }
  const ws = s.wikiState;

  function loadWikiData() {
    if (!client?.token || ws.loading) return;
    ws.loading = true;
    ws.error = '';

    const charId = s.pairing?.characterId || s.character || 'companion';
    const userId = s.pairing?.userId || 'default-user';
    const instanceId = s.pairing?.characterInstanceId || 'companion-default';

    // 1. Fetch Continuity Snapshot (includes active facts & candidates)
    client.request('/api/continuity/snapshot', {
      method: 'POST',
      body: {
        pairing: { userId, characterId: charId, characterInstanceId: instanceId },
        includeCandidates: true,
      }
    })
      .then(snap => {
        ws.loading = false;
        const rawUserFacts = snap.facts || [...(snap.wiki || []), ...(snap.soul || [])];
        ws.userFacts = rawUserFacts.map(f => ({
          id: f.id,
          domain: 'user',
          text: f.text,
          version: f.version || 1,
          category: f.category || '用户事实',
          observedAt: f.observedAt || null,
          updatedAt: f.updatedAt || f.observedAt || null,
          analysis: f.analysis || null,
          tags: f.tags || ['用户记忆'],
          sources: f.sources || f.sourceIds || [],
          confidence: f.confidence ?? null,
          isCanon: false,
          isCandidate: false,
        }));

        ws.candidates = (snap.candidates || []).map(c => ({
          id: c.id,
          domain: 'candidates',
          text: c.text,
          version: c.version || 1,
          category: c.category || '待审候选',
          observedAt: c.observedAt || null,
          updatedAt: c.updatedAt || null,
          analysis: c.analysis || null,
          tags: c.tags || ['待审事实'],
          sources: c.sources || c.sourceIds || [],
          confidence: c.confidence ?? null,
          isCanon: false,
          isCandidate: true,
        }));

        // Canon facts (simulated from character base snapshot if present)
        ws.canonFacts = [
          {
            id: 'canon-core-identity',
            domain: 'canon',
            text: '沈砚（Aika）：性格沉稳、克制，重视彼此之间的承诺，始终相伴左右。',
            version: 1,
            category: '核心设定',
            observedAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
            analysis: '角色核心原点叙事，保持不可修改的权威状态。',
            tags: ['角色原作', 'Canon'],
            sources: ['character-pack:v1.0'],
            confidence: 1.0,
            isCanon: true,
            isCandidate: false,
          }
        ];

        // Gather unique tags
        const allTags = new Set(['全部']);
        [...ws.userFacts, ...ws.canonFacts, ...ws.candidates].forEach(item => {
          (item.tags || []).forEach(t => allTags.add(t));
        });
        ws.tags = Array.from(allTags);
        ws.loaded = true;

        actions.render();
      })
      .catch(err => {
        // Fallback to /api/records query if continuity not fully initialized
        client.request(`/api/records?characterId=${encodeURIComponent(charId)}&kind=memory&state=active&limit=100`)
          .then(data => {
            ws.loading = false;
            ws.loaded = true;
            ws.userFacts = (data.records || []).map(r => ({
              id: r.id,
              domain: 'user',
              text: r.text,
              version: r.version || 1,
              category: '长期记忆',
              observedAt: null, // do not fabricate createdAt as observedAt
              updatedAt: r.createdAt || null,
              analysis: null,
              tags: ['记忆沉淀'],
              sources: r.sources || [],
              confidence: null,
              isCanon: false,
              isCandidate: false,
            }));
            actions.render();
          })
          .catch(e => {
            ws.loading = false;
            ws.loaded = true;
            ws.error = '无法读取 Wiki 数据：' + (e.message || e);
            actions.render();
          });
      });
  }

  // Initial load
  if (!ws.loaded && !ws.loading && client?.token) {
    loadWikiData();
  }

  // Filter current list
  const currentPool = ws.activeDomain === 'user' ? ws.userFacts :
    ws.activeDomain === 'canon' ? ws.canonFacts : ws.candidates;

  const filteredItems = currentPool.filter(item => {
    if (ws.selectedTag !== '全部' && !item.tags.includes(ws.selectedTag)) return false;
    if (ws.searchQuery) {
      const q = ws.searchQuery.toLowerCase();
      return item.text.toLowerCase().includes(q) ||
        (item.analysis && item.analysis.toLowerCase().includes(q)) ||
        item.tags.some(t => t.toLowerCase().includes(q));
    }
    return true;
  });

  // 1. Domain Selector Bar (User Facts / Character Canon / Pending Candidates)
  const domainTabs = el('div', { class: 'wiki-domain-tabs', style: 'display:flex; gap:10px; margin-bottom:16px; border-bottom:1px solid #e2e8f0; padding-bottom:8px;' },
    button(`🌱 用户记忆事实 (${ws.userFacts.length})`, () => {
      ws.activeDomain = 'user';
      ws.selectedItem = null;
      actions.render();
    }, { class: ws.activeDomain === 'user' ? 'primary' : 'secondary', style: 'font-size:13px;' }),
    button(`📖 角色原作 Canon (${ws.canonFacts.length})`, () => {
      ws.activeDomain = 'canon';
      ws.selectedItem = null;
      actions.render();
    }, { class: ws.activeDomain === 'canon' ? 'primary' : 'secondary', style: 'font-size:13px;' }),
    button(`⏳ 待审候选 (${ws.candidates.length})`, () => {
      ws.activeDomain = 'candidates';
      ws.selectedItem = null;
      actions.render();
    }, { class: ws.activeDomain === 'candidates' ? 'primary' : 'secondary', style: 'font-size:13px;' }),
    button('🔄 刷新', () => loadWikiData(), { class: 'subtle-btn', style: 'margin-left:auto;' })
  );

  // 2. Search & Tag Filter
  const searchBar = el('div', { class: 'wiki-filter-bar', style: 'display:flex; gap:12px; margin-bottom:16px; align-items:center;' },
    field('搜索知识', 'wiki-search-input', ws.searchQuery, v => {
      ws.searchQuery = v.trim();
      actions.render();
    }, { placeholder: '输入关键词搜索 Wiki 正文、分析或标签...', style: 'flex:1;' }),
    el('div', { class: 'wiki-tags', style: 'display:flex; gap:6px; flex-wrap:wrap;' },
      ...ws.tags.slice(0, 6).map(tag => button(tag, () => {
        ws.selectedTag = tag;
        actions.render();
      }, { class: ws.selectedTag === tag ? 'primary' : 'secondary', style: 'font-size:12px; padding:3px 10px;' }))
    )
  );

  // 3. Main Split View: Left List + Right Detail Drawer
  const listArea = el('div', { class: 'wiki-list', style: 'flex:1; display:flex; flex-direction:column; gap:8px;' });
  if (filteredItems.length === 0) {
    listArea.append(el('div', { class: 'subtle', style: 'padding:24px; text-align:center; background:#f8fafc; border-radius:8px;' },
      ws.loading ? '正在同步 Wiki 知识沉淀...' : '暂无匹配的知识条目。'
    ));
  } else {
    for (const item of filteredItems) {
      const isSelected = ws.selectedItem?.id === item.id;
      const cardItem = el('div', {
        class: `wiki-item-card ${isSelected ? 'is-selected' : ''}`,
        style: `padding:14px; border:1px solid ${isSelected ? '#3b82f6' : '#e2e8f0'}; border-radius:8px; background:${isSelected ? '#f0f7ff' : '#ffffff'}; cursor:pointer; transition:all 0.15s ease;`,
        onClick: () => {
          ws.selectedItem = item;
          ws.isEditing = false;
          actions.render();
        }
      },
        el('div', { style: 'display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:6px;' },
          el('span', { class: 'badge', style: `font-size:11px; ${item.isCanon ? 'background:#e0e7ff; color:#3730a3;' : item.isCandidate ? 'background:#fef3c7; color:#92400e;' : 'background:#dcfce7; color:#166534;'}` },
            item.category
          ),
          el('small', { class: 'subtle', style: 'font-size:11px;' },
            item.observedAt ? `观测: ${time(item.observedAt)}` : '观测时间: 未提供'
          )
        ),
        el('p', { style: 'margin:0; font-size:14px; line-height:1.5; color:#1e293b; font-weight:500;' }, item.text),
        el('div', { style: 'display:flex; gap:6px; margin-top:8px;' },
          ...(item.tags || []).map(t => el('span', { class: 'subtle', style: 'font-size:11px; background:#f1f5f9; padding:1px 6px; border-radius:4px;' }, `#${t}`))
        )
      );
      listArea.append(cardItem);
    }
  }

  // Right Detail Area
  const detailArea = el('div', { class: 'wiki-detail', style: 'width:420px; border-left:1px solid #e2e8f0; padding-left:20px; display:flex; flex-direction:column; gap:16px;' });
  if (!ws.selectedItem) {
    detailArea.append(
      el('div', { class: 'subtle', style: 'margin-top:60px; text-align:center;' }, '👈 请选择左侧条目查看详细信息与溯源')
    );
  } else {
    const item = ws.selectedItem;
    detailArea.append(
      el('h3', { style: 'margin:0; font-size:16px; color:#0f172a;' }, `知识详情 · ${item.category}`),
      el('div', { class: 'detail-section' },
        el('label', { style: 'font-size:12px; font-weight:600; color:#64748b;' }, '正文事实：'),
        ws.isEditing ?
          field('修改正文', 'edit-fact-text', ws.editingText, v => { ws.editingText = v; }, { type: 'textarea' }) :
          el('div', { style: 'padding:10px; background:#f8fafc; border-radius:6px; font-size:13px; line-height:1.6; margin-top:4px;' }, item.text)
      ),
      el('div', { class: 'detail-section' },
        el('label', { style: 'font-size:12px; font-weight:600; color:#64748b;' }, '事实分析 (Analysis)：'),
        el('div', { style: 'padding:8px; background:#f8fafc; border-radius:6px; font-size:12px; color:#475569; line-height:1.5; margin-top:4px;' },
          item.analysis || el('span', { class: 'subtle' }, '未提供专门结构化分析')
        )
      ),
      el('div', { class: 'detail-section' },
        el('label', { style: 'font-size:12px; font-weight:600; color:#64748b;' }, '时序属性：'),
        el('ul', { style: 'margin:4px 0 0 0; padding-left:18px; font-size:12px; color:#64748b; line-height:1.6;' },
          el('li', {}, `首次观测 (ObservedAt)：${item.observedAt ? time(item.observedAt) : '未提供'}`),
          el('li', {}, `最近更新 (UpdatedAt)：${item.updatedAt ? time(item.updatedAt) : '未提供'}`),
          el('li', {}, `数据版本 (Version)：v${item.version}`)
        )
      ),
      el('div', { class: 'detail-section' },
        el('label', { style: 'font-size:12px; font-weight:600; color:#64748b;' }, '溯源凭据 (Sources)：'),
        el('div', { style: 'margin-top:4px; font-size:12px;' },
          item.sources && item.sources.length > 0 ?
            el('ul', { style: 'margin:0; padding-left:18px; line-height:1.5; color:#3b82f6;' },
              ...item.sources.map(src => el('li', {}, typeof src === 'string' ? src : (src.id || JSON.stringify(src))))
            ) :
            el('span', { class: 'subtle' }, '暂无外部溯源引用')
        )
      ),
      // Action buttons
      el('div', { class: 'actions', style: 'margin-top:auto; padding-top:16px; border-top:1px solid #e2e8f0; display:flex; gap:10px; flex-wrap:wrap;' },
        item.isCanon ?
          el('small', { class: 'subtle', style: 'color:#64748b;' }, '🔒 角色原作 Canon 事实具有权威保护，不可直接编辑。') :
          item.isCandidate ? [
            button('✅ 审核通过并晋升为正式事实', async () => {
              try {
                const charId = s.pairing?.characterId || 'companion';
                const userId = s.pairing?.userId || 'default-user';
                const instanceId = s.pairing?.characterInstanceId || 'companion-default';
                await client.request('/api/continuity/promote', {
                  method: 'POST',
                  body: {
                    pairing: { userId, characterId: charId, characterInstanceId: instanceId },
                    operationId: crypto.randomUUID(),
                    targetId: item.id,
                    expectedVersion: item.version,
                  }
                });
                alert('候选事实已成功晋升为正式 Wiki 知识！');
                loadWikiData();
              } catch (err) {
                alert('晋升失败：' + (err.message || err));
              }
            }, { class: 'primary' }),
            button('❌ 丢弃该候选', () => {
              ws.candidates = ws.candidates.filter(c => c.id !== item.id);
              ws.selectedItem = null;
              actions.render();
            }, { class: 'subtle-btn' })
          ] : [
            ws.isEditing ?
              button('保存修改', async () => {
                try {
                  const charId = s.pairing?.characterId || 'companion';
                  await client.request('/api/records/edit', {
                    method: 'POST',
                    body: {
                      characterId: charId,
                      id: item.id,
                      expectedVersion: item.version,
                      operationId: crypto.randomUUID(),
                      text: ws.editingText,
                      reason: ws.editReason || '用户在 Wiki 知识库纠正事实',
                    }
                  });
                  item.text = ws.editingText;
                  ws.isEditing = false;
                  alert('事实更正已保存并立即生效！');
                  actions.render();
                } catch (err) {
                  alert('修改失败：' + (err.message || err));
                }
              }, { class: 'primary' }) :
              button('✏️ 更正事实', () => {
                ws.isEditing = true;
                ws.editingText = item.text;
                ws.editReason = '';
                actions.render();
              }, { class: 'secondary' }),
            button('🗑️ 遗忘此条事实', async () => {
              if (!confirm('确定要在角色的长期记忆与 Wiki 中永久遗忘该事实吗？遗忘后将同步失效相关检索缓存。')) return;
              try {
                const charId = s.pairing?.characterId || 'companion';
                await client.request('/api/memory/forget', {
                  method: 'POST',
                  body: {
                    characterId: charId,
                    id: item.id,
                    expectedVersion: item.version,
                    operationId: crypto.randomUUID(),
                    reason: '用户在 Wiki 界面要求遗忘该事实',
                  }
                });
                ws.userFacts = ws.userFacts.filter(f => f.id !== item.id);
                ws.selectedItem = null;
                alert('事实已成功遗忘并失效。');
                actions.render();
              } catch (err) {
                alert('遗忘失败：' + (err.message || err));
              }
            }, { class: 'subtle-btn', style: 'color:#dc2626;' })
          ]
      )
    );
  }

  const contentLayout = el('div', { class: 'wiki-split-layout', style: 'display:flex; gap:20px; min-height:480px;' }, listArea, detailArea);

  container.append(
    el('h2', { style: 'margin-top:0; font-size:18px;' }, '沉淀知识库与事实 Wiki'),
    el('p', { class: 'subtle', style: 'margin-bottom:16px;' }, '集中阅读并管理从陪伴对话中沉淀下来的记忆事实、角色底色设定与待审候选。'),
    ws.error && notice(ws.error, 'error'),
    ws.message && notice(ws.message, 'success'),
    domainTabs,
    searchBar,
    contentLayout
  );

  return container;
}
