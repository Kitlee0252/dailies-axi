import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { normalizeComposition, parseComposition } from '../composition.mjs';
import { sha256 } from '../manifest.mjs';
import { intersection, length } from './ranges.mjs';
import { edlSegments, placed } from './model.mjs';
import { audioChannels, audioPeak, audioSampleRate, audioSamples, cropPixels, extractFrame, picture, probe, run, sound, transcribe, videoRate } from './media.mjs';
import { flashRanges } from './verify-edit.mjs';
import { renderPlan } from './render-plan.mjs';

const require = createRequire(import.meta.url);
const hyperframes = join(dirname(require.resolve('hyperframes/package.json')), 'bin', 'hyperframes.mjs');
const env = { ...process.env, HYPERFRAMES_NO_TELEMETRY: '1', HYPERFRAMES_NO_UPDATE_CHECK: '1', DO_NOT_TRACK: '1' };
const speechText = text => text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{M}\p{N}]/gu, '');

async function render(project, output, [start, end], { fps, frame_count }, rate) {
  const partial = start !== 0 || end !== frame_count;
  const args = partial ? ['--start', String(start / fps), '--end', String(end / fps)] : [];
  await run(process.execPath, [hyperframes, 'render', project, '-o', output, '--quality', 'draft', '--workers', '1',
    '--frames-cache-dir', 'off', '--fps', rate, ...args], { env });
}

async function renderSourceAudio(edl, window, assets, mediaFor, output, audio) {
  const args = [];
  const filters = [];
  const segments = placed(edlSegments(edl));
  for (const { asset, range, output: timeline } of segments) {
    const portion = intersection(window, timeline);
    if (!portion) continue;
    const i = filters.length;
    const start = (range[0] + portion[0] - timeline[0]) / edl.fps;
    const time = length(portion) / edl.fps;
    const mute = audio.some(item => item.output[0] === timeline[0] && item.volume === 0);
    if (assets[asset].audio && !mute) args.push('-ss', String(start), '-t', String(time), '-i', join(mediaFor(asset), `${asset}.mp4`));
    else args.push('-f', 'lavfi', '-t', String(time), '-i', 'anullsrc=r=16000:cl=mono');
    const samples = Math.round(time * 16000);
    filters.push(`[${i}:a]aformat=sample_rates=16000:channel_layouts=mono,asetpts=PTS-STARTPTS,apad,atrim=end_sample=${samples}[a${i}]`);
  }
  await run('ffmpeg', ['-v', 'error', '-y', ...args, '-filter_complex',
    `${filters.join(';')};${filters.map((_, i) => `[a${i}]`).join('')}concat=n=${filters.length}:v=0:a=1[out]`,
    '-map', '[out]', '-c:a', 'pcm_s16le', output]);
}

async function checkSpeech({ input, audio, meta, file, edl, assets, media, mediaFor, temp, window, full, attributes }) {
  const assetHasAudio = edl.segments.some(segment => assets[segment.asset].audio);
  const language = input.language ?? 'zh';
  const wav = join(temp, 'read.wav');
  let expected = input.expected_speech;
  if (!assetHasAudio && expected === undefined) expected = '';
  if (full && typeof expected !== 'string') {
    return { check: 'C4', code: 'expected-speech-required', message: 'Set expected_speech to checked dialogue, or an empty string for a film without dialogue' };
  }
  if (!full && assetHasAudio) {
    const reference = join(temp, 'reference.wav');
    await renderSourceAudio(edl, window, assets, mediaFor, reference, attributes);
    expected = await transcribe(reference, wav, media, language);
  }
  const hasAudibleSignal = meta.audio && !audio.quiet.some(([a, b]) =>
    a <= 1 / meta.fps && b >= (meta.frame_count - 1) / meta.fps);
  const heard = hasAudibleSignal ? await transcribe(file, wav, media, language) : '';
  return speechText(expected ?? '') === speechText(heard)
    ? { check: 'C4', expected, heard, passed: true }
    : { check: 'C4', code: 'speech-mismatch', expected, heard };
}

