/**
 * core/collection-batch-runner.ts
 *
 * N082-06: Incremental batch parsing and scheduling runner.
 * Manages daily, catchup, and manual document/text parsing batches.
 * Bounded concurrency, checkpoint tracking, and persistent daily schedule ledger.
 */

import type { Database } from 'better-sqlite3';
import type { PairingScope } from '../contracts/character-pack.js';
import type { JobStatus, JobTrigger, DerivedTextStatus } from '../contracts/companion-mode.js';
import type { CollectionStore } from '../memory/collection-store.js';
import type { DocumentParser } from './document-parser.js';

export interface BatchRunnerOptions {
  readonly db: Database;
  readonly store: CollectionStore;
  readonly pairing: PairingScope;
  readonly parser?: DocumentParser | undefined;
  readonly now?: (() => string) | undefined;
}

export class CollectionBatchRunner {
  private readonly db: Database;
  private readonly store: CollectionStore;
  private readonly pairing: PairingScope;
  private readonly parser?: DocumentParser | undefined;
  private readonly now: () => string;
  private activeJob: JobStatus | null = null;

  constructor(options: BatchRunnerOptions) {
    this.db = options.db;
    this.store = options.store;
    this.pairing = options.pairing;
    this.parser = options.parser;
    this.now = options.now ?? (() => new Date().toISOString());
    this.#initLedger();
  }

  #initLedger(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS companion_batch_ledger(
        user_id TEXT NOT NULL, character_id TEXT NOT NULL, character_instance_id TEXT NOT NULL,
        scheduled_day TEXT NOT NULL,
        last_success_at TEXT NOT NULL,
        PRIMARY KEY(user_id, character_id, character_instance_id, scheduled_day));
    `);
  }

  /**
   * Request a batch run.
   * If a batch is already running for this pairing, returns the active job.
   * If scheduled daily batch already ran for today, skips to prevent duplication.
   */
  async request(input: {
    readonly trigger: JobTrigger;
    readonly operationId: string;
    readonly expectedPolicyRevision: number;
    readonly generation: number;
    readonly scheduledDay?: string; // YYYY-MM-DD
    readonly readFileBytes?: (payloadRef: string) => Promise<Uint8Array | null>;
  }): Promise<JobStatus> {
    if (this.activeJob && this.activeJob.state === 'running') {
      return this.activeJob;
    }

    const today = input.scheduledDay ?? this.now().slice(0, 10);

    // If daily/catchup, check ledger: do not re-run if already succeeded today
    if (input.trigger === 'daily' || input.trigger === 'catchup') {
      const alreadyRun = this.db.prepare(`
        SELECT 1 FROM companion_batch_ledger
        WHERE user_id=? AND character_id=? AND character_instance_id=? AND scheduled_day=?
      `).get(this.pairing.userId, this.pairing.characterId, this.pairing.characterInstanceId, today);

      if (alreadyRun) {
        return {
          jobId: `skipped-${today}`,
          pairing: this.pairing,
          kind: 'batch',
          trigger: input.trigger,
          policyRevision: input.expectedPolicyRevision,
          generation: input.generation,
          scheduledDay: today,
          cutoff: this.now(),
          state: 'succeeded',
          startedAt: this.now(),
          finishedAt: this.now(),
          checkpoint: null,
          counts: { accepted: 0, processed: 0, failed: 0, skipped: 1, dropped: 0 },
          reasonCode: 'already_completed_today',
        };
      }
    }

    const cutoff = this.now();
    const job = this.store.claimJob({
      pairing: this.pairing,
      kind: 'batch',
      trigger: input.trigger,
      policyRevision: input.expectedPolicyRevision,
      generation: input.generation,
      scheduledDay: today,
      cutoff,
    });
    this.activeJob = job;

    // Run the batch execution
    void this.#executeBatch(job, cutoff, input.readFileBytes);
    return job;
  }

  async #executeBatch(
    job: JobStatus,
    cutoff: string,
    readFileBytes?: (payloadRef: string) => Promise<Uint8Array | null>,
  ): Promise<void> {
    let processed = 0;
    let failed = 0;
    let skipped = 0;
    let accepted = 0;
    let after: { readonly receivedAt: string; readonly id: string } | undefined;

    while (true) {
      const pending = this.store.listPending(this.pairing, cutoff, 50, after);
      if (pending.length === 0) break;
      accepted += pending.length;
      for (const item of pending) {
        try {
          let extractedText = '';
          let status: DerivedTextStatus = 'ok';

          if (item.sourceKind === 'clipboard_text' || item.sourceKind === 'input_text' || item.sourceKind === 'manual_text') {
            const text = this.store.readPendingText(this.pairing, item.id, item.grantRevision);
            if (text === null || !text.trim()) status = 'failed';
            else extractedText = text;
          } else if (item.sourceKind === 'download_directory' && this.parser && readFileBytes) {
            const bytes = await readFileBytes(item.payloadRef);
            if (!bytes) {
              status = 'missing';
            } else {
              const parsed = await this.parser.parse({
                filename: item.displayName ?? 'document.txt',
                bytes,
                mimeType: item.mimeType,
              });
              extractedText = parsed.text;
              status = parsed.status;
            }
          } else {
            skipped++;
            continue;
          }

          const processingKey = `proc-${item.id}-v1`;
          this.store.commitDerived(this.pairing, {
            parentRefs: [{ sourceId: item.id, version: item.stableVersion ?? 'v1' }],
            processorId: 'standard-batch-parser-v1',
            processorVersion: '1.0.0',
            grantRevision: item.grantRevision,
            processingKey,
            status,
            text: extractedText,
            expiresAt: item.expiresAt,
          });

          if (status === 'ok') processed++;
          else failed++;
        } catch {
          failed++;
        }
      }
      const last = pending[pending.length - 1]!;
      after = { receivedAt: last.receivedAt, id: last.id };
    }

    const complete = failed === 0 && skipped === 0;
    const finalState = complete ? 'succeeded' : (processed > 0 ? 'partial' : 'failed');
    this.store.finishJob(job.jobId, {
      state: finalState,
      counts: { accepted, processed, failed, skipped, dropped: 0 },
    });

    // Record success in daily ledger
    if (complete && (job.trigger === 'daily' || job.trigger === 'catchup')) {
      this.db.prepare(`
        INSERT INTO companion_batch_ledger(
          user_id, character_id, character_instance_id, scheduled_day, last_success_at)
        VALUES(?,?,?,?,?)
        ON CONFLICT(user_id, character_id, character_instance_id, scheduled_day) DO UPDATE SET
          last_success_at=excluded.last_success_at
      `).run(
        this.pairing.userId, this.pairing.characterId, this.pairing.characterInstanceId,
        job.scheduledDay, this.now(),
      );
    }

    this.activeJob = null;
  }

  isDayCompleted(day: string): boolean {
    const row = this.db.prepare(`
      SELECT 1 FROM companion_batch_ledger
      WHERE user_id=? AND character_id=? AND character_instance_id=? AND scheduled_day=?
    `).get(this.pairing.userId, this.pairing.characterId, this.pairing.characterInstanceId, day);
    return row !== undefined;
  }
}
