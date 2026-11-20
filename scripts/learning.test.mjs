import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluate, generalCandidates, preferenceKey } from './cut/learning-rules.mjs';
import { projectDecisions, resolveLearning } from './cut/learning-plan.mjs';
import { lockNotes, readNotes } from './notes.mjs';
import { learningErrors } from './cut/learning-verify.mjs';
import { checkProposalFixture } from './cut/learning-proposal-fixture.mjs';

const dimension = 'pacing.sentence_gap';
const context = 'douyin-koubo';
const at = '2026-03-05T00:00:00.000Z';
const day = 86400000;
const time = days => new Date(Date.parse(at) + days * day).toISOString();
const event = (type, overrides = {}) => ({ id: type, at, project: 'P1', round: 'v1',
  reviewer: 'R1', dimension, context, direction: 'tighter', type, ...overrides });
const p1 = [
  event('explicit_note', { id: 'e1' }),
  event('alt_chosen', { id: 'e2', value: 0.35 }),
  event('silent', { id: 'e3' }),
  event('signoff', { id: 'e4' }),
];
const p2 = [...p1, event('explicit_note', { id: 'e5', project: 'P2', at: time(66) }),
  event('accepted', { id: 'e6', project: 'P2', at: time(67), value: 0.35 })];
const key = preferenceKey(event('explicit_note'));
const state = (events, days = 67, forKey = key) => evaluate(events, Date.parse(time(days)), forKey);
const brief = { project: 'P2', reviewers: [{ id: 'R1' }], context: { key: context } };
const resolve = (fields = {}) => resolveLearning({ brief, reviewer: 'R1', prefs: [state(p2)],
  current: [], decisions: [], ...fields });

test('S1 one project only becomes a candidate', () => {
  assert.equal(state(p1, 0).status, 'candidate');
});
test('S2 evidence from a second project activates the chosen value', () => {
  const pref = state(p2);
  assert.equal(pref.status, 'active');
  assert.equal(pref.value, 0.35);
  assert.equal(pref.projects, 2);
});
test('S3 the current explicit instruction wins over the profile', () => {
  const [result] = resolve({ current: [event('explicit_note', { direction: 'looser', authority: 'explicit' })] });
  assert.equal(result.source, 'note');
  assert.equal(result.direction, 'looser');
});
test('F5 the same reviewer in a different scenario sees no default', () => {
  assert.equal(state(p2, 67, key.replace(context, 'bilibili-vlog')).status, 'observed');
  assert.deepEqual(resolve({ brief: { ...brief, context: { key: 'bilibili-vlog' } } }), []);
});
test('F4 self-applied defaults cannot refresh recency or inflate a project past its cap', () => {
  const silent = Array.from({ length: 30 }, (_, i) => event('silent_learned', {
    project: 'P3', id: `s${i}`, at: time(450),
  }));
  const result = state([...p2, ...silent], 465);
  assert.equal(result.status, 'candidate');
  assert.equal(result.last_explicit, time(67));
  assert.equal(result.projects, 2);
  assert.ok(result.pos - state(p2, 465).pos <= 0.5);
});
test('F2 established preferences become suggestions over 365 days', () => {
  assert.equal(state(p2, 490).status, 'candidate');
});
test('F2b 730 days without explicit evidence archives the preference', () => {
  assert.equal(state(p2, 820).status, 'observed');
  assert.equal(state([event('stated')], 820).status, 'observed');
});
test('F6 reversing a learned default contests it and flips the project decision', () => {
  const reversal = event('reopen_opposite_learned', { id: 'e7', direction: 'looser', project: 'P2', at: time(68) });
  const ledger = [...p2, reversal];
  assert.equal(state(ledger, 68).status, 'contested');
  assert.equal(state(ledger, 68).neg, 1.5);
  const decisions = projectDecisions(ledger.filter(e => e.project === 'P2'), brief);
  const [plan] = resolve({ decisions, prefs: [state(ledger, 68)] });
  assert.equal(plan.source, 'project');
  assert.equal(plan.direction, 'looser');
  assert.equal(decisions.find(d => d.value === 0.35).valid_to, time(68));
});
test('revocation discards previous evidence and retains the tombstone', () => {
  const ledger = [...p2, event('revoke', { at: time(68) })];
  assert.equal(state(ledger, 68).status, 'revoked');
  assert.equal(state(ledger, 68).pos, 0);
});
test('a stated long-term preference immediately activates in its own context only', () => {
  const events = [event('stated', { value: 0.3 })];
  assert.equal(state(events, 0).status, 'active');
  assert.equal(state(events, 0, key.replace(context, 'bilibili-vlog')).status, 'observed');
});
test('a later explicit reversal contests even a stated preference', () => {
  assert.equal(state([event('stated'), event('reopen_opposite_learned', {
    direction: 'looser', at: time(1),
  })], 1).status, 'contested');
});
test('anonymous feedback creates a project decision without entering the profile', () => {
  const events = [event('explicit_note', { reviewer: 'anonymous' })];
  assert.equal(state(events, 0, key.replace('R1', 'anonymous')).status, 'observed');
  assert.equal(projectDecisions(events, { ...brief, project: 'P1' }).length, 1);
});
test('F1 L3 needs three reviewers, five projects and no objection', () => {
  const events = [1, 2, 3].flatMap(i => [1, 2].flatMap(j => [1, 2].map(k =>
    event('explicit_note', { id: `e${i}${j}${k}`, reviewer: `R${i}`, project: `P${i}${j}`, value: 0.35 }))));
  assert.equal(generalCandidates(events.map(e => ({ ...e, reviewer: 'R1' })), Date.parse(at)).length, 0);
  assert.equal(generalCandidates(events, Date.parse(at)).length, 1);
  assert.equal(generalCandidates([...events, event('reopen_opposite_learned', {
    reviewer: 'R3', direction: 'looser',
  })], Date.parse(at)).length, 0);
});
test('F3 the decision owner wins without averaging and the other direction stays selectable', () => {
  const current = [event('explicit_note', { reviewer: 'R4', direction: 'looser', value: 0.5 }),
    event('explicit_note', { reviewer: 'R1', value: 0.3 })];
  const reviewers = [...brief.reviewers, { id: 'R4' }];
  const [owned] = resolve({ brief: { ...brief, reviewers, decision_owner: 'R1' }, current });
  assert.equal(owned.value, 0.3);
  assert.deepEqual(owned.alternatives.map(item => item.value), [0.3, 0.5]);
  assert.equal(resolve({ brief: { ...brief, reviewers }, current })[0].mode, 'contested');
});

