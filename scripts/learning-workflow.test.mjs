import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { lockNotes } from './notes.mjs';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('./cut-cli.mjs', import.meta.url));
const dimension = 'pacing.sentence_gap';
const key = `R1|${dimension}|douyin-koubo|tighter`;

async function setup(t, reviewers = [{ id: 'R1', role: 'director' }], decision_owner) {
  const workspace = await mkdtemp(join(tmpdir(), 'dailies-learn-'));
  const home = join(workspace, 'home');
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await writeFile(join(workspace, 'brief.json'), JSON.stringify({ schema_version: 1, project: 'P1',
    context: { platform: 'douyin', format: 'koubo' }, reviewers, decision_owner }));
  const learn = async (...args) => {
    const { stdout } = await exec(process.execPath, [cli, 'learn', ...args, '--workspace', workspace],
      { env: { ...process.env, DAILIES_HOME: home, DAILIES_LEARN: '' } });
    return JSON.parse(stdout);
  };
  const round = async (version, notes, { parent = null, resolutions = {}, reactions = [], reviewer = 'R1' } = {}) => {
    const folder = join(workspace, 'review', version);
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, 'version.json'), JSON.stringify({ version, parent, resolutions, reviewers }));
    await writeFile(join(folder, 'edl.json'), JSON.stringify({ frame_count: 120, segments: [] }));
    await lockNotes(folder, version, { schema_version: 3, version, reviewer, reactions, notes });
  };
  const classify = async (version, notes) => {
    const file = join(workspace, `${version}.classify.json`);
    await writeFile(file, JSON.stringify({ schema_version: 1, round: version, classified_by: 'dailies-edit@0.3.0', notes }));
    return learn('ingest', '--round', version, '--classified', file);
  };
  return { workspace, home, learn, round, classify };
}

const note = (id, text, extra) => ({ id, text, kind: 'general', whole_video: true, ...extra });
const classification = (id, extra) => ({ note: id, dimension, direction: 'tighter', authority: 'taste', scope: 'global', ...extra });

test('CLI ingests once, rebuilds identical profile bytes, and honors pause, resume and revocation', async t => {
  const { workspace, home, round, learn, classify } = await setup(t);
  await round('v1', [note('N1', 'Always tighten the sentence gaps in this context.')]);
  assert.equal((await learn('ingest', '--round', 'v1')).to_classify[0].reviewer, 'R1');
  const record = [classification('N1', { scope: 'long-term', value: 0.35 })];
  assert.equal((await classify('v1', record)).transitions[0].to, 'active');
  assert.equal((await classify('v1', record)).added, 0);
  assert.equal((await learn('ingest', '--round', 'v1')).to_classify.length, 0);
  const file = join(home, 'reviewers', 'R1.json');
  const profile = await readFile(file, 'utf8');
  await learn('status', '--at', JSON.parse(profile).computed_at, '--rebuild');
  assert.equal(await readFile(file, 'utf8'), profile);
  const ledger = await readFile(join(workspace, 'learning', 'events.jsonl'), 'utf8');
  assert.equal(ledger.trim().split('\n').length, 1);
  assert.equal(await readFile(join(home, 'ledger.jsonl'), 'utf8'), ledger);
  await learn('pause', '--reviewer', 'R1');
  assert.equal((await learn('plan', '--round', 'v1')).paused, true);
  await learn('pause', '--reviewer', 'R1', '--resume');
  assert.equal((await learn('plan', '--round', 'v1')).paused, false);
  await learn('pause');
  assert.equal((await learn('plan', '--round', 'v1')).paused, true);
  assert.equal((await learn('plan', '--round', 'v1')).decisions.length, 1);
  await learn('pause', '--resume');
  const revoke = ['forget', key, '--quote', 'Stop applying my pacing preference.'];
  assert.equal((await learn(...revoke)).status, 'revoked');
  await learn(...revoke);
  assert.equal((await learn('status')).profiles[0].prefs[0].status, 'revoked');
  assert.equal((await readFile(join(home, 'ledger.jsonl'), 'utf8')).trim().split('\n').length, 2);
});

