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

async function openFixture(t, { audio = false } = {}) {
  const cwd = await mkdtemp(join(await realpath(tmpdir()), 'dailies-open-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const generated = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=96x64:rate=10',
    ...(audio ? ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000', '-c:a', 'aac'] : []),
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
  console.log(encode({ prompts: [{ tag: 'video-review', prompt: 'Feedback\\n\\nContext data:\\n' + JSON.stringify(batch) }],
    next_step: 'Apply the requested changes to ' + file, dom_snapshot: 'uid=1 body' }));
} else if (command === 'reply') {
  const { appendFileSync } = await import('node:fs');
  appendFileSync(process.env.TEST_REPLY_LOG, JSON.stringify(process.argv.slice(3)) + '\\n');
  console.log(encode({ reply: { file, status: 'sent' } }));
} else {
  console.log(encode({ session: { file: command, url: 'http://127.0.0.1/review', status: 'opened' } }));
}
`, { mode: 0o700 });
  // A stand-in for whisper.cpp that times one word, so open can transcribe offline.
  await writeFile(join(tools, 'fake-whisper'), `#!/usr/bin/env node
const args = process.argv.slice(2);
// Unspaced scripts are timed per token, without -sow.
if (args.includes('-sow')) process.exit(7);
const out = args[args.indexOf('-of') + 1];
require('node:fs').writeFileSync(out + '.json', JSON.stringify({ transcription: [{ text: '你好', offsets: { from: 0, to: 400 } }] }));
`, { mode: 0o700 });
  await writeFile(join(tools, 'ggml-large-v3-turbo-test.bin'), '');
  return { cwd, tools, env: { ...process.env, PATH: tools + delimiter + process.env.PATH,
    DAILIES_WHISPER: join(tools, 'missing-whisper'), TEST_REPLY_LOG: join(cwd, 'replies.log') } };
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
  // The poll replaces Lavish's page-editing advice with the edit-and-build step.
  assert.doesNotMatch(output, /dom_snapshot|Apply the requested changes/);
  assert.match(output, /notes_file: .*notes\.json/);
  assert.match(output, /dailies-axi build v2 --note/);
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

test('open transcribes with local whisper and still opens when whisper is missing', async t => {
  const { cwd, tools, env } = await openFixture(t, { audio: true });
  const whisperEnv = { ...env, TEST_NO_POLL: '1', DAILIES_WHISPER: join(tools, 'fake-whisper'),
    DAILIES_WHISPER_MODEL: join(tools, 'ggml-large-v3-turbo-test.bin') };
  const result = spawnSync(process.execPath, [bin, 'open', 'rough cut.mp4', 'with speech', '--no-poll'],
    { cwd, env: whisperEnv, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(decode(result.stdout).transcript, { status: 'ready', source: 'whisper', language: 'zh' });
  const page = await readFile(join(cwd, 'with speech', 'review', 'v1', 'review.html'), 'utf8');
  assert.match(page, /你好/);

  const missing = spawnSync(process.execPath, [bin, 'open', 'rough cut.mp4', 'no whisper', '--no-poll'],
    { cwd, env: { ...env, TEST_NO_POLL: '1' }, encoding: 'utf8' });
  assert.equal(missing.status, 0, missing.stderr);
  const receipt = decode(missing.stdout);
  assert.equal(receipt.transcript.status, 'unavailable');
  assert.equal(receipt.session.url, 'http://127.0.0.1/review');

  const skipped = spawnSync(process.execPath, [bin, 'open', 'rough cut.mp4', 'skipped', '--no-poll', '--no-transcribe'],
    { cwd, env: whisperEnv, encoding: 'utf8' });
  assert.equal(decode(skipped.stdout).transcript.status, 'skipped');
  assert.throws(() => parseCommand(['open', 'cut.mp4', '--no-transcribe', '--language', 'en']), /cannot be combined/);

  // A later clip ingested for a multi-clip composition is transcribed the same way.
  const added = spawnSync(process.execPath, [bin, 'ingest', '../rough cut.mp4', 'take-2'],
    { cwd: join(cwd, 'with speech'), env: whisperEnv, encoding: 'utf8' });
  assert.equal(added.status, 0, added.stderr);
  assert.equal(decode(added.stdout).transcript.status, 'ready');
  assert.ok((await stat(join(cwd, 'with speech', 'media', 'take-2.transcript.json'))).size);
});

test('ingest records hard cuts and the next version posts its link in the previous review', { timeout: 20000 }, async t => {
  const { cwd, env } = await openFixture(t);
  const cuts = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=96x64:r=10:d=1',
    '-f', 'lavfi', '-i', 'color=c=red:s=96x64:r=10:d=1', '-filter_complex', '[0][1]concat=n=2:v=1',
    '-c:v', 'libx264', join(cwd, 'two shots.mp4')], { encoding: 'utf8' });
  assert.equal(cuts.status, 0, cuts.stderr);
  const child = spawn(process.execPath, [bin, 'open', 'two shots.mp4'], { cwd, env, signal: t.signal });
  t.after(() => child.stdin.end());
  child.stdout.once('data', () => child.stdin.end());
  assert.equal((await once(child, 'close'))[0], 0);
  const workspace = join(cwd, 'two shots-review');
  const manifest = JSON.parse(await readFile(join(workspace, 'media', 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.assets.cut.scene_cuts, [10]);
  const edl = JSON.parse(await readFile(join(workspace, 'review', 'v1', 'edl.json'), 'utf8'));
  assert.deepEqual(edl.cuts, [10]);

  assert.equal(run(workspace, 'build', 'v2', '--note', 'Trimmed').status, 0);
  const opened = spawnSync(process.execPath, [bin, 'review', 'v2'], { cwd: workspace, env, encoding: 'utf8' });
  assert.equal(opened.status, 0, opened.stderr);
  assert.match(decode(opened.stdout).announced, /Posted the v2 link in the v1 review/);
  const [previous, flag, message] = JSON.parse(await readFile(join(cwd, 'replies.log'), 'utf8'));
  assert.equal(previous, join(workspace, 'review', 'v1', 'review.html'));
  assert.equal(flag, '--agent-reply');
  assert.equal(message, 'v2 is ready for review: http://127.0.0.1/review\n\nTrimmed');
  // Reopening the same version does not repeat the announcement.
  spawnSync(process.execPath, [bin, 'review', 'v2'], { cwd: workspace, env, encoding: 'utf8' });
  assert.equal((await readFile(join(cwd, 'replies.log'), 'utf8')).trim().split('\n').length, 1);
});

test('open ingests two composition originals, reuses them in v2 and snapshots exact outcome frames', { timeout: 20000 }, async t => {
  const { cwd, env } = await openFixture(t);
  const input = join(cwd, 'edit.htm');
  const author = `<!doctype html><body><main data-composition-id="edit" data-width="96" data-height="64"
    data-fps="30" data-duration-frame="24">
    <video id="a" data-review-clip="camera-a" src="rough cut.mp4" muted
      data-start-frame="0" data-duration-frame="11"></video>
    <video id="b" data-review-clip="camera-b" src="media/camera-b.mp4" data-review-source="take b.mp4"
      muted data-start-frame="11" data-duration-frame="13" data-media-start-frame="2"></video>
    </main></body>`;
  await writeFile(input, author);
  await writeFile(join(cwd, 'take b.mp4'), await readFile(join(cwd, 'rough cut.mp4')));
  const invoke = (...args) => spawnSync(process.execPath, [bin, ...args], { cwd, env, encoding: 'utf8' });
  const first = invoke('open', 'edit.htm', '--no-transcribe');
  assert.equal(first.status, 0, first.stderr);
  const v1 = join(cwd, 'edit-review', 'review', 'v1');
  const locked = await readFile(join(v1, 'notes.json'), 'utf8');
  assert.match(locked, /Synthetic feedback/);
  const snapshot = await readFile(join(v1, 'composition', 'index.html'), 'utf8');
  assert.match(snapshot, /src="media\/camera-b.mp4"/);
  assert.match(snapshot, /data-media-start="0\.06666666666666667"/);
  assert.doesNotMatch(snapshot, /data-review-source|rough cut\.mp4|duration-frame/);
  assert.equal(await readFile(input, 'utf8'), author);
  const edit = join(cwd, 'edit-review', 'source', 'index.html');
  const revision = join(cwd, 'changes.json');

  await writeFile(revision, JSON.stringify({ N1: { note: 'New cut', frame: 11, end_frame: 25 } }));
  const invalid = invoke('open', edit, '--outcomes', revision, '--no-poll');
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /Outcome N1 end_frame.*at most 24 in v2/);

  await writeFile(revision, JSON.stringify({ N1: { note: 'New cut', frame: 11, end_frame: 24 } }));
  const second = invoke('open', edit, '--note', 'New timing', '--outcomes', revision, '--no-poll');
  assert.equal(second.status, 0, second.stderr);
  const receipt = decode(second.stdout);
  assert.equal(receipt.version, 'v2');
  assert.equal(receipt.session.url, 'http://127.0.0.1/review');
  assert.deepEqual(receipt.ingested, []);
  assert.deepEqual(receipt.clips[1], { clip: 'b', start_frame: 11, end_frame: 24, media_in: 2, media_out: 15 });
  const v2 = join(cwd, 'edit-review', 'review', 'v2');
  assert.deepEqual(JSON.parse(await readFile(join(v2, 'version.json'), 'utf8')).resolutions,
    { N1: { version: 'v2', note: 'New cut', frame: 11, end_frame: 24 } });
  assert.match(await readFile(join(v1, 'next.js'), 'utf8'), /"end_frame":24/);
  assert.equal(await readFile(join(v1, 'notes.json'), 'utf8'), locked);

  const third = invoke('open', edit, '--no-poll');
  assert.equal(third.status, 1);
  assert.match(third.stderr, /Poll and lock v2/);
});
