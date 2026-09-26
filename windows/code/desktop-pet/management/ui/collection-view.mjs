// N081-06: 本地采集（Collection）控制台视图。
//
// 本页是 0.81 的最小可用入口：展示真实来源状态、让用户为每个来源显式选择范围并启用、回看最近
// 样本、标记有用/无用/错配/漏采，以及单条/时段/清空删除。
//
// 边界：
//  - 默认零采集；未授权来源显示为“未启用”，未接线来源显示为“不可用”，两者都不伪装健康。
//  - 配对由服务端从当前运行实例确定；浏览器不传也不改写 userId/characterId/instanceId。
//  - 写操作带 operationId 与各自的 expectedRevision；冲突提示刷新，不静默重试。
//  - 图片经鉴权资产路由读取；本页不接触任意文件路径，也不展示键盘正文。

import { el, button, card, notice } from './dom.mjs';

const SOURCE_LABEL = Object.freeze({
  keyboard: '键盘活动',
  screenshot_directory: '截图目录',
  clipboard_image: '剪贴板图片',
});

const STATE_LABEL = Object.freeze({
  active: '已启用',
  paused: '已暂停',
  stopped: '已停止',
  revoked: '已撤销',
  expired: '已过期',
  disabled: '未启用',
  unavailable: '不可用',
});

const STATE_TONE = Object.freeze({
  active: 'ok',
  paused: 'warn',
  stopped: 'warn',
  revoked: 'muted',
  expired: 'warn',
  disabled: 'muted',
  unavailable: 'error',
});

const ORIGIN_LABEL = Object.freeze({
  directory_candidate: '目录候选',
  clipboard_unknown: '来源不确定',
  correlated_capture: '双通道同一次捕获',
});

function safeError(error, fallback) {
  const message = error instanceof Error ? error.message : '';
  return message && message.length < 200 ? message : fallback;
}

/** Local-day boundaries converted to UTC for the query, so the UI shows local days. */
function localDayRange(days) {
  const to = new Date();
  const from = new Date(to.getTime() - days * 86_400_000);
  return { from: from.toISOString(), to: to.toISOString() };
}

function formatTime(value) {
  if (!value) return '—';
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return '—';
  return new Date(parsed).toLocaleString();
}

