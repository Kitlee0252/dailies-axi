import test from 'node:test';
import assert from 'node:assert/strict';
import { frameMidpoint, rectInSource } from './regions.mjs';

test('frame midpoint works at fractional source rates', () => {
  assert.ok(Math.abs(frameMidpoint(24, 24000 / 1001) - 24.5 * 1001 / 24000) < 1e-12);
});

test('source rect excludes letterboxing and undoes cover crop', () => {
  const box = { x: 0, y: 0, width: 100, height: 100 };
  const rect = { x: 0, y: 0, width: 100, height: 100 };
  assert.deepEqual(rectInSource(rect, box, 200, 100, 'cover', '50% 50%'),
    { x: .25, y: 0, width: .5, height: 1 });
  assert.equal(rectInSource({ ...rect, height: 20 }, box, 200, 100, 'contain', '50% 50%'), null);
});

test('a missing CFR slot repeats its preceding source frame', async () => {
  const { mapFrames } = await import('./manifest.mjs');
  assert.deepEqual(mapFrames([0, 1, 2, 4, 5], 1, 1, 6), [0, 1, 2, 2, 3, 4]);
});

test('ranges crossing cuts yield separate source intervals', async () => {
  const { mapInterval } = await import('./edl.mjs');
  const asset = { proxy: 'media/camera.mp4', source_fps: '1/1',
    proxy_to_source: [0, 1, 1, 2, 3, 4, 5], source_pts: [0, 1, 3, 4, 5, 6], duration: 7 };
  const edl = { segments: [
    { clip: 'a', asset: 'camera', start_frame: 0, end_frame: 2, media_in: 0 },
    { clip: 'b', asset: 'camera', start_frame: 2, end_frame: 5, media_in: 4 }
  ] };
  assert.deepEqual(mapInterval(edl, { camera: asset }, 1, 4)
    .map(({ clip, frame, end_frame, source_frame, last_source_frame }) =>
      ({ clip, frame, end_frame, source_frame, last_source_frame })), [
    { clip: 'a', frame: 1, end_frame: 2, source_frame: 1, last_source_frame: 1 },
    { clip: 'b', frame: 2, end_frame: 4, source_frame: 3, last_source_frame: 4 }
  ]);
});

test('copied parser preserves corrected subtitles and strict time overlap', async () => {
  const { parseTranscript, wordsBetween } = await import('./transcript.mjs');
  const transcript = parseTranscript('1\n00:00:01,000 --> 00:00:02,000\n原话\n\n2\n00:00:02,000 --> 00:00:03,000\n下句', 'fix.srt');
  assert.equal(wordsBetween(transcript, 1.5, 2), '原话');
  assert.equal(wordsBetween(transcript, 2, 2.5), '下句');
  assert.equal(wordsBetween(parseTranscript('{"transcription":[{"text":"口播","offsets":{"from":100,"to":800}}]}'), 0, .5), '口播');
});

test('poll accepts one batch and subsequent submissions cannot replace it', async () => {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { lockNotes } = await import('./notes.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'dailies-test-'));
  try {
    const batch = { version: 'v1', schema_version: 2, notes: [{ id: 'N1', text: 'first' }] };
    await lockNotes(dir, 'v1', batch);
    await assert.rejects(lockNotes(dir, 'v1', { ...batch, notes: [{ id: 'N1', text: 'changed' }] }), /already sent/);
    assert.equal(JSON.parse(await readFile(join(dir, 'notes.json'))).notes[0].text, 'first');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Chinese point context includes the preceding and following sentences', async () => {
  const { parseTranscript } = await import('./transcript.mjs');
  const { spokenAround } = await import('./spoken.mjs');
  const transcript = parseTranscript(JSON.stringify([
    { text: '前句。', start: 1, end: 3 },
    { text: '这句。', start: 8, end: 11 },
    { text: '后句。', start: 15, end: 17 },
  ]));
  assert.equal(spokenAround(transcript, 9), '前句。 这句。 后句。');
});

test('EDL validates frame alignment and rejects trims outside the original proxy', async () => {
  const { compositionEdl } = await import('./composition-edl.mjs');
  const assets = { camera: { proxy: 'media/camera.mp4', proxy_fps: 2, frame_count: 6,
    proxy_to_source: [0, 1, 2, 3, 4, 5], source_pts: [0, .5, 1, 1.5, 2, 2.5], duration: 3 } };
  const build = (media, duration) => compositionEdl(
    `<main data-composition-id="test" data-fps="2" data-duration="2">
     <video id="shot" data-review-clip="camera" src="media/camera.mp4"
       data-start="0" data-media-start="${media}" data-duration="${duration}"></video></main>`, assets);
  assert.deepEqual(build(1, 2).segments[0], { clip: 'shot', asset: 'camera',
    start_frame: 0, end_frame: 4, media_in: 2, media_out: 6, source_in: 2, source_out: 6,
    source_in_seconds: 1, source_out_seconds: 3 });
  assert.throws(() => build(.25, 2), /frame boundary/);
  assert.throws(() => build(1.5, 2), /outside the composition or proxy/);
});
