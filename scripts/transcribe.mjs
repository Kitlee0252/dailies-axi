// Adapted from framejam src/server/transcribe.ts (tool/model lookup and invocation).
// https://github.com/moritzkremb/framejam/blob/bc45364aff90ba931d350e931291940fdc6e604c/src/server/transcribe.ts
// MIT License, Copyright (c) 2026 Moritz Kremb. See third_party/framejam/LICENSE.
// Changes: source-time cache, corrected SRT, Mandarin default, token timing for unspaced scripts, local tools only.
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { alignWhisperTranscript, isTranscriptError, parseTranscript } from './transcript.mjs';
import { readManifest, sha256, writeJson } from './manifest.mjs';
import { findModel, findWhisper } from './whisper.mjs';

const exec = promisify(execFile);

async function detectSilences(wav) {
  // Use Whisper's aligned audio so both measurements share the source timeline.
  const { stderr } = await exec('ffmpeg', ['-hide_banner', '-nostats', '-i', wav,
    '-af', 'silencedetect=n=-40dB:d=0.4', '-f', 'null', '-'], { maxBuffer: 8 * 1024 * 1024 });
  const silences = [];
  let start;
  for (const [, boundary, seconds] of stderr.matchAll(/silence_(start|end): (-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)/gi)) {
    if (boundary === 'start') start = Number(seconds);
    else if (start !== undefined) {
      silences.push({ start, end: Number(seconds) });
      start = undefined;
    }
  }
  return silences;
}

async function transcribeWav(wav, dir, language, whisper, model) {
  const threads = String(Math.max(1, Math.min(8, os.cpus().length - 1)));
  const out = path.join(dir, 'words');
  // Word splitting would time whole sentences in scripts without spaces.
  const split = /^(zh|ja|yue)$/.test(language) ? [] : ['-sow'];
  await exec(whisper, ['-m', model, '-f', wav, '-ml', '1', ...split, '-oj', '-of', out,
    '-t', threads, '-pp', '-np', '-l', language]);
  try {
    return parseTranscript(await readFile(`${out}.json`, 'utf8'), 'words.json');
  } catch (error) {
    if (!isTranscriptError(error) || !error.message.startsWith('No timed words')) throw error;
    return { words: [], paragraphs: [] };
  }
}

const { positionals: [id, extra], values } = parseArgs({
  allowPositionals: true, options: { media: { type: 'string', default: 'media' }, srt: { type: 'string' }, language: { type: 'string', default: 'zh' } },
});
if (extra || !/^[a-zA-Z0-9][\w-]*$/.test(id ?? '')) {
  throw new Error('Usage: node scripts/transcribe.mjs <asset-id> [--media DIR] [--srt corrected.srt] [--language zh]');
}
const dir = path.resolve(values.media);
const { assets } = await readManifest(dir);
if (!Object.hasOwn(assets, id)) throw new Error(`Unknown asset: ${id}. Ingest it first.`);
const asset = assets[id];
const output = path.join(dir, `${id}.transcript.json`);
const srt = values.srt;
const lock = path.join(dir, `.${id}.transcribe-lock`);
try {
  await mkdir(lock);
} catch (error) {
  if (error.code === 'EEXIST') throw new Error(`A transcript update is already running for ${id}`);
  throw error;
}
try {
  const cached = await readFile(output, 'utf8').then(JSON.parse, error => {
    if (error.code !== 'ENOENT') throw error;
  });
  const language = values.language;
  const current = cached?.source_sha256 === asset.source_sha256 ? cached : undefined;
  const sameLanguage = current?.language === language;

  let transcript;
  if (srt) {
    if (path.extname(srt).toLowerCase() !== '.srt') throw new Error('Provide a corrected .srt timed against the original source');
    transcript = parseTranscript(await readFile(srt, 'utf8'), srt);
  } else if (current?.corrected || (sameLanguage && (current.silences || !asset.audio))) {
    console.log(`Cached transcript: ${output}`);
  } else if (!asset.audio) {
    transcript = { words: [], paragraphs: [] };
  } else {
    const whisper = sameLanguage ? undefined : findWhisper();
    const model = sameLanguage ? undefined : findModel(dir);
    if (!sameLanguage) {
      if (!whisper) throw new Error('Missing whisper-cli. Install whisper.cpp locally or set DAILIES_WHISPER.');
      if (!model) throw new Error('Missing local whisper model. Put ggml-large-v3-turbo-q5_0.bin in ~/.cache/hyperframes/whisper/models or set DAILIES_WHISPER_MODEL.');
      if (/\.en[.-]/.test(path.basename(model))) throw new Error('Use a multilingual whisper model');
    }
    if (await sha256(asset.source) !== asset.source_sha256) throw new Error('Source changed after ingest, use a new asset ID');
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'dailies-whisper-'));
    try {
      const wav = path.join(tmp, 'audio.wav');
      await exec('ffmpeg', ['-v', 'error', '-i', asset.source, '-vn', '-af',
        `asetpts=PTS-(${asset.audio_offset ?? 0})/TB,aresample=async=1:first_pts=0`,
        '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav]);
      const silences = current?.silences ?? await detectSilences(wav);
      const draft = sameLanguage ? current : await transcribeWav(wav, tmp, language, whisper, model);
      transcript = alignWhisperTranscript(draft, silences);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }
  if (transcript) {
    await writeJson(output, { ...transcript, source_sha256: asset.source_sha256, corrected: Boolean(srt), language });
    console.log(`Saved ${transcript.words.length} timed words to ${output}`);
  }
} finally {
  await rm(lock, { recursive: true });
}
