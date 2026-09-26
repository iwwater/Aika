// UIR-04: Modern Playground View for Interactive Dialogue Testing.
// Connects to /api/playground/* facade and standard TurnPort.
// Features Chinese IME protection, idempotency, explicit cancel, and contextual inspection.

import { el, button, field, notice, card, time } from './dom.mjs';
import { ICONS, svgIcon } from './icons.mjs';

export function createPlaygroundView(actions) {
  const { s, client, selectCanonicalPage } = actions;
  const container = el('div', { class: 'playground-view-container' });

  if (!s.playgroundState) {
    s.playgroundState = {
      sessionId: `pg-session-${Date.now()}`,
      turns: [],
      currentInputText: '',
      isComposing: false, // Tracks Chinese IME composition state
      isSubmitting: false,
      activeTurnId: null,
      activeOperationId: null,
      backendChecked: false,
      backendAvailable: true,
      backendMessage: '',
      probeNotice: null,
      error: '',
      message: '',
      contextProbeQuery: '',
      contextProbeResult: null,
      isProbingContext: false,
    };
  }
  const ps = s.playgroundState;

  if (!ps.backendChecked && !ps.checkingBackend && client?.token) {
    ps.checkingBackend = true;
    client.request('/api/playground/session')
      .then(res => {
        ps.checkingBackend = false;
        ps.backendChecked = true;
        ps.backendAvailable = true;
        actions.render();
      })
      .catch(err => {
        ps.checkingBackend = false;
        ps.backendChecked = true;
        ps.backendAvailable = false;
        ps.backendMessage = err.message || '当前环境未装载正式 Playground 调试后端。';
        actions.render();
      });
  }

  // 1. Header Banner & Safety Notice
  const safetyBanner = !ps.backendAvailable ? el('div', {
    class: 'notice error',
    style: 'display:flex; align-items:center; gap:8px; margin-bottom:16px; padding:10px 14px; border-radius:8px;'
  },
    svgIcon(ICONS.bell, 'notice-icon'),
    el('span', { style: 'font-size:13px; line-height:1.5;' },
      `⚠️ 正式 Playground 后端端口未装载 (unavailable)：${ps.backendMessage || '未连接到正式链路'}。无法发起实时轮次调试。`
    )
  ) : el('div', {
    class: 'notice warning',
    style: 'display:flex; align-items:center; gap:8px; margin-bottom:16px; padding:10px 14px; border-radius:8px;'
  },
    svgIcon(ICONS.bell, 'notice-icon'),
    el('span', { style: 'font-size:13px; line-height:1.5;' },
      '📢 正式调试模式：当前会话与桌宠共享生产对话通道。提交的文本将写入真实历史记录，并可能参与沉淀记忆候选。'
    )
  );

  // 2. Active Session Info Bar
  const charId = s.pairing?.characterId || s.character || 'companion';
  const effectiveModel = s.snapshot?.settings?.effective?.providers?.dialogue?.model || '未检测到模型';
  const effectiveVoice = s.snapshot?.settings?.effective?.providers?.tts?.voice || '未配置音色';

  const sessionBar = el('div', {
    class: 'playground-session-bar',
    style: 'display:flex; justify-content:space-between; align-items:center; background:#f8fafc; border:1px solid #e2e8f0; border-radius:8px; padding:10px 16px; margin-bottom:16px;'
  },
    el('div', { style: 'display:flex; gap:16px; font-size:12px; color:#475569;' },
      el('span', {}, `当前角色: `, el('strong', { style: 'color:#0f172a;' }, charId)),
      el('span', {}, `生效模型: `, el('code', { style: 'color:#2563eb;' }, effectiveModel)),
      el('span', {}, `合成音色: `, el('strong', { style: 'color:#0f172a;' }, effectiveVoice)),
      el('span', {}, `会话: `, el('code', {}, ps.sessionId.slice(-10)))
    ),
    el('div', { style: 'display:flex; gap:8px;' },
      button('清空界面显示', () => {
        ps.turns = [];
        actions.render();
      }, { class: 'subtle-btn', style: 'font-size:11px;' })
    )
  );

  // 3. Dialogue History Display
  const chatList = el('div', {
    class: 'playground-chat-list',
    style: 'display:flex; flex-direction:column; gap:14px; min-height:280px; max-height:480px; overflow-y:auto; padding:16px; background:#ffffff; border:1px solid #e2e8f0; border-radius:8px; margin-bottom:16px;'
  });

  if (ps.turns.length === 0) {
    chatList.append(
      el('div', { class: 'subtle', style: 'margin:auto; text-align:center; padding:32px;' },
        '💬 暂无调试记录。在下方输入文本并点击发送，即可与有效模型进行正式轮次交互。'
      )
    );
  } else {
    for (const t of ps.turns) {
      // User bubble
      const userBubble = el('div', {
        class: 'chat-bubble user-bubble',
        style: 'align-self:flex-end; max-width:80%; padding:10px 14px; background:#3b82f6; color:#ffffff; border-radius:12px 12px 2px 12px; font-size:14px; line-height:1.5; word-break:break-word;'
      }, t.text);

      // Assistant bubble
      const assistantBubble = el('div', {
        class: 'chat-bubble assistant-bubble',
        style: 'align-self:flex-start; max-width:80%; padding:12px 16px; background:#f1f5f9; color:#1e293b; border-radius:12px 12px 12px 2px; font-size:14px; line-height:1.6; word-break:break-word; border:1px solid #e2e8f0;'
      });

      if (t.status === 'running') {
        assistantBubble.append(
          el('div', { style: 'display:flex; align-items:center; gap:8px; color:#64748b;' },
            el('span', { class: 'spinner', style: 'display:inline-block; animation:spin 1s linear infinite;' }, '⏳'),
            '正在思考与生成回复...'
          )
        );
      } else if (t.status === 'cancelled') {
        assistantBubble.append(
          el('span', { style: 'color:#dc2626;' }, '⚠️ 该轮次生成已被用户手动取消。')
        );
      } else if (t.status === 'failed') {
        assistantBubble.append(
          el('span', { style: 'color:#dc2626;' }, `❌ 生成失败: ${t.error || '服务未返回有效响应'}`)
        );
      } else {
        assistantBubble.append(
          el('div', {}, t.reply || '（未接收到文本输出）'),
          el('div', { style: 'margin-top:10px; padding-top:8px; border-top:1px dashed #cbd5e1; display:flex; justify-content:space-between; align-items:center;' },
            el('small', { class: 'subtle', style: 'font-size:11px;' }, time(t.completedAt || Date.now())),
            button('🔍 查看本次调用 Trace', () => {
              selectCanonicalPage('developer', 'llm');
            }, { class: 'subtle-btn', style: 'font-size:11px; color:#2563eb; padding:2px 6px;' })
          )
        );
      }

      chatList.append(userBubble, assistantBubble);
    }
  }

  // 4. Input Area with Chinese IME Safety
  const inputField = el('textarea', {
    id: 'playground-text-input',
    rows: '3',
    style: 'width:100%; padding:10px 12px; border:1px solid #cbd5e1; border-radius:8px; font-size:14px; font-family:inherit; resize:vertical; outline:none;',
    placeholder: '输入对话调试文本（Enter 发送，Shift+Enter 换行，支持中文输入法）...',
    value: ps.currentInputText,
    disabled: ps.isSubmitting || !ps.backendAvailable,
    onInput: e => {
      ps.currentInputText = e.target.value;
      const sendBtn = container.querySelector('#playground-send-btn');
      if (sendBtn) sendBtn.disabled = ps.isSubmitting || !ps.backendAvailable || !e.target.value.trim();
    },
    onCompositionstart: () => { ps.isComposing = true; },
    onCompositionend: () => { ps.isComposing = false; },
    onKeydown: e => {
      // Iron Rule: If Chinese IME composition is in progress, do not submit on Enter!
      if (e.key === 'Enter' && !e.shiftKey && !ps.isComposing && ps.backendAvailable) {
        e.preventDefault();
        doSubmitTurn();
      }
    }
  });

  async function doSubmitTurn() {
    const text = (ps.currentInputText || '').trim();
    if (!text || ps.isSubmitting || !ps.backendAvailable) return;

    ps.isSubmitting = true;
    ps.error = '';
    const operationId = crypto.randomUUID();
    ps.activeOperationId = operationId;
    ps.activeTurnId = null;

    const turnItem = {
      turnId: '',
      operationId,
      text,
      status: 'running',
      reply: null,
      traceRef: null,
      startedAt: new Date().toISOString()
    };
    ps.turns.push(turnItem);
    ps.currentInputText = '';
    actions.render();

    try {
      const charId = s.pairing?.characterId || 'companion';
      const userId = s.pairing?.userId || 'default-user';
      const instanceId = s.pairing?.characterInstanceId || 'companion-default';

      const res = await client.request('/api/playground/turns', {
        method: 'POST',
        body: {
          operationId,
          sessionId: ps.sessionId,
          pairing: { userId, characterId: charId, characterInstanceId: instanceId },
          text
        }
      });

      turnItem.turnId = res?.turnId || '';
      ps.activeTurnId = res?.turnId || null;
      turnItem.status = res?.status || 'completed';
      turnItem.reply = res?.reply ?? (res?.status === 'completed' ? '（未接收到文本输出）' : null);
      turnItem.traceRef = res?.traceRef || res?.turnId || null;
      turnItem.completedAt = res?.completedAt || new Date().toISOString();
    } catch (err) {
      turnItem.status = 'failed';
      turnItem.error = err.message || String(err);
      turnItem.completedAt = new Date().toISOString();
    } finally {
      ps.isSubmitting = false;
      actions.render();
    }
  }

  async function doCancelTurn() {
    const targetTurnId = ps.activeTurnId || (ps.turns.find(t => t.status === 'running')?.turnId);
    if (!targetTurnId) return;
    try {
      await client.request(`/api/playground/turns/${encodeURIComponent(targetTurnId)}/cancel`, {
        method: 'POST'
      });
      const active = ps.turns.find(t => t.turnId === targetTurnId || (t.status === 'running' && !t.turnId));
      if (active) active.status = 'cancelled';
    } catch (err) {
      console.warn('Cancel turn failed:', err);
    } finally {
      ps.isSubmitting = false;
      ps.activeTurnId = null;
      actions.render();
    }
  }

  const sendBar = el('div', { style: 'display:flex; justify-content:space-between; align-items:center; margin-top:8px;' },
    el('small', { class: 'subtle', style: 'font-size:12px;' }, '按 Enter 发送，Shift+Enter 换行。中文输入法选字时不误触发。'),
    el('div', { style: 'display:flex; gap:10px;' },
      ps.isSubmitting ?
        button('⏹️ 取消生成', doCancelTurn, { class: 'secondary', style: 'color:#dc2626; border-color:#fca5a5;' }) :
        null,
      button(ps.isSubmitting ? '发送中...' : '发送调试轮次', doSubmitTurn, {
        id: 'playground-send-btn',
        class: 'primary',
        disabled: ps.isSubmitting || !ps.backendAvailable || !ps.currentInputText.trim()
      })
    )
  );

  // 5. Capability Probe & Inspection Box (STT / TTS / Context Probe)
  const probeCard = card('调试辅助能力 · 试音与检索试算',
    el('div', { style: 'display:flex; gap:12px; margin-bottom:12px; flex-wrap:wrap;' },
      button('🎤 STT 麦克风试录', async () => {
        try {
          const res = await client.request('/api/microphone/test');
          ps.probeNotice = { type: 'info', text: '麦克风测试状态：' + JSON.stringify(res) };
        } catch {
          ps.probeNotice = { type: 'warning', text: '当前麦克风设备不可用或未授权 (unavailable)' };
        }
        actions.render();
      }, { class: 'secondary', style: 'font-size:12px;' }),
      button('🔊 TTS 音色试听', async () => {
        try {
          ps.probeNotice = { type: 'info', text: `当前角色生效音色：[${effectiveVoice}]（正式试听请在桌宠主控端播放）` };
        } catch {
          ps.probeNotice = { type: 'warning', text: 'TTS 试听不可用' };
        }
        actions.render();
      }, { class: 'secondary', style: 'font-size:12px;' }),
    ),
    ps.probeNotice ? el('div', { class: `notice ${ps.probeNotice.type}`, style: 'margin-bottom:10px; padding:6px 12px; font-size:12px;' }, ps.probeNotice.text) : null,
    el('div', { style: 'border-top:1px solid #e2e8f0; padding-top:12px;' },
      el('label', { style: 'font-size:12px; font-weight:600; color:#475569;' }, '上下文检索试算 (Context Probe) · 仅试算，不冒充真实已消耗 Context：'),
      el('div', { style: 'display:flex; gap:10px; margin-top:6px;' },
        field('试算关键词', 'context-probe-input', ps.contextProbeQuery, v => { ps.contextProbeQuery = v; }, {
          placeholder: '输入查询词，试算当前召回的记忆与事实...',
          style: 'flex:1;'
        }),
        button('执行试算', async () => {
          if (!ps.contextProbeQuery.trim()) return;
          ps.isProbingContext = true;
          actions.render();
          try {
            const data = await client.request(`/api/context?characterId=${encodeURIComponent(charId)}&query=${encodeURIComponent(ps.contextProbeQuery.trim())}`);
            ps.contextProbeResult = data;
          } catch (e) {
            ps.contextProbeResult = { error: e.message || String(e) };
          } finally {
            ps.isProbingContext = false;
            actions.render();
          }
        }, { class: 'secondary', disabled: ps.isProbingContext })
      ),
      ps.contextProbeResult ?
        el('div', { style: 'margin-top:10px; padding:10px; background:#f8fafc; border:1px solid #e2e8f0; border-radius:6px; font-size:12px;' },
          el('div', { style: 'color:#64748b; margin-bottom:4px;' }, `召回记忆 (${ps.contextProbeResult.memories?.length || 0} 条)：`),
          ...(ps.contextProbeResult.memories || []).slice(0, 3).map(m => el('div', { style: 'padding:2px 0;' }, `• ${m.text || JSON.stringify(m)}`)),
          ps.contextProbeResult.error ? el('div', { style: 'color:#dc2626;' }, ps.contextProbeResult.error) : null
        ) : null
    )
  );

  container.append(
    safetyBanner,
    sessionBar,
    chatList,
    inputField,
    sendBar,
    el('div', { style: 'margin-top:24px;' }, probeCard)
  );

  return container;
}