test('a mixed-reviewer batch preserves both voices but the named owner decides', async t => {
  const { round, learn, classify } = await setup(t, [{ id: 'R1' }, { id: 'R2' }], 'R1');
  await round('v1', [note('N1', 'Tighten the gap.', { reviewer: 'R1' }),
    note('N2', 'Leave a longer gap.', { reviewer: 'R2' })], { reviewer: 'R2' });
  await classify('v1', [classification('N1', { value: 0.35 }),
    classification('N2', { direction: 'looser', value: 0.5 })]);
  const { entries, decisions } = await learn('plan', '--round', 'v1');
  assert.equal(entries[0].conflict.decision_owner, 'R1');
  assert.equal(decisions[0].decided_by, 'R1');
  assert.deepEqual(entries[0].alternatives.map(alt => alt.value), [0.35, 0.5]);
  assert.equal((await learn('status', '--reviewer', 'R2')).profiles[0].prefs[0].neg, 0);
});

test('CLI records the chosen alternative without penalizing the other choices', async t => {
  const { round, learn, classify, workspace } = await setup(t);
  await round('v1', [note('N1', 'Tighten the gap.')]);
  await classify('v1', [classification('N1')]);
  await round('v2', [], { parent: 'v1', reactions: [{ outcome: 'v1:N1', choice: 'B' }],
    resolutions: { N1: { status: 'applied', alternatives: [{ id: 'A', value: 0.5 }, { id: 'B', value: 0.35 }] } } });
  await learn('ingest', '--round', 'v2');
  const events = (await readFile(join(workspace, 'learning', 'events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(new Set(events.map(e => e.type)), new Set(['explicit_note', 'alt_chosen', 'alt_unchosen']));
  assert.equal((await learn('status')).profiles[0].prefs[0].value, 0.35);
  assert.equal((await learn('plan', '--round', 'v2')).entries[0].source, 'project');
  assert.equal((await learn('plan', '--round', 'v2')).entries[0].value, 0.35);
});

test('a profile offers an unrelated preference once and only applies it after opt-in', async t => {
  const { home, learn, round } = await setup(t);
  await mkdir(home);
  await writeFile(join(home, 'ledger.jsonl'), JSON.stringify({ schema_version: 1,
    id: 'stated', reviewer: 'R1', context: 'douyin-koubo', dimension, direction: 'tighter', value: 0.35,
    project: 'other-project', at: new Date().toISOString(), type: 'stated' }) + '\n');
  await round('v1', [note('N1', 'A separate issue.')]);
  const first = await learn('plan', '--round', 'v1');
  assert.equal(first.entries[0].mode, 'offer');
  assert.deepEqual(first.generated_notes, []);
  await round('v2', [note('N1', 'Another separate issue.')], { parent: 'v1' });
  assert.deepEqual((await learn('plan', '--round', 'v2')).entries, []);
  await learn('status', '--rebuild');
  const file = join(home, 'reviewers', 'R1.json');
  const profile = JSON.parse(await readFile(file, 'utf8'));
  profile.settings.auto_apply = true;
  await writeFile(file, JSON.stringify(profile));
  const next = await learn('plan', '--round', 'v2');
  assert.equal(next.entries[0].mode, 'default');
  assert.equal(next.entries[0].note, 'v2:L1');
  assert.equal(next.generated_notes[0].whole_video, true);
});

test('L3 writes and announces one screened proposal with real regression results', async t => {
  const { home, learn } = await setup(t);
  await mkdir(home);
  const makeEvents = context => [1, 2, 3].flatMap(i => [1, 2].flatMap(j => [1, 2].map(k => ({
    schema_version: 1, id: `synthetic-${context}-${i}${j}${k}`, reviewer: `R${i}`, role: 'Synthetic Client Name',
    context, dimension, direction: 'tighter', value: 0.35, project: `PRIVATE-PROJECT-${i}${j}`,
    at: new Date().toISOString(), type: 'explicit_note', quote: 'Synthetic Person /private/client.mov https://invalid.example/',
  }))));
  const events = [...makeEvents('douyin-koubo'), ...makeEvents('clientname-koubo')];
  await writeFile(join(home, 'ledger.jsonl'), events.map(e => JSON.stringify(e)).join('\n') + '\n');
  const result = await learn('propose');
  assert.equal(result.proposals.length, 1, JSON.stringify(result.refused));
  assert.equal(result.refused.length, 1);
  const document = await readFile(result.proposals[0].file, 'utf8');
  assert.match(document, /Old defaults \d+\/\d+ passed.*Proposed defaults \d+\/\d+ passed/);
  assert.match(document, /3 reviewers \(reviewer\), 6 projects/);
  assert.doesNotMatch(document, /Synthetic|PRIVATE|clientname|invalid\.example|\/private\//);
  assert.equal((await learn('propose')).proposals.length, 0);
  assert.equal((await readdir(join(home, 'proposals'))).length, 1);
});
