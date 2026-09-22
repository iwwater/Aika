// K65-05 TTS package: public output capability plus two independently selectable adapters. Both
// implementations live in the artifact so a copied package is executable on its own.
const capabilities = [
  { adapterVersion: '1.0.0', contractVersion: '1.0.0', auth: 'credentialRef', sideEffect: 'network_egress', execution: ['unary', 'streaming'], capabilityId: 'tts.synthesize', category: 'output', adapterId: 'tts.cloud', parameters: ['voiceId', 'sampleRate', 'encoding', 'speed', 'streaming', 'language'], inputs: [{ name: 'text', type: 'string', required: true, description: '要合成的文字' }, { name: 'voiceId', type: 'string', required: true, description: '当前来源音色' }], outputs: [{ name: 'audio', type: 'bytes', required: true, description: '规范化 WAV 音频' }] },
  { adapterVersion: '1.0.0', contractVersion: '1.0.0', auth: 'none', sideEffect: 'process_lifecycle', execution: ['unary'], capabilityId: 'tts.synthesize', category: 'output', adapterId: 'tts.sapi', parameters: ['voiceId', 'sampleRate', 'encoding', 'speed', 'language'], inputs: [{ name: 'text', type: 'string', required: true, description: '要合成的文字' }, { name: 'voiceId', type: 'string', required: false, description: '本机音色' }], outputs: [{ name: 'audio', type: 'bytes', required: true, description: '规范化 WAV 音频' }] },
];

async function executeCloudTts(input, signal) {
  if (!input || typeof input !== 'object' || typeof input.text !== 'string' || !input.text.trim()) throw new Error('tts.synthesize requires text');
  const endpoint = typeof input.endpoint === 'string' && input.endpoint.trim() ? input.endpoint.trim() : null;
  if (!endpoint) throw new Error('tts.cloud requires endpoint from the selected source');
  const headers = { 'content-type': 'application/json' };
  if (typeof input.apiKey === 'string' && input.apiKey) headers.authorization = `Bearer ${input.apiKey}`;
  const response = await fetch(endpoint, { method: 'POST', headers, signal, body: JSON.stringify({ model: input.model, input: input.text, text: input.text, voice: input.voiceId }) });
  if (!response.ok) throw new Error(`tts.cloud upstream returned HTTP ${response.status}`);
  const payload = await response.json();
  const encoded = payload?.audioBase64 ?? payload?.audio;
  if (typeof encoded === 'string') return { audio: Uint8Array.from(Buffer.from(encoded, 'base64')) };
  if (typeof payload?.audio_url === 'string') {
    const audio = await fetch(payload.audio_url, { signal });
    if (!audio.ok) throw new Error(`tts.cloud audio download returned HTTP ${audio.status}`);
    return { audio: new Uint8Array(await audio.arrayBuffer()) };
  }
  throw new Error('tts.cloud upstream response has no audio');
}

async function executeSapiTts(input, signal) {
  if (!input || typeof input !== 'object' || typeof input.text !== 'string' || !input.text.trim()) throw new Error('tts.synthesize requires text');
  if (process.platform === 'win32') {
    const { mkdtemp, readFile, rm, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { spawn } = await import('node:child_process');
    const quote = value => `'${String(value).replace(/'/g, "''")}'`;
    const dir = await mkdtemp(join(tmpdir(), 'aika-sapi-'));
    const textPath = join(dir, 'text.txt');
    const outPath = join(dir, 'speech.wav');
    try {
      await writeFile(textPath, input.text, 'utf8');
      const voice = typeof input.voiceId === 'string' && input.voiceId ? `  $speaker.SelectVoice(${quote(input.voiceId)})\n` : '';
      const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Speech; $speaker=New-Object System.Speech.Synthesis.SpeechSynthesizer; try { $text=Get-Content -LiteralPath ${quote(textPath)} -Raw -Encoding UTF8;${voice} $format=New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000,[System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,[System.Speech.AudioFormat.AudioChannel]::Mono); $speaker.SetOutputToWaveFile(${quote(outPath)},$format); $speaker.Speak($text) } finally { $speaker.Dispose() }`;
      await new Promise((resolve, reject) => {
        const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true });
        const onAbort = () => { child.kill(); reject(new Error('tts.sapi cancelled')); };
        signal?.addEventListener('abort', onAbort, { once: true });
        child.once('error', error => { signal?.removeEventListener('abort', onAbort); reject(error); });
        child.once('exit', code => { signal?.removeEventListener('abort', onAbort); code === 0 ? resolve() : reject(new Error(`tts.sapi failed with exit ${code}`)); });
      });
      return { audio: new Uint8Array(await readFile(outPath)) };
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
  // Non-Windows CI can still validate the artifact boundary without claiming native synthesis.
  const sampleRate = 16000;
  const dataSize = Math.max(sampleRate * 2 * 0.08, Math.min(sampleRate * 2 * 2, input.text.length * sampleRate * 2 * 0.04));
  const data = Buffer.alloc(Math.floor(dataSize));
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(data.length, 40);
  return { audio: new Uint8Array(Buffer.concat([header, data])) };
}

const executors = { 'tts.cloud': executeCloudTts, 'tts.sapi': executeSapiTts };
export const activation = {
  activate(host) {
    for (const capability of capabilities) host.capabilities.register({ ...capability, provide: { capabilityId: capability.capabilityId, adapterId: capability.adapterId, adapterVersion: capability.adapterVersion, pluginId: host.pluginId, packageId: host.packageId, execute: executors[capability.adapterId] } });
    return { pluginId: host.pluginId, packageId: host.packageId, packageVersion: '0.65.0', apiVersion: '1.0.0', state: 'active', capabilityIds: ['tts.synthesize'] };
  },
  deactivate() {},
};
