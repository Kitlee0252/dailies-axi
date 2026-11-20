import test from 'node:test';
import assert from 'node:assert/strict';
import { frameMidpoint, rectInSource } from './regions.mjs';

test('review corrections keep source cue bounds and untouched words', async () => {
  const { correctTranscript } = await import('./spoken.mjs');
  const transcript = { corrected: false, words: [
    { text: 'first', start: 0, end: 1 }, { text: 'line.', start: 1, end: 2 },
    { text: 'later.', start: 4, end: 5 },
  ] };
  const corrected = correctTranscript(transcript, [{ from: 0, to: 2, text: 'Fixed phrase' }]);
  assert.equal(corrected.corrected, true);
  assert.deepEqual(corrected.words, [
    { text: 'Fixed phrase', start: 0, end: 2, review_edited: true },
    { text: 'later.', start: 4, end: 5 },
  ]);
  assert.deepEqual(corrected.paragraphs, [0, 1]);
  assert.equal(transcript.words[0].text, 'first');
  assert.throws(() => correctTranscript(transcript, [
    { from: 0, to: 2, text: 'first' }, { from: 1, to: 2, text: 'overlaps' },
  ]), /correction/);
});

test('locked corrections update the working transcript and note quotes but preserve the review snapshot', async t => {
  const { mkdtemp, mkdir, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { writeJson } = await import('./manifest.mjs');
  const { lockNotes, persistTranscriptEdits } = await import('./notes.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'dailies-translation-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const folder = join(dir, 'review'), snapshot = join(folder, 'media'), media = join(dir, 'working');
  await mkdir(snapshot, { recursive: true });
  await mkdir(media);
  const asset = { proxy: 'media/cut.mp4', source_sha256: 'source', source_fps: '1/1', duration: 2,
    source_pts: [0, 1], proxy_to_source: [0, 1] };
  const transcript = { source_sha256: 'source', words: [{ start: 0, end: 2, text: 'Wrong' }] };
  for (const boundary of [media, snapshot]) {
    await writeJson(join(boundary, 'manifest.json'), { schema_version: 1, assets: { cut: asset } });
    await writeJson(join(boundary, 'cut.transcript.json'), transcript);
  }
  await writeJson(join(folder, 'version.json'), { version: 'v1', transcript_media: media });
  await writeJson(join(folder, 'edl.json'), { fps: 1, segments: [{ asset: 'cut', clip: 'cut', start_frame: 0,
    end_frame: 2, media_in: 0, source_in_seconds: 0, source_out_seconds: 2 }] });
  const correction = { asset: 'cut', from: 0, to: 1, text: 'Correct' };
  const capture = await lockNotes(folder, 'v1', {
    schema_version: 3, version: 'v1', notes: [{ id: 'N1', kind: 'range', frame: 0, end_frame: 2,
      text: 'Keep the spoken line', spoken: 'Wrong' }], transcript_edits: [correction], overlay_position: .6,
  });
  assert.deepEqual(capture.transcript_edits, [correction]);
  assert.equal(capture.overlay_position, .6);
  assert.equal(capture.notes[0].spoken, 'Correct');
  assert.equal(capture.notes[0].source[0].spoken, 'Correct');
  const read = async boundary => JSON.parse(await readFile(join(boundary, 'cut.transcript.json'), 'utf8'));
  assert.deepEqual(await read(snapshot), transcript);
  assert.deepEqual((await read(media)).words, [{ start: 0, end: 2, text: 'Correct', review_edited: true }]);
  await writeJson(join(media, 'cut.transcript.json'), { ...transcript, corrected: true });
  await persistTranscriptEdits(folder, capture);
  assert.deepEqual(await read(media), { ...transcript, corrected: true });
});

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
  assert.equal(spokenAround(transcript, 9), '前句。这句。后句。');
});

