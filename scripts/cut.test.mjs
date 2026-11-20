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
  assert.deepEqual(result.changes.outcomes.N1.frames, [[118, 178]]);
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

test('source attributes survive a later delete and follow the moved surviving pieces', () => {
  const imageHtml = html.replace('data-fps="30"', 'data-fps="30" data-width="160" data-height="90"');
  const sized = { cut: { ...asset, width: 160, height: 90 } };
  const measured = { cut: { visual_cuts: [], silences: [[0, 638]] } };
  const edits = [
    op('N1', 'audio', { asset: 'cut', range: [135, 292], gain_db: 6, fade_in: .1, fade_out: .15 }),
    op('N2', 'reframe', { asset: 'cut', range: [435, 566], scale: 2, x: .25, y: .2 }),
  ];
  const first = applyOperations(cut, base, notes, sequenceInput(...edits), sized, measured);
  assert.equal(first.cut.schema_version, 2);
  assert.deepEqual(first.changes.outcomes.N1.frames, [[135, 292]]);
  const generated = alignComposition(imageHtml, first.cut, sized);
  assert.match(generated, /data-volume="1.995262[^"]*" data-fade-in="0.1" data-fade-out="0.15"/);
  assert.match(generated, /width:200%!important/);
  assert.doesNotMatch(generated, /id="shot-a"[^>]*data-volume=/);
  const firstEdl = compositionEdl(generated, sized);
  const inspect = candidate => inspectEdit({ base, actual: compositionEdl(candidate, sized), html: candidate,
    ...first, analysis: measured, assets: sized });
  assert.deepEqual(inspect(generated).errors, []);
  assert.ok(inspect(generated.replace('data-fade-in="0.1"', 'data-fade-in="0.2"')).errors
    .some(error => error.code === 'attribute-mismatch'));

  const second = applyOperations(first.cut, firstEdl, [
    note('N1', 'range', 170, 220), note('N2', 'range', 135, 292), note('N3', 'range', 435, 566),
  ], { schema_version: 1, from: 'v2', ops: [
    op('N1', 'delete', { asset: 'cut', range: [170, 220] }),
    op('N2', 'move', { asset: 'cut', range: [135, 292], after: 'start' }),
    op('N3', 'delete', { asset: 'cut', range: [435, 566] }),
  ] }, sized, measured);
  assert.deepEqual(sequence(second).slice(0, 2), [['cut', [135, 170]], ['cut', [220, 292]]]);
  assert.equal(second.changes.outcomes.N3.status, 'anchor-lost');
  assert.deepEqual(second.changes.anchor_losses[0].anchor, { asset: 'cut', range: [435, 566] });
  const later = alignComposition(generated, second.cut, sized);
  assert.equal([...later.matchAll(/data-volume="1\.995262/g)].length, 2);
  assert.doesNotMatch(later, /clip-path/);
});

test('reframe rejects a crop that would reveal pixels beyond the source', () => {
  assert.throws(() => applyOperations(cut, base, notes, sequenceInput(
    op('N1', 'reframe', { asset: 'cut', range: [135, 292], scale: 0.5, x: .5, y: .5 }),
  ), assets, analysis), /reframe.*scale/i);
});

test('audio mute uses zero volume and can be replaced on a narrower source interval', () => {
  const first = applyOperations(cut, base, notes, sequenceInput(
    op('N1', 'audio', { asset: 'cut', range: [135, 292], mute: true }),
    op('N1', 'audio', { asset: 'cut', range: [175, 230], mute: false, gain_db: -6 }),
  ), assets, analysis);
  const generated = alignComposition(html, first.cut, assets);
  assert.equal([...generated.matchAll(/data-volume="0"/g)].length, 2);
  assert.match(generated, /data-volume="0.50118/);
});

test('HyperFrames renders source gain, fades, mute and a scaled crop', { timeout: 90_000 }, async t => {
  const { mkdir, mkdtemp, rm, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { run } = await import('./cut/media.mjs');
  const { verifyRenders } = await import('./cut/verify-render.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'dailies-cut-attributes-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const media = join(dir, 'media');
  // A sine wave has no transcript. Isolate the unrelated speech check from
  // Whisper's tendency to hallucinate words on music and test tones.
  const whisper = join(dir, 'whisper');
  const model = join(dir, 'model.bin');
  await writeFile(whisper, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  await writeFile(model, '');
  const previous = { DAILIES_WHISPER: process.env.DAILIES_WHISPER,
    DAILIES_WHISPER_MODEL: process.env.DAILIES_WHISPER_MODEL };
  Object.assign(process.env, { DAILIES_WHISPER: whisper, DAILIES_WHISPER_MODEL: model });
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  await mkdir(media);
  await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'smptebars=size=160x90:rate=30',
    '-f', 'lavfi', '-i', 'sine=frequency=523:sample_rate=48000', '-t', '3',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', join(media, 'cut.mp4')]);
  await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:size=160x90:rate=30',
    '-f', 'lavfi', '-i', 'sine=frequency=311:sample_rate=48000', '-t', '1',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', join(media, 'take.mp4')]);
  const source = `<!doctype html><html><head><style>body{margin:0}[data-composition-id]{position:relative}
    video{position:absolute;inset:0;width:100%;height:100%;object-fit:contain}</style></head><body>
    <main data-composition-id="film" data-fps="30" data-width="160" data-height="90" data-duration-frame="90">
    <video id="cut" class="clip" data-review-clip="cut" src="media/cut.mp4" data-start-frame="0"
      data-duration-frame="90" data-has-audio="true" data-track-index="0"></video></main></body></html>`;
  const localAssets = { cut: { ...asset, frame_count: 90, width: 160, height: 90 },
    take: { ...sequenceAssets.take, frame_count: 30, width: 160, height: 90, audio: true } };
  const measured = { cut: { visual_cuts: [], silences: [] }, take: { visual_cuts: [], silences: [] } };
  const edl = compositionEdl(source, localAssets);
  const result = applyOperations(cutFromEdl(edl, 'v1'), edl, [note('N1', 'range', 0, 90)], sequenceInput(
    op('N1', 'insert', { asset: 'take', range: [0, 30], after: 'start' }),
    op('N1', 'audio', { asset: 'cut', range: [0, 60], gain_db: 6, fade_in: .25, fade_out: .25 }),
    op('N1', 'audio', { asset: 'cut', range: [60, 90], mute: true }),
    op('N1', 'reframe', { asset: 'cut', range: [0, 60], scale: 2, x: .25, y: .6 }),
  ), localAssets, measured);
  const generated = alignComposition(source, result.cut, localAssets);
  const actual = compositionEdl(generated, localAssets);
  const edit = inspectEdit({ base: edl, actual, html: generated, ...result, analysis: measured, assets: localAssets });
  assert.deepEqual(edit.errors, []);
  const render = await verifyRenders({ dir, html: generated, edl: actual, assets: localAssets, media, edit,
    input: { expected_speech: '' } });
  const checks = render.rendered[0].checks;
  assert.ok(checks.some(check => check.check === 'C2' && check.frame === 30 && check.passed), JSON.stringify(render));
  assert.ok(checks.some(check => check.check === 'audio-level' && check.volume > 1 && check.passed), JSON.stringify(render));
  assert.ok(checks.some(check => check.check === 'audio-level' && check.volume === 0 && check.passed), JSON.stringify(render));
  assert.ok(checks.some(check => check.check === 'reframe-pixels' && check.passed), JSON.stringify(render));
  assert.deepEqual(render.errors, []);
  const wrong = generated.replace('data-volume="0"', 'data-volume="1"')
    .replace(/ style="position:absolute!important;[^"]+"/, '');
  await mkdir(join(dir, 'diagnostic'));
  const bad = await verifyRenders({ dir: join(dir, 'diagnostic'), html: wrong, edl: actual, assets: localAssets,
    media, edit, input: { expected_speech: '' } });
  assert.ok(bad.errors.some(error => error.code === 'audio-level-mismatch' && error.volume === 0));
  assert.ok(bad.errors.some(error => error.code === 'reframe-pixel-mismatch'));
});

test('short fades target new audible sequence splices and leave the old delete path unchanged', () => {
  const measured = { cut: { visual_cuts: [], silences: [[132, 132], [292, 292]],
    silence_seconds: [] } };
  const moved = applyOperations(cut, base, notes, sequenceInput(
    op('N1', 'move', { asset: 'cut', range: [132, 292], after: 'start' }),
  ), assets, measured);
  const generated = alignComposition(html, moved.cut, assets);
  assert.match(generated, /data-fade-out="0\.03"/);
  assert.match(generated, /data-fade-in="0\.03"/);
  assert.doesNotMatch(generated, /data-fade-in="0\.03"[^>]*id="shot-a--f132"/);
  assert.equal(moved.changes.splice_points.length, 2);

  const deleted = applyOperations(cut, base, notes, sequenceInput(
    op('N1', 'delete', { asset: 'cut', range: [135, 292] }),
  ), assets, measured);
  assert.doesNotMatch(alignComposition(html, deleted.cut, assets), /data-fade-/);
});
