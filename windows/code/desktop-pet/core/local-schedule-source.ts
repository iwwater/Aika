/**
 * core/local-schedule-source.ts
 *
 * 08-04: Local File-backed Schedule Source Port.
 * Reads user schedule events from an isolated JSON file.
 * Fails gracefully and securely without external network dependencies.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { PairingScope } from '../contracts/character-pack.js';
import type { ScheduleEvent, ScheduleSourcePort, ScheduleSourceStatus } from '../contracts/schedule.js';

export interface RawScheduleItem {
  readonly id: string;
  readonly revision?: number;
  readonly title: string;
  readonly startAt: string;
  readonly endAt: string;
  readonly allDay?: boolean;
  readonly location?: string;
  readonly reminderOffsetMinutes?: number;
}

export class LocalFileScheduleSourcePort implements ScheduleSourcePort {
  private lastSyncAt: string | null = null;

  constructor(
    private readonly filePath: string,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async status(_pairing: PairingScope): Promise<ScheduleSourceStatus> {
    return {
      available: true,
      sourceKind: 'local_file',
      lastSyncAt: this.lastSyncAt,
      message: `本地日程文件来源已激活 (${this.filePath})。`,
    };
  }

  async getUpcomingEvents(pairing: PairingScope, windowStart: string, windowEnd: string): Promise<readonly ScheduleEvent[]> {
    const rawEvents = await this.readRawItems();
    this.lastSyncAt = this.now();

    const startMs = Date.parse(windowStart);
    const endMs = Date.parse(windowEnd);

    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs > endMs) {
      return [];
    }

    const filtered: ScheduleEvent[] = [];
    for (const item of rawEvents) {
      if (typeof item.id !== 'string' || !item.id || typeof item.title !== 'string' || !item.title) continue;
      const eventStartMs = Date.parse(item.startAt);
      const eventEndMs = Date.parse(item.endAt);
      if (!Number.isFinite(eventStartMs) || !Number.isFinite(eventEndMs)) continue;

      if (eventStartMs >= startMs && eventStartMs <= endMs) {
        filtered.push({
          scheduleId: item.id,
          revision: Number.isSafeInteger(item.revision) && (item.revision as number) > 0 ? (item.revision as number) : 1,
          title: item.title,
          startAt: new Date(eventStartMs).toISOString(),
          endAt: new Date(eventEndMs).toISOString(),
          allDay: item.allDay === true,
          reminderOffsetMinutes: typeof item.reminderOffsetMinutes === 'number' ? item.reminderOffsetMinutes : 15,
          sourceService: 'local_file',
          retrievedAt: this.lastSyncAt,
          ...(typeof item.location === 'string' ? { location: item.location } : {}),
        });
      }
    }

    filtered.sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt));
    return Object.freeze(filtered);
  }

  async saveEvents(items: readonly RawScheduleItem[]): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(items, null, 2) + '\n', 'utf8');
  }

  private async readRawItems(): Promise<readonly RawScheduleItem[]> {
    try {
      const content = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(content);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
}
