import { isDeepStrictEqual } from 'node:util';
import { incompatible } from './learning-rules.mjs';
import { deferred, learnedBasis, sameScope } from './learning-plan.mjs';

function weaker(decision, basis) {
  if (incompatible(decision.dimension, decision.direction, basis.direction)) return true;
  if (basis.value === undefined || decision.value === undefined) return false;
  if (typeof basis.value === 'number' && typeof decision.value === 'number') {
    return ['tighter', 'less'].includes(decision.direction) ? basis.value > decision.value :
      ['looser', 'more'].includes(decision.direction) && basis.value < decision.value;
  }
  return basis.value !== decision.value;
}

export function learningErrors({ ops, changes, decisions, plan, current = [], version,
  anchors = new Map(), planRequired = false }) {
  const errors = [];
  for (const op of ops.filter(op => !deferred(op))) {
    const { note, basis } = op;
    const result = Object.hasOwn(changes.outcomes, note) ? changes.outcomes[note] : undefined;
    const ref = version && `${version}:${note}`;
    const classification = current.find(e => e.note === ref);
    const entry = plan?.entries.find(e => e.note === ref ||
      (!e.note && e.mode === 'default' && e.dimension === basis?.dimension));
    if (learnedBasis(basis)) {
      const hasDisclosure = result?.learned?.some(item => ['pref', 'layer', 'mode', 'evidence', 'undo'].every(field =>
        typeof basis[field] === 'string' && basis[field].trim() && item[field] === basis[field]));
      const copyOfPlan = plan ? entry && isDeepStrictEqual(entry.basis, basis) : !planRequired;
      if (!hasDisclosure || !copyOfPlan ||
        (entry?.scope === 'local' && op.scope !== 'local') ||
        !['default', 'suggest', 'contested'].includes(basis.mode)) {
        errors.push({ check: 'C-learn', code: 'undisclosed-learning', note,
          message: 'Use the learning plan basis and disclose the preference, evidence and undo in this outcome.' });
      }
    }
    if (entry?.mode === 'default' && learnedBasis(entry.basis) && !learnedBasis(basis)) {
      errors.push({ check: 'C-learn', code: 'missing-learning-basis', note,
        message: 'Copy the learned default basis into the operation and disclose it in the outcome.' });
    }
    const actual = basis ?? classification;
    const dimension = op.op === 'tighten' ? 'pacing.sentence_gap' : actual?.dimension;
    if (!dimension) continue;
    const treatment = op.op === 'tighten' ?
      { ...actual, direction: 'tighter', value: op.min_pause ?? actual?.value } : actual;
    const scoped = decisions.filter(d => !d.valid_to && d.dimension === dimension &&
      sameScope(d, { scope: op.scope, anchors: classification?.anchors ?? anchors.get(note), note: ref }));
    const localException = op.scope === 'local' && scoped.findLast(d => d.scope === 'local' && d.note === ref);
    for (const decision of scoped) {
      if (localException && decision.scope !== 'local' && decision.valid_from <= localException.valid_from) continue;
      if (treatment && weaker(decision, treatment)) errors.push({ check: 'L1', code: 'regressed-project-decision',
        note, decision: decision.id, message: 'The treatment conflicts with a surviving project decision. Record the reviewer’s superseding instruction first.' });
    }
  }
  return errors;
}
