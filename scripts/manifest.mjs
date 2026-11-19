import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export function frameRate(value) {
  const [num, den = 1] = String(value).split('/').map(Number);
  const fps = num / den;
  if (!(fps > 0 && Number.isFinite(fps))) throw new Error(`Invalid frame rate: ${value}`);
  return fps;
}

// Corresponds to ffmpeg's fps filter with start_time=0 and round=near.
// When several input frames round to the same slot, fps retains the last.
export function mapFrames(pts, timeBase, fps, count) {
  const slots = pts.map(pts => Math.round(pts * timeBase * fps + 1e-8));
  let source = 0;
  return Array.from({ length: count }, (_, frame) => {
    while (slots[source + 1] <= frame) source++;
    return source;
  });
}

export async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export async function readManifest(dir) {
  try {
    return JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { schema_version: 1, assets: {} };
  }
}

export async function writeJson(file, value) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + '\n');
  await rename(tmp, file);
}
