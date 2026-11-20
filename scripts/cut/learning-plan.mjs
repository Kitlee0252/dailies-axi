import { ownerOf } from '../brief.mjs';
import { chronological, explicit, incompatible, opposite, params, preferenceKey } from './learning-rules.mjs';
import { overlaps } from './ranges.mjs';

export const deferred = op => ['ask', 'decline'].includes(op.op);
export const learnedBasis = basis => ['reviewer', 'skill'].includes(basis?.layer);

export function sameScope(left, right) {
  if (left.scope !== 'local' || right.scope !== 'local') return true;
  if (!left.anchors?.length || !right.anchors?.length) return left.note === right.note;
  return left.anchors.some(a => right.anchors.some(b => a.asset === b.asset && overlaps(a.range, b.range)));
}

export function projectDecisions(events, brief) {
  const owner = ownerOf(brief);
  const decisions = [];
  const sorted = chronological(events);
  for (const e of sorted.filter(e => explicit.has(e.type) && !e.rejected)) {
    const conflicting = sorted.filter(other => other.round === e.round && other.reviewer !== e.reviewer &&
      other.dimension === e.dimension && explicit.has(other.type) && !other.rejected && sameScope(e, other) &&
      disagrees(e, other));
    if (conflicting.length && e.reviewer !== owner) continue;
    const existing = decisions.filter(d => !d.valid_to && d.dimension === e.dimension && sameScope(d, e));
    if (existing.some(d => d.decided_by !== e.reviewer && e.reviewer !== owner && disagrees(e, d))) continue;
    const compatible = existing.filter(d => d.direction === e.direction);
    const prior = compatible.at(-1);
    const value = e.value ?? (e.type === 'reopen_same' ? undefined : prior?.value);
    const replaced = existing.filter(d => e.scope !== 'local' || d.scope === 'local');
    for (const d of replaced) d.valid_to = e.at;
    decisions.push({
      id: `D${decisions.length + 1}`, dimension: e.dimension, direction: e.direction,
      ...(value !== undefined ? { value } : {}), from: [...(prior?.from ?? []), e.id],
      decided_by: e.reviewer, valid_from: e.at, valid_to: null,
      ...(e.scope ? { scope: e.scope } : {}), ...(e.anchors?.length ? { anchors: e.anchors } : {}),
      ...(e.note ? { note: e.note } : {}), ...(e.round ? { round: e.round } : {}), event: e.id,
    });
  }
  return decisions;
}

function disagrees(a, b) {
  return incompatible(a.dimension, a.direction, b.direction) ||
    (a.direction === b.direction && a.value !== undefined && b.value !== undefined && a.value !== b.value);
}

const option = (item, index, main = false) => ({ id: 'ABC'[index] ?? `V${index + 1}`,
  direction: item.direction, ...(item.value !== undefined ? { value: item.value } : {}), ...(main ? { main } : {}),
  ...(item.reviewer ? { reviewer: item.reviewer } : {}) });
const numericPacing = [0.5, 0.35, 0.25];

function tasteOptions(dimension, direction, value, main = false) {
  if (dimension === 'pacing.sentence_gap') {
    const [looser, center, tighter] = numericPacing;
    const values = Number.isFinite(value) ? [value, ...[
      numericPacing.toReversed().find(item => item < value) ?? value * 0.75,
      numericPacing.find(item => item > value) ?? value * 1.4,
    ].map(item => Number(item.toFixed(3)))] : [looser, center, tighter];
    return values.map((value, i) => option({ direction, value }, i, main && i === 0));
  }
  return [
    option({ direction, value }, 0, main),
    { id: 'B', direction, treatment: 'more-pronounced' },
    { id: 'C', direction, treatment: 'less-pronounced' },
  ];
}

function action({ item, source, mode, note, alternatives, disclosure, scope }) {
  const { dimension, direction, value } = item;
  const basis = { layer: source, mode, dimension, direction, ...(value !== undefined ? { value } : {}),
    ...(disclosure ?? {}) };
  return { source, mode, dimension, ...(note ? { note } : {}), ...(scope ? { scope } : {}),
    direction, ...(value !== undefined ? { value } : {}), basis,
    ...(disclosure ? { disclosure } : {}), ...(alternatives ? { alternatives } : {}),
    ...(source === 'project' && item.anchors?.length ? { anchors: item.anchors } : {}) };
}