async function checkOverlay(file, reference, overlay, window) {
  const shared = intersection(overlay.output, window);
  const local = shared.map(frame => frame - window[0]);
  const baseline = [];
  await cropPixels(reference, overlay.rect, local, frame => baseline.push(frame));
  let visible = 0;
  const count = await cropPixels(file, overlay.rect, local, (frame, i) => {
    if (!baseline[i]) return;
    let different = 0;
    for (let p = 0; p < frame.length; p += 3) {
      const contrast = Math.max(Math.abs(frame[p] - baseline[i][p]),
        Math.abs(frame[p + 1] - baseline[i][p + 1]), Math.abs(frame[p + 2] - baseline[i][p + 2]));
      if (contrast >= 24) different++;
    }
    if (different >= frame.length / 3 * .008) visible++;
  });
  const passed = visible === length(shared) && visible === count;
  return { check: 'C5', element: overlay.element, range: shared, visible_frames: visible, passed,
    ...(passed ? {} : { code: 'overlay-pixels-missing' }) };
}

const toDb = value => 20 * Math.log10(Math.max(value, 1e-6));

async function checkAudio(file, reference, planned, window, fps, hasAudio, channels) {
  const shared = intersection(planned.output, window);
  const offset = (shared[0] - planned.output[0]) / fps;
  const duration = length(shared) / fps;
  const pieceDuration = length(planned.output) / fps;
  // HyperFrames duplicates a mono channel at unity. FFmpeg's default stereo
  // conversion attenuates each copy by 3 dB.
  const volume = planned.volume * (channels === 1 ? Math.SQRT2 : 1);
  const outputStart = (shared[0] - window[0]) / fps;
  const sourceStart = planned.range[0] / fps + offset;
  // Compare RMS levels against dry source multiplied by the requested linear
  // envelope. AAC pre-echo and sub-millisecond mixer placement can influence
  // the small interval around an edge.
  const edge = Math.min(.008, duration / 5);
  const count = Math.max(1, Math.ceil((duration - 2 * edge) / .15));
  const span = (duration - 2 * edge) / count;
  let sourcePeakDb = -120;
  let mismatches = 0;
  let worst = 0;
  for (let i = 0; i < count;) {
    const group = Math.min(count - i, 60);
    const start = edge + i * span;
    const seconds = span * group;
    const [dry, wet] = await Promise.all([
      audioSamples(reference, sourceStart + start, seconds),
      hasAudio ? audioSamples(file, outputStart + start, seconds) : [],
    ]);
    for (let j = 0; j < group; j++) {
      const begin = Math.round(j * span * audioSampleRate) * 2;
      const end = Math.round((j + 1) * span * audioSampleRate) * 2;
      let expected = 0;
      let rendered = 0;
      let sourceEnergy = 0;
      for (let k = begin; k < end; k++) {
        const time = offset + start + Math.floor(k / 2) / audioSampleRate;
        const head = planned.fade_in ? time / planned.fade_in : 1;
        const tail = planned.fade_out ? (pieceDuration - time) / planned.fade_out : 1;
        const sample = dry[k] ?? 0;
        expected += (sample * volume * Math.max(0, Math.min(1, head, tail))) ** 2;
        sourceEnergy += sample ** 2;
        rendered += (wet[k] ?? 0) ** 2;
      }
      const referenceDb = toDb(Math.sqrt(expected / (end - begin)));
      const renderedDb = toDb(Math.sqrt(rendered / (end - begin)));
      sourcePeakDb = Math.max(sourcePeakDb, toDb(Math.sqrt(sourceEnergy / (end - begin))));
      if (referenceDb <= -55 && renderedDb <= -49) continue;
      const delta = Math.abs(referenceDb - renderedDb);
      worst = Math.max(worst, delta);
      if (delta > 2.5) mismatches++;
    }
    i += group;
  }
  const passed = mismatches === 0;
  return { check: 'audio-level', passed, range: shared, volume: planned.volume, fade_in: planned.fade_in,
    fade_out: planned.fade_out, measured_windows: count, mismatches, max_delta_db: Number(worst.toFixed(2)),
    max_source_rms_dbfs: Number(sourcePeakDb.toFixed(2)),
    ...(passed ? {} : { code: 'audio-level-mismatch' }) };
}

