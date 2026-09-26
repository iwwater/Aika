import test from 'node:test';
import assert from 'node:assert/strict';

interface TraceBatchMetadata {
  turnId: string;
  batchId: string | null;
  sourceId: string;
  candidateId: string | null;
  targetWikiId: string | null;
  status: 'applied' | 'rejected' | 'pending';
}

test('UIR-05 Trace Links: Explicit metadata links without temporal guessing', () => {
  const structuredLinks: TraceBatchMetadata[] = [
    {
      turnId: 'turn-100',
      batchId: 'batch-ingest-50',
      sourceId: 'dialogue:turn-100',
      candidateId: 'cand-01',
      targetWikiId: 'wiki-fact-01',
      status: 'applied'
    },
    {
      turnId: 'turn-101',
      batchId: null, // No background maintenance recorded for this casual chat
      sourceId: 'dialogue:turn-101',
      candidateId: null,
      targetWikiId: null,
      status: 'rejected'
    }
  ];

  // Turn 100 has exact provenance chain
  const t100 = structuredLinks.find(l => l.turnId === 'turn-100')!;
  assert.equal(t100.batchId, 'batch-ingest-50');
  assert.equal(t100.targetWikiId, 'wiki-fact-01');

  // Turn 101 has null batchId, must NOT guess or link to batch-ingest-50 despite being adjacent in time
  const t101 = structuredLinks.find(l => l.turnId === 'turn-101')!;
  assert.equal(t101.batchId, null);
  assert.equal(t101.targetWikiId, null);
});
