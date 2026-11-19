import { spawn } from 'node:child_process';
import { access, readFile, readdir } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { decode, encode } from '@toon-format/toon';
import { lockNotes, projectState, readNotes } from './notes.mjs';

const [file, ...args] = process.argv.slice(2);
if (!file || basename(file) !== 'review.html') {
  throw new Error('Usage: node scripts/poll-review.mjs review/vN/review.html [lavish poll options]');
}
const path = resolve(file);
const folder = dirname(path);
const root = dirname(folder);
const { version } = JSON.parse(await readFile(join(folder, 'version.json'), 'utf8'));
const latest = async () => (await readdir(root, { withFileTypes: true }))
  .filter(entry => entry.isDirectory() && /^v[1-9]\d*$/.test(entry.name))
  .map(entry => entry.name).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))).at(-1);
if (version !== await latest()) throw new Error('Only the latest version can be polled for video feedback');
const existing = await readNotes(folder);
if (existing) {
  await projectState(folder, 'notes.js', { notes: existing.notes, sentAt: existing.sentAt });
  console.log(JSON.stringify(existing, null, 2));
} else {
  const child = spawn('lavish-axi', ['poll', path, '--owner', 'video-review', ...args],
    { stdio: ['inherit', 'pipe', 'inherit'] });
  const exit = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  let raw = '';
  child.stdout.setEncoding('utf8');
  for await (const chunk of child.stdout) raw += chunk;
  const code = await exit;
  let receipt = raw;
  try {
    if (code !== 0) {
      process.exitCode = code ?? 1;
    } else {
      const result = decode(raw);
      let locked;
      for (const prompt of result.prompts ?? []) {
        if (prompt.tag !== 'video-review') continue;
        const marker = '\n\nContext data:\n';
        const boundary = prompt.prompt.lastIndexOf(marker);
        if (boundary < 0) throw new Error('Lavish video-review prompt omitted the batch data');
        const batch = JSON.parse(prompt.prompt.slice(boundary + marker.length));
        if (batch.version !== version) throw new Error('Batch belongs to a different review version');
        locked = await lockNotes(folder, await latest(), batch);
      }
      if (locked) {
        // Lavish's own next step asks for edits to the generated review page and
        // its DOM snapshot shows that page. Point the agent at the edit instead.
        const { dom_snapshot, next_step, ...rest } = result;
        receipt = encode({ ...rest, feedback: await handoff(locked) }) + '\n';
      }
    }
  } finally {
    // Preserve the full receipt even if a newer round won or validation fails.
    process.stdout.write(receipt);
  }
}

async function handoff(record) {
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  const workspace = dirname(root);
  const composition = join(workspace, 'source', 'index.html');
  const hasComposition = await access(composition).then(() => true, () => false);
  const transcripts = (await readdir(join(folder, 'media')).catch(() => []))
    .filter(name => name.endsWith('.transcript.json')).map(name => join(folder, 'media', name));
  const next = `v${Number(version.slice(1)) + 1}`;
  const defaultRoot = basename(root) === 'review';
  const buildArgs = defaultRoot ? next : `${next} ${quote(root)}`;
  const reviewArg = defaultRoot ? next : quote(join(root, next, 'review.html'));
  return {
    version, notes: record.notes.length, notes_file: join(folder, 'notes.json'), edl: join(folder, 'edl.json'),
    ...(transcripts.length ? { transcripts } : {}), ...(hasComposition ? { composition } : {}),
    next_step: `Edit ${hasComposition ? composition : 'the working composition'} to address each note in notes_file. ` +
      'edl.json maps composition frames to proxy and source frames and lists shot cuts; ' +
      (transcripts.length ? 'the transcripts give word timings in source seconds. ' : '') +
      `Then, from ${quote(workspace)}, run dailies-axi build ${buildArgs} --note "<summary>" --outcomes <file> ` +
      `with a JSON object mapping each note ID to text or { note, frame, end_frame? } in ${next}, and dailies-axi review ${reviewArg}.` +
      (hasComposition && defaultRoot
        ? ` Or run dailies-axi open ${quote(composition)} --note "<summary>" --outcomes <file> to build, open and poll in one step.`
        : ''),
  };
}
