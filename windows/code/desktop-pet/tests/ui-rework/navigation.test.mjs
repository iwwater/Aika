import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseConsoleRoute,
  resolveCanonicalRoute,
  PRIMARY_PAGES,
  DEVELOPER_PAGE,
  DEFAULT_CANONICAL_PAGE
} from '../../management/ui/routes.mjs';

test('UIR-01 Navigation: primary 6 entries parse correctly and are identified', () => {
  for (const page of PRIMARY_PAGES) {
    const route = parseConsoleRoute(`#page=${page}`);
    assert.equal(route.canonicalPage, page);
    assert.equal(route.isDeveloperRoute, false);
  }
});

test('UIR-01 Navigation: developer entry is flagged as developer route', () => {
  const route = parseConsoleRoute('#page=developer');
  assert.equal(route.canonicalPage, DEVELOPER_PAGE);
  assert.equal(route.isDeveloperRoute, true);
});

test('UIR-01 Navigation: legacy overview maps to dashboard', () => {
  const r = parseConsoleRoute('#page=overview');
  assert.equal(r.canonicalPage, 'dashboard');
});

test('UIR-01 Navigation: models/voice/skins/presentation map into Characters', () => {
  const rModels = parseConsoleRoute('#page=models');
  assert.equal(rModels.canonicalPage, 'characters');
  assert.equal(rModels.canonicalSection, 'models');

  const rVoice = parseConsoleRoute('#page=voice');
  assert.equal(rVoice.canonicalPage, 'characters');
  assert.equal(rVoice.canonicalSection, 'voice');

  const rSkins = parseConsoleRoute('#page=skins');
  assert.equal(rSkins.canonicalPage, 'characters');
  assert.equal(rSkins.canonicalSection, 'appearance');

  const rPres = parseConsoleRoute('#page=presentation');
  assert.equal(rPres.canonicalPage, 'characters');
  assert.equal(rPres.canonicalSection, 'appearance');
});

test('UIR-01 Navigation: health/work/integrations/privacy map into Settings', () => {
  const rHealth = parseConsoleRoute('#page=health');
  assert.equal(rHealth.canonicalPage, 'settings');
  assert.equal(rHealth.canonicalSection, 'diagnostics');

  const rProjects = parseConsoleRoute('#page=projects');
  assert.equal(rProjects.canonicalPage, 'settings');
  assert.equal(rProjects.canonicalSection, 'work');

  const rTasks = parseConsoleRoute('#page=tasks');
  assert.equal(rTasks.canonicalPage, 'settings');
  assert.equal(rTasks.canonicalSection, 'work');

  const rWechat = parseConsoleRoute('#page=wechat');
  assert.equal(rWechat.canonicalPage, 'settings');
  assert.equal(rWechat.canonicalSection, 'integrations');

  const rPerception = parseConsoleRoute('#page=perception');
  assert.equal(rPerception.canonicalPage, 'settings');
  assert.equal(rPerception.canonicalSection, 'privacy');

  const rProactive = parseConsoleRoute('#page=proactive');
  assert.equal(rProactive.canonicalPage, 'settings');
  assert.equal(rProactive.canonicalSection, 'privacy');
});

test('UIR-01 Navigation: timeline and events map into Developer and require dev mode', () => {
  const rTimeline = parseConsoleRoute('#page=timeline');
  assert.equal(rTimeline.canonicalPage, 'developer');
  assert.equal(rTimeline.canonicalSection, 'timeline');
  assert.equal(rTimeline.isDeveloperRoute, true);

  const rEvents = parseConsoleRoute('#page=events');
  assert.equal(rEvents.canonicalPage, 'developer');
  assert.equal(rEvents.canonicalSection, 'logs');
  assert.equal(rEvents.isDeveloperRoute, true);
});

test('UIR-01 Navigation: memory sub-sections dispatch correctly across domains', () => {
  // Chat records -> Developer LLM trace
  const rChat = parseConsoleRoute('#page=memory&section=records&type=chat');
  assert.equal(rChat.canonicalPage, 'developer');
  assert.equal(rChat.canonicalSection, 'llm');
  assert.equal(rChat.isDeveloperRoute, true);

  // Facts records -> Knowledge facts
  const rFacts = parseConsoleRoute('#page=memory&section=records');
  assert.equal(rFacts.canonicalPage, 'knowledge');
  assert.equal(rFacts.canonicalSection, 'facts');

  // Prompt -> Characters persona
  const rPrompt = parseConsoleRoute('#page=memory&section=prompt');
  assert.equal(rPrompt.canonicalPage, 'characters');
  assert.equal(rPrompt.canonicalSection, 'persona');

  // Context -> Playground context
  const rContext = parseConsoleRoute('#page=memory&section=context');
  assert.equal(rContext.canonicalPage, 'playground');
  assert.equal(rContext.canonicalSection, 'context');
});

test('UIR-01 Navigation: token is stripped from canonicalTargetHash and URL query', () => {
  const r = parseConsoleRoute('#token=super-secret-xyz&page=knowledge&character=alice&user=u123');
  assert.equal(r.hasTokenInUrl, true);
  assert.equal(r.token, 'super-secret-xyz');
  assert.ok(!r.targetHash.includes('super-secret-xyz'));
  assert.ok(!r.canonicalTargetHash.includes('super-secret-xyz'));
  assert.equal(r.pairing.userId, 'u123');
  assert.equal(r.pairing.characterId, 'alice');
  assert.equal(r.hasExplicitUser, true);
  assert.equal(r.hasExplicitCharacter, true);
});
