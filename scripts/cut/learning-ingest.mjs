import { join } from 'node:path';
import { readNotes, supportedNotes } from '../notes.mjs';
import { reviewedSpans } from './model.mjs';
import { readOptional } from './files.mjs';
import { deferred, learnedBasis } from './learning-plan.mjs';
import { eventId } from './learning-store.mjs';
import { chronological, incompatible, normalizeTaste, noteRef } from './learning-rules.mjs';

export async function learningRound(reviewRoot, version) {
  if (!/^v[1-9]\d*$/.test(version ?? '')) throw new Error('Supply --round vN for a locked review');
  const folder = join(reviewRoot, version);
  const [batch, review, edl, changes] = await Promise.all([
    readNotes(folder), readOptional(join(folder, 'version.json')), readOptional(join(folder, 'edl.json')),
    readOptional(join(folder, 'changes.json')),
  ]);
  if (!supportedNotes(batch) || batch.version !== version || review?.version !== version ||
    !batch.batch?.id || !Number.isFinite(Date.parse(batch.batch.createdAt)) || !Array.isArray(batch.notes)) {
    throw new Error(`Learning requires a locked ${version} feedback batch`);
  }
  return { batch, review, edl, changes, version };
}

export function batchReviewer(store, round, item) {
  const reviewers = store.brief?.reviewers ?? [];
  const reviewer = item?.reviewer ?? round.batch.reviewer ?? (reviewers.length === 1 ? reviewers[0].id : 'anonymous');
  return reviewers.some(item => item.id === reviewer) ? reviewer : 'anonymous';
}

function createEvent(store, round, reviewer, identity, fields) {
  const role = store.brief?.reviewers.find(item => item.id === reviewer)?.role;
  return {
    schema_version: 1, id: eventId(store.project, round.version, reviewer, ...identity),
    at: round.batch.batch.createdAt, project: store.project, round: round.version, reviewer, ...(role ? { role } : {}),
    context: store.brief?.context.key ?? '', inferred: false, basis: null, ...fields,
  };
}

function treatmentFor(round, ref, events) {
  if (!noteRef.test(ref ?? '') || !ref.startsWith(`${round.review.parent}:`)) return;
  const id = ref.split(':')[1];
  if (!Object.hasOwn(round.review.resolutions ?? {}, id)) return;
  const outcome = round.review.resolutions[id];
  const operations = round.changes?.operations?.filter(op => op.note === id && !deferred(op)) ?? [];
  const prior = chronological(events).findLast(e => e.note === ref && e.round === round.review.parent && e.classified_by &&
    !['silent', 'silent_learned', 'signoff'].includes(e.type));
  const treatment = operations.find(op => op.basis?.dimension)?.basis ?? prior;
  if (!treatment) return { outcome };
  const main = outcome.alternatives?.find(alt => alt.main);
  const basis = learnedBasis(treatment) ? treatment : outcome.learned?.[0] ?? null;
  const { scope, anchors } = prior ?? operations[0] ?? {};
  return { outcome, original: prior, basis, scope, anchors, ...(normalizeTaste({ ...treatment, ...main })) };
}

function classifiedEvents(store, round, classified, local) {
  if (!classified) return [];
  if (classified.schema_version !== 1 || classified.round !== round.version || !Array.isArray(classified.notes) ||
    !/^dailies-edit@[0-9]+\.[0-9]+\.[0-9]+$/.test(classified.classified_by ?? '')) {
    throw new Error('Classification needs schema 1, round, classified_by and notes');
  }
  const byId = new Map(classified.notes.map(item => [item?.note, item]));
  if (byId.size !== classified.notes.length || byId.size !== round.batch.notes.length ||
    round.batch.notes.some(note => !byId.has(note.id))) throw new Error('Classify each locked note exactly once');
  return round.batch.notes.flatMap((note, sequence) => {
    const reviewer = batchReviewer(store, round, note);
    const item = byId.get(note.id);
    if (item.skip === true) return [];
    const taste = normalizeTaste(item);
    const { authority, scope } = item;
    if (!['explicit', 'taste'].includes(authority) || !['local', 'global', 'long-term'].includes(scope) ||
      (scope !== 'local' && !(note.whole_video || note.kind === 'general') && !item.scope_reason?.trim())) {
      throw new Error(`Invalid authority or scope for ${note.id}`);
    }
    if (scope === 'long-term' && reviewer === 'anonymous') throw new Error('Long-term preferences require a reviewer from the brief');
    const reopens = note.reopens ?? item.reopens;
    if (note.reopens && item.reopens && note.reopens !== item.reopens) throw new Error('Use the reviewer’s reopen reference');
    const previous = reopens && treatmentFor(round, reopens, local);
    if (reopens && !previous) throw new Error(`Unknown reopened outcome: ${reopens}`);
    let type = scope === 'long-term' ? 'stated' : 'explicit_note';
    if (previous?.dimension === taste.dimension && type !== 'stated') {
      if (previous.direction === taste.direction) type = 'reopen_same';
      else if (incompatible(taste.dimension, previous.direction, taste.direction)) {
        type = previous.basis ? 'reopen_opposite_learned' : 'reopen_opposite';
      }
    }
    const anchors = scope === 'local' && round.edl ?
      reviewedSpans(round.edl, note).map(({ asset, range }) => ({ asset, range })) : [];
    return [createEvent(store, round, reviewer, ['note', note.id], {
      ...taste, type, sequence: 1000 + sequence, authority, scope: scope === 'long-term' ? 'global' : scope,
      ...(anchors.length ? { anchors } : {}),
      note: `${round.version}:${note.id}`, quote: note.text,
      ...(reopens ? { outcome: reopens, inferred: !note.reopens, basis: previous.basis ?? null } : {}),
      classified_by: classified.classified_by,
    })];
  });
}

