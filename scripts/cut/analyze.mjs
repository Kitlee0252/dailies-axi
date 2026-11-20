import { join } from 'node:path';
import { sha256, writeJson } from '../manifest.mjs';
import { alignWhisperTranscript } from '../transcript.mjs';
import { picture, probe, sound } from './media.mjs';
import { assetId, schema } from './model.mjs';
import { readOptional } from './files.mjs';

export async function analyzeAsset(media, asset, info, cache = media) {
  if (!assetId.test(asset)) throw new Error(`Invalid asset: ${asset}`);
  const file = join(media, `${asset}.mp4`);
  const path = join(cache, `${asset}.analysis.json`);
  const proxy_sha256 = await sha256(file);
  const cached = await readOptional(path);
  let analysis = cached;
  if (cached?.schema_version !== schema || cached.proxy_sha256 !== proxy_sha256 ||
      cached.source_sha256 !== info.source_sha256) {
    const actual = await probe(file);
    if (actual.frame_count !== info.frame_count || Math.abs(actual.fps - info.proxy_fps) > 1e-7) {
      throw new Error(`Proxy ${asset} changed duration or rate after ingest`);
    }
    const [visual, audio] = await Promise.all([picture(file), sound(file, actual)]);
    if (visual.frame_count !== info.frame_count || await sha256(file) !== proxy_sha256) {
      throw new Error(`Proxy changed while analyzing ${asset}`);
    }
    const silences = audio.quiet.map(([start, end]) => [Math.ceil(start * actual.fps), Math.floor(end * actual.fps)])
      .filter(([start, end]) => start <= end);
    analysis = { schema_version: schema, asset, proxy_sha256, source_sha256: info.source_sha256,
      ...actual, visual_cuts: visual.visual_cuts, silences, silence_seconds: audio.quiet,
      onsets: audio.quiet.map(([, end]) => end).filter(end => end < actual.frame_count / actual.fps),
      loudness_lufs: audio.loudness, peak_dbfs: audio.peak };
    await writeJson(path, analysis);
  }
  const transcript = await readOptional(join(media, `${asset}.transcript.json`));
  if (transcript?.source_sha256 === info.source_sha256 && transcript?.words?.length) {
    // Ingested Whisper timings normally already carry source-audio alignment.
    // Only realign legacy tokens, and preserve manually corrected subtitles.
    const speech = transcript.corrected || transcript.silences ? transcript : alignWhisperTranscript(transcript,
      analysis.silence_seconds.filter(([start, end]) => end - start >= .4).map(([start, end]) => ({ start, end })));
    return { ...analysis, speech: { words: speech.words, language: speech.language } };
  }
  return analysis;
}

export async function analyzeAssets(media, assets, cache = media) {
  const results = [];
  for (const [asset, info] of Object.entries(assets)) results.push([asset, await analyzeAsset(media, asset, info, cache)]);
  return Object.fromEntries(results);
}
