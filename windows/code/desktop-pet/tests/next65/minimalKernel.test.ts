/** K65-03: portable kernel plus ordinary package integration. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { validateManifestFile } from '../../plugins/manifest.js';
import { createPackageHost, PluginRequestError } from '../../plugins/host-runtime.js';
import { importPackageHost, setPackageEnablement } from '../../plugins/host-config.js';
import { createMinimalKernel } from '../../kernel/minimal-kernel.js';
import { executePackageCapability } from '../../kernel/package-composition.js';
import type { DialogueProvider } from '../../contracts/index.js';

const root = resolve(process.cwd());
const artifactRoot = resolve(root, 'dist/next65');
const normalRoot = resolve(artifactRoot, 'packages/normal');

function secrets() {
  return { has: () => false, resolve: () => null, list: () => [] };
}

async function submitAndWait(kernel: ReturnType<typeof createMinimalKernel>, text: string): Promise<{ scope: Awaited<ReturnType<typeof kernel.submit>>; event: { status: string; replyText?: string } }> {
  const terminal = new Promise<{ scope: { turnId: string }; status: string; replyText?: string }>(resolve => {
    const unsubscribe = kernel.subscribe(event => {
      if (event.type === 'terminal') { unsubscribe(); resolve(event); }
    });
  });
  const scope = await kernel.submit({ text });
  const event = await terminal;
  assert.equal(event.scope.turnId, scope.turnId);
  return { scope, event };
}

test('03-A/D: build emits a self-contained kernel and an independently validated ordinary package', () => {
  const kernelFile = resolve(artifactRoot, 'kernel/index.js');
  const manifestFile = resolve(normalRoot, 'manifest.json');
  assert.equal(existsSync(kernelFile), true, 'K65-03 kernel artifact must exist');
  assert.equal(existsSync(manifestFile), true, 'K65-03 ordinary package manifest must exist');
  const source = readFileSync(kernelFile, 'utf8');
  for (const forbidden of ['qwen-dialogue', 'qwen-tts', 'sherpa-onnx', 'wechat/', 'wake-manager', 'better-sqlite3']) {
    assert.equal(source.includes(forbidden), false, `kernel must not carry optional implementation ${forbidden}`);
  }
  const checked = validateManifestFile(normalRoot);
  assert.equal(checked.ok, true, JSON.stringify(checked.issues));
  assert.equal((checked.manifest as { plugins: readonly { capabilities: readonly { capabilityId: string }[] }[] }).plugins[0]?.capabilities[0]?.capabilityId, 'llm.chat');
});

test('03-B: no ordinary package is a clear refusal; importing the ordinary package uses the same public host path', async () => {
  const emptyHostRoot = mkdtempSync(resolve(tmpdir(), 'k65-03-empty-'));
  const hostRoot = mkdtempSync(resolve(tmpdir(), 'k65-03-normal-'));
  try {
    const emptyHost = createPackageHost({ hostRoot: emptyHostRoot, secrets: secrets() });
    await assert.rejects(emptyHost.resolve({ pluginId: 'normal.product', capabilityId: 'llm.chat' }), (error: unknown) => error instanceof PluginRequestError && error.category === 'manifest_invalid');
    await emptyHost.close();
    const imported = importPackageHost({ sourceRoot: normalRoot, hostRoot });
    assert.equal(imported.ok, true, JSON.stringify(imported.issues));
    assert.equal(setPackageEnablement({ hostRoot, packageId: 'com.aika.product.normal', enabled: true }).ok, true);
    const host = createPackageHost({ hostRoot, secrets: secrets() });
    const providers = await host.resolve({ pluginId: 'normal.product', capabilityId: 'llm.chat' });
    assert.deepEqual(providers.map(provider => provider.adapterId), ['normal.llm']);
    assert.equal(typeof providers[0]?.execute, 'function', 'installed package must expose an executable adapter');
    const server = createServer(async (_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ choices: [{ message: { content: 'artifact reply' } }] }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/chat/completions`;
    const result = await executePackageCapability(host, { pluginId: 'normal.product', capabilityId: 'llm.chat' }, { endpoint, model: 'fixture', text: 'hello' });
    assert.deepEqual(result, { text: 'artifact reply' });
    server.closeAllConnections(); server.close();
    await host.close();
  } finally { rmSync(emptyHostRoot, { recursive: true, force: true }); rmSync(hostRoot, { recursive: true, force: true }); }
});

test('03-C: minimal kernel runs real turn authority and bounded recent history for multiple text turns', async () => {
  const dialogue: DialogueProvider = { async reply(input) {
    return { scope: input.scope, text: `本地回复:${input.text}`, expression: { emotion: 'neutral', intensity: 0, delivery: '', gesture: null } };
  } };
  const kernel = createMinimalKernel({ dialogue });
  const first = await submitAndWait(kernel, '第一轮');
  assert.equal(first.event.status, 'completed');
  assert.equal(first.event.replyText, '本地回复:第一轮');
  const second = await submitAndWait(kernel, '第二轮');
  assert.equal(second.event.status, 'completed');
  assert.equal(kernel.history.snapshot(first.scope.characterId).map(message => message.text).join('|'), '第一轮|本地回复:第一轮|第二轮|本地回复:第二轮');
  kernel.close();
});

test('03-C: a newer text turn cancels the old provider call and the old reply cannot enter history', async () => {
  let firstStarted!: () => void;
  const firstProviderStarted = new Promise<void>(resolve => { firstStarted = resolve; });
  const dialogue: DialogueProvider = { async reply(input, signal) {
    if (input.text === '会被取消') {
      firstStarted();
      await new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
    }
    return { scope: input.scope, text: `回复:${input.text}`, expression: { emotion: 'neutral', intensity: 0, delivery: '', gesture: null } };
  } };
  const kernel = createMinimalKernel({ dialogue });
  const terminals = new Promise<readonly { scope: { turnId: string }; status: string; replyText?: string }[]>(resolve => {
    const events: { scope: { turnId: string }; status: string; replyText?: string }[] = [];
    const unsubscribe = kernel.subscribe(event => { if (event.type === 'terminal') { events.push(event); if (events.length === 2) { unsubscribe(); resolve(events); } } });
  });
  const firstPromise = kernel.submit({ text: '会被取消' });
  await firstProviderStarted;
  const firstScope = await firstPromise;
  const secondScope = await kernel.submit({ text: '新一轮' });
  const events = await terminals;
  const oldTerminal = events.find(event => event.scope.turnId === firstScope.turnId)!;
  const newTerminal = events.find(event => event.scope.turnId === secondScope.turnId)!;
  assert.equal(oldTerminal.status, 'cancelled');
  assert.equal(newTerminal.status, 'completed');
  assert.deepEqual(kernel.history.snapshot(firstScope.characterId).map(message => message.text), ['会被取消', '新一轮', '回复:新一轮']);
  kernel.close();
});

test('03-E: ordinary package text chain replays two no-key local HTTP sources without cloud fallback', async () => {
  const seen: { readonly source: string; readonly model: string; readonly authorization: string | null }[] = [];
  const servers = ['local-a', 'local-b'].map(source => createServer(async (request, response) => {
    if (request.url !== '/v1/chat/completions' || request.method !== 'POST') { response.writeHead(404); response.end(); return; }
    let body = ''; for await (const chunk of request) body += chunk;
    const parsed = JSON.parse(body) as { model?: string };
    seen.push({ source, model: parsed.model ?? '', authorization: typeof request.headers.authorization === 'string' ? request.headers.authorization : null });
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ choices: [{ message: { content: `${source}:${parsed.model}` } }] }));
  }));
  await Promise.all(servers.map(server => new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))));
  const endpoints = servers.map(server => `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`);
  let selected = { endpoint: endpoints[0]!, model: 'local-model-a' };
  const dialogue: DialogueProvider = { async reply(input, signal) {
    const response = await fetch(`${selected.endpoint}/chat/completions`, { method: 'POST', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: selected.model, messages: [{ role: 'user', content: input.text }] }) });
    const body = await response.json() as { choices?: { message?: { content?: string } }[] };
    return { scope: input.scope, text: body.choices?.[0]?.message?.content ?? '', expression: { emotion: 'neutral', intensity: 0, delivery: '', gesture: null } };
  } };
  try {
    const kernel = createMinimalKernel({ dialogue });
    await submitAndWait(kernel, '本地 A');
    selected = { endpoint: endpoints[1]!, model: 'local-model-b' };
    await submitAndWait(kernel, '本地 B');
    kernel.close();
    assert.deepEqual(seen, [
      { source: 'local-a', model: 'local-model-a', authorization: null },
      { source: 'local-b', model: 'local-model-b', authorization: null },
    ]);
  } finally { for (const server of servers) { server.closeAllConnections(); server.close(); } }
});
