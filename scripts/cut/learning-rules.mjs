import params from './learning-params.json' with { type: 'json' };

export { params };
export const day = 86400000;
const numeric = (pair, unit) => ({ pair, unit });
export const dimensions = {
  'pacing.sentence_gap': numeric(['tighter', 'looser'], 's'),
  'pacing.total_length': numeric(['less', 'more'], 's'),
  'cut.filler': { pair: ['avoid', 'use'] },
  'cut.retake': { pair: ['avoid', 'use'] },
  'opening.hook': numeric(['less', 'more'], 's'),
  'ending.outro': { pair: ['avoid', 'use'] },
  'captions.style': { values: ['karaoke', 'line', 'none'] },
  'captions.position': { values: ['lower', 'middle'] },
  'graphics.fullscreen_text': { pair: ['avoid', 'use'] },
  'graphics.density': { pair: ['less', 'more'] },
  'audio.music_level': numeric(['less', 'more'], 'dB'),
  'transitions.style': { values: ['hard', 'effect'] },
  'reframe.method': { values: ['zoom', 'blur-pad'] },
};
export const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;
export const noteRef = /^v[1-9]\d*:[NL][1-9]\d*$/;
const weak = new Set(['silent', 'silent_learned']);
const reversal = new Set(['reopen_opposite', 'reopen_opposite_learned']);
export const explicit = new Set(['explicit_note', 'stated', 'alt_chosen', 'accepted', 'reopen_same', ...reversal]);

export function normalizeTaste({ dimension, direction, value, unit }) {
  const spec = Object.hasOwn(dimensions, dimension) ? dimensions[dimension] : undefined;
  if (!spec && !/^other:[a-z0-9-]{1,60}$/.test(dimension ?? '')) throw new Error('Use a controlled learning dimension or other:<slug>');
  if (spec?.values && ['use', 'avoid'].includes(direction) && value !== undefined) direction += `:${value}`;
  const [verb, category, extra] = String(direction).split(':');
  const validValue = spec?.values ? (value === undefined || value === category) :
    value === undefined || (typeof value === 'number' && Number.isFinite(value) &&
      (spec?.unit === 'dB' || value >= 0));
  const validDirection = spec?.values ? ['use', 'avoid'].includes(verb) && spec.values.includes(category) && !extra :
    (spec?.pair ?? ['tighter', 'looser', 'more', 'less', 'use', 'avoid']).includes(direction);
  if (!validDirection || !validValue || (unit !== undefined && unit !== spec?.unit)) {
    throw new Error(`Invalid direction, value or unit for ${dimension}`);
  }
  return { dimension, direction, ...(category || value !== undefined ? { value: category ?? value } : {}),
    ...(spec?.unit && value !== undefined ? { unit: spec.unit } : {}) };
}

export const preferenceKey = ({ reviewer, dimension, context, direction }) => [reviewer, dimension, context, direction].join('|');
export const profileEligible = e => e.reviewer !== 'anonymous' && e.context && Object.hasOwn(dimensions, e.dimension);
const oppositeDirections = { tighter: 'looser', looser: 'tighter', more: 'less', less: 'more', use: 'avoid', avoid: 'use' };
export function opposite(direction) {
  const [verb, value] = direction.split(':');
  return value ? `${oppositeDirections[verb]}:${value}` : oppositeDirections[verb];
}

export function incompatible(dimension, left, right) {
  return opposite(left) === right || Boolean(dimensions[dimension]?.values &&
    left.startsWith('use:') && right.startsWith('use:') && left !== right);
}

export function chronological(events) {
  return [...events].sort((a, b) => Date.parse(a.at) - Date.parse(b.at) ||
    (a.sequence ?? 0) - (b.sequence ?? 0) || a.id.localeCompare(b.id, 'en'));
}

function wilson(pos, neg) {
  const total = pos + neg;
  if (!total) return 0;
  const p = pos / total;
  const z2 = params.z ** 2;
  return (p + z2 / (2 * total) - params.z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total)) /
    (1 + z2 / total);
}

