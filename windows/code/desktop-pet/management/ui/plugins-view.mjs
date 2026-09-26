// UIR-06: Modern Plugins View
// Exposes installed packages, lifecycle states, local import, enable/disable, and Flow profiles.

import { el, button, field, notice, card } from './dom.mjs';
import { createStatusBadge } from './envelope.mjs';

export function createPluginsView(actions) {
  const { s, client } = actions;
  const container = el('div', { class: 'plugins-view-container' });

  if (!s.pluginsState) {
    s.pluginsState = {
      packages: [],
      truth: null,
      loaded: false,
      loading: false,
      error: '',
      message: '',
      importPath: '',
      selectedSubTab: s.canonicalSection === 'flow' ? 'flow' : 'list',
    };
  }
  const ps = s.pluginsState;
  if (s.canonicalSection === 'flow' && ps.selectedSubTab !== 'flow') {
    ps.selectedSubTab = 'flow';
  }

  function loadPackages() {
    if (!client?.token || ps.loading) return;
    ps.loading = true;
    ps.error = '';

    Promise.all([
      client.request('/api/next65/packages'),
      client.request('/api/next65/truth').catch(() => null)
    ])
      .then(([pkgs, truth]) => {
        ps.packages = pkgs || [];
        ps.truth = truth;
        ps.loaded = true;
        ps.loading = false;
        actions.render();
      })
      .catch(err => {
        ps.loaded = true;
        ps.loading = false;
        ps.error = '读取插件包失败：' + (err.message || err);
        actions.render();
      });
  }

  if (!ps.loaded && !ps.loading && client?.token) {
    loadPackages();
  }

  // Subtabs: List vs Flow
  const tabStrip = el('div', {
    class: 'plugins-tab-strip',
    style: 'display:flex; gap:10px; margin-bottom:16px; border-bottom:1px solid #e2e8f0; padding-bottom:8px;'
  },
    button('📦 已安装插件包', () => {
      ps.selectedSubTab = 'list';
      actions.selectCanonicalPage('plugins', 'list');
    }, { class: ps.selectedSubTab === 'list' ? 'primary' : 'secondary', style: 'font-size:13px;' }),
    button('🔀 Flow 流程编排 (高级)', () => {
      ps.selectedSubTab = 'flow';
      actions.selectCanonicalPage('plugins', 'flow');
    }, { class: ps.selectedSubTab === 'flow' ? 'primary' : 'secondary', style: 'font-size:13px;' }),
    button('🔄 刷新', () => loadPackages(), { class: 'subtle-btn', style: 'margin-left:auto;' })
  );

  const mainArea = el('div', { class: 'plugins-main-area' });

  if (ps.selectedSubTab === 'list') {
    // Packages List View
    const importBox = el('div', {
      style: 'background:#f8fafc; border:1px solid #e2e8f0; border-radius:8px; padding:12px 16px; margin-bottom:16px; display:flex; gap:10px; align-items:flex-end;'
    },
      field('本地包路径导入 (0.65 扩展包)', 'plugin-import-path', ps.importPath, v => { ps.importPath = v.trim(); }, {
        placeholder: '例如 F:/AIVoice/packages/my-custom-plugin...',
        style: 'flex:1;'
      }),
      button('导入并激活', async () => {
        if (!ps.importPath) return;
        ps.error = '';
        ps.message = '';
        try {
          await client.request('/api/next65/packages/import', {
            method: 'POST',
            body: { sourceRoot: ps.importPath }
          });
          ps.importPath = '';
          ps.message = '插件包导入成功！';
          loadPackages();
        } catch (e) {
          ps.error = '导入失败：' + (e.message || e);
          actions.render();
        }
      }, { class: 'primary' })
    );

    const listCards = el('div', { style: 'display:flex; flex-direction:column; gap:12px;' });
    if (ps.error) {
      listCards.append(el('div', { class: 'notice warning', style: 'margin-bottom:8px;' }, ps.error));
    }
    if (ps.message) {
      listCards.append(el('div', { class: 'notice success', style: 'margin-bottom:8px;' }, ps.message));
    }
    if (ps.packages.length === 0) {
      listCards.append(
        el('div', { class: 'subtle', style: 'padding:24px; text-align:center; background:#f8fafc; border-radius:8px;' },
          ps.loading ? '正在读取插件列表...' : (ps.error ? '当前插件服务不可用 (unavailable)' : '当前未安装任何本地插件包。')
        )
      );
    } else {
      for (const p of ps.packages) {
        const status = p.ready ? 'ready' : (p.enabled ? 'loading' : 'disabled');
        const cardItem = el('div', {
          style: 'padding:16px; border:1px solid #e2e8f0; border-radius:8px; background:#ffffff; display:flex; justify-content:space-between; align-items:flex-start;'
        },
          el('div', {},
            el('div', { style: 'display:flex; align-items:center; gap:8px; margin-bottom:4px;' },
              el('strong', { style: 'font-size:15px; color:#0f172a;' }, p.packageId),
              createStatusBadge(status, p.ready ? '已就绪 (Ready)' : (p.enabled ? '已启用 (Enabled)' : '已停用 (Disabled)'))
            ),
            el('p', { class: 'subtle', style: 'margin:4px 0; font-size:13px;' },
              p.manifestLabels && p.manifestLabels.length > 0 ? `包含插件：${p.manifestLabels.join('、')}` : '基础扩展包'
            ),
            el('small', { class: 'subtle', style: 'font-size:11px;' },
              `Loaded: ${p.loaded ? '是' : '否'} | Active: ${p.active ? '是' : '否'} | 路径: ${p.packageRoot || '本地'}`
            )
          ),
          el('div', { style: 'display:flex; gap:8px;' },
            p.enabled ?
              button('停用', async () => {
                try {
                  await client.request(`/api/next65/packages/${encodeURIComponent(p.packageId)}/disable`, { method: 'POST' });
                  loadPackages();
                } catch (err) {
                  alert('停用失败：' + (err.message || err));
                }
              }, { class: 'secondary' }) :
              null,
            button('卸载', async () => {
              if (!confirm(`确定要从本机卸载插件包 ${p.packageId} 吗？`)) return;
              try {
                await client.request(`/api/next65/packages/${encodeURIComponent(p.packageId)}/uninstall`, { method: 'POST' });
                loadPackages();
              } catch (err) {
                alert('卸载失败：' + (err.message || err));
              }
            }, { class: 'subtle-btn', style: 'color:#dc2626;' })
          )
        );
        listCards.append(cardItem);
      }
    }

    mainArea.append(importBox, listCards);
  } else {
    // Flow Profile View
    mainArea.append(
      el('div', { class: 'card' },
        el('h3', {}, 'Flow 节点编排流程'),
        el('p', { class: 'subtle' }, '管理各阶段运行时 Flow Profiles。'),
        el('div', { style: 'padding:12px; background:#f8fafc; border-radius:6px; font-size:13px;' },
          ps.truth ? `注册能力：${(ps.truth.registeredCapabilities || []).join('、') || '基础能力'}` : '正在读取 Flow 状态...'
        )
      )
    );
  }

  container.append(
    el('h2', { style: 'margin-top:0;' }, '插件扩展与能力包 (Plugins)'),
    el('p', { class: 'subtle', style: 'margin-bottom:16px;' }, '管理本地 0.65 插件包生命周期、启停与高级流程。'),
    ps.error && notice(ps.error, 'error'),
    ps.message && notice(ps.message, 'success'),
    tabStrip,
    mainArea
  );

  return container;
}