async function checkSpliceClick(file, time, frame, hasAudio) {
  const edge = .015;
  const start = Math.max(0, time - edge);
  const samples = hasAudio ? await audioSamples(file, start, time + edge - start) : [];
  const center = Math.round((time - start) * audioSampleRate);
  const radius = Math.round(.002 * audioSampleRate);
  let peak = 0;
  const shoulders = [];
  for (let i = 1; i * 2 + 1 < samples.length; i++) {
    const jump = Math.max(Math.abs(samples[i * 2] - samples[(i - 1) * 2]),
      Math.abs(samples[i * 2 + 1] - samples[(i - 1) * 2 + 1]));
    if (Math.abs(i - center) <= radius) peak = Math.max(peak, jump);
    else shoulders.push(jump);
  }
  shoulders.sort((a, b) => a - b);
  const threshold = Math.max(.015, 4 * (shoulders[Math.floor(.95 * shoulders.length)] ?? 0));
  const passed = peak <= threshold;
  return { check: 'C2', frame, passed, peak_sample_jump: Number(peak.toFixed(5)),
    ...(passed ? {} : { code: 'render-splice-click' }) };
}

async function checkReframe(file, reference, planned, window) {
  const shared = intersection(planned.output, window);
  const local = shared.map(frame => frame - window[0]);
  const source = shared.map(frame => frame - planned.output[0] + planned.range[0]);
  const count = length(shared);
  const samples = Math.min(7, count);
  const sampled = new Set(Array.from({ length: samples }, (_, i) => Math.round(i * (count - 1) / Math.max(1, samples - 1))));
  const expected = new Map();
  await cropPixels(reference, planned.rect, source, (pixels, i) => {
    if (sampled.has(i)) expected.set(i, pixels);
  });
  let matched = 0;
  await cropPixels(file, { x: 0, y: 0, width: 1, height: 1 }, local, (frame, i) => {
    if (!expected.has(i)) return;
    const crop = expected.get(i);
    let delta = 0;
    let visiblyDifferent = 0;
    for (let p = 0; p < crop.length; p += 3) {
      const distance = (Math.abs(crop[p] - frame[p]) + Math.abs(crop[p + 1] - frame[p + 1]) +
        Math.abs(crop[p + 2] - frame[p + 2])) / 3;
      delta += distance;
      if (distance > 26) visiblyDifferent++;
    }
    const pixels = crop.length / 3;
    if (delta / pixels <= 12 && visiblyDifferent / pixels <= .20) matched++;
  });
  const passed = expected.size === sampled.size && matched === sampled.size;
  return { check: 'reframe-pixels', range: shared, passed, sampled_frames: sampled.size, matched_frames: matched,
    ...(passed ? {} : { code: 'reframe-pixel-mismatch' }) };
}

