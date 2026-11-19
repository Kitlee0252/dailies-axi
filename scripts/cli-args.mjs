import { basename, extname, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const version = /^v[1-9]\d*$/;
const asset = /^[a-zA-Z0-9][\w-]*$/;
const frame = /^\d+$/;
export const isCompositionFile = file => /^\.html?$/i.test(extname(file));
const optionTypes = { string: { type: 'string' }, boolean: { type: 'boolean' }, path: { type: 'string' } };

export const commands = {
  open: {
    usage: 'open <video|composition.html> [workspace-dir] [--asset ID] [--version vN] [--note SUMMARY] [--outcomes FILE] [--language CODE | --srt FILE | --no-transcribe] [--no-poll] [--no-open]',
    description: 'Ingest a video or the missing originals in a HyperFrames composition, build the review, open it in Lavish and wait for feedback. Open the workspace’s source/index.html for the next round. Use --no-poll to exit after opening.',
    positionals: [{ path: true }, { path: true, optional: true }],
    flags: { asset: 'string', version: 'string', note: 'string', outcomes: 'path', language: 'string', srt: 'path',
      'no-transcribe': 'boolean', 'no-poll': 'boolean', 'no-open': 'boolean' },
  },
  init: {
    usage: 'init [directory] [--sample]',
    description: 'Create source/ and media/ and copy a starter composition. Use --sample for Night Signal.',
    positionals: [{ path: true, default: '.' }],
    flags: { sample: 'boolean' },
  },
  ingest: {
    usage: 'ingest <source-file> <asset-id> [--fps RATE] [--media DIR] [--language CODE | --srt FILE | --no-transcribe]',
    description: 'Make a local proxy, detect shot cuts, transcribe when local Whisper is available, and fill an untouched footage starter with its dimensions, rate and duration.',
    positionals: [{ path: true }, { pattern: asset }],
    flags: { fps: 'string', media: 'path', language: 'string', srt: 'path', 'no-transcribe': 'boolean' },
  },
  transcribe: {
    usage: 'transcribe <asset-id> [--srt FILE] [--language CODE] [--media DIR]',
    description: 'Transcribe locally with whisper.cpp, or import a corrected source-time SRT.',
    positionals: [{ pattern: asset }],
    flags: { srt: 'path', language: 'string', media: 'path' },
  },
  build: {
    usage: 'build <vN> [output-directory] [--composition FILE] [--media DIR] [--note SUMMARY] [--outcomes FILE]',
    description: 'Build the next immutable review version. Defaults to source/index.html and review/.',
    positionals: [{ pattern: version }, { path: true, default: 'review' }],
    flags: { composition: 'path', media: 'path', note: 'string', outcomes: 'path' },
  },
  review: {
    usage: 'review <vN|review.html> [--reopen] [--no-open]',
    description: 'Open a local review in Lavish. Reopen an ended session only with the reviewer’s consent.',
    positionals: [{ review: true }],
    flags: { reopen: 'boolean', 'no-open': 'boolean' },
  },
  poll: {
    usage: 'poll <vN|review.html> [--agent-reply TEXT | --agent-reply-file FILE] [--takeover] [--timeout-ms MS]',
    description: 'Wait for Lavish feedback in the foreground and lock the video batch as notes.json.',
    positionals: [{ review: true }],
    flags: { 'agent-reply': 'string', 'agent-reply-file': 'path', takeover: 'boolean', 'timeout-ms': 'string' },
  },
  frame: {
    usage: 'frame <proxy.mp4> <frame> <output.jpg>',
    description: 'Extract a JPEG at an exact zero-based decoded proxy frame index.',
    positionals: [{ path: true }, { pattern: frame }, { path: true }],
    flags: {},
  },
  doctor: {
    usage: 'doctor [--media DIR]',
    description: 'Check Node, FFmpeg, FFprobe, Lavish and optional local transcription dependencies.',
    positionals: [],
    flags: { media: 'path' },
  },
};

export function parseCommand([command, ...argv], cwd = process.cwd()) {
  if (!command || command === '--help' || command === '-h') return { help: true };
  if (command === '--version' && !argv.length) return { version: true };
  if (!Object.hasOwn(commands, command)) throw new Error(`Unknown command: ${command}. Run dailies-axi --help.`);
  const spec = commands[command];
  const options = Object.fromEntries(Object.entries(spec.flags).map(([name, type]) => [name, optionTypes[type]]));
  let parsed;
  const usage = `Usage: dailies-axi ${spec.usage}`;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true,
      options: { ...options, help: { type: 'boolean', short: 'h' } } });
  } catch (error) {
    throw new Error(`${error.message}\n${usage}`);
  }
  const { values, positionals } = parsed;
  if (values.help) return { command, help: true };
  if (positionals.length > spec.positionals.length) throw new Error(usage);
  const args = spec.positionals.map((arg, i) => {
    const value = positionals[i] ?? arg.default;
    if (value === undefined && arg.optional) return;
    if (!value || (arg.pattern && !arg.pattern.test(value))) throw new Error(usage);
    if (arg.review) {
      if (version.test(value)) return resolve(cwd, 'review', value, 'review.html');
      if (basename(value) !== 'review.html') throw new Error(usage);
    }
    return arg.path || arg.review ? resolve(cwd, value) : value;
  });
  const flags = Object.fromEntries(Object.entries(values).map(([name, value]) => {
    if (spec.flags[name] !== 'path' || (name === 'agent-reply-file' && value === '-')) return [name, value];
    if (!value) throw new Error(`--${name} requires a path.\n${usage}`);
    return [name, resolve(cwd, value)];
  }));
  if (flags['no-transcribe'] && (flags.srt || flags.language)) {
    throw new Error(`--no-transcribe cannot be combined with --srt or --language\n${usage}`);
  }
  if (command === 'open') {
    const [file] = args;
    if (isCompositionFile(file)) {
      if (flags.asset !== undefined) throw new Error(`--asset only applies to opening a video.\n${usage}`);
    } else {
      if (flags.note !== undefined || flags.outcomes !== undefined) {
        throw new Error(`--note and --outcomes only apply to opening a composition.\n${usage}`);
      }
      args[1] ??= resolve(cwd, `${basename(file, extname(file))}-review`);
      flags.asset ??= 'cut';
      flags.version ??= 'v1';
      if (!asset.test(flags.asset)) throw new Error(`Invalid asset ID: ${flags.asset}\n${usage}`);
    }
    if (flags.version !== undefined &&
        (!version.test(flags.version) || !Number.isSafeInteger(Number(flags.version.slice(1))))) {
      throw new Error(`Invalid starting version: ${flags.version}\n${usage}`);
    }
  }
  return { command, args, options: flags };
}
