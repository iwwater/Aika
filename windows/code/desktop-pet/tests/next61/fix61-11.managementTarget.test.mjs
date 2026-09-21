// FIX61-11 shell token: which console URL does one panel entry actually produce?
//
// These are the production composition rules for a deep link, asserted on the URLs the host would really
// hand to the browser — `managementTarget` is the exact function the host calls, imported from the same
// module the shell pins as a runtime file. A source-text check cannot see this bug: the old code contained
// the route string and still lost the token, so the WHATWG replacement is reproduced here first and then
// measured against the real composition function.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { managementTarget } from '../../tools/management-url.mjs';

const TOKEN = 'a'.repeat(64);
const SESSION = 'http://127.0.0.1:51234/#token=' + TOKEN;
const params = url => new URLSearchParams(new URL(url).hash.slice(1));

test('FIX61-11 a panel route keeps the session token AND the page route', () => {
  // The defect itself, reproduced on the production URL shape: composing with the constructor is what
  // dropped the credential. If this ever stops replacing the fragment the merge below is no longer needed.
  assert.equal(new URL('/#page=skins', SESSION).hash, '#page=skins',
    'the WHATWG constructor replaces the whole fragment, which is exactly why the token was lost');
  assert.equal(params(new URL('/#page=skins', SESSION).href).get('token'), null, 'the old composition really drops the token');

  const skins = new URL(managementTarget(SESSION, '/#page=skins'));
  assert.equal(skins.origin, 'http://127.0.0.1:51234', 'the session origin is preserved');
  assert.equal(skins.pathname, '/', 'the route is a fragment, not a path');
  assert.equal(params(skins.href).get('token'), TOKEN, 'the session token must survive the route');
  assert.equal(params(skins.href).get('page'), 'skins', 'the page the panel asked for must survive too');

  // The pre-existing `#section=` entries take the same path.
  const records = managementTarget(SESSION, '/#section=records');
  assert.equal(params(records).get('token'), TOKEN, '#section routes must keep the token as well');
  assert.equal(params(records).get('section'), 'records', 'the section must still select its sub-tab');

  // A route may also be a real path (`/knowledge-view.mjs` from the 知识库 entry).
  const knowledge = new URL(managementTarget(SESSION, '/knowledge-view.mjs'));
  assert.equal(knowledge.pathname, '/knowledge-view.mjs', 'a path route is still a path route');
  assert.equal(params(knowledge.href).get('token'), TOKEN, 'a path route keeps the token too');
});

test('FIX61-11 token-only, route-only and empty cases stay valid', () => {
  // Token with no route: byte-identical to the session URL the backend published.
  assert.equal(managementTarget(SESSION, '/'), SESSION, 'a route-less entry must not rewrite the session URL');
  assert.equal(managementTarget(SESSION, undefined), SESSION, 'a missing route must not rewrite the session URL');
  assert.equal(managementTarget(SESSION, ''), SESSION, 'an empty route must not rewrite the session URL');

  // Route with no token: the console must still select the page (it then asks for authorization).
  const routeOnly = new URL(managementTarget('http://127.0.0.1:51234/', '/#page=skins'));
  assert.equal(routeOnly.hash, '#page=skins', 'a token-less session keeps the route');
  assert.equal(params(routeOnly.href).get('page'), 'skins');

  // Neither: an ordinary origin with nothing to merge.
  assert.equal(managementTarget('http://127.0.0.1:51234/', '/'), 'http://127.0.0.1:51234/');
  assert.equal(managementTarget('http://127.0.0.1:51234/', undefined), 'http://127.0.0.1:51234/');
});

test('FIX61-11 a route can never replace the session credential or leave its origin', () => {
  // The console reads the FIRST `token` (management/ui/app.mjs), and the session fragment is written
  // first, so a route carrying its own token cannot downgrade the authorization.
  const spoofed = params(managementTarget(SESSION, '/#token=' + 'b'.repeat(64) + '&page=skins'));
  assert.equal(spoofed.get('token'), TOKEN, 'the real session token stays first and therefore wins');
  assert.equal(spoofed.get('page'), 'skins', 'the route keys are still merged');

  // Every other key the console reads from the same hash is preserved as well.
  const combined = params(managementTarget(SESSION, '/#page=memory&section=records'));
  assert.equal(combined.get('token'), TOKEN);
  assert.equal(combined.get('page'), 'memory');
  assert.equal(combined.get('section'), 'records');

  // A protocol-relative route would merge the token into a foreign host's URL: refused outright.
  for (const hostile of ['//example.com/x', '/\\example.com/x', 'https://example.com/#page=skins'])
    assert.throws(() => managementTarget(SESSION, hostile), /management origin/, hostile + ' must be refused');
});