export function resolveLearning({ brief, reviewer, current, decisions, prefs, defaults = [], paused = false,
  auto_apply = false, offered = new Set(), round }) {
  const context = brief?.context?.key;
  const owner = ownerOf(brief);
  const applicable = paused ? [] : prefs.filter(pref => {
    const [, , key] = pref.key.split('|');
    return key === context && ['active', 'candidate', 'contested'].includes(pref.status);
  });
  const relevantDecision = d => !d.valid_to && (d.scope !== 'local' || d.round === round);
  const dimensions = [...new Set([...current, ...decisions.filter(relevantDecision),
    ...(brief?.constraints ?? []), ...applicable.map(pref => ({ dimension: pref.key.split('|')[1] }))].map(item => item.dimension))];
  return dimensions.flatMap(dimension => {
    const notes = chronological(current.filter(e => e.dimension === dimension && !e.rejected));
    const priority = [...notes].reverse().sort((a, b) => Number(b.reviewer === owner) - Number(a.reviewer === owner));
    const latest = priority[0];
    const others = priority.filter(e => latest && e.reviewer !== latest.reviewer && sameScope(latest, e) && disagrees(latest, e));
    if (others.length) {
      const owned = latest.reviewer === owner;
      return [{ ...action({ item: latest, source: 'note', mode: owned ? 'apply' : 'contested',
        note: latest.note, alternatives: [latest, ...others].slice(0, 2).map((e, i) => option(e, i, owned && !i)) }),
      conflict: { decision_owner: owned ? owner : null, reviewers: [latest.reviewer, ...others.map(e => e.reviewer)] } }];
    }
    // Resolve localized requests independently; one pin must not authorize another.
    const targets = notes.length ? notes.filter(e => e.round === latest.round) : [undefined];
    return targets.flatMap(note => {
      const prefOptions = applicable.filter(pref => pref.key.startsWith(`${note?.reviewer ?? reviewer}|${dimension}|`));
      const selected = prefOptions.find(pref => pref.status === 'contested') ??
        prefOptions.find(pref => pref.status === 'active' && (!note || pref.key.split('|')[3] === note.direction)) ??
        prefOptions.find(pref => pref.status === 'candidate' && (!note || pref.key.split('|')[3] === note.direction));
      const reference = note?.note;
      const project = decisions.findLast(d => !d.valid_to && d.dimension === dimension &&
        d.event !== note?.id && (!note || !disagrees(note, d)) &&
        (d.scope !== 'local' || (note ? sameScope(d, note) : d.round === round)));
      if (note && (note.authority !== 'taste' || note.value !== undefined)) {
        return [action({ item: note, source: 'note', mode: 'apply', note: reference, scope: note.scope })];
      }
      if (project && (!note || project.value !== undefined)) {
        return [action({ item: project, source: 'project', mode: 'apply', note: reference, scope: note?.scope ?? project.scope })];
      }
      const constraint = brief?.constraints?.find(item => item.dimension === dimension);
      if (constraint) return [action({ item: constraint, source: 'brief', mode: 'apply', note: reference, scope: note?.scope })];
      if (selected) {
        const [, , , direction] = selected.key.split('|');
        const item = { dimension, direction, value: selected.value };
        const disclosure = { pref: selected.key, layer: 'reviewer',
          evidence: `${selected.projects} project(s), last explicit confirmation ${selected.last_explicit?.slice(0, 10)}`,
          undo: 'Say “stop using this preference”.' };
        if (!note) {
          if (selected.status !== 'active') return [];
          if (auto_apply) return [action({ item, source: 'reviewer', mode: 'default',
            scope: 'global', disclosure, alternatives: tasteOptions(dimension, direction, item.value, true) })];
          if (offered.has(dimension)) return [];
          return [action({ item, source: 'reviewer', mode: 'offer', disclosure })];
        }
        if (selected.status === 'contested') {
          const direction = note.direction;
          return [action({ item: note, source: 'reviewer', mode: 'contested', note: reference, scope: note.scope,
            disclosure, alternatives: [option(note, 0), option({ direction: opposite(direction) }, 1)] })];
        }
        if (!incompatible(dimension, direction, note.direction) && direction === note.direction) {
          const mode = selected.status === 'active' ? 'default' : 'suggest';
          return [action({ item, source: 'reviewer', mode, note: reference, scope: note.scope, disclosure,
            alternatives: tasteOptions(dimension, direction, item.value, mode === 'default') })];
        }
      }
      const general = defaults.find(item => item.dimension === dimension && item.context === context &&
        (!note || item.direction === note.direction));
      if (general && note) {
        const disclosure = { pref: preferenceKey({ ...general, reviewer: 'skill' }), layer: 'skill',
          evidence: 'Approved general default.', undo: 'Say “stop using this preference”.' };
        return [action({ item: general, source: 'skill', mode: 'default', note: reference, scope: note.scope, disclosure,
          alternatives: tasteOptions(dimension, general.direction, general.value, true) })];
      }
      return note ? [action({ item: note, source: 'note', mode: 'none', note: reference, scope: note.scope,
        alternatives: tasteOptions(dimension, note.direction) })] : [];
    });
  });
}

export function summaryFor(prefs, reviewer, context) {
  return prefs.filter(pref => {
    const [id, , key] = pref.key.split('|');
    return id === reviewer && key === context && ['candidate', 'active', 'contested'].includes(pref.status);
  }).slice(0, params.summaryLimit).map(pref => {
    const [, dimension, , direction] = pref.key.split('|');
    return `${dimension} ${direction}${pref.value === undefined ? '' : ` (${pref.value})`}: ${pref.status}`;
  });
}
