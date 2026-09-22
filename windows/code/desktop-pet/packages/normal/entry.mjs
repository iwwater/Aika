// K65-03 ordinary product package. The entry is self-contained so an installed artifact can execute
// without importing the development tree. Host composition supplies endpoint/model/credential input.
const capability = {
  adapterVersion: '1.0.0', contractVersion: '1.0.0', auth: 'credentialRef', sideEffect: 'network_egress',
  execution: ['unary'], capabilityId: 'llm.chat', category: 'dialogue', adapterId: 'normal.llm',
  parameters: ['temperature', 'maxOutputTokens', 'contextWindow', 'structuredOutput', 'tools', 'thinking', 'language'],
  inputs: [{ name: 'text', type: 'string', required: true, description: '当前轮用户文本' }],
  outputs: [{ name: 'text', type: 'string', required: true, description: '模型回复文本' }],
};

async function executeDialogue(input, signal) {
  if (!input || typeof input !== 'object' || typeof input.text !== 'string' || !input.text.trim()) throw new Error('llm.chat requires a non-empty text input');
  const endpoint = typeof input.endpoint === 'string' && input.endpoint.trim() ? input.endpoint.trim() : null;
  const model = typeof input.model === 'string' && input.model.trim() ? input.model.trim() : null;
  if (!endpoint || !model) throw new Error('llm.chat requires endpoint and model from the selected source');
  const headers = { 'content-type': 'application/json' };
  if (typeof input.apiKey === 'string' && input.apiKey) headers.authorization = `Bearer ${input.apiKey}`;
  const response = await fetch(endpoint, { method: 'POST', headers, signal, body: JSON.stringify({ model, messages: input.messages ?? [{ role: 'user', content: input.text }], temperature: input.temperature, max_tokens: input.maxOutputTokens }) });
  if (!response.ok) throw new Error(`llm.chat upstream returned HTTP ${response.status}`);
  const payload = await response.json();
  const text = payload?.choices?.[0]?.message?.content ?? payload?.output?.text ?? payload?.text;
  if (typeof text !== 'string') throw new Error('llm.chat upstream response has no text');
  return { text };
}

export const activation = {
  activate(host) {
    host.capabilities.register({ ...capability, provide: {
      capabilityId: capability.capabilityId, adapterId: capability.adapterId, adapterVersion: capability.adapterVersion,
      pluginId: host.pluginId, packageId: host.packageId,
      execute: executeDialogue,
    } });
    return { pluginId: host.pluginId, packageId: host.packageId, packageVersion: '0.65.0', apiVersion: '1.0.0', state: 'active', capabilityIds: [capability.capabilityId] };
  },
  deactivate() {},
};
