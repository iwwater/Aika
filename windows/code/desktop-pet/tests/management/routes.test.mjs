import test from 'node:test';
import assert from 'node:assert/strict';
import { parseConsoleRoute, CONSOLE_PAGES, DEFAULT_PAGE } from '../../management/ui/routes.mjs';

test('N075-01 Route: parses token, page, and pairing scope', () => {
  const hash = '#token=secret123&page=models&character=companion&instance=inst-1';
  const parsed = parseConsoleRoute(hash);

  assert.equal(parsed.token, 'secret123');
  assert.equal(parsed.page, 'models');
  assert.equal(parsed.pairing.characterId, 'companion');
  assert.equal(parsed.pairing.characterInstanceId, 'inst-1');
  assert.equal(parsed.hasTokenInUrl, true);
  // Target hash strips token
  assert.ok(!parsed.targetHash.includes('secret123'));
  assert.ok(parsed.targetHash.includes('page=models'));
});

test('N075-01 Route: bridges legacy FE75-02 section targets to first-class pages', () => {
  // 1. #section=timeline -> page: timeline
  const r1 = parseConsoleRoute('#section=timeline');
  assert.equal(r1.page, 'timeline');
  assert.equal(r1.section, null);

  // 2. #section=diagnostics -> page: events
  const r2 = parseConsoleRoute('#section=diagnostics');
  assert.equal(r2.page, 'events');
  assert.equal(r2.section, null);

  // 3. #section=runtime -> page: health
  const r3 = parseConsoleRoute('#section=runtime');
  assert.equal(r3.page, 'health');
  assert.equal(r3.section, null);

  // 4. #section=records -> page: memory, section: records
  const r4 = parseConsoleRoute('#section=records');
  assert.equal(r4.page, 'memory');
  assert.equal(r4.section, 'records');
});

test('N075-01 Route: unknown page falls back to overview default', () => {
  const parsed = parseConsoleRoute('#page=some_unknown_xyz');
  assert.equal(parsed.page, DEFAULT_PAGE);
  assert.equal(parsed.section, null);
});

test('N075-02 Shell Assets: required console assets exist and are non-empty', async () => {
  const { readFile } = await import('node:fs/promises');
  const { resolve } = await import('node:path');
  const uiRoot = resolve('management/ui');

  const files = [
    'index.html',
    'style.css',
    'app.mjs',
    'routes.mjs',
    'icons.mjs',
    'modern-overview.mjs',
    'modern-knowledge-view.mjs',
    'modern-timeline-view.mjs',
  ];

  for (const file of files) {
    const content = await readFile(resolve(uiRoot, file), 'utf8');
    assert.ok(content.length > 0, `File ${file} should not be empty`);
  }
});
