import assert from 'node:assert/strict';
import { resolveLearning } from './learning-plan.mjs';

export function checkProposalFixture(defaults, rule, enabled) {
  const note = { ...rule, value: undefined, id: 'fixture', reviewer: 'fixture', round: 'v1', note: 'v1:N1',
    at: '2026-01-01T00:00:00.000Z', scope: 'global', authority: 'taste' };
  const input = { brief: { context: { key: rule.context }, reviewers: [] },
    reviewer: 'fixture', current: [note], prefs: [], decisions: [], defaults };
  const [plan] = resolveLearning(input);
  assert.equal(plan.source, enabled ? 'skill' : 'note');
  assert.equal(plan.mode, enabled ? 'default' : 'none');
  assert.equal(plan.alternatives.length, 3);
  if (enabled) {
    assert.equal(plan.value, rule.value);
    assert.ok(plan.disclosure?.undo);
  }
  assert.equal(resolveLearning({ ...input, brief: { ...input.brief, context: { key: 'fixture-other' } } })[0].mode, 'none');
  assert.equal(resolveLearning({ ...input, current: [{ ...note, authority: 'explicit' }] })[0].source, 'note');
  assert.deepEqual(resolveLearning({ ...input, current: [] }), []);
}