test('capture locks v3 reaction-only batches and leaves v2 batches readable', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dailies-capture-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const old = { schema_version: 2, version: 'v1', notes: [{ id: 'N1', text: 'Earlier note' }] };
  await lockNotes(dir, 'v1', old);
  assert.equal((await readNotes(dir)).schema_version, 2);
  await rm(join(dir, 'notes.json'));
  await writeFile(join(dir, 'version.json'), JSON.stringify({ version: 'v2', parent: 'v1',
    reviewers: [{ id: 'R1' }], resolutions: { N1: { alternatives: [{ id: 'B', value: 0.35 }] } } }));
  const current = { schema_version: 3, version: 'v2', reviewer: 'R1',
    notes: [], reactions: [{ outcome: 'v1:N1', choice: 'B' }] };
  await lockNotes(dir, 'v2', current);
  assert.deepEqual((await readNotes(dir)).reactions, current.reactions);
  assert.match(await readFile(join(dir, 'notes.js'), 'utf8'), /"choice":"B"/);
});

test('verify blocks a learned edit without disclosure and a stronger surviving project decision', () => {
  const basis = { layer: 'reviewer', pref: key, mode: 'default', dimension, direction: 'tighter',
    value: 0.5, evidence: '2 projects, 2026-05-11', undo: 'Say “stop using this preference”.' };
  const ops = [{ note: 'N1', op: 'tighten', basis }];
  const changes = { outcomes: { N1: { status: 'applied' } } };
  const decisions = [{ id: 'D1', dimension, direction: 'tighter', value: 0.35, valid_to: null }];
  assert.deepEqual(learningErrors({ ops, changes, decisions }).map(e => e.check), ['C-learn', 'L1']);
  changes.outcomes.N1.learned = [basis];
  assert.deepEqual(learningErrors({ ops, changes, decisions }).map(e => e.check), ['L1']);
});

test('general defaults preserve authorization and scope in the proposal comparison fixture', () => {
  const rule = { dimension, context, direction: 'tighter', value: 0.35 };
  const fixture = process.env.DAILIES_DEFAULTS_FIXTURE;
  const { defaults, rule: proposed, enabled } = fixture ?
    JSON.parse(fixture) : { defaults: [rule], rule, enabled: true };
  checkProposalFixture(defaults, proposed, enabled);
});