function exposureEvents(store, round, reviewer, local, classified, includeSilence) {
  const reopenings = new Set([...round.batch.notes.filter(n => batchReviewer(store, round, n) === reviewer).map(n => n.reopens),
    ...classified.filter(e => e.reviewer === reviewer).map(e => e.outcome)]);
  const reactions = (round.batch.reactions ?? []).filter(item => batchReviewer(store, round, item) === reviewer);
  return Object.keys(round.review.resolutions ?? {}).flatMap((id, sequence) => {
    const ref = `${round.review.parent}:${id}`;
    const treatment = treatmentFor(round, ref, local);
    if (!treatment?.dimension || reopenings.has(ref)) return [];
    const signals = reactions.filter(item => item.outcome === ref);
    const choice = signals.find(item => item.choice);
    const verdict = signals.find(item => item.verdict)?.verdict;
    const alt = choice && treatment.outcome.alternatives.find(item => item.id === choice.choice);
    const eligibleSilence = treatment.outcome.status === 'applied' && (treatment.basis?.pref?.startsWith(`${reviewer}|`) ||
      (treatment.original && treatment.original.reviewer === reviewer));
    const common = { ...normalizeTaste(treatment), basis: treatment.basis, scope: treatment.scope,
      anchors: treatment.anchors, note: ref, outcome: ref, sequence };
    const record = (type, fields) => createEvent(store, round, reviewer, ['outcome', ref, type, fields?.alternative], {
      ...common, type, ...fields,
    });
    if (choice) {
      const selected = normalizeTaste({ ...treatment, ...alt });
      return [record('alt_chosen', { ...selected, alternative: alt.id }),
        ...treatment.outcome.alternatives.filter(other => other.id !== alt.id).map(other =>
          record('alt_unchosen', { ...normalizeTaste({ ...treatment, ...other }), alternative: other.id }))];
    }
    if (verdict === 'reject') return [record(treatment.basis ? 'reopen_opposite_learned' : 'reopen_opposite', { rejected: true })];
    if (verdict === 'accept' && treatment.outcome.status !== 'pending') return [record('accepted')];
    if (!verdict && includeSilence && eligibleSilence) return [record(treatment.basis ? 'silent_learned' : 'silent')];
    return [];
  });
}

export function roundEvents(store, round, local, classified) {
  const reviewers = new Set([batchReviewer(store, round),
    ...(round.batch.reactions ?? []).map(item => batchReviewer(store, round, item)),
    ...round.batch.notes.map(item => batchReviewer(store, round, item))]);
  const notes = classifiedEvents(store, round, classified, local);
  // Wait for classification before attributing silence or an unqualified reject to a note that may reopen it.
  const ready = classified || !round.batch.notes.length;
  const reactions = [...reviewers].flatMap(reviewer => exposureEvents(store, round, reviewer, local, notes, ready))
    .filter(e => ready || !e.rejected);
  return [...reactions, ...notes];
}

export function signoffEvents(store, round, local, decisions) {
  const reviewer = batchReviewer(store, round);
  return decisions.filter(d => !d.valid_to && d.decided_by === reviewer).flatMap((d, sequence) => {
    const evidence = chronological(local.filter(e => d.from.includes(e.id)));
    const delivered = evidence.findLast(e => ['accepted', 'silent', 'silent_learned'].includes(e.type) ||
      local.some(other => other.note === e.note && ['accepted', 'silent'].includes(other.type)));
    // A chosen alternative is only retained once a later review has acknowledged its treatment.
    if (!delivered && !round.changes?.operations.some(op => !deferred(op) && op.basis?.dimension === d.dimension &&
      op.basis.direction === d.direction && (d.value === undefined || op.basis.value === d.value) &&
      round.review.resolutions?.[op.note]?.status === 'applied')) return [];
    return [createEvent(store, round, reviewer, ['signoff', d.dimension, d.direction, d.note], {
      ...normalizeTaste(d), type: 'signoff', sequence, note: d.note, outcome: delivered?.outcome,
    })];
  });
}
