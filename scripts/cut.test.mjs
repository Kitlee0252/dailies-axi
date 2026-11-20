import assert from 'node:assert/strict';
import test from 'node:test';
import { applyOperations } from './cut/operations.mjs';
import { cutFromEdl } from './cut/model.mjs';
import { inspectEdit } from './cut/verify-edit.mjs';
import { renderPlan } from './cut/render-plan.mjs';
import { alignComposition } from './cut/generate.mjs';
import { compositionEdl } from './composition-edl.mjs';

// Report §5, in source-aligned proxy frames. The two missed review scene cuts
// are present in the independent color analysis.
const asset = {
  proxy: 'media/cut.mp4', proxy_fps: 30, frame_count: 638, audio: true,
  proxy_to_source: Array.from({ length: 638 }, (_, i) => i),
  source_pts: Array.from({ length: 638 }, (_, i) => i / 30),
  scene_cuts: [292, 580], duration: 638 / 30,
};
const assets = { cut: asset };
const analysis = { cut: { visual_cuts: [132, 292, 430, 580],
  silences: [[0, 9], [113, 141], [274, 302], [412, 440], [561, 588], [620, 638]] } };
const html = `<!doctype html><div data-composition-id="film" data-fps="30" data-duration-frame="638">
  <section id="intro" data-start="0"><em>Leave me byte-for-byte.</em></section>
  <video id="shot-a" data-review-clip="cut" src="media/cut.mp4" data-start-frame="0"
    data-duration-frame="638" class="clip custom" data-track-index="0" data-has-audio="true"></video>
</div><script>/* Animation belongs to the author. */</script>`;
const base = compositionEdl(html, assets);
const cut = cutFromEdl(base, 'v1');
const note = (id, kind, frame, end_frame) => ({ id, kind, text: id, frame, end_frame });
const notes = [note('N1', 'range', 135, 292), note('N2', 'pin', 470),
  note('N3', 'range', 580, 638), note('N4', 'general', 0, 638)];
const op = (note, op, fields) => ({ note, op, scope: 'local', authority: 'explicit', intent: note, ...fields });
const ops = { schema_version: 1, from: 'v1', ops: [
  op('N1', 'delete', { asset: 'cut', range: [135, 292] }),
  op('N2', 'overlay', { element: 'price', text: '¥99', anchor: { asset: 'cut', range: [440, 561] },
    rect: { x: 0.1, y: 0.7, width: 0.8, height: 0.12 } }),
  op('N3', 'delete', { asset: 'cut', range: [580, 638] }),
  op('N4', 'tighten', { scope: 'global', authority: 'taste', min_pause: 0.5, keep_pad: 0.15 }),
] };

test('cumulative source edits merge once, ripple captions and preserve authored composition', () => {
  const result = applyOperations(cut, base, notes, ops, assets, analysis);
  assert.deepEqual(result.cut.segments.map(segment => segment.range), [[0, 118], [297, 417], [435, 566]]);
  assert.deepEqual(result.changes.outcomes.N2.frames, [[243, 364]]);
  const generated = alignComposition(html, result.cut, assets);
  assert.ok(generated.includes('<section id="intro" data-start="0"><em>Leave me byte-for-byte.</em></section>'));
  assert.ok(generated.includes('<script>/* Animation belongs to the author. */</script>'));
  assert.equal(compositionEdl(generated, assets).frame_count, 369);
  assert.deepEqual(inspectEdit({ base, actual: compositionEdl(generated, assets),
    html: generated, ...result, analysis }).errors, []);

  const reordered = applyOperations(cut, base, notes, { ...ops, ops: [...ops.ops].reverse() }, assets, analysis);
  assert.deepEqual(reordered.cut, result.cut);
});

test('naive v2 leaves two flash shots, under-deletes N3 by two frames, and loses the caption', () => {
  const result = applyOperations(cut, base, notes, ops, assets, analysis);
  const naive = `<div data-composition-id="film" data-fps="30" data-duration-frame="425">
    <video id="a" data-review-clip="cut" src="media/cut.mp4" data-start-frame="0" data-duration-frame="135"></video>
    <video id="b" data-review-clip="cut" src="media/cut.mp4" data-start-frame="135" data-media-start-frame="292"
      data-duration-frame="290"></video>
    <div id="price" data-start-frame="470" data-duration-frame="90">¥99</div></div>`;
  const { errors } = inspectEdit({ base, actual: compositionEdl(naive, assets),
    html: naive, ...result, analysis });
  assert.deepEqual(errors.filter(item => item.check === 'C3').map(item => item.range), [[132, 135], [423, 425]]);
  assert.equal(errors.find(item => item.check === 'C1' && item.note === 'N3').missing_frames, 2);
  assert.equal(errors.find(item => item.check === 'C5' && item.element === 'price').code, 'overlay-out-of-range');
});

