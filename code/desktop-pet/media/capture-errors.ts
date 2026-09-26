import type { DeviceFailure } from '../contracts/desktop-bridge.js';
import { abortError } from './scope.js';

type Stage = DeviceFailure['stage'];
const fallback: DeviceFailure = { code: 'device_operation_failed', stage: 'unknown' };

/** Validate pairs, not just individual enum values; never retain remote text or extra fields. */
export function readDeviceFailure(value: unknown): DeviceFailure | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const { code, stage } = value as Record<string, unknown>;
  const valid =
    ((code === 'permission_denied' || code === 'device_unavailable') && stage === 'get_user_media') ||
    (code === 'capture_module_failed' && stage === 'audio_worklet') ||
    (code === 'capture_start_failed' && typeof stage === 'string' && ['get_user_media', 'audio_resume', 'camera_preview', 'unknown'].includes(stage)) ||
    (code === 'capture_finish_failed' && stage === 'capture_finish') ||
    (code === 'device_operation_failed' && stage === 'unknown');
  if (valid) return { code, stage } as DeviceFailure;
}

export function deviceFailureMessage(failure: DeviceFailure): string {
  const safe = readDeviceFailure(failure) ?? fallback;
  switch (safe.code) {
    case 'permission_denied': return '未能获得麦克风或摄像头权限，请在系统设置中允许访问后重试。';
    case 'device_unavailable': return '麦克风或摄像头不可用，请检查设备连接、占用情况后重试。';
    case 'capture_module_failed': return '录音组件加载失败，请重新打开应用后重试。';
    case 'capture_finish_failed': return '这次录音未能完成，请重试。';
    case 'capture_start_failed':
      if (safe.stage === 'audio_resume') return '录音音频未能启动，请重新打开应用后重试。';
      if (safe.stage === 'camera_preview') return '摄像头画面未能启动，请检查设备后重试。';
      return '录音启动失败，请重试；若仍失败，请重新打开应用。';
    case 'device_operation_failed': return '设备操作未能完成，请重试；若仍失败，请重新打开应用。';
  }
}

export class CaptureError extends Error {
  readonly failure: DeviceFailure;
  constructor(failure: DeviceFailure) {
    const safe = readDeviceFailure(failure) ?? fallback;
    super(deviceFailureMessage(safe));
    this.name = 'CaptureError'; this.failure = Object.freeze(safe);
  }
}

/** Only our explicit, fixed diagnostics may be serialized by the desktop bridge. */
export function toDeviceFailure(error: unknown): DeviceFailure {
  return error instanceof CaptureError ? { ...error.failure } : { ...fallback };
}

export function captureFailure(error: unknown, stage: Stage, signal: AbortSignal): Error {
  if (signal.aborted) return abortError();
  if (error instanceof CaptureError) return error;
  const name = error && typeof error === 'object' && 'name' in error ? error.name : undefined;
  if (stage === 'get_user_media' && (name === 'NotAllowedError' || name === 'SecurityError')) return new CaptureError({ code: 'permission_denied', stage });
  if (stage === 'get_user_media' && (name === 'NotFoundError' || name === 'NotReadableError' || name === 'OverconstrainedError')) return new CaptureError({ code: 'device_unavailable', stage });
  if (stage === 'audio_worklet') return new CaptureError({ code: 'capture_module_failed', stage });
  if (stage === 'capture_finish') return new CaptureError({ code: 'capture_finish_failed', stage });
  return new CaptureError({ code: 'capture_start_failed', stage });
}
