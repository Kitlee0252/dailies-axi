import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