export function evaluate(events, now, key) {
  const [reviewer, dimension, context, direction] = key.split('|');
  const mine = chronological(events.filter(e => profileEligible(e) && Date.parse(e.at) <= now &&
    e.reviewer === reviewer && e.dimension === dimension && e.context === context));
  const tombstone = mine.findLastIndex(e => e.type === 'revoke' && e.direction === direction);
  const opposingTombstone = mine.findLastIndex(e => e.type === 'revoke' && incompatible(dimension, direction, e.direction));
  const live = mine.slice(tombstone + 1).filter(e => !['revoke', 'alt_unchosen'].includes(e.type));
  let pos = 0, neg = 0, posRaw = 0, negRaw = 0, recentNeg = 0;
  let lastExplicit, value, stated = false;
  const projects = new Set();
  const evidence = [];
  const silentUsed = new Map();
  for (const e of live) {
    const matching = e.direction === direction;
    const opposing = incompatible(dimension, direction, e.direction);
    const rejection = e.rejected === true && matching;
    if ((!matching && !opposing) || (!matching && !explicit.has(e.type))) continue;
    if (opposing && opposingTombstone >= 0 && Date.parse(e.at) <= Date.parse(mine[opposingTombstone].at)) continue;
    const positive = matching && !rejection;
    const age = (now - Date.parse(e.at)) / day;
    let weight = rejection ? Math.abs(params.weights[e.basis?.layer ? 'reopen_opposite_learned' : 'reopen_opposite'])
      : Math.abs(params.weights[e.type]);
    if (positive && reversal.has(e.type)) weight = params.weights.explicit_note;
    if (weak.has(e.type)) {
      const used = silentUsed.get(e.project) ?? 0;
      weight = Math.max(0, Math.min(weight, params.silentCapPerProject - used));
      silentUsed.set(e.project, used + weight);
    }
    if (positive) {
      posRaw += weight;
      pos += weight * 2 ** (-age / params.halfLifeDays);
      if (explicit.has(e.type)) {
        projects.add(e.project);
        lastExplicit = e.at;
        if (e.type === 'stated') stated = true;
        if (e.type === 'reopen_same' || e.value !== undefined) value = e.value;
      }
    } else {
      negRaw += weight;
      neg += weight * 2 ** (-age / params.halfLifeDays);
      if (age <= params.contestWindowDays) recentNeg += weight;
    }
    evidence.push(`${e.project}:${e.id}`);
  }
  const lb = wilson(pos, neg);
  const ageExplicit = lastExplicit ? (now - Date.parse(lastExplicit)) / day : Infinity;
  const established = posRaw >= params.active.pos && projects.size >= params.active.projects &&
    wilson(posRaw, negRaw) >= params.active.lb;
  const fresh = ageExplicit <= params.staleDays;
  let status = 'observed';
  if (tombstone >= 0 && !live.some(e => e.direction === direction && explicit.has(e.type) && !e.rejected)) status = 'revoked';
  else if (ageExplicit <= params.archiveDays && recentNeg >= params.contestMin &&
    (stated || (pos >= params.candidate.pos && lb < params.active.lb))) status = 'contested';
  else if (fresh && (stated || (pos >= params.active.pos && projects.size >= params.active.projects &&
    lb >= params.active.lb))) status = 'active';
  else if (ageExplicit <= params.archiveDays && (stated || established ||
    (fresh && pos >= params.candidate.pos && lb >= params.candidate.lb))) status = 'candidate';
  return { key, status, ...(value !== undefined ? { value } : {}), pos, neg, lb, projects: projects.size,
    last_explicit: lastExplicit ?? null, events: evidence, project_ids: [...projects],
    ...(status === 'revoked' ? { revoked_at: mine[tombstone].at } : {}) };
}

export function profiles(events, now) {
  const keys = [...new Set(events.filter(profileEligible).map(preferenceKey))].sort();
  return keys.map(key => evaluate(events, now, key));
}

export function generalCandidates(events, now) {
  const prefs = profiles(events, now);
  const rules = new Map();
  for (const pref of prefs.filter(item => item.status === 'active')) {
    const [, dimension, context, direction] = pref.key.split('|');
    const rule = [dimension, context, direction].join('|');
    if (!rules.has(rule)) rules.set(rule, []);
    rules.get(rule).push(pref);
  }
  return [...rules].flatMap(([rule, active]) => {
    const [dimension, context, direction] = rule.split('|');
    const projects = new Set(active.flatMap(pref => pref.project_ids));
    if (active.length < params.general.reviewers || projects.size < params.general.projects) return [];
    const peers = prefs.filter(pref => pref.key.split('|')[1] === dimension && pref.key.split('|')[2] === context);
    const blocked = peers.some(pref => {
      const other = pref.key.split('|')[3];
      return pref.status === 'contested' || (other === direction && (pref.status === 'revoked' || pref.neg > 0)) ||
        (incompatible(dimension, direction, other) && pref.last_explicit !== null);
    }) || events.some(e => profileEligible(e) && e.dimension === dimension && e.context === context &&
      e.direction === direction && e.rejected === true && Date.parse(e.at) <= now);
    return blocked ? [] : [{ rule, dimension, context, direction, active, projects: projects.size }];
  });
}
