/** Exact original synthetic contexts isolate dialogue grounding from memory mutation. */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import type { DialogueProvider, DialogueRequest } from '../contracts/index.js';

export async function runDialogueRegressionScenarios(out: string, original: string, dialogue: DialogueProvider): Promise<void> {
  await compare(out, original, dialogue, ['03-natural-correction', '05-after-forget']);
}

/** Independent post-forget absence observation; does not rerun memory operations. */
export async function runAbsenceRegressionScenario(out: string, original: string, dialogue: DialogueProvider): Promise<void> {
  await compare(out, original, dialogue, ['03-original-follow-up']);
}

async function compare(out: string, original: string, dialogue: DialogueProvider, cases: readonly string[]): Promise<void> {
  const review = JSON.parse(await readFile(`${original}/review.json`, 'utf8')) as { fingerprints: Record<string, string> };
  // Verify all selected original fixtures before allowing any paid generation.
  const fixtures = await Promise.all(cases.map(async id => {
    const bytes = await readFile(`${original}/${id}.json`);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (sha256 !== review.fingerprints[`${id}.json`]) throw new Error('Original dialogue evidence changed');
    const source = JSON.parse(bytes.toString('utf8'));
    if (source.synthetic !== true || !source.contextBeforeReply || !source.outcome || !source.reply) throw new Error('Incomplete synthetic dialogue fixture');
    const input: DialogueRequest = { scope: source.scope, text: source.text, context: source.contextBeforeReply, memoryOutcome: source.outcome };
    return { id, sha256, input, previousReply: source.reply };
  }));
  await mkdir(out, { recursive: false });
  for (const fixture of fixtures) {
    const record: Record<string, unknown> = { ...fixture, synthetic: true, evidenceLevel: 'actual provider with exact original synthetic context; no storage writes', semanticAcceptance: false };
    const started = performance.now();
    try {
      record.reply = await dialogue.reply(fixture.input, AbortSignal.timeout(60_000));
      record.completed = true;
    } catch (error) {
      record.completed = false;
      record.errorName = error instanceof Error ? error.name : 'unknown';
    }
    record.elapsedMs = Math.round(performance.now() - started);
    await writeFile(`${out}/${fixture.id}.json`, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
  }
}
