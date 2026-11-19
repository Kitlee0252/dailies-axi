import { spawn } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { decode } from '@toon-format/toon';
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
  // Preserve the full receipt even if a newer round won or validation fails.
  process.stdout.write(raw);
  if (code !== 0) {
    process.exitCode = code ?? 1;
  } else {
    const result = decode(raw);
    for (const prompt of result.prompts ?? []) {
      if (prompt.tag !== 'video-review') continue;
      const marker = '\n\nContext data:\n';
      const boundary = prompt.prompt.lastIndexOf(marker);
      if (boundary < 0) throw new Error('Lavish video-review prompt omitted the batch data');
      const batch = JSON.parse(prompt.prompt.slice(boundary + marker.length));
      if (batch.version !== version) throw new Error('Batch belongs to a different review version');
      await lockNotes(folder, await latest(), batch);
    }
  }
}
