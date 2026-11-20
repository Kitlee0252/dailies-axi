import { spawn, execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { extractFrame as extractJpeg } from '../extract-frame.mjs';
import { promisify } from 'node:util';
import { frameRate } from '../manifest.mjs';
import { findModel, findWhisper } from '../whisper.mjs';

const exec = promisify(execFile);

export async function run(tool, args, options) {
  try {
    return await exec(tool, args, { maxBuffer: 16 * 1024 * 1024, ...options });
  } catch (error) {
    throw new Error(`${tool} failed: ${error.stderr?.trim().slice(-4000) || error.message}`);
  }
}

const ffmpeg = ['-hide_banner', '-nostdin', '-filter_threads', '1'];

export async function videoRate(file) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries',
    'stream=r_frame_rate', '-of', 'csv=p=0', file]);
  const rate = stdout.trim();
  frameRate(rate);
  return rate;
}

export async function probe(file) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-count_frames',
    '-show_entries', 'stream=codec_type,nb_read_frames,r_frame_rate', '-of', 'json', file]);
  const { streams } = JSON.parse(stdout);
  const video = streams.find(stream => stream.codec_type === 'video');
  if (!video || !Number.isSafeInteger(Number(video.nb_read_frames))) throw new Error('Unable to count decoded video frames');
  return { frame_count: Number(video.nb_read_frames), fps: frameRate(video.r_frame_rate),
    audio: streams.some(stream => stream.codec_type === 'audio') };
}

export function quietIntervals(log, duration) {
  const result = [];
  let start;
  for (const [, edge, time] of log.matchAll(/silence_(start|end): (-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)/gi)) {
    if (edge === 'start') start = Math.max(0, Number(time));
    else if (start !== undefined) {
      const end = Math.min(duration, Number(time));
      if (start < end) result.push([start, end]);
      start = undefined;
    }
  }
  if (start !== undefined && start < duration) result.push([start, duration]);
  return result;
}

export async function sound(file, { fps, frame_count, audio }) {
  const duration = frame_count / fps;
  if (!audio) return { quiet: [[0, duration]], loudness: null, peak: null };
  const { stderr } = await run('ffmpeg', [...ffmpeg, '-nostats', '-i', file, '-vn',
    '-af', 'silencedetect=n=-40dB:d=0.045,ebur128=peak=true:framelog=verbose', '-f', 'null', '-']);
  const levels = stderr.slice(stderr.lastIndexOf('Summary:'));
  const finite = value => Number.isFinite(Number(value)) ? Number(value) : null;
  return { quiet: quietIntervals(stderr, duration),
    loudness: finite(levels.match(/\bI:\s*(-?[\d.]+) LUFS/)?.[1]),
    peak: finite(levels.match(/Peak:\s*(-?[\d.]+) dBFS/)?.[1]) };
}

async function readFrames(file, filter, size, receive) {
  const child = spawn('ffmpeg', [...ffmpeg, '-loglevel', 'error', '-i', file, '-an', '-vf', filter,
    '-fps_mode', 'passthrough', '-pix_fmt', 'rgb24', '-c:v', 'rawvideo', '-threads', '1', '-f', 'rawvideo', '-'],
  { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
  const closed = new Promise(resolve => {
    child.on('error', resolve);
    child.on('close', code => resolve(code === 0 ? null : new Error(`FFmpeg frame decode failed: ${stderr}`)));
  });
  let residue = Buffer.alloc(0);
  let i = 0;
  try {
    for await (const chunk of child.stdout) {
      const data = residue.length ? Buffer.concat([residue, chunk]) : chunk;
      let offset = 0;
      while (offset + size <= data.length) {
        receive(data.subarray(offset, offset + size), i++);
        offset += size;
      }
      residue = data.subarray(offset);
    }
  } catch (error) {
    child.kill();
    await closed;
    throw error;
  }
  const error = await closed;
  if (error) throw error;
  if (residue.length) throw new Error('Incomplete raw frame');
  return i;
}

export async function picture(file) {
  let previous;
  const visual_cuts = [];
  const frame_count = await readFrames(file, 'scale=16:16:flags=area', 16 * 16 * 3, (frame, i) => {
    if (previous) {
      let distance = 0;
      for (let j = 0; j < frame.length; j++) distance += Math.abs(frame[j] - previous[j]);
      if (distance / (frame.length * 255) > 0.08) visual_cuts.push(i);
    }
    previous = frame;
  });
  return { frame_count, visual_cuts };
}

export async function cropPixels(file, { x, y, width, height }, [start, end], receive) {
  const crop = `crop=w='max(1,iw*${width})':h='max(1,ih*${height})':x='iw*${x}':y='ih*${y}':exact=1`;
  return readFrames(file, `select='between(n,${start},${end - 1})',format=rgb24,${crop},scale=64:32:flags=area`,
    64 * 32 * 3, receive);
}

export const audioSampleRate = 48000;

export async function audioChannels(file) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', 'a:0',
    '-show_entries', 'stream=channels', '-of', 'csv=p=0', file]);
  return Number(stdout.trim());
}

export async function audioSamples(file, start, duration) {
  const { stdout } = await run('ffmpeg', [...ffmpeg, '-loglevel', 'error', '-ss', String(start),
    '-i', file, '-t', String(duration), '-vn', '-ar', String(audioSampleRate), '-ac', '2',
    '-c:a', 'pcm_f32le', '-f', 'f32le', '-'], { encoding: 'buffer' });
  return new Float32Array(stdout.buffer, stdout.byteOffset, Math.floor(stdout.length / 4));
}

export async function audioPeak(file, seconds) {
  const { stdout } = await run('ffmpeg', [...ffmpeg, '-loglevel', 'error', '-ss', String(Math.max(0, seconds - .02)),
    '-i', file, '-t', '0.04', '-vn', '-ar', '16000', '-c:a', 'pcm_s16le', '-f', 's16le', '-'],
  { encoding: 'buffer' });
  let peak = 0;
  for (let i = 0; i + 2 <= stdout.length; i += 2) peak = Math.max(peak, Math.abs(stdout.readInt16LE(i)));
  return peak / 32768;
}

export async function transcribe(file, wav, media, language) {
  const whisper = findWhisper();
  const model = findModel(media);
  if (!whisper || !model) throw new Error('Install local whisper.cpp and a multilingual model for independent ASR');
  if (!/^[a-z]{2,3}$/.test(language)) throw new Error('Set ops.json language to the Whisper language code');
  await run('ffmpeg', [...ffmpeg, '-loglevel', 'error', '-y', '-i', file,
    '-vn', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav]);
  const { stdout } = await run(whisper, ['-m', model, '-f', wav, '-l', language, '-nt', '-np', '-t', '4']);
  return stdout.trim();
}

export async function extractFrame(file, frame, output) {
  const image = await extractJpeg(file, frame);
  if (!image) throw new Error(`Unable to extract evidence frame F${frame}`);
  await writeFile(output, image);
}

export async function waveform(file, seconds, duration, output) {
  await run('ffmpeg', [...ffmpeg, '-loglevel', 'error', '-y', '-ss', String(seconds), '-t', String(duration),
    '-i', file, '-filter_complex', 'aformat=channel_layouts=mono,showwavespic=s=640x100:colors=white',
    '-frames:v', '1', '-update', '1', output]);
}
