import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isPointInRect,
  isPointInAnyRect,
  sanitizeRects,
  shouldIgnoreMouseEvents,
} from '../../desktop/interactive-region.js';

test('UI-MAN-01 region hit testing covers both edges of a rectangle', () => {
  const rect = { x: 10, y: 20, width: 100, height: 50 };
  assert.equal(isPointInRect(10, 20, rect), true, 'top-left edge is inside');
  assert.equal(isPointInRect(109, 69, rect), true, 'bottom-right inside edge is inside');
  assert.equal(isPointInRect(110, 20, rect), false, 'right edge is exclusive');
  assert.equal(isPointInRect(10, 70, rect), false, 'bottom edge is exclusive');
  assert.equal(isPointInRect(9, 20, rect), false, 'left of the rect is outside');
  assert.equal(isPointInRect(10, 19, rect), false, 'above the rect is outside');
});

test('UI-MAN-01 many-region hit testing ignores empty lists, not the pointer', () => {
  const regions = [
    { x: 0, y: 0, width: 10, height: 10 },
    { x: 100, y: 100, width: 10, height: 10 },
  ];
  assert.equal(isPointInAnyRect(5, 5, regions), true);
  assert.equal(isPointInAnyRect(105, 105, regions), true);
  assert.equal(isPointInAnyRect(50, 50, regions), false);
  assert.equal(isPointInAnyRect(5, 5, []), false, 'no regions can never contain a point');
});

test('UI-MAN-01 untrusted region payloads are rejected, clamped and bounded', () => {
  assert.deepEqual(sanitizeRects(null), [], 'non-array payload yields no regions');
  assert.deepEqual(sanitizeRects('nope'), [], 'string payload yields no regions');
  assert.deepEqual(sanitizeRects([null, 5, 'x', {}]), [], 'malformed entries are dropped');
  assert.deepEqual(
    sanitizeRects([{ x: 0, y: 0, width: 0, height: 10 }]),
    [],
    'zero-width regions cannot capture the pointer',
  );
  assert.deepEqual(
    sanitizeRects([{ x: 0, y: 0, width: 10, height: -4 }]),
    [],
    'negative-height regions are dropped',
  );
  assert.deepEqual(
    sanitizeRects([{ x: -500, y: -500, width: 600, height: 600 }]),
    [{ x: 0, y: 0, width: 100, height: 100 }],
    'negative origins clamp into the window instead of covering off-screen space',
  );
  assert.deepEqual(
    sanitizeRects([{ x: -5000, y: 0, width: 10, height: 10 }]),
    [],
    'regions entirely outside the window are dropped so they cannot hold the desktop',
  );
  assert.deepEqual(
    sanitizeRects([{ x: 10, y: 10, width: 100000, height: 100000 }], { x: 0, y: 0, width: 800, height: 600 }),
    [{ x: 10, y: 10, width: 790, height: 590 }],
    'oversized regions clamp to the window bounds',
  );
  assert.deepEqual(
    sanitizeRects([{ x: '12', y: '8', width: '40', height: '20' }]),
    [{ x: 12, y: 8, width: 40, height: 20 }],
    'numeric strings from a DOM report are accepted',
  );
});

test('UI-MAN-01 click-through arbitration keeps the character body transparent', () => {
  const regions = [{ x: 100, y: 100, width: 200, height: 200 }];

  assert.equal(
    shouldIgnoreMouseEvents(false, { x: 5, y: 5 }, regions),
    false,
    'with click-through disabled the window always receives the mouse',
  );
  assert.equal(
    shouldIgnoreMouseEvents(true, { x: 150, y: 150 }, regions),
    false,
    'a pointer on the drawer must stop the window from ignoring the mouse',
  );
  assert.equal(
    shouldIgnoreMouseEvents(true, { x: 5, y: 5 }, regions),
    true,
    'a pointer on the character body must stay click-through',
  );
  assert.equal(
    shouldIgnoreMouseEvents(true, null, []),
    true,
    'with no known pointer or regions the window keeps passing clicks to the desktop',
  );
  assert.equal(
    shouldIgnoreMouseEvents(true, null, regions),
    true,
    'an unknown pointer defaults to click-through rather than capturing the desktop',
  );
});

test('UI-MAN-01 a region list edited by a hostile renderer cannot widen capture', () => {
  const hostile = sanitizeRects([
    { x: 0, y: 0, width: 100000, height: 100000 },
    { x: Number.NaN, y: 0, width: 10, height: 10 },
    { x: 0, y: 0, width: Number.POSITIVE_INFINITY, height: 10 },
  ], { x: 0, y: 0, width: 400, height: 300 });

  assert.deepEqual(hostile, [{ x: 0, y: 0, width: 400, height: 300 }]);
  assert.equal(shouldIgnoreMouseEvents(true, { x: 399, y: 299 }, hostile), false);
  assert.equal(shouldIgnoreMouseEvents(true, { x: 400, y: 299 }, hostile), true);
});
