// Adapted from framejam src/server/transcribe.ts (tool/model lookup and invocation).
// https://github.com/moritzkremb/framejam/blob/bc45364aff90ba931d350e931291940fdc6e604c/src/server/transcribe.ts
// MIT License, Copyright (c) 2026 Moritz Kremb. See third_party/framejam/LICENSE.
// Changes: source-time cache, corrected SRT, Mandarin default, local tools only.
import { execFile, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { isTranscriptError, parseTranscript } from './transcript.mjs';
import { readManifest, sha256, writeJson } from './manifest.mjs';

const exec = promisify(execFile);
const MODEL_RANK = ['large-v3-turbo', 'large-v3', 'large', 'medium', 'small', 'base', 'tiny'];

function onPath(cmd) {
  const res = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { encoding: 'utf8' });
  return res.status === 0 ? res.stdout.split(/\r?\n/)[0]?.trim() || undefined : undefined;
}

function findWhisper() {
  const configured = process.env.DAILIES_WHISPER;
  if (configured) return fs.existsSync(configured) ? configured : onPath(configured);
  return onPath('whisper-cli') ?? onPath('whisper-cpp');
}

function findModel(dir) {
  const configured = process.env.DAILIES_WHISPER_MODEL;
  if (configured) return fs.existsSync(configured) ? configured : undefined;
  const home = os.homedir();
  const dirs = [path.join(dir, 'models'), path.join(home, '.cache', 'whisper.cpp'),
    path.join(home, '.cache'), path.join(home, '.cache', 'hyperframes', 'whisper', 'models')];
  const found = [];
  for (const dir of dirs) {
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const n of names) {
      if (/^ggml-.*\.bin$|^whisper-.*\.bin$/.test(n) && !n.includes('silero') && !/\.en[.-]/.test(n)) {
        found.push(path.join(dir, n));
      }
    }
  }
  const rank = f => {
    const i = MODEL_RANK.findIndex(m => path.basename(f).includes(m));
    return i < 0 ? MODEL_RANK.length : i;
  };
  return found.sort((a, b) => rank(a) - rank(b))[0];
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

  let transcript;
  if (srt) {
    if (path.extname(srt).toLowerCase() !== '.srt') throw new Error('Provide a corrected .srt timed against the original source');
    transcript = parseTranscript(await readFile(srt, 'utf8'), srt);
  } else if (cached?.source_sha256 === asset.source_sha256 && (cached.corrected || cached.language === language)) {
    console.log(`Cached transcript: ${output}`);
  } else if (!asset.audio) {
    transcript = { words: [], paragraphs: [] };
  } else {
    const whisper = findWhisper(), model = findModel(dir);
    if (!whisper) throw new Error('Missing whisper-cli. Install whisper.cpp locally or set DAILIES_WHISPER.');
    if (!model) throw new Error('Missing local whisper model. Put ggml-large-v3-turbo-q5_0.bin in ~/.cache/hyperframes/whisper/models or set DAILIES_WHISPER_MODEL.');
    if (/\.en[.-]/.test(path.basename(model))) throw new Error('Use a multilingual whisper model');
    if (await sha256(asset.source) !== asset.source_sha256) throw new Error('Source changed after ingest, use a new asset ID');
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'dailies-whisper-'));
    try {
      const wav = path.join(tmp, 'audio.wav');
      await exec('ffmpeg', ['-v', 'error', '-i', asset.source, '-vn', '-af',
        `asetpts=PTS-(${asset.audio_offset ?? 0})/TB,aresample=async=1:first_pts=0`,
        '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav]);
      const threads = String(Math.max(1, Math.min(8, os.cpus().length - 1)));
      const out = path.join(tmp, 'words');
      await exec(whisper, ['-m', model, '-f', wav, '-ml', '1', '-sow', '-oj', '-of', out,
        '-t', threads, '-pp', '-np', '-l', language]);
      try {
        transcript = parseTranscript(await readFile(`${out}.json`, 'utf8'), 'words.json');
      } catch (error) {
        if (!isTranscriptError(error) || !error.message.startsWith('No timed words')) throw error;
        transcript = { words: [], paragraphs: [] };
      }
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