test('Whisper pauses align opening tokens and carry cue breaks into a trimmed edit', async () => {
  const { alignWhisperTranscript, wordsBetween } = await import('./transcript.mjs');
  const { playedTranscript, transcriptCues } = await import('./spoken.mjs');
  const words = [['尾', 1, 2.02], ['杯', 2.02, 2.3], ['身', 2.3, 3.2], ['好', 3.2, 4]].map(
    ([text, start, end]) => ({ text, start, end }));
  const silences = [{ start: 2.05, end: 3 }];
  const automatic = { ...alignWhisperTranscript({ words }, silences), corrected: false };
  assert.deepEqual(automatic.words.map(word => word.start), [1, 3, 3, 3.2]);
  assert.deepEqual(automatic.silences, silences);
  assert.equal(wordsBetween(automatic, 1, 3), '尾');
  assert.equal(wordsBetween(automatic, 3, 4), '杯身好');
  const edl = { fps: 1, segments: [{ asset: 'cut', start_frame: 0, end_frame: 3,
    source_in_seconds: 1, source_out_seconds: 4 }] };
  assert.deepEqual(transcriptCues(playedTranscript(edl, { cut: automatic })).map(cue => cue.start), [0, 2]);
});

test('continuous automatic speech gets bounded cues while corrected cues retain their timing', async () => {
  const { playedTranscript, transcriptCues } = await import('./spoken.mjs');
  const words = Array.from({ length: 20 }, (_, i) => ({ text: '字', start: i, end: i + 1 }));
  const edl = { fps: 1, segments: [{ asset: 'cut', start_frame: 0, end_frame: 20,
    source_in_seconds: 0, source_out_seconds: 20 }] };
  const starts = transcript => transcriptCues(playedTranscript(edl, { cut: transcript })).map(cue => cue.start);
  assert.deepEqual(starts({ words, corrected: false }), [0, 6, 12, 18]);
  assert.deepEqual(starts({ words, corrected: true }), [0]);
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

test('character-timed Chinese joins without spaces while spaced scripts keep them', async () => {
  const { joinWords, parseTranscript, wordsBetween } = await import('./transcript.mjs');
  assert.equal(joinWords(['它', '非常', '轻', '便', ',', '也', '很', '耐', '用', '。']), '它非常轻便,也很耐用。');
  assert.equal(joinWords(['Hello', 'world', ',', 'again.']), 'Hello world, again.');
  assert.equal(joinWords(['用', 'HyperFrames', '剪']), '用HyperFrames剪');
  // Token-level quotes keep the head and tail of long Chinese ranges readable.
  const chars = Array.from({ length: 80 }, (_, i) => ({ text: '字', start: i / 10, end: (i + 1) / 10 }));
  assert.equal(wordsBetween(parseTranscript(JSON.stringify(chars)), 0, 8), '字'.repeat(80));
});

test('EDL lists shot cuts from segment edges and detected scene cuts inside the used media', async () => {
  const { compositionEdl } = await import('./composition-edl.mjs');
  const { shotSpans, snapToCut } = await import('./edl.mjs');
  const asset = { proxy: 'media/cut.mp4', proxy_fps: 1, frame_count: 10, scene_cuts: [3, 6, 8],
    proxy_to_source: [...Array(10).keys()], source_pts: [...Array(10).keys()], duration: 10 };
  const edl = compositionEdl(`<main data-composition-id="test" data-fps="1" data-duration="7">
    <video id="a" data-review-clip="cut" src="media/cut.mp4" data-start="0" data-media-start="0" data-duration="5"></video>
    <video id="b" data-review-clip="cut" src="media/cut.mp4" data-start="5" data-media-start="8" data-duration="2"></video>
    </main>`, { cut: asset });
  // Cut 3 lies inside segment a, cut 6 was trimmed away, and cut 8 coincides with b's start.
  assert.deepEqual(edl.cuts, [3, 5]);
  assert.deepEqual(shotSpans(edl, 4, 5), [{ start_frame: 3, end_frame: 5 }]);
  assert.deepEqual(shotSpans(edl, 2, 6).map(span => span.start_frame), [0, 3, 5]);
  assert.equal(snapToCut(edl, 4, 1), 3);
  assert.equal(snapToCut(edl, 4, 0), 4);
  assert.equal(snapToCut(edl, 6, 1), 5); // A tie keeps the earlier cut.
});

test('the feedback prompt names the shot a note sits in', async () => {
  const { feedbackPrompt } = await import('./feedback-format.mjs');
  const prompt = feedbackPrompt('v1', [{ id: 'N1', kind: 'range', frame: 192, end_frame: 334, text: '删掉这段',
    shots: [{ start_frame: 188, end_frame: 340 }] }]);
  assert.match(prompt, /Shot cut to cut: F188–F340 \(end excluded\)/);
});

test('note quotes follow the edit and leave out speech this version cut', async () => {
  const { withSpoken } = await import('./spoken.mjs');
  const words = [['前句。', 1, 2], ['删掉的。', 4, 5], ['后句。', 7, 8]].map(([text, start, end]) => ({ text, start, end }));
  const transcripts = { cut: { words, paragraphs: [0] } };
  // The edit plays source 0–3 s, then jumps to source 6–9 s at composition 3 s.
  const edl = { fps: 1, segments: [
    { asset: 'cut', start_frame: 0, end_frame: 3, source_in_seconds: 0, source_out_seconds: 3 },
    { asset: 'cut', start_frame: 3, end_frame: 6, source_in_seconds: 6, source_out_seconds: 9 },
  ] };
  const pin = withSpoken({ kind: 'pin', frame: 2 }, [], transcripts, edl);
  assert.equal(pin.spoken_around, '前句。后句。');
  const range = withSpoken({ kind: 'range', frame: 0, end_frame: 6 }, [], transcripts, edl);
  assert.equal(range.spoken, '前句。后句。');
  // A word timed slightly before a trim point still counts as played.
  const trimmed = { ...edl, segments: [{ ...edl.segments[0], source_in_seconds: 1.6 }] };
  assert.equal(withSpoken({ kind: 'range', frame: 0, end_frame: 3 }, [], transcripts, trimmed).spoken, '前句。');
});

test('frame timing normalizes rounded seconds, reports the nearest frame and detects conflicting forms', async () => {
  const { normalizeComposition, parseComposition } = await import('./composition.mjs');
  const html = start => `<!doctype html><body><main data-composition-id="test" data-fps="30" data-duration-frame="200">
    <div id="overlay" ${start}></div></main></body>`;
  const normalize = start => {
    const source = html(start);
    return normalizeComposition(source, parseComposition(source));
  };
  assert.match(normalize('data-start-frame="188" data-start="6.266666667"'), /data-start="6\.266666666666667"/);
  assert.throws(() => normalize('data-start="6.26"'), /#overlay data-start.*nearest is F188/);
  assert.throws(() => normalize('data-start="6.266666667" data-start-frame="187"'), /F188 vs F187/);
  assert.throws(() => normalize('data-start-frame="188.5"'), /non-negative integer/);
});

test('outcomes keep plain text and validate point and range targets in the new version', async () => {
  const { resolveOutcomes } = await import('./outcomes.mjs');
  const previous = { notes: ['N1', 'N2', 'N3'].map(id => ({ id })) };
  const resolve = outcomes => resolveOutcomes(outcomes, previous, 'v2', 10);
  assert.deepEqual(resolve({ N1: 'Trimmed', N2: { note: 'Title', frame: 0 }, N3: { note: 'Fade', frame: 8, end_frame: 10 } }), {
    N1: { version: 'v2', note: 'Trimmed' },
    N2: { version: 'v2', note: 'Title', frame: 0 },
    N3: { version: 'v2', note: 'Fade', frame: 8, end_frame: 10 },
  });
  assert.throws(() => resolve({ N4: 'Typo' }), /unknown previous note ID/);
  for (const details of [{ frame: 10 }, { frame: -1 }, { frame: 1.5 }, { end_frame: 1 }]) {
    assert.throws(() => resolve({ N1: { note: 'Edit', ...details } }), /frame must be an integer/);
  }
  assert.throws(() => resolve({ N1: { note: 'Edit', frame: 8, end_frame: 8 } }), /end_frame must be an integer greater/);
});
