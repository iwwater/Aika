// Aika Next dialogue adapters: OpenAI-compatible (covers DeepSeek via endpoint/model config) and Gemini.
// Both are thin DialogueProvider implementations on top of the upstream ProviderTransport; the transport
// owns auth, budget authorization, HTTPS policy, SSE byte-buffering and diagnostics. No retries here.
import type { DialogueProvider, DialogueReply, DialogueRequest } from '../contracts/index.js';
import type { EndpointConfig, JsonRecord } from './transport.js';
import { ProviderTransport, object, string } from './transport.js';

const NEUTRAL_EXPRESSION = { emotion: 'neutral', intensity: 0, delivery: '', gesture: null } as const;

export interface AikaDialogueProviderConfig {
  readonly protocol: 'openai-compatible' | 'gemini';
  readonly endpoint: string;
  readonly model: string;
  readonly apiKey: () => string;
  readonly authorizer: import('./transport.js').CallAuthorizer;
}

function historyMessages(request: DialogueRequest): { role: 'user' | 'assistant'; content: string }[] {
  const currentUserId = `${request.scope.turnId}:user`;
  const history = request.context.recent
    .filter(message => message.id !== currentUserId && (message.role === 'user' || message.role === 'assistant'))
    .map(message => ({ role: message.role as 'user' | 'assistant', content: message.text }));
  history.push({ role: 'user', content: request.text });
  return history;
}

/** Selected memories ride once in the provider input; empty selection injects nothing so the legacy happy path is unchanged. */
function memoryContext(request: DialogueRequest): string | null {
  const memories = request.context.memories;
  if (!memories || memories.length === 0) return null;
  const lines = memories.map(memory => `- ${memory.text}`).join('\n');
  return `相关记忆：\n${lines}`;
}

function replyFor(request: DialogueRequest, text: string): DialogueReply {
  return { scope: request.scope, text, expression: { ...NEUTRAL_EXPRESSION } };
}

/** OpenAI-compatible chat/completions with server-side SSE aggregation. DeepSeek = same protocol, other endpoint/model. */
export class OpenAiCompatibleDialogueProvider implements DialogueProvider {
  constructor(private readonly transport: ProviderTransport, private readonly config: EndpointConfig, private readonly systemPrompt: string) {}
  async reply(request: DialogueRequest, signal: AbortSignal): Promise<DialogueReply> {
    const memoryBlock = memoryContext(request);
    const messages = [
      { role: 'system' as const, content: this.systemPrompt },
      ...(memoryBlock ? [{ role: 'system' as const, content: memoryBlock }] : []),
      ...historyMessages(request)
    ];
    const result = await this.transport.request(this.config, request.scope, 'dialogue', { messages, stream: true }, signal);
    const text = string(object(result).text).trim();
    if (!text) throw new Error('Provider returned an empty reply');
    return replyFor(request, text);
  }
}

/** Gemini generateContent: the model rides in the URL, the key rides in x-goog-api-key. */
export class GeminiDialogueProvider implements DialogueProvider {
  constructor(private readonly transport: ProviderTransport, private readonly config: EndpointConfig, private readonly systemPrompt: string) {}
  async reply(request: DialogueRequest, signal: AbortSignal): Promise<DialogueReply> {
    const contents: { role: 'user' | 'model'; parts: { text: string }[] }[] = [];
    for (const message of historyMessages(request)) {
      const role = message.role === 'assistant' ? 'model' : 'user';
      const last = contents.at(-1);
      if (last && last.role === role) last.parts.push({ text: message.content });
      else contents.push({ role, parts: [{ text: message.content }] });
    }
    const memoryBlock = memoryContext(request);
    const body: JsonRecord = { contents, systemInstruction: { parts: [{ text: this.systemPrompt }, ...(memoryBlock ? [{ text: memoryBlock }] : [])] } };
    const result = await this.transport.request(this.config, request.scope, 'dialogue', body, signal, undefined, undefined, {
      omitModel: true,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.config.apiKey() }
    });
    const payload = object(result);
    const candidates = payload.candidates;
    if (!Array.isArray(candidates) || candidates.length === 0) throw new Error('Provider returned no candidates');
    const candidate = object(candidates[0]);
    if (candidate.finishReason !== 'STOP') throw new Error(`Provider finish reason ${String(candidate.finishReason)} is not a normal completion`);
    const parts = object(candidate.content).parts;
    if (!Array.isArray(parts)) throw new Error('Provider returned no content parts');
    const text = parts.map(part => string(object(part).text)).join('').trim();
    if (!text) throw new Error('Provider returned an empty reply');
    return replyFor(request, text);
  }
}

export function createAikaDialogueProvider(config: AikaDialogueProviderConfig, transport: ProviderTransport, systemPrompt: string): DialogueProvider {
  switch (config.protocol) {
    case 'openai-compatible': return new OpenAiCompatibleDialogueProvider(transport, config, systemPrompt);
    case 'gemini': return new GeminiDialogueProvider(transport, config, systemPrompt);
    default: throw new Error(`Unsupported provider protocol: ${String((config as { protocol?: unknown }).protocol)}`);
  }
}
