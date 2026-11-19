#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decode, encode } from '@toon-format/toon';
import { commands, parseCommand } from './cli-args.mjs';
import { readManifest } from './manifest.mjs';
import { findModel, findWhisper } from './whisper.mjs';
import { compositionPath, initWorkspace, isFootageStarter, populateStarter, readComposition, samplePath } from './workspace.mjs';

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const print = data => console.log(encode(data));
const fileArg = file => `'${file.replaceAll("'", "'\\''")}'`;

function run(executable, args, capture) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ['inherit', capture ? 'pipe' : 'inherit', 'inherit'] });
    let output = '';
    child.stdout?.setEncoding('utf8').on('data', chunk => { output += chunk; });
    child.on('error', error => {
      if (error.code === 'ENOENT') reject(new Error(`${executable} was not found. Run dailies-axi doctor.`));
      else reject(error);
    });
    child.on('close', (code, signal) => {
      if (code === 0) return resolve(output);
      if (output) process.stdout.write(output);
      process.exitCode = code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1);
      reject(new Error(`${executable} exited with ${code ?? signal}`));
    });
  });
}

const script = (file, args, capture = true) =>
  run(process.execPath, [fileURLToPath(new URL(file, import.meta.url)), ...args], capture);
const flags = options => Object.entries(options).flatMap(([key, value]) =>
  value === true ? [`--${key}`] : [`--${key}=${value}`]);

async function withStarterLock(file, operation) {
  const lock = join(dirname(file), '.dailies-init-lock');
  try {
    await mkdir(lock);
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('Another command is preparing the starter composition. Retry when it finishes.');
    throw error;
  }
  try {
    return await operation();
  } finally {
    await rm(lock, { recursive: true });
  }
}

async function ingest(args, options, file) {
  const { fps, media = join(process.cwd(), 'media') } = options;
  const execute = async () => {
    const result = JSON.parse(await script('./ingest.mjs', [...args, ...flags({ media, ...(fps ? { fps } : {}) })]));
    const updated = await populateStarter(file, result);
    const mediaFlag = options.media ? ` --media ${fileArg(options.media)}` : '';
    return { ...result, media, ...(updated ? { composition: file } : {}),
      next_step: updated ? `Run dailies-axi build v1${mediaFlag}.`
        : 'Add the asset to the composition if needed, then build the next review version.' };
  };
  const result = await isFootageStarter(await readComposition(file)) ? await withStarterLock(file, execute) : await execute();
  const { next_step, ...rest } = result;
  return { ...rest, transcript: await autoTranscribe(result.asset, media, options), next_step };
}

async function build(args, options, file) {
  const [version, root] = args;
  if (!options.composition) {
    const contents = await readComposition(file);
    if (await isFootageStarter(contents)) {
      // Recover a starter if a proxy was already ingested but the starter write did not finish.
      await withStarterLock(file, async () => {
        if (!await isFootageStarter(await readComposition(file))) return;
        const { assets } = await readManifest(options.media ?? join(process.cwd(), 'media'));
        const entries = Object.entries(assets);
        if (entries.length !== 1) {
          throw new Error(entries.length ? 'Choose an asset in source/index.html before building.' :
            'Run dailies-axi ingest to fill the footage starter before building.');
        }
        const [[asset, info]] = entries;
        await populateStarter(file, { ...info, asset, fps: info.proxy_fps, duration: info.frame_count / info.proxy_fps });
      });
    }
    options = { ...options, composition: contents === undefined ? samplePath : file };
  }
  await script('./build-review.mjs', [...args, ...flags(options)]);
  const review_file = join(root, version, 'review.html');
  return { version, review_file, next_step: `Run dailies-axi review ${fileArg(review_file)}.` };
}