export async function verifyRenders({ dir, html, edl, assets, media, mediaFor = () => media, edit, input, mode }) {
  const fps = edl.fps;
  const attributes = edit.audio ?? [];
  const reframes = edit.reframes ?? [];
  const channels = new Map(await Promise.all([...new Set(attributes.map(item => item.asset))].map(async asset =>
    [asset, await audioChannels(join(mediaFor(asset), `${asset}.mp4`))])));
  const clickFrames = edit.click_frames ?? [];
  const fadedSequenceFrames = new Set((edit.splice_fades ?? []).filter(join => join.sequence).map(join => join.frame));
  const windows = renderPlan(edl.frame_count, fps, [...edit.changed_frames, ...clickFrames],
    [...edit.overlays, ...attributes, ...reframes].map(item => item.output), mode);
  const full = windows.length === 1 && windows[0][0] === 0 && windows[0][1] === edl.frame_count;
  if (!full && ![24, 25, 30, 60].includes(fps)) {
    throw new Error('HyperFrames window renders support 24, 25, 30 or 60 fps. Ask for approval to render this edit fully.');
  }
  if (full && typeof input.expected_speech !== 'string' && edl.segments.some(segment => assets[segment.asset].audio)) {
    throw new Error('Set expected_speech in ops.json before verifying an edit with audio');
  }
  // HyperFrames accepts rational rates on the CLI. A decimal data-fps such
  // as 29.970029... otherwise falls back to 30 when the rate is implicit.
  const rate = await videoRate(join(mediaFor(edl.segments[0].asset), `${edl.segments[0].asset}.mp4`));
  const temp = await mkdtemp(join(dir, '.render-'));
  const outputDir = join(dir, mode === 'windows' && !full ? 'windows' : 'render');
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  const errors = [];
  const warnings = [];
  const rendered = [];
  const project = join(temp, 'project');
  try {
    await mkdir(join(project, 'media'), { recursive: true });
    const normal = normalizeComposition(html, parseComposition(html));
    const entry = join(project, 'index.html');
    const gsap = require.resolve('gsap/dist/gsap.min.js');
    await copyFile(gsap, join(project, 'gsap.min.js'));
    for (const asset of new Set(edl.segments.map(segment => segment.asset))) {
      await copyFile(join(mediaFor(asset), `${asset}.mp4`), join(project, 'media', `${asset}.mp4`));
    }
    for (const window of windows) {
      const name = full ? 'film' : `f${window[0]}-f${window[1]}`;
      const file = join(outputDir, `${name}.mp4`);
      await writeFile(entry, normal);
      await render(project, file, window, edl, rate);
      const meta = await probe(file);
      const evidence = { coverage: window, file: relative(dir, file), sha256: await sha256(file),
        frame_count: meta.frame_count, checks: [] };
      rendered.push(evidence);
      if (meta.frame_count !== length(window) || Math.abs(meta.fps - fps) > 1e-7) {
        errors.push({ check: 'duration', code: 'render-duration', window, expected_frames: length(window), ...meta });
        continue;
      }
      const [visual, audio] = await Promise.all([picture(file), sound(file, meta)]);
      const visualFlashes = flashRanges(visual.visual_cuts, meta.frame_count, fps);
      for (const [a, b] of visualFlashes) {
        // A window can begin or end in a longer shot, so edge fragments
        // are only objective faults when they are also at the film edges.
        if ((a === 0 && window[0] !== 0) || (b === meta.frame_count && window[1] !== edl.frame_count)) continue;
        errors.push({ check: 'C3', code: 'render-flash-shot', range: [a + window[0], b + window[0]] });
      }
      evidence.visual_cuts = visual.visual_cuts.map(frame => frame + window[0]);
      evidence.loudness_lufs = audio.loudness;
      evidence.peak_dbfs = audio.peak;
      if (audio.loudness !== null && (audio.loudness < -26 || audio.loudness > -10 || audio.peak > -1)) {
        warnings.push({ code: 'loudness', window, lufs: audio.loudness, peak_dbfs: audio.peak });
      }
      if (audio.quiet.some(([a, b]) => b - a > .75 && a > 0 && b < meta.frame_count / fps)) {
        warnings.push({ code: 'long-pause', window });
      }
      for (const frame of edit.changed_frames.filter(frame => window[0] < frame && frame < window[1])) {
        const local = frame - window[0];
        const seconds = local / fps;
        if (!fadedSequenceFrames.has(frame) &&
            !audio.quiet.some(([start, end]) => seconds - .01 >= start && seconds + .01 <= end)) {
          errors.push({ check: 'C2', code: 'render-cut-in-speech', frame });
        }
        if (meta.audio && await audioPeak(file, seconds) > .85) warnings.push({ code: 'splice-peak', frame });
        for (const offset of [-1, 0]) {
          await extractFrame(file, local + offset, join(outputDir, `splice-${frame + offset}.jpg`));
        }
      }
      for (const frame of clickFrames.filter(frame => window[0] < frame && frame < window[1])) {
        const check = await checkSpliceClick(file, (frame - window[0]) / fps, frame, meta.audio);
        evidence.checks.push(check);
        if (!check.passed) errors.push(check);
      }
      for (const item of attributes.filter(item => intersection(window, item.output))) {
        const check = await checkAudio(file, join(mediaFor(item.asset), `${item.asset}.mp4`), item, window, fps, meta.audio, channels.get(item.asset));
        evidence.checks.push(check);
        if (!check.passed) errors.push(check);
      }
      for (const item of reframes.filter(item => intersection(window, item.output))) {
        const check = await checkReframe(file, join(mediaFor(item.asset), `${item.asset}.mp4`), item, window);
        evidence.checks.push(check);
        if (!check.passed) errors.push(check);
      }
      const speech = await checkSpeech({ input, audio, meta, file, edl, assets, media, mediaFor, temp, window, full, attributes });
      evidence.checks.push(speech);
      if (!speech.passed) errors.push({ ...speech, window });
      for (const overlay of edit.overlays.filter(item => intersection(window, item.output))) {
        const reference = join(temp, 'overlay-reference.mp4');
        const css = `<style>[data-dailies-cut-overlay][id="${overlay.element}"]{visibility:hidden!important;opacity:0!important}</style>`;
        await writeFile(entry, normal.replace(/<\/head>/i, `${css}</head>`));
        await render(project, reference, window, edl, rate);
        const pixel = await checkOverlay(file, reference, overlay, window);
        evidence.checks.push(pixel);
        if (!pixel.passed) errors.push(pixel);
      }
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
  return { errors, warnings, rendered, coverage: full ? 'full' : 'windows' };
}