test('a removed overlay anchor is reported and does not jump to other footage', () => {
  const result = applyOperations(cut, base, notes.map(item => item.id === 'N2' ? { ...item, frame: 160 } : item), { ...ops, ops: ops.ops.map(item => item.note === 'N2'
    ? { ...item, anchor: { asset: 'cut', range: [140, 190] } } : item) }, assets, analysis);
  assert.equal(result.changes.outcomes.N2.status, 'anchor-lost');
  assert.deepEqual(result.changes.outcomes.N2.frames, []);
  assert.equal(result.cut.overlays.length, 1);
  const generated = alignComposition(html, result.cut, assets);
  assert.doesNotMatch(generated, /id="price"/);
  assert.ok(inspectEdit({ base, actual: compositionEdl(generated, assets), html: generated,
    ...result, analysis }).errors.some(item => item.code === 'anchor-lost'));
});

test('a requested cut inside speech with no quiet boundary nearby is rejected', () => {
  assert.throws(() => applyOperations(cut, base, notes, { ...ops, ops: [
    op('N1', 'delete', { asset: 'cut', range: [150, 240] }),
  ] }, assets, analysis), /inside speech/);
});

test('long edits require an explicit render choice and clip merged windows to the film', () => {
  assert.deepEqual(renderPlan(5400, 30, [150], []), [[0, 5400]]);
  assert.throws(() => renderPlan(5401, 30, [], []), /3 minutes/);
  assert.deepEqual(renderPlan(5401, 30, [50, 120, 5380], [[300, 320]], 'windows'),
    [[0, 180], [240, 380], [5320, 5401]]);
  assert.deepEqual(renderPlan(5401, 30, [], [], 'full'), [[0, 5401]]);
});

test('structured outcomes preserve status and multiple frame links', async () => {
  const { resolveOutcomes } = await import('./outcomes.mjs');
  const result = resolveOutcomes({ schema_version: 1, kind: 'dailies-cut-changes', from: 'v1', to: 'v2',
    frame_count: 100, outcomes: {
      N1: { status: 'applied', note: 'Two cuts', frames: [[5, 6], [20, 30]] },
      N2: { status: 'pending', note: 'Choose the treatment', frames: [] },
    } }, { version: 'v1', notes: [{ id: 'N1' }, { id: 'N2' }] }, 'v2', 100);
  assert.deepEqual(result, {
    N1: { version: 'v2', note: 'Two cuts', status: 'applied', frames: [[5, 6], [20, 30]], frame: 5 },
    N2: { version: 'v2', note: 'Choose the treatment', status: 'pending', frames: [] },
  });
});

test('open accepts a brief supplied by a noninteractive caller', async () => {
  const { parseCommand } = await import('./cli-args.mjs');
  assert.equal(parseCommand(['open', 'cut.mp4', '--brief', '保温杯口播']).options.brief, '保温杯口播');
});

test('pause tightening absorbs a nearby visual cut instead of leaving a two-frame flash', () => {
  const measured = { cut: { visual_cuts: [132, 292, 430, 580],
    silences: [[105, 135], [266, 294], [404, 433], [553, 583]] } };
  const input = { ...ops, ops: ops.ops.map(item => item.op === 'tighten' ? { ...item, min_pause: 0.7 }
    : item.op === 'overlay' ? { ...item, anchor: { asset: 'cut', range: [435, 552] } } : item) };
  const result = applyOperations(cut, base, notes, input, assets, measured);
  assert.deepEqual(result.cut.segments.map(segment => segment.range), [[0, 110], [292, 409], [430, 558]]);
  const generated = alignComposition(html, result.cut, assets);
  assert.deepEqual(inspectEdit({ base, actual: compositionEdl(generated, assets),
    html: generated, ...result, analysis: measured }).errors, []);
});

test('subsequent trims cannot restore source footage deleted in an earlier round', () => {
  const first = applyOperations(cut, base, notes, ops, assets, analysis).cut;
  const source = alignComposition(html, first, assets);
  const nextEdl = compositionEdl(source, assets);
  const nextNote = note('N1', 'range', 105, 117);
  const input = { schema_version: 1, from: 'v2', ops: [
    op('N1', 'trim', { asset: 'cut', clip: 'shot-a', range: [0, 125] }),
  ] };
  assert.throws(() => applyOperations(first, nextEdl, [nextNote], input, assets, analysis), /previously removed/);
  const shorter = { ...input, ops: [{ ...input.ops[0], range: [0, 115] }] };
  const second = applyOperations(first, nextEdl, [nextNote], shorter, assets, analysis);
  assert.deepEqual(second.cut.segments[0].range, [0, 115]);
  assert.deepEqual(second.changes.removed, [{ asset: 'cut', range: [115, 118] }]);
  assert.deepEqual(second.changes.added, []);
});

test('tightening counts pauses remaining after the explicit deletion', () => {
  const measured = { cut: { visual_cuts: [132, 292, 430, 580],
    silences: [[105, 135], [266, 294], [404, 433], [553, 583]] } };
  const input = { ...ops, ops: ops.ops.map(item => item.op === 'tighten' ? { ...item, min_pause: 0.7 }
    : item.op === 'overlay' ? { ...item, anchor: { asset: 'cut', range: [435, 552] } } : item) };
  const result = applyOperations(cut, base, notes, input, assets, measured);
  assert.match(result.changes.outcomes.N4.note, /Tightened 3 pause/);
});

