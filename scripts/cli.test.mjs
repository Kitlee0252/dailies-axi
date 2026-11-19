import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { decode } from '@toon-format/toon';
import { parseCommand } from './cli-args.mjs';

test('ingest accepts literal filenames after -- and resolves media from the caller', () => {
  const cwd = join(tmpdir(), 'Another project');
  const parsed = parseCommand(['ingest', '--media=proxies here', '--fps', '24000/1001', '--', '-take.mov', 'cam'], cwd);
  assert.deepEqual(parsed.args, [join(cwd, '-take.mov'), 'cam']);
  assert.deepEqual(parsed.options, { media: join(cwd, 'proxies here'), fps: '24000/1001' });
});

test('open derives the workspace in the caller and validates overrides', () => {
  const cwd = join(tmpdir(), 'Another project');
  const defaults = parseCommand(['open', 'edits/my.cut.mov'], cwd);
  assert.deepEqual(defaults.args, [join(cwd, 'edits/my.cut.mov'), join(cwd, 'my.cut-review')]);
  assert.deepEqual(defaults.options, { asset: 'cut', version: 'v1' });
  const custom = parseCommand(['open', 'cut.mp4', 'private', '--asset', 'camera-2', '--version', 'v4', '--no-poll'], cwd);
  assert.equal(custom.args[1], join(cwd, 'private'));
  assert.deepEqual(custom.options, { asset: 'camera-2', version: 'v4', 'no-poll': true });
  assert.throws(() => parseCommand(['open', 'cut.mp4', '--asset', '../camera']), /Invalid asset ID/);
  assert.throws(() => parseCommand(['open', 'cut.mp4', '--version', 'v0']), /Invalid starting version/);
});

test('build resolves its output and file options without treating notes as paths', () => {
  const cwd = join(tmpdir(), 'Another project');
  const parsed = parseCommand(['build', 'v2', 'alternate output', '--composition', 'edit.html',
    '--outcomes', 'notes/outcomes.json', '--note=Leave $5'], cwd);
  assert.deepEqual(parsed.args, ['v2', join(cwd, 'alternate output')]);
  assert.equal(parsed.options.composition, join(cwd, 'edit.html'));
  assert.equal(parsed.options.outcomes, join(cwd, 'notes', 'outcomes.json'));
  assert.equal(parsed.options.note, 'Leave $5');
});

test('poll accepts a version or explicit page and preserves the stdin reply sentinel', () => {
  const cwd = join(tmpdir(), 'Another project');
  const standard = parseCommand(['poll', 'v3', '--agent-reply-file', '-'], cwd);
  assert.deepEqual(standard.args, [join(cwd, 'review', 'v3', 'review.html')]);
  assert.equal(standard.options['agent-reply-file'], '-');
  const custom = parseCommand(['review', 'other/v2/review.html', '--reopen'], cwd);
  assert.deepEqual(custom.args, [join(cwd, 'other', 'v2', 'review.html')]);
  assert.equal(custom.options.reopen, true);
});

test('unknown commands, flags and surplus arguments are rejected', () => {
  assert.throws(() => parseCommand(['share', 'v1']), /Unknown command/);
  assert.throws(() => parseCommand(['review', 'v1', '--share']), /Unknown option/);
  assert.throws(() => parseCommand(['frame', 'input.mp4', '0', 'out.jpg', 'extra']), /Usage/);
  assert.throws(() => parseCommand(['ingest', 'input.mp4', '../camera']), /Usage/);
});

const bin = fileURLToPath(new URL('./cli.mjs', import.meta.url));
const run = (cwd, ...args) => spawnSync(process.execPath, [bin, ...args], { cwd, encoding: 'utf8' });

