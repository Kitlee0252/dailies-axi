const record = value => value && typeof value === 'object' && !Array.isArray(value);
export const structuredOutcomes = value => value?.kind === 'dailies-cut-changes';
const text = value => typeof value === 'string' && value.trim();

export function outcomeMetadata(outcome = {}) {
  if (!record(outcome)) throw new Error('Outcome details must be an object');
  const { alternatives, learned } = outcome;
  if (alternatives !== undefined && (!Array.isArray(alternatives) ||
    alternatives.some(item => !record(item) || !/^[A-Z][A-Z0-9_-]{0,15}$/.test(item.id ?? '') ||
      (item.main !== undefined && typeof item.main !== 'boolean') ||
      (item.value !== undefined && !Number.isFinite(item.value) && !text(item.value)) ||
      ['label', 'direction', 'treatment'].some(field => item[field] !== undefined && !text(item[field]))) ||
    new Set(alternatives.map(item => item.id)).size !== alternatives.length ||
    alternatives.filter(item => item.main).length > 1)) throw new Error('Invalid outcome alternatives');
  if (learned !== undefined && (!Array.isArray(learned) || learned.some(item => !record(item) ||
    !['reviewer', 'skill'].includes(item.layer) || ['pref', 'mode', 'evidence', 'undo'].some(field => !text(item[field]))))) {
    throw new Error('Invalid outcome learning disclosure');
  }
  return {
    ...(alternatives !== undefined ? { alternatives } : {}),
    ...(learned !== undefined ? { learned } : {}),
  };
}

export function outcomeNotes(outcomes, previous) {
  const notes = previous?.notes ?? [];
  const generated = structuredOutcomes(outcomes) ? outcomes.generated_notes ?? [] : [];
  if (!Array.isArray(generated) || generated.some(note => !record(note) ||
    !/^L[1-9]\d*$/.test(note.id) || !text(note.text) || note.whole_video !== true) ||
    new Set([...notes, ...generated].map(note => note.id)).size !== notes.length + generated.length) {
    throw new Error('Invalid generated outcome targets');
  }
  return [...notes, ...generated];
}

function validateTarget(id, version, frameCount, frame, end_frame) {
  if (!Number.isSafeInteger(frame) || frame < 0 || frame >= frameCount) {
    throw new Error(`Outcome ${id} frame must be an integer from 0 to ${frameCount - 1} in ${version}`);
  }
  if (end_frame !== undefined && (!Number.isSafeInteger(end_frame) || end_frame <= frame || end_frame > frameCount)) {
    throw new Error(`Outcome ${id} end_frame must be an integer greater than frame and at most ${frameCount} in ${version}`);
  }
}

export function resolveOutcomes(outcomes, previous, version, frameCount) {
  const structured = structuredOutcomes(outcomes);
  const ids = new Set(outcomeNotes(outcomes, previous).map(note => note.id));
  if (structured) {
    const { schema_version, from, to, frame_count } = outcomes;
    if (schema_version !== 1 || from !== previous?.version || to !== version || frame_count !== frameCount) {
      throw new Error('changes.json does not describe this review version');
    }
    outcomes = outcomes.outcomes;
  }
  if (!record(outcomes)) throw new Error('Outcomes must be a JSON object keyed by previous note ID');
  return Object.fromEntries(Object.entries(outcomes).map(([id, outcome]) => {
    if (!ids.has(id)) throw new Error(`Outcome refers to unknown previous note ID: ${id}`);
    if (structured) {
      const { note, status, frames } = outcome ?? {};
      if (typeof note !== 'string' || !note.trim() || !['applied', 'pending', 'anchor-lost'].includes(status) ||
          !Array.isArray(frames)) throw new Error(`Invalid structured outcome ${id}`);
      for (const range of frames) {
        if (!Array.isArray(range) || range.length !== 2) throw new Error(`Outcome ${id} needs half-open frame ranges`);
        validateTarget(id, version, frameCount, ...range);
      }
      const first = frames[0];
      return [id, { version, note, status, frames, ...outcomeMetadata(outcome), ...(first ? { frame: first[0],
        ...(first[1] - first[0] > 1 ? { end_frame: first[1] } : {}) } : {}) }];
    }
    const details = typeof outcome === 'string' ? { note: outcome } : outcome;
    if (!record(details) || typeof details.note !== 'string' || !details.note.trim() ||
        Object.keys(details).some(key => !['note', 'frame', 'end_frame', 'alternatives', 'learned'].includes(key))) {
      throw new Error(`Outcome ${id} needs a non-empty explanation as text or {note, frame?, end_frame?}`);
    }
    const { note, frame, end_frame } = details;
    const metadata = outcomeMetadata(details);
    if (frame === undefined && end_frame === undefined) return [id, { version, note, ...metadata }];
    validateTarget(id, version, frameCount, frame, end_frame);
    return [id, { version, note, frame, ...metadata, ...(end_frame === undefined ? {} : { end_frame }) }];
  }));
}
