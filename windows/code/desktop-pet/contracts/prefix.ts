// FIX61-09: the frozen context prefix, as the provider must serialize it.
//
// Freezing makes the LOCAL request stable so a vendor KV cache CAN be reused: same bytes, same order,
// same leading position. It is not a claim that any provider cached, kept or discounted anything, and
// it does not reduce the logical input token count - the same text is still sent every turn.
export interface PrefixMessage {
  readonly id: string;
  readonly role: 'user' | 'assistant';
  readonly text: string;
}

export interface DialoguePrefix {
  readonly id: string;
  readonly revision: number;
  /** SHA-256 of the frozen text; the byte identity a caller can compare across turns. */
  readonly hash: string;
  /** Frozen system/persona/core-memory/summary/knowledge block. Byte-stable for the whole snapshot. */
  readonly text: string;
  /** Frozen recent history pinned by this snapshot; the provider emits it directly after the text. */
  readonly messages: readonly PrefixMessage[];
  /**
   * Exact evidence versions this prefix pinned. They are revalidated before the reply, the write-back and
   * the playback, so a correction, a forget or an edit revokes the frozen prefix like any other source.
   */
  readonly sources: readonly { readonly id: string; readonly version: number }[];
  /** Upper bound in UTF-8 bytes for the dynamic suffix. The frozen prefix is never truncated for it. */
  readonly suffixBytes: number;
  /**
   * False when this prefix was produced without the full library assembly: the first turn after a start,
   * or the safe minimal prefix used while a revoked snapshot is rebuilt in the background.
   */
  readonly complete: boolean;
}