async function review(file, options) {
  if (!(await stat(file)).isFile()) throw new Error(`Not a review file: ${file}`);
  const result = decode(await run('lavish-axi', [file, ...flags(options)], true));
  if (result.session?.status !== 'user-ended' && result.session?.file && result.next_step) {
    result.next_step = result.next_step.replace(`lavish-axi poll ${result.session.file}`, () =>
      `dailies-axi poll ${fileArg(file)}`);
  }
  const announced = result.session?.url && await announce(file, result.session.url);
  return announced ? { ...result, announced } : result;
}

// The reviewer is still looking at the previous round, so post the new link
// there once. Lavish refuses when the reviewer ended that session.
async function announce(file, url) {
  const { version, parent, note } = JSON.parse(await readFile(join(dirname(file), 'version.json'), 'utf8'));
  const marker = join(dirname(file), '.announced');
  if (!parent || await stat(marker).then(() => true, () => false)) return;
  const previous = join(dirname(dirname(file)), parent, 'review.html');
  const message = `${version} is ready for review: ${url}${note ? `\n\n${note}` : ''}`;
  const reply = spawnSync('lavish-axi', ['reply', previous, '--agent-reply', message], { encoding: 'utf8', timeout: 20000 });
  if (reply.status !== 0) {
    return `Could not post the ${version} link in the ${parent} review. Give the reviewer the session URL.`;
  }
  await writeFile(marker, url);
  return `Posted the ${version} link in the ${parent} review.`;
}

function poll(file, options = {}) {
  return script('./poll-review.mjs', [file, ...flags(options)], false);
}

// A transcript lets the reviewer anchor notes to speech, so ingest makes one when it can.
// Missing tools or a failed run never block the ingest or the review link.
async function autoTranscribe(asset, media, options) {
  if (options['no-transcribe']) return { status: 'skipped' };
  if (!options.srt) {
    const { assets } = await readManifest(media);
    if (!assets[asset]?.audio) return { status: 'no audio' };
    const model = findModel(media);
    if (!findWhisper() || !model || /\.en[.-]/.test(basename(model))) {
      return { status: 'unavailable', action: 'Install whisper.cpp with a multilingual model, or pass --srt FILE. Run dailies-axi doctor.' };
    }
  }
  const args = [asset, `--media=${media}`, ...(options.srt ? [`--srt=${options.srt}`] : []),
    ...(options.language ? [`--language=${options.language}`] : [])];
  try {
    await script('./transcribe.mjs', args);
  } catch {
    process.exitCode = undefined;
    return { status: 'failed', action: 'See the transcription error above. The review opened without speech; run dailies-axi transcribe, then build the next version.' };
  }
  const { words } = JSON.parse(await readFile(join(media, `${asset}.transcript.json`), 'utf8'));
  return { status: words.length ? 'ready' : 'no speech', source: options.srt ? 'srt' : 'whisper',
    ...(options.srt ? {} : { language: options.language ?? 'zh' }) };
}

async function open(video, workspace, options) {
  if (!(await stat(video)).isFile()) throw new Error(`Not a video file: ${video}`);
  await mkdir(dirname(workspace), { recursive: true, mode: 0o700 });
  try {
    await mkdir(workspace, { mode: 0o700 });
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new Error(`Workspace already exists: ${workspace}. Choose a new workspace or use the individual commands to continue there.`);
    }
    throw error;
  }

  await initWorkspace(workspace);
  const file = compositionPath(workspace);
  const media = join(workspace, 'media');
  const { asset, version } = options;
  const { transcript } = await ingest([video, asset], { ...options, media }, file);
  const { review_file } = await build([version, join(workspace, 'review')], { media, 'initial-version': true }, file);
  const result = await review(review_file, {});
  const ended = result.session?.status === 'user-ended';
  if (!ended && !result.session?.url) throw new Error('Lavish did not return a review link.');
  if (!ended) result.next_step = options['no-poll'] ? `Run dailies-axi poll ${fileArg(review_file)} to collect feedback.`
    : 'Waiting for feedback. In Lavish, choose Send feedback to agent.';

  const receipt = encode({ workspace, asset, version, review_file, transcript, ...result });
  await new Promise((resolve, reject) => process.stdout.write(`${receipt}\n`, error => error ? reject(error) : resolve()));
  if (!ended && !options['no-poll']) return poll(review_file);
}

