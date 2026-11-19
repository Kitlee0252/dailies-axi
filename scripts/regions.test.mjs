import assert from 'node:assert/strict';
import test from 'node:test';
import { pickRect, intersects, frameAt } from './regions.mjs';

test('reverse drags clamp to the visible canvas and normalize to its bounds', () => {
  assert.deepEqual(pickRect({ x: 0.75, y: 0.5 }, { x: -0.1, y: 2 }, 960, 540),
    { x: 0, y: 0.5, width: 0.75, height: 0.5 });
});

test('a click in a corner makes a bounded nonempty region', () => {
  const rect = pickRect({ x: 1, y: 1 }, { x: 1, y: 1 }, 960, 540);
  assert.equal(rect.width, 32 / 960);
  assert.equal(rect.height, 32 / 540);
  assert.equal(rect.x + rect.width, 1);
  assert.equal(rect.y + rect.height, 1);
});

test('intersection requires area, and the exclusive video end maps to its last frame', () => {
  const rect = { x: 0, y: 0, width: 0.5, height: 0.5 };
  assert.equal(intersects(rect, { ...rect, x: 0.25 }), true);
  assert.equal(intersects(rect, { ...rect, x: 0.5 }), false);
  assert.equal(frameAt(24, 24, 576), 575);
  assert.equal(frameAt(2.1, 24, 576), 50);
});
