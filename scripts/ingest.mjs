import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { frameRate, mapFrames, readManifest, sha256, writeJson } from './manifest.mjs';
import { picture } from './cut/media.mjs';

const run = promisify(execFile);
const probe = async (file, args) => JSON.parse((await run('ffprobe',
  ['-v', 'error', ...args, '-of', 'json', file], { maxBuffer: 64 * 1024 * 1024 })).stdout);
const { positionals: [file, id, extra], values } = parseArgs({
  allowPositionals: true, options: { fps: { type: 'string' }, media: { type: 'string', default: 'media' } },
});
if (!file || extra || !/^[a-zA-Z0-9][\w-]*$/.test(id ?? '')) {
  throw new Error('Usage: node scripts/ingest.mjs <source-file> <asset-id> [--fps RATE] [--media DIR]');
}
const source = resolve(file);
const digest = await sha256(source);
const dir = resolve(values.media);
const { streams, format } = await probe(source, ['-show_streams', '-show_format']);
const video = streams.find(stream => stream.codec_type === 'video' && !stream.disposition?.attached_pic);
if (!video) throw new Error('No video stream found');
const { frames } = await probe(source, ['-select_streams', String(video.index), '-show_frames',
  '-show_entries', 'frame=best_effort_timestamp']);
const pts = frames.map(frame => Number(frame.best_effort_timestamp));
if (!pts.length || pts.some((value, i) => !Number.isSafeInteger(value) || (i > 0 && value < pts[i - 1]))) {
  throw new Error('Source frames need ordered presentation timestamps');
}
const sourceFps = video.r_frame_rate;
const rate = values.fps ?? sourceFps;
if (!/^\d+(?:\.\d+|\/\d+)?$/.test(rate)) throw new Error('Use a decimal or rational frame rate');
const fps = frameRate(rate);
const timeBase = frameRate(video.time_base);
const sourcePts = pts.map(value => value - pts[0]);
const nominal = frameRate(sourceFps);
const slots = sourcePts.map(value => Math.round(value * timeBase * nominal + 1e-8));
const dropped = slots.flatMap((slot, i) =>
  slot - slots[i - 1] > 1 ? [{ after_source_frame: i - 1, count: slot - slots[i - 1] - 1 }] : []);
const rotation = video.side_data_list?.find(item => item.rotation !== undefined)?.rotation ?? Number(video.tags?.rotate ?? 0);
const audio = streams.find(stream => stream.codec_type === 'audio');

await mkdir(dir, { recursive: true });
const lock = join(dir, '.ingest-lock');
await mkdir(lock);
let temp;
try {
  const manifest = await readManifest(dir);
  if (Object.hasOwn(manifest.assets, id)) throw new Error(`Asset ${id} already exists. Choose a new ID.`);
  temp = await mkdtemp(join(dir, '.ingest-'));
  const output = join(temp, 'proxy.mp4');
  const srcStart = pts[0] * timeBase - Number(format.start_time ?? 0);
  const videoFilter = `setpts=PTS-STARTPTS,fps=${rate}:start_time=0:round=near,scale=w='min(iw,1920)':h=-2:force_divisible_by=2`;
  await run('ffmpeg', ['-v', 'error', '-i', source, '-map', `0:${video.index}`,
    ...(audio ? ['-map', `0:${audio.index}`, '-af', `asetpts=PTS-(${srcStart})/TB,aresample=async=1:first_pts=0`, '-c:a', 'aac'] : []),
    '-vf', videoFilter, '-c:v', 'libx264', '-preset', 'fast', '-g', '15', '-bf', '0',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', output]);
  const { streams: [proxy] } = await probe(output, ['-select_streams', 'v:0', '-show_streams']);
  const count = Number(proxy.nb_frames);
  if (!(Number.isSafeInteger(count) && count > 0 && Math.abs(frameRate(proxy.r_frame_rate) - fps) < 1e-7)) {
    throw new Error('Could not verify the proxy rate and frame count');
  }
  const proxyToSource = mapFrames(sourcePts, timeBase, fps, count);
  // Hard cuts in the proxy let reviewers and agents work shot by shot. A
  // rendered rough cut carries no edit list, so detect them from the picture.
  const { visual_cuts: sceneCuts, frame_count: decodedCount } = await picture(output);
  if (decodedCount !== count) throw new Error('Decoded proxy frame count differs from its metadata');
  const name = `${id}.mp4`;
  if (await sha256(source) !== digest) throw new Error('Source changed during ingest');
  manifest.assets[id] = {
    source, source_sha256: digest, source_fps: sourceFps, source_time_base: video.time_base,
    source_first_pts: pts[0], source_pts: sourcePts.map(value => value * timeBase),
    source_timecode: video.tags?.timecode ?? format.tags?.timecode ?? null,
    source_width: video.width, source_height: video.height, rotation,
    duration: sourcePts.at(-1) * timeBase + 1 / nominal,
    audio: Boolean(audio), audio_offset: srcStart,
    proxy: `media/${name}`, proxy_fps: fps, width: proxy.width, height: proxy.height, frame_count: count,
    conform: Math.abs(nominal - fps) > 1e-7 ? 'resampled on the original time axis' : null,
    dropped_frames: dropped, scene_cuts: sceneCuts, proxy_to_source: proxyToSource,
    repeated_frames: proxyToSource.flatMap((value, frame) => value === proxyToSource[frame - 1] ? [frame] : []),
  };
  await rename(output, join(dir, name));
  await writeJson(join(dir, 'manifest.json'), manifest);
  console.log(JSON.stringify({ asset: id, fps, frames: count, duration: count / fps,
    width: proxy.width, height: proxy.height, audio: Boolean(audio), shots: sceneCuts.length + 1,
    repeated_frames: manifest.assets[id].repeated_frames }));
} finally {
  if (temp) await rm(temp, { recursive: true, force: true });
  await rm(lock, { recursive: true });
}