const sequenceAssets = { ...assets, take: { ...asset, proxy: 'media/take.mp4', audio: false } };
const sequenceAnalysis = { ...analysis, take: { visual_cuts: [], silences: [[0, 638]] } };
const sequenceInput = (...ops) => ({ schema_version: 1, from: 'v1', ops });
const sequence = result => result.cut.segments.map(({ asset, range }) => [asset, range]);

test('move snaps the source and relocates it before a later deletion', () => {
  const result = applyOperations(cut, base, notes, sequenceInput(
    op('N1', 'move', { asset: 'cut', range: [135, 292], after: { asset: 'cut', frame: 429 } }),
    op('N3', 'delete', { asset: 'cut', range: [580, 638] }),
  ), assets, analysis);
  assert.deepEqual(sequence(result), [['cut', [0, 132]], ['cut', [292, 430]], ['cut', [132, 292]], ['cut', [430, 580]]]);
  assert.deepEqual(result.changes.outcomes.N1.frames, [[270, 430]]);
  assert.deepEqual(result.changes.removed, [{ asset: 'cut', range: [580, 638] }]);
  const generated = alignComposition(html, result.cut, assets);
  assert.deepEqual(inspectEdit({ base, actual: compositionEdl(generated, assets), html: generated,
    ...result, analysis, assets }).errors, []);
  const wrongOrder = generated.replace('data-start-frame="132"', 'data-start-frame="292"')
    .replace('data-start-frame="270"', 'data-start-frame="132"');
  assert.ok(inspectEdit({ base, actual: compositionEdl(wrongOrder, assets), html: wrongOrder,
    ...result, analysis, assets }).errors.some(error => error.code === 'conform-mismatch'));
});

test('insert gives unused footage a managed clip and a start-of-film link', () => {
  const result = applyOperations(cut, base, notes, sequenceInput(
    op('N4', 'insert', { asset: 'take', range: [20, 80], after: 'start' }),
  ), sequenceAssets, sequenceAnalysis);
  assert.deepEqual(sequence(result), [['take', [20, 80]], ['cut', [0, 638]]]);
  assert.deepEqual(result.changes.outcomes.N4.frames, [[0, 60]]);
  const generated = alignComposition(html, result.cut, sequenceAssets);
  assert.match(generated, /<video [^>]*muted=""[^>]*src="media\/take\.mp4"/);
  assert.equal(compositionEdl(generated, sequenceAssets).segments[1].start_frame, 60);
});

test('replace swaps in another take and tightening still removes pauses on reviewed footage', () => {
  const result = applyOperations(cut, base, notes, sequenceInput(
    op('N1', 'replace', { asset: 'cut', range: [135, 292], with: { asset: 'take', range: [20, 80] } }),
    op('N4', 'tighten', { scope: 'global', authority: 'taste', min_pause: 0.75, keep_pad: 0.15 }),
  ), sequenceAssets, sequenceAnalysis);
  assert.deepEqual(sequence(result), [['cut', [0, 118]], ['take', [20, 80]], ['cut', [297, 417]],
    ['cut', [435, 566]], ['cut', [583, 638]]]);
  assert.ok(result.changes.outcomes.N1.frames.some(([start]) => start === 118));
});

test('sequence operations reject reused footage and require explicit authority to restore protected frames', () => {
  assert.throws(() => applyOperations(cut, base, notes, sequenceInput(
    op('N1', 'replace', { asset: 'cut', range: [135, 292], with: { asset: 'cut', range: [430, 580] } }),
  ), assets, analysis), /reuse/i);
  const protectedCut = { ...cut, protected: [{ asset: 'take', range: [0, 100] }] };
  const insert = op('N4', 'insert', { asset: 'take', range: [20, 80], after: 'start' });
  assert.throws(() => applyOperations(protectedCut, base, notes, sequenceInput(
    { ...insert, authority: 'inferred' },
  ), sequenceAssets, sequenceAnalysis), /explicit.*protected/i);
  const result = applyOperations(protectedCut, base, notes, sequenceInput(insert), sequenceAssets, sequenceAnalysis);
  assert.deepEqual(result.cut.protected, [{ asset: 'take', range: [0, 20] }, { asset: 'take', range: [80, 100] }]);
});

test('replacement candidates find unused repeated dialogue across assets on the source axis', async () => {
  const { replacementCandidates } = await import('./cut/retakes.mjs');
  const speech = (start, text) => ({ words: text.split(' ').map((text, i) => ({
    text, start: start + i / 3, end: start + (i + 1) / 3,
  })) });
  const measured = {
    cut: { visual_cuts: [], silences: [[132, 135], [165, 172]], speech: speech(4.5, 'Fold it twice.') },
    take: { visual_cuts: [], silences: [[60, 66], [95, 100]], speech: speech(2.2, 'fold it twice') },
  };
  const candidates = replacementCandidates([{ asset: 'cut', range: [135, 165] }], base, sequenceAssets, measured);
  assert.deepEqual(candidates.map(({ target, with: alternate }) => [target, alternate]), [
    [{ asset: 'cut', range: [135, 165] }, { asset: 'take', range: [66, 96] }],
  ]);
});
