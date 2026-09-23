/**
 * core/companion-event-hub.ts
 *
 * 08-01: Domain event router adhering to HostEventChannel and CompanionEventEnvelope contracts.
 * Routes events by domain (canon | companion | work) and pairing (PairingScope).
 */

import type { CompanionEventEnvelope, EventDomain } from '../contracts/perception.js';
import type { PairingScope } from '../contracts/character-pack.js';
import type { HostEventChannel, EventScope } from '../contracts/plugin.js';
import { randomUUID } from 'node:crypto';

export interface CompanionEventListener {
  readonly id: string;
  readonly domains: readonly EventDomain[];
  readonly pairing?: PairingScope | undefined;
  readonly handler: (envelope: CompanionEventEnvelope) => void | Promise<void>;
}

export function isSamePairing(a: PairingScope, b: PairingScope): boolean {
  return a.userId === b.userId && a.characterId === b.characterId && a.characterInstanceId === b.characterInstanceId;
}

export class CompanionEventHub implements HostEventChannel {
  private readonly listeners = new Map<string, CompanionEventListener>();
  private readonly pendingPromises = new Set<Promise<void>>();

  /**
   * Subscribe to events for specific domains and optional pairing.
   */
  subscribeDomain(
    domains: readonly EventDomain[],
    handler: (envelope: CompanionEventEnvelope) => void | Promise<void>,
    pairing?: PairingScope,
  ): () => void {
    const id = `sub-${randomUUID()}`;
    const listener: CompanionEventListener = {
      id,
      domains: Object.freeze([...domains]),
      pairing,
      handler,
    };
    this.listeners.set(id, listener);
    return () => {
      this.listeners.delete(id);
    };
  }

  /**
   * Publish a validated domain event envelope.
   */
  publishEnvelope(envelope: CompanionEventEnvelope): void {
    if (!envelope || envelope.schemaVersion !== 1) {
      throw new Error('Invalid event envelope: schemaVersion must be 1');
    }
    if (!envelope.eventId?.trim()) {
      throw new Error('Invalid event envelope: missing eventId');
    }
    if (!['canon', 'companion', 'work'].includes(envelope.domain)) {
      throw new Error(`Invalid event envelope: invalid domain ${envelope.domain}`);
    }
    if (!envelope.pairing?.userId || !envelope.pairing?.characterId || !envelope.pairing?.characterInstanceId) {
      throw new Error('Invalid event envelope: invalid pairing scope');
    }
    if (Number.isNaN(Date.parse(envelope.occurredAt)) || Number.isNaN(Date.parse(envelope.receivedAt))) {
      throw new Error('Invalid event envelope: timestamps must be ISO strings');
    }

    for (const listener of this.listeners.values()) {
      if (listener.domains.length > 0 && !listener.domains.includes(envelope.domain)) {
        continue;
      }
      if (listener.pairing && !isSamePairing(listener.pairing, envelope.pairing)) {
        continue;
      }
      try {
        const result = listener.handler(envelope);
        if (result && typeof (result as Promise<void>).then === 'function') {
          const promise = (result as Promise<void>).finally(() => {
            this.pendingPromises.delete(promise);
          });
          this.pendingPromises.add(promise);
        }
      } catch (err) {
        console.error(`[CompanionEventHub] Listener error on event ${envelope.eventId}:`, err);
      }
    }
  }

  /**
   * Await all asynchronous listeners to complete.
   */
  async drain(): Promise<void> {
    if (this.pendingPromises.size > 0) {
      await Promise.allSettled([...this.pendingPromises]);
    }
  }

  // --- HostEventChannel compliance ----------------------------------------------------------------

  subscribe(topics: readonly string[], scope: EventScope, handler: (topic: string, payload: unknown) => void): () => void {
    const id = `host-sub-${randomUUID()}`;
    const listener: CompanionEventListener = {
      id,
      domains: ['canon', 'companion', 'work'],
      handler: (envelope: CompanionEventEnvelope) => {
        if (topics.includes(envelope.type) || topics.includes('*')) {
          if (!scope.sessionId || scope.sessionId === envelope.turnId) {
            handler(envelope.type, envelope.payload);
          }
        }
      },
    };
    this.listeners.set(id, listener);
    return () => {
      this.listeners.delete(id);
    };
  }

  publish(topic: string, payload: unknown, scope: EventScope): void {
    const now = new Date().toISOString();
    const envelope: CompanionEventEnvelope = {
      eventId: `ev-host-${randomUUID()}`,
      schemaVersion: 1,
      domain: topic.startsWith('work') ? 'work' : topic.startsWith('canon') ? 'canon' : 'companion',
      type: topic,
      pairing: {
        userId: 'host-user',
        characterId: 'companion',
        characterInstanceId: scope.sessionId || 'default-instance',
      },
      ...(scope.turnId ? { turnId: scope.turnId } : {}),
      sourceRef: { id: scope.packageId, version: 1 },
      occurredAt: now,
      receivedAt: now,
      payload,
      summary: `Host event: ${topic}`,
    };
    this.publishEnvelope(envelope);
  }

  get listenerCount(): number {
    return this.listeners.size;
  }
}
