import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TextSourceProvider,
  HttpWikiSourceProvider,
  CompositeCharacterSourceProvider,
} from '../../memory/character-source-provider.js';
import { CharacterPackError } from '../../contracts/character-pack.js';

test('N07-02 SourceProvider: TextSourceProvider handles inline text and local files', async () => {
  const provider = new TextSourceProvider();

  // Inline text
  const res1 = await provider.fetch({
    kind: 'text',
    uri: 'doc-inline',
    title: '沈砚传记.txt',
    text: '沈砚生于临海城。',
  });
  assert.equal(res1.kind, 'text');
  assert.equal(res1.sourceName, '沈砚传记.txt');
  assert.equal(res1.text, '沈砚生于临海城。');

  // Unsupported file extension
  await assert.rejects(
    async () => provider.fetch({ kind: 'file', uri: 'malicious.bin' }),
    (err: any) => err instanceof CharacterPackError && err.code === 'unsupported_source',
  );

  // Missing file
  await assert.rejects(
    async () => provider.fetch({ kind: 'file', uri: 'non_existent_file_xyz.txt' }),
    (err: any) => err instanceof CharacterPackError && err.code === 'source_fetch_failed',
  );
});

test('N07-02 SourceProvider: HttpWikiSourceProvider blocks SSRF and private IPs by default', async () => {
  const provider = new HttpWikiSourceProvider();

  const privateUrls = [
    'http://localhost/wiki/test',
    'http://127.0.0.1:8080/wiki/test',
    'http://192.168.1.100/wiki/test',
    'http://10.0.0.1/wiki/test',
  ];

  for (const url of privateUrls) {
    await assert.rejects(
      async () => provider.fetch({ kind: 'http_wiki', uri: url }),
      (err: any) =>
        err instanceof CharacterPackError &&
        err.code === 'source_fetch_failed' &&
        err.message.includes('禁止请求局域网或私有地址'),
    );
  }

  // Non-http scheme
  await assert.rejects(
    async () => provider.fetch({ kind: 'http_wiki', uri: 'ftp://files.example.com/wiki.txt' }),
    (err: any) => err instanceof CharacterPackError && err.code === 'unsupported_source',
  );
});

test('N07-02 SourceProvider: HttpWikiSourceProvider reports HTTP errors without faking success', async () => {
  const mockFetcher: typeof fetch = async (url: any) => {
    return new Response('Not Found', {
      status: 404,
      statusText: 'Not Found',
      headers: { 'Content-Type': 'text/plain' },
    });
  };

  const provider = new HttpWikiSourceProvider({
    fetcher: mockFetcher,
    allowPrivateHosts: true,
  });

  await assert.rejects(
    async () => provider.fetch({ kind: 'http_wiki', uri: 'https://wiki.example.com/character/404' }),
    (err: any) =>
      err instanceof CharacterPackError &&
      err.code === 'source_fetch_failed' &&
      err.message.includes('HTTP 404'),
  );
});

test('N07-02 SourceProvider: HttpWikiSourceProvider sanitizes HTML into clean markdown structure', async () => {
  const htmlSample = `
    <!DOCTYPE html>
    <html>
      <head>
        <title>沈砚 - 虚构作品角色百科</title>
        <style>.main { color: red; }</style>
        <script>console.log("tracker");</script>
      </head>
      <body>
        <nav><a href="/home">Home</a></nav>
        <h1>人物生平</h1>
        <p>沈砚住在<b>临海城</b>，习惯先观察周遭再回答。&amp;重视承诺。</p>
        <h2>重要经历</h2>
        <ul>
          <li>在暴雨之夜留伞。</li>
          <li>守候旧码头。</li>
        </ul>
        <footer>版权所有 2026</footer>
      </body>
    </html>
  `;

  const mockFetcher: typeof fetch = async () => {
    return new Response(htmlSample, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  };

  const provider = new HttpWikiSourceProvider({
    fetcher: mockFetcher,
    allowPrivateHosts: true,
  });

  const res = await provider.fetch({
    kind: 'http_wiki',
    uri: 'https://wiki.example.com/wiki/ShenYan',
  });

  assert.equal(res.kind, 'http_wiki');
  assert.equal(res.sourceName, '沈砚.md');

  // Assert scripts, styles, nav, footer are stripped
  assert.ok(!res.text.includes('tracker'));
  assert.ok(!res.text.includes('.main { color: red; }'));
  assert.ok(!res.text.includes('Home'));
  assert.ok(!res.text.includes('版权所有'));

  // Assert headings converted
  assert.ok(res.text.includes('# 人物生平'));
  assert.ok(res.text.includes('## 重要经历'));

  // Assert entities unescaped
  assert.ok(res.text.includes('&重视承诺'));
  assert.ok(res.text.includes('沈砚住在临海城'));
});

test('N07-02 SourceProvider: HttpWikiSourceProvider detects login wall or insufficient text', async () => {
  const loginWallHtml = `
    <html>
      <head><title>Login Required</title></head>
      <body>
        <div class="login-required">请先登录后再查看本词条完整内容。</div>
      </body>
    </html>
  `;

  const mockFetcher: typeof fetch = async () => {
    return new Response(loginWallHtml, {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    });
  };

  const provider = new HttpWikiSourceProvider({
    fetcher: mockFetcher,
    allowPrivateHosts: true,
  });

  await assert.rejects(
    async () => provider.fetch({ kind: 'http_wiki', uri: 'https://wiki.example.com/wiki/Protected' }),
    (err: any) =>
      err instanceof CharacterPackError &&
      err.code === 'source_fetch_failed' &&
      err.message.includes('登录墙'),
  );
});

test('N07-02 SourceProvider: CompositeCharacterSourceProvider dispatches correctly', async () => {
  const composite = new CompositeCharacterSourceProvider();

  assert.equal(
    composite.canHandle({ kind: 'text', uri: 'inline', text: '内容' }),
    true,
  );
  assert.equal(
    composite.canHandle({ kind: 'file', uri: 'c:/story.txt' }),
    true,
  );
  assert.equal(
    composite.canHandle({ kind: 'http_wiki', uri: 'https://wiki.example.com/char' }),
    true,
  );
});
