/**
 * contracts/schedule.ts
 *
 * 08-04 Formal Schedule Source Contract:
 * Defines ScheduleEvent, ScheduleSourceStatus, and ScheduleSourcePort.
 *
 * Requirements:
 * - Isolation: schedule items are scoped to pairing (user and character instance).
 * - Immutability & Verifiability: each schedule event carries a monotonic revision and sourceService identifier.
 * - Confinement & Fail-closed: in the absence of a configured calendar provider, the port fails closed.
 */

import type { PairingScope } from './character-pack.js';

export type ScheduleSourceKind = 'windows_calendar' | 'caldav' | 'local_file' | 'unconfigured';

export interface ScheduleEvent {
  readonly scheduleId: string;
  readonly revision: number;
  readonly title: string;
  readonly startAt: string;
  readonly endAt: string;
  readonly allDay?: boolean;
  readonly location?: string;
  readonly reminderOffsetMinutes?: number;
  readonly sourceService: ScheduleSourceKind;
  readonly retrievedAt: string;
}

export interface ScheduleSourceStatus {
  readonly available: boolean;
  readonly sourceKind: ScheduleSourceKind;
  readonly lastSyncAt: string | null;
  readonly message: string;
}

export interface ScheduleSourcePort {
  status(pairing: PairingScope): Promise<ScheduleSourceStatus>;
  getUpcomingEvents(pairing: PairingScope, windowStart: string, windowEnd: string): Promise<readonly ScheduleEvent[]>;
  subscribe?(pairing: PairingScope, listener: (events: readonly ScheduleEvent[]) => void): () => void;
}

/** Default fail-closed schedule port when no real external calendar service is configured. */
export class UnavailableScheduleSourcePort implements ScheduleSourcePort {
  async status(_pairing: PairingScope): Promise<ScheduleSourceStatus> {
    return {
      available: false,
      sourceKind: 'unconfigured',
      lastSyncAt: null,
      message: '系统当前未配置外部日历或日程服务。',
    };
  }

  async getUpcomingEvents(_pairing: PairingScope, _windowStart: string, _windowEnd: string): Promise<readonly ScheduleEvent[]> {
    return [];
  }
}
