import type { DialogueProvider, DialogueRequest, DialogueReply } from '../contracts/index.js';

export interface FlowContextRunner {
  runActiveConversationFlow(
    scope: { readonly characterId: string; readonly sessionId: string; readonly turnId: string },
    query: string,
    signal: AbortSignal,
  ): Promise<{ readonly profileId: string; readonly text: string } | null>;
}

/** Adds active, administrator-approved local Flow results to the existing single dialogue request. */
export class FlowAwareDialogueProvider implements DialogueProvider {
  constructor(private readonly dialogue: DialogueProvider, private readonly flow: FlowContextRunner) {}

  async reply(input: DialogueRequest, signal: AbortSignal): Promise<DialogueReply> {
    const result = await this.flow.runActiveConversationFlow(input.scope, input.text, signal);
    if (!result) return this.dialogue.reply(input, signal);
    const context = Object.freeze({ ...input.context, flowContext: Object.freeze(result) });
    return this.dialogue.reply({ ...input, context }, signal);
  }
}
