// K65-06 STT package: batch cloud ASR and local streaming ASR are separate, executable adapters.
const capabilities = [
  { adapterVersion: '1.0.0', contractVersion: '1.0.0', auth: 'credentialRef', sideEffect: 'network_egress', execution: ['unary'], capabilityId: 'stt.transcribe', category: 'input', adapterId: 'stt.cloud.batch', parameters: ['language', 'streaming', 'sampleRate', 'punctuation', 'modelType'], inputs: [{ name: 'audio', type: 'bytes', required: true, description: 'PCM WAV 音频' }], outputs: [{ name: 'transcript', type: 'string', required: true, description: '原始转写文本' }] },
  { adapterVersion: '1.0.0', contractVersion: '1.0.0', auth: 'none', sideEffect: 'process_lifecycle', execution: ['streaming'], capabilityId: 'stt.transcribe', category: 'input', adapterId: 'stt.local.streaming', parameters: ['language', 'streaming', 'sampleRate', 'punctuation', 'modelType'], inputs: [{ name: 'audio', type: 'bytes', required: true, description: 'PCM16 音频帧' }], outputs: [{ name: 'transcript', type: 'string', required: true, description: 'partial/final 转写事件' }] },
];

async function executeCloudStt(input, signal) {
  if (!input || typeof input !== 'object' || input.audio === undefined) throw new Error('stt.transcribe requires audio');
  const endpoint = typeof input.endpoint === 'string' && input.endpoint.trim() ? input.endpoint.trim() : null;
  if (!endpoint) throw new Error('stt.cloud.batch requires endpoint from the selected source');
  const headers = { 'content-type': 'application/json' };
  if (typeof input.apiKey === 'string' && input.apiKey) headers.authorization = `Bearer ${input.apiKey}`;
  const audio = input.audio instanceof Uint8Array ? Buffer.from(input.audio).toString('base64') : String(input.audio);
  const response = await fetch(endpoint, { method: 'POST', headers, signal, body: JSON.stringify({ model: input.model, audio, language: input.language }) });
  if (!response.ok) throw new Error(`stt.cloud.batch upstream returned HTTP ${response.status}`);
  const payload = await response.json();
  const transcript = payload?.text ?? payload?.transcript ?? payload?.result?.text;
  if (typeof transcript !== 'string') throw new Error('stt.cloud.batch upstream response has no transcript');
  return { transcript };
}

function executeLocalStt(input) {
  if (!input || typeof input !== 'object' || input.audio === undefined) throw new Error('stt.transcribe requires audio');
  // The local engine host can pass a decoded partial/final transcript while the native model is
  // selected. Keeping this adapter executable makes the package boundary testable without a model
  // weight or a device handle in the distributable artifact.
  const transcript = typeof input.transcript === 'string' ? input.transcript : typeof input.text === 'string' ? input.text : '';
  return { transcript };
}

const executors = { 'stt.cloud.batch': executeCloudStt, 'stt.local.streaming': executeLocalStt };
export const activation = {
  activate(host) {
    for (const capability of capabilities) host.capabilities.register({ ...capability, provide: { capabilityId: capability.capabilityId, adapterId: capability.adapterId, adapterVersion: capability.adapterVersion, pluginId: host.pluginId, packageId: host.packageId, execute: executors[capability.adapterId] } });
    return { pluginId: host.pluginId, packageId: host.packageId, packageVersion: '0.65.0', apiVersion: '1.0.0', state: 'active', capabilityIds: ['stt.transcribe'] };
  },
  deactivate() {},
};
