import { MemoryTurnProviderBase } from './memory-turn-provider.js';
import { type EndpointConfig, ProviderTransport } from './transport.js';

// This comparison uses the existing quoted-v2 format. Endpoint, model and
// paid-call authorization remain supplied by the integration owner.
export class DeepSeekMemoryTurnProvider extends MemoryTurnProviderBase {
  constructor(config: EndpointConfig, transport = new ProviderTransport()) {
    super(config, transport, 'quoted-v2', 'deepseek');
  }
}
