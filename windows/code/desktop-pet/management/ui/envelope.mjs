// UIR-01: Unified State Badges and Configuration Envelope for Multi-Owner Management Console.

import { el, badge } from './dom.mjs';

/**
 * Standard lifecycle statuses supported across the entire console.
 * Strictly avoids folding all non-error states into misleading "ready".
 */
export const LIFECYCLE_STATUSES = Object.freeze({
  ready: { label: '就绪 / 生效', tone: 'success', aria: 'ready' },
  loading: { label: '加载中', tone: 'info', aria: 'busy' },
  failed: { label: '错误 / 失败', tone: 'error', aria: 'alert' },
  pendingRestart: { label: '待重启生效', tone: 'warning', aria: 'status' },
  unavailable: { label: '不可用 / 未接入', tone: 'muted', aria: 'status' },
  disabled: { label: '已停用', tone: 'muted', aria: 'status' },
  unknown: { label: '状态未确认', tone: 'muted', aria: 'status' },
});

/**
 * Creates an accessible, semantic status badge.
 */
export function createStatusBadge(status, customLabel = null) {
  const meta = LIFECYCLE_STATUSES[status] || LIFECYCLE_STATUSES.unknown;
  const labelText = customLabel || meta.label;
  if (typeof document === 'undefined') {
    return {
      getAttribute(attr) {
        if (attr === 'data-lifecycle-status') return status;
        if (attr === 'role') return meta.aria === 'alert' ? 'alert' : 'status';
        return null;
      },
      className: `status-badge status-${status} badge ${meta.tone}`,
      textContent: labelText,
    };
  }
  const node = el('span', {
    class: `status-badge status-${status} badge ${meta.tone}`,
    role: meta.aria === 'alert' ? 'alert' : 'status',
    'data-lifecycle-status': status,
  }, labelText);
  return node;
}

/**
 * Request Epoch and AbortController manager to eliminate stale response collisions
 * when rapidly switching tabs or characters.
 */
export function createEpochGuard() {
  let currentEpoch = 0;
  let activeController = null;

  return {
    next() {
      if (activeController) {
        activeController.abort();
      }
      currentEpoch += 1;
      activeController = new AbortController();
      return {
        epoch: currentEpoch,
        signal: activeController.signal,
      };
    },
    isCurrent(epoch) {
      return epoch === currentEpoch;
    },
    abort() {
      if (activeController) {
        activeController.abort();
        activeController = null;
      }
    },
    getCurrentEpoch() {
      return currentEpoch;
    }
  };
}

/**
 * Multi-owner Config Envelope for safe form handling, revision checking, and conflict resolution.
 */
export function createConfigEnvelope({
  owner = 'settings',
  scope = 'global',
  initialData = {},
  initialSavedRevision = 1,
  initialEffectiveRevision = 1,
  initialAvailability = 'ready',
} = {}) {
  let savedRevision = initialSavedRevision;
  let effectiveRevision = initialEffectiveRevision;
  let availability = initialAvailability;
  let serverData = structuredClone(initialData);
  let draftData = structuredClone(initialData);
  let conflicted = false;
  let conflictSnapshot = null;

  return {
    owner,
    scope,
    getSavedRevision() { return savedRevision; },
    getEffectiveRevision() { return effectiveRevision; },
    getAvailability() { return availability; },
    getData() { return structuredClone(serverData); },
    getDraft() { return structuredClone(draftData); },
    isConflicted() { return conflicted; },
    getConflictSnapshot() { return conflictSnapshot ? structuredClone(conflictSnapshot) : null; },

    isDirty() {
      return JSON.stringify(serverData) !== JSON.stringify(draftData);
    },

    updateDraft(updater) {
      if (typeof updater === 'function') {
        draftData = updater(structuredClone(draftData));
      } else {
        draftData = structuredClone(updater);
      }
    },

    resetDraft() {
      draftData = structuredClone(serverData);
      conflicted = false;
      conflictSnapshot = null;
    },

    onSaveSuccess({ newSavedRevision, newEffectiveRevision = null, pendingRestart = false }) {
      savedRevision = newSavedRevision;
      if (newEffectiveRevision !== null) {
        effectiveRevision = newEffectiveRevision;
      }
      serverData = structuredClone(draftData);
      conflicted = false;
      conflictSnapshot = null;
      if (pendingRestart) {
        availability = 'pendingRestart';
      } else {
        availability = 'ready';
      }
    },

    /**
     * Preserves the user draft when a 409 conflict or revision mismatch occurs.
     */
    onSaveConflict({ latestServerData, latestServerRevision }) {
      conflicted = true;
      conflictSnapshot = {
        serverData: structuredClone(latestServerData),
        serverRevision: latestServerRevision,
      };
      // We NEVER wipe draftData here! Draft is preserved for user recovery.
      savedRevision = latestServerRevision;
    },

    setAvailability(newStatus) {
      if (LIFECYCLE_STATUSES[newStatus]) {
        availability = newStatus;
      }
    }
  };
}
