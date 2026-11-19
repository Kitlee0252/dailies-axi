// Adapted from framejam src/server/transcribe.ts (tool/model lookup and invocation).
// https://github.com/moritzkremb/framejam/blob/bc45364aff90ba931d350e931291940fdc6e604c/src/server/transcribe.ts
// MIT License, Copyright (c) 2026 Moritz Kremb. See third_party/framejam/LICENSE.
// Changes: source-time cache, corrected SRT, Mandarin default, local tools only.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MODEL_RANK = ['large-v3-turbo', 'large-v3', 'large', 'medium', 'small', 'base', 'tiny'];

function onPath(cmd) {
  const res = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { encoding: 'utf8' });
  return res.status === 0 ? res.stdout.split(/\r?\n/)[0]?.trim() || undefined : undefined;
}

function isFile(file, mode = fs.constants.R_OK) {
  try {
    fs.accessSync(file, mode);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

export function findWhisper() {
  const configured = process.env.DAILIES_WHISPER;
  if (configured) return isFile(configured, fs.constants.X_OK) ? path.resolve(configured) : onPath(configured);
  return onPath('whisper-cli') ?? onPath('whisper-cpp');
}

export function findModel(dir) {
  const configured = process.env.DAILIES_WHISPER_MODEL;
  if (configured) return isFile(configured) ? path.resolve(configured) : undefined;
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
        const model = path.join(dir, n);
        if (isFile(model)) found.push(model);
      }
    }
  }
  const rank = f => {
    const i = MODEL_RANK.findIndex(m => path.basename(f).includes(m));
    return i < 0 ? MODEL_RANK.length : i;
  };
  return found.sort((a, b) => rank(a) - rank(b))[0];
}