export function createCollectionView(client, render, context) {
  let status = null;
  let samples = [];
  let loadError = '';
  let loadPending = false;
  let loaded = false;
  let busy = '';
  let actionError = '';
  let actionNotice = '';
  let directoryDraft = '';
  const retentionDays = 7;
  /** sampleId -> object URL. Revoked whenever the sample set is reloaded or the view is left. */
  const thumbnails = new Map();

  const releaseThumbnails = () => {
    for (const url of thumbnails.values()) URL.revokeObjectURL(url);
    thumbnails.clear();
  };

  /** Read one authenticated thumbnail as an object URL; a revoked sample simply fails to load. */
  const loadThumbnail = async sampleId => {
    if (thumbnails.has(sampleId)) return thumbnails.get(sampleId);
    try {
      const url = await client.requestImage(`/api/collection/samples/${encodeURIComponent(sampleId)}/asset?variant=thumbnail`);
      thumbnails.set(sampleId, url);
      render();
      return url;
    } catch { return null; }
  };

  const operate = async (id, action) => {
    if (busy) return;
    busy = id; actionError = ''; actionNotice = ''; render();
    try {
      await action();
    } catch (error) {
      actionError = safeError(error, '采集操作未完成。');
    } finally {
      busy = ''; render();
    }
  };

  const sourceByKind = kind => [...(status?.sources ?? [])].find(source => source.kind === kind) ?? null;

  const writeSource = async (kind, path, payload, successText) => operate(`${path}:${kind}`, async () => {
    const source = sourceByKind(kind);
    await client.request(`/api/collection/sources/${kind}/${path}`, {
      method: 'POST',
      body: JSON.stringify({ ...payload, expectedRevision: source?.revision ?? 0 }),
    });
    actionNotice = successText;
    await refresh(true);
  });

  const refresh = async (force = false) => {
    const c = context();
    if (c.connection !== 'online' || c.page !== 'collection') return;
    if (loadPending) return;
    // A successful load is not repeated on every render; that is what keeps navigation instant.
    if (loaded && !force) return;
    loadPending = true; loadError = ''; render();
    try {
      // A reload invalidates previously fetched thumbnails; they belong to the old sample set.
      releaseThumbnails();
      status = await client.request('/api/collection/status');
      // Disabled and unavailable sources return no samples; the query is bounded to the retention window.
      const range = localDayRange(retentionDays);
      const page = await client.request(`/api/collection/samples?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}&limit=50`);
      samples = Array.isArray(page?.items) ? page.items : [];
      for (const sample of samples) {
        if (sample.sampleKind === 'image' && !thumbnails.has(sample.id)) void loadThumbnail(sample.id);
      }
      loaded = true;
    } catch (error) {
      loadError = safeError(error, '无法读取本地采集状态。');
      // A failed load must not stay "pending": otherwise the page would re-render forever.
      loaded = true;
    } finally {
      loadPending = false; render();
    }
  };

  const sourceCard = source => {
    const kind = source.kind;
    const label = SOURCE_LABEL[kind] ?? kind;
    const state = STATE_LABEL[source.state] ?? source.state;
    const tone = STATE_TONE[source.state] ?? 'muted';
    const rows = [
      el('p', { class: 'subtle' }, `状态：${state}　授权修订 ${source.revision}`),
      el('p', { class: 'subtle' }, `授权截止：${formatTime(source.grantExpiresAt)}`),
      el('p', { class: 'subtle' }, `最近采集：${formatTime(source.lastAcceptedAt)}`),
      el('p', { class: 'subtle' }, `已接受 ${source.accepted}　重复 ${source.duplicates}　拒绝 ${source.rejected}　丢弃 ${source.dropped}`),
    ];
    // The authorized directory is shown only here, on the authenticated local console.
    if (kind === 'screenshot_directory' && source.directoryDisplayPath) {
      rows.push(el('p', { class: 'subtle' }, `已授权目录：${source.directoryDisplayPath}`));
    }
    if (source.lastErrorCode) rows.push(el('p', { class: 'subtle' }, `最近错误码：${source.lastErrorCode}`));

    const controls = [];
    if (source.state === 'unavailable') {
      // An unwired source is not a permission question; say so instead of offering a dead switch.
      controls.push(notice('当前运行实例没有可用的该来源实现（例如采集 helper 未构建）。基础对话不受影响。', 'warning'));
    } else if (source.state === 'active') {
      controls.push(button(busy ? '处理中…' : '暂停', { onClick: () => void writeSource(kind, 'pause', { operationId: newId('pause', kind) }, `${label}已暂停。`), disabled: !!busy }));
      controls.push(button(busy ? '处理中…' : '停止', { onClick: () => void writeSource(kind, 'stop', { operationId: newId('stop', kind) }, `${label}已停止；按 TTL 管理的旧样本保留。`), disabled: !!busy }));
    } else if (source.state === 'paused') {
      controls.push(button(busy ? '处理中…' : '继续', { onClick: () => void writeSource(kind, 'resume', { operationId: newId('resume', kind) }, `${label}已继续；只接收新事件。`), disabled: !!busy }));
      controls.push(button(busy ? '处理中…' : '停止', { onClick: () => void writeSource(kind, 'stop', { operationId: newId('stop', kind) }, `${label}已停止。`), disabled: !!busy }));
    } else {
      const payload = {
        operationId: newId('activate', kind),
        userConfirmed: true,
        expectedRevision: source.revision || 0,
        // A shorter lifetime than the profile ceiling is allowed; the ceiling is enforced server-side.
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        ...(kind === 'screenshot_directory' ? { directoryRoot: directoryDraft } : {}),
      };
      const canActivate = kind !== 'screenshot_directory' || directoryDraft.trim().length > 0;
      controls.push(button(busy ? '处理中…' : '启用该来源', {
        onClick: () => void writeSource(kind, 'activate', payload, `${label}已启用；只采集此后出现的事件。`),
        disabled: !canActivate || !!busy,
      }));
    }
    // Revocation deletes this source's effective samples, so it is separate from stop and confirmed.
    if (source.state !== 'disabled' && source.state !== 'unavailable') {
      controls.push(button(busy ? '处理中…' : '撤销并删除该来源样本', {
        onClick: () => {
          if (!window.confirm(`撤销${label}会删除该来源当前有效的样本与受管副本，其他来源不受影响。继续吗？`)) return;
          void writeSource(kind, 'revoke', { operationId: newId('revoke', kind), userConfirmed: true }, `${label}已撤销，其样本与受管副本已删除。`);
        },
        disabled: !!busy,
      }));
    }

    const children = [el('h3', { class: `collection-state ${tone}` }, `${label} · ${state}`), ...rows];
    if (kind === 'screenshot_directory') {
      children.push(el('label', { class: 'subtle' }, '授权目录（仅本机可见）',
        el('input', {
          type: 'text', value: directoryDraft, placeholder: '例如 D:\\Screenshots',
          onInput: event => { directoryDraft = event.currentTarget.value; render(); },
        })));
    }
    children.push(el('div', { class: 'collection-controls' }, ...controls));
    return card(label, ...children);
  };

  const sampleCard = sample => {
    const isImage = sample.sampleKind === 'image';
    const title = isImage
      ? `图片候选 · ${ORIGIN_LABEL[sample.origin] ?? sample.origin}`
      : `键盘活动区间 · ${sample.activityCount} 次活动`;
    const meta = [
      el('p', { class: 'subtle' }, `采集时间：${formatTime(sample.receivedAt)}　到期：${formatTime(sample.expiresAt)}`),
      el('p', { class: 'subtle' }, `来源可信度：${sample.sourceConfidence}　修订 ${sample.revision}`),
    ];
    if (!isImage) {
      // Only the interval and its aggregate count are ever shown; no key content exists to show.
      meta.push(el('p', { class: 'subtle' }, `区间：${formatTime(sample.bucketStart)} → ${formatTime(sample.bucketEnd)}${sample.afkBoundary ? '（AFK 边界）' : ''}`));
    }
    const thumbUrl = isImage ? thumbnails.get(sample.id) : null;
    const thumb = isImage
      ? (thumbUrl
        ? el('img', { class: 'collection-thumb', alt: '本地样本缩略图', src: thumbUrl })
        : el('p', { class: 'subtle' }, '缩略图读取中或已失效（撤销/删除后不可读）。'))
      : null;

    const controls = [];
    for (const [label, value] of [['有用', 'useful'], ['无用', 'not_useful'], ['错配', 'mismatch']]) {
      controls.push(button(label, {
        disabled: !!busy,
        onClick: () => void operate(`feedback:${sample.id}`, async () => {
          await client.request(`/api/collection/samples/${encodeURIComponent(sample.id)}/feedback`, {
            method: 'POST',
            body: JSON.stringify({ label: value, expectedRevision: sample.revision, operationId: newId('feedback', sample.id) }),
          });
          actionNotice = `已标记为${label}。`;
          await refresh(true);
        }),
      }));
    }
    controls.push(button('删除', {
      disabled: !!busy,
      onClick: () => void operate(`delete:${sample.id}`, async () => {
        await client.request(`/api/collection/samples/${encodeURIComponent(sample.id)}/delete`, {
          method: 'POST',
          body: JSON.stringify({ expectedRevision: status?.collectionRevision ?? 0, operationId: newId('delete', sample.id) }),
        });
        actionNotice = '该样本已删除；受管副本与投影失效，用户原图不受影响。';
        await refresh(true);
      }),
    }));
    return card(title, ...(thumb ? [thumb] : []), ...meta, el('div', { class: 'collection-controls' }, ...controls));
  };

  return {
    refresh: () => refresh(false),
    // Leaving the page invalidates nothing on the server; it only drops fetched thumbnails.
    leave: () => { loaded = false; releaseThumbnails(); },
    dispose: () => { loaded = false; releaseThumbnails(); },
    view() {
      const children = [];
      if (loadError) children.push(notice(loadError, 'error'));
      if (actionError) children.push(notice(actionError, 'error'));
      if (actionNotice) children.push(notice(actionNotice, 'ok'));

      children.push(notice(
        '本地采集默认关闭。只有你在这里为某个来源选择范围并确认后才会开始；键盘只记录活动次数与区间（不含任何按键内容），图片副本存在本机受管目录，用户原图永不被采集模块删除。'
        + `当前配置档：${status?.profile === 'smoke' ? '快速测试（smoke，短保留期）' : '正常（normal）'}。`,
        'warning'));

      if (!status && loadPending) {
        children.push(card('本地采集', el('p', { class: 'subtle' }, '正在读取采集状态…')));
      } else if (!status) {
        children.push(card('本地采集', el('p', { class: 'subtle' }, '当前运行实例未装配本地采集；其他功能不受影响。')));
      } else {
        children.push(card('受管占用',
          el('p', { class: 'subtle' }, `受管字节：${status.managedBytes}　队列：${status.queueItems} 项 / ${status.queueBytes} 字节`),
          el('p', { class: 'subtle' }, `策略版本：${status.policyVersion}　采集修订：${status.collectionRevision}`),
          el('p', { class: 'subtle' }, `保留期：${Math.round((status.policy?.sampleRetentionMs ?? 0) / 86_400_000 * 10) / 10} 天　受管上限：${status.policy?.managedByteLimit ?? 0} 字节`)));

        children.push(el('div', { class: 'grid collection-grid' }, ...[...status.sources].map(sourceCard)));

        children.push(card('当前配对最近样本',
          el('p', { class: 'subtle' }, loadPending ? '正在读取…' : `最近 ${retentionDays} 天内 ${samples.length} 条（最多显示 50 条）`),
          ...(samples.length === 0
            ? [el('p', { class: 'subtle' }, '暂无有效样本。0 条不代表来源健康。')]
            : samples.map(sampleCard))));

        children.push(card('删除与漏采',
          el('p', { class: 'subtle' }, '清空会删除当前配对试运行的全部样本，并保留无正文 tombstone 防止重放；用户原图不受影响。'),
          el('div', { class: 'collection-controls' },
            button(busy ? '处理中…' : '记录一次漏采标记（无正文）', {
              disabled: !!busy,
              onClick: () => void operate('missing', async () => {
                await client.request('/api/collection/feedback/missing', {
                  method: 'POST',
                  body: JSON.stringify({ kind: 'clipboard_image', observedAt: new Date().toISOString(), operationId: newId('missing', 'now') }),
                });
                actionNotice = '已记录一次漏采标注；不会创建假样本或时间线卡片。';
                render();
              }),
            }),
            button(busy ? '处理中…' : '清空当前配对样本', {
              disabled: !!busy,
              onClick: () => {
                if (!window.confirm('清空会删除当前配对的全部试运行样本与受管副本。继续吗？')) return;
                void operate('clear', async () => {
                  await client.request('/api/collection/samples/clear', {
                    method: 'POST',
                    body: JSON.stringify({ expectedRevision: status?.collectionRevision ?? 0, operationId: newId('clear', 'now'), userConfirmed: true }),
                  });
                  actionNotice = '已清空当前配对样本；用户原图不受影响。';
                  await refresh(true);
                });
              },
            }),
            button(loadPending ? '读取中…' : '刷新', { disabled: loadPending, onClick: () => void refresh(true) }))));
      }
      return el('div', { class: 'page collection-page' }, ...children);
    },
  };
}

let counter = 0;
function newId(prefix, suffix) {
  counter += 1;
  return `${prefix}-${suffix}-${Date.now()}-${counter}`;
}