test('init creates a workspace in an external directory and preserves existing edits', async t => {
  const cwd = await mkdtemp(join(await realpath(tmpdir()), 'dailies-cli-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const result = run(cwd, 'init', 'Review project');
  assert.equal(result.status, 0, result.stderr);
  const data = decode(result.stdout);
  assert.equal(data.workspace, join(cwd, 'Review project'));
  const path = join(data.workspace, 'source', 'index.html');
  assert.match(await readFile(path, 'utf8'), /data-composition-id="footage"/);
  await writeFile(path, 'my edit');
  assert.equal(run(cwd, 'init', 'Review project').status, 0);
  assert.equal(await readFile(path, 'utf8'), 'my edit');
});

test('sample build uses assets from the installation and writes to the caller', async t => {
  const cwd = await mkdtemp(join(await realpath(tmpdir()), 'dailies-cli-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  assert.equal(run(cwd, 'init', '--sample').status, 0);
  const result = run(cwd, 'build', 'v1');
  assert.equal(result.status, 0, result.stderr);
  const { review_file } = decode(result.stdout);
  assert.equal(review_file, join(cwd, 'review', 'v1', 'review.html'));
  assert.match(await readFile(review_file, 'utf8'), /Night Signal/);
});

async function openFixture(t) {
  const cwd = await mkdtemp(join(await realpath(tmpdir()), 'dailies-open-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const generated = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=96x64:rate=10',
    '-t', '0.5', '-c:v', 'libx264', join(cwd, 'rough cut.mp4')], { encoding: 'utf8' });
  assert.equal(generated.status, 0, generated.error?.message ?? generated.stderr);
  const tools = join(cwd, 'bin');
  await mkdir(tools);
  await writeFile(join(tools, 'lavish-axi'), `#!/usr/bin/env node
const { encode } = await import(${JSON.stringify(import.meta.resolve('@toon-format/toon'))});
const [command, file, ownerFlag, owner] = process.argv.slice(2);
if (command === 'poll') {
  if (process.env.TEST_NO_POLL || ownerFlag !== '--owner' || owner !== 'video-review') process.exit(9);
  for await (const chunk of process.stdin) { /* Wait for the test to submit feedback. */ }
  const batch = { schema_version: 2, version: 'v1', notes: [{ id: 'N1', text: 'Synthetic feedback' }] };
  console.log(encode({ prompts: [{ tag: 'video-review', prompt: 'Feedback\\n\\nContext data:\\n' + JSON.stringify(batch) }] }));
} else {
  console.log(encode({ session: { file: command, url: 'http://127.0.0.1/review', status: 'opened' } }));
}
`, { mode: 0o700 });
  return { cwd, env: { ...process.env, PATH: tools + delimiter + process.env.PATH } };
}

test('open publishes the link before feedback and a repeat preserves the locked batch', { timeout: 15000 }, async t => {
  const { cwd, env } = await openFixture(t);
  const child = spawn(process.execPath, [bin, 'open', 'rough cut.mp4'], { cwd, env, signal: t.signal });
  t.after(() => child.stdin.end());
  const closed = once(child, 'close');
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const lines = createInterface({ input: child.stdout });
  let output = '';
  for await (const line of lines) {
    output += line + '\n';
    if (line.startsWith('next_step:')) {
      assert.equal(decode(output).session.url, 'http://127.0.0.1/review');
      child.stdin.end();
    }
  }
  assert.equal((await closed)[0], 0, stderr);
  assert.match(output, /Synthetic feedback/);
  const workspace = join(cwd, 'rough cut-review');
  assert.equal((await stat(workspace)).mode & 0o077, 0);
  const notes = join(workspace, 'review', 'v1', 'notes.json');
  const locked = await readFile(notes, 'utf8');
  assert.equal(JSON.parse(locked).notes[0].text, 'Synthetic feedback');
  const repeat = run(cwd, 'open', 'rough cut.mp4');
  assert.equal(repeat.status, 1);
  assert.match(repeat.stderr, /Workspace already exists/);
  assert.equal(await readFile(notes, 'utf8'), locked);
});

test('open --no-poll honors overrides and preserves the next-version lock', async t => {
  const { cwd, env } = await openFixture(t);
  const result = spawnSync(process.execPath, [bin, 'open', 'rough cut.mp4', 'other review', '--asset', 'cam',
    '--version', 'v4', '--no-poll'], { cwd, env: { ...env, TEST_NO_POLL: '1' }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const receipt = decode(result.stdout);
  assert.equal(receipt.asset, 'cam');
  const workspace = join(cwd, 'other review');
  const first = join(workspace, 'review', 'v4');
  assert.equal(receipt.review_file, join(first, 'review.html'));
  assert.ok((await stat(join(first, 'media', 'cam.mp4'))).size);
  assert.equal(JSON.parse(await readFile(join(first, 'version.json'), 'utf8')).parent, null);
  const next = run(workspace, 'build', 'v5');
  assert.equal(next.status, 1);
  assert.match(next.stderr, /Poll and lock v4/);
});