function doctor(options) {
  const nodeOk = Number(process.versions.node.split('.')[0]) >= Number(pkg.engines.node.slice(2));
  const encoders = spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8', timeout: 5000 });
  const model = findModel(options.media ?? join(process.cwd(), 'media'));
  const available = (tool, arg) => spawnSync(tool, [arg], { stdio: 'ignore', timeout: 5000 }).status === 0;
  const check = (tool, ok, fix, required = true) =>
    ({ tool, required, status: ok ? 'ok' : 'missing', action: ok ? '' : fix });
  const checks = [
    check('Node', nodeOk, `Install Node ${pkg.engines.node}.`),
    check('FFmpeg', encoders.status === 0 && /\blibx264\b/.test(encoders.stdout), 'Install FFmpeg with libx264 and put it on PATH.'),
    check('FFprobe', available('ffprobe', '-version'), 'Install FFprobe and put it on PATH.'),
    check('lavish-axi', available('lavish-axi', '--help'), 'Run npm install -g lavish-axi.'),
    check('whisper.cpp', Boolean(findWhisper()), 'Install whisper.cpp or set DAILIES_WHISPER.', false),
    check('whisper model', Boolean(model && !/\.en[.-]/.test(basename(model))),
      'Install a multilingual GGML model or set DAILIES_WHISPER_MODEL.', false),
  ];
  const ok = checks.every(item => !item.required || item.status === 'ok');
  print({ status: ok ? 'ready' : 'missing', node_version: process.version, checks, next_step: ok ? 'Run dailies-axi open <video> in your project.'
    : 'Fix missing required checks and run dailies-axi doctor again.' });
  if (!ok) process.exitCode = 1;
}

async function main() {
  const parsed = parseCommand(process.argv.slice(2));
  const { command, args, options } = parsed;
  if (parsed.help) {
    if (command) return print({ usage: `dailies-axi ${commands[command].usage}`, description: commands[command].description });
    return print({
      bin: 'dailies-axi',
      description: 'Prepare local video dailies and collect frame-accurate feedback in Lavish.',
      usage: 'dailies-axi <command> [arguments]',
      commands: Object.values(commands).map(({ usage, description }) => ({ usage, description })),
      next_step: 'Run dailies-axi doctor, then dailies-axi open <video>.',
      privacy: 'Keep footage and review artifacts local. Never share or export them through Lavish.',
    });
  }
  if (parsed.version) return console.log(pkg.version);

  const file = compositionPath(process.cwd());
  switch (command) {
    case 'open': return open(...args, options);
    case 'init': {
      const [workspace] = args;
      const created = await initWorkspace(workspace, options.sample);
      return print({ workspace, composition: compositionPath(workspace), media: join(workspace, 'media'), created,
        next_step: !created ? 'Use the existing composition in the workspace.'
          : options.sample ? 'From the workspace, run dailies-axi build v1.'
          : 'From the workspace, run dailies-axi ingest <source-file> <asset-id>.' });
    }
    case 'ingest': return print(await ingest(args, options, file));
    case 'build': return print(await build(args, options, file));
    case 'transcribe': {
      const output = await script('./transcribe.mjs', [...args, ...flags(options)]);
      return print({ asset: args[0], result: output.trim(),
        next_step: 'Build the next review version to include the transcript.' });
    }
    case 'review': return print(await review(args[0], options));
    case 'poll': return poll(args[0], options);
    case 'frame': {
      await script('./extract-frame.mjs', args);
      return print({ image: args[2], frame: Number(args[1]), next_step: 'Inspect this image alongside the review note and EDL.' });
    }
    case 'doctor': return doctor(options);
  }
}

try {
  await main();
} catch (error) {
  console.error(encode({ error: error.message }));
  process.exitCode ||= 1;
}
