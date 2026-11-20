import assert from 'node:assert/strict';
import test from 'node:test';
import { updateSelection } from './review-selection.mjs';

const first = { start: 10, end: 20 };
const middle = { start: 30, end: 40 };
const last = { start: 50, end: 60 };
const selectCue = (selection, cue) => updateSelection(selection, { type: 'cue', cue });

test('Shift-click extends or shrinks from the original cue in either direction', () => {
  const anchor = selectCue(null, middle);
  assert.deepEqual(anchor, { ...middle, anchor: middle });
  const later = selectCue(anchor, last);
  assert.deepEqual(later, { start: 30, end: 60, anchor: middle });
  const earlier = selectCue(later, first);
  assert.deepEqual(earlier, { start: 10, end: 40, anchor: middle });
  assert.deepEqual(selectCue(earlier, middle), anchor);
});

test('point navigation and a new timeline range reset the transcript anchor', () => {
  const selected = selectCue(null, first);
  const cleared = updateSelection(selected, { type: 'clear' });
  assert.equal(cleared, null);
  assert.deepEqual(selectCue(cleared, last), { ...last, anchor: last });
  const dragged = updateSelection(selected, { type: 'range', ...middle });
  assert.deepEqual(dragged, middle);
  assert.deepEqual(selectCue(dragged, last), { ...last, anchor: last });
});

test('end adjustment leaves the start fixed and clamps to a valid half-open range', () => {
  const adjust = (selection, delta) => updateSelection(selection, { type: 'adjust-end', delta, frameCount: 60 });
  const selected = selectCue(null, last);
  assert.equal(adjust(null, 1), null);
  assert.deepEqual(adjust(selected, 1), selected);
  assert.deepEqual(adjust(selected, -1), { ...selected, end: 59 });
  assert.deepEqual(adjust({ start: 15, end: 16 }, -1), { start: 15, end: 16 });
});
