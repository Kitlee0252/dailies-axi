// Adapted from framejam src/server/thumbs.ts.
// https://github.com/moritzkremb/framejam/blob/bc45364aff90ba931d350e931291940fdc6e604c/src/server/thumbs.ts
// MIT License, Copyright (c) 2026 Moritz Kremb. See third_party/framejam/LICENSE.
// Changes: frame-index selection and a CLI for local frame grabs.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

let ffmpegAvailable;

export function hasFfmpeg() {
  if (ffmpegAvailable === undefined) {
    ffmpegAvailable = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
  }
  return ffmpegAvailable;
}

export function extractFrame(videoFile, frame) {
  if (!hasFfmpeg() || !fs.existsSync(videoFile) || !Number.isSafeInteger(frame) || frame < 0) {
    return Promise.resolve(undefined);
  }
  return new Promise(resolve => {
    const proc = spawn('ffmpeg', ['-loglevel', 'error', '-i', videoFile, '-frames:v', '1',
      '-vf', `select=eq(n\\,${frame}),scale=480:-2`, '-q:v', '4', '-f', 'image2', '-c:v', 'mjpeg', 'pipe:1'],
    { stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks = [];
    proc.stdout.on('data', d => chunks.push(d));
    proc.on('error', () => resolve(undefined));
    proc.on('close', code => resolve(code === 0 && chunks.length ? Buffer.concat(chunks) : undefined));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [video, frame, output] = process.argv.slice(2);
  if (!video || !/^\d+$/.test(frame ?? '') || !output) {
    throw new Error('Usage: node scripts/extract-frame.mjs <proxy.mp4> <frame> <output.jpg>');
  }
  const image = await extractFrame(video, Number(frame));
  if (!image) throw new Error('Could not extract that frame. Check FFmpeg, the input path and frame number.');
  await writeFile(output, image);
}
