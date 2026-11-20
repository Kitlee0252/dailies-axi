const record = value => value && typeof value === 'object' && !Array.isArray(value);
export const structuredOutcomes = value => value?.kind === 'dailies-cut-changes';

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
  if (structured) {
    const { schema_version, from, to, frame_count } = outcomes;
    if (schema_version !== 1 || from !== previous?.version || to !== version || frame_count !== frameCount) {
      throw new Error('changes.json does not describe this review version');
    }
    outcomes = outcomes.outcomes;
  }
  if (!record(outcomes)) throw new Error('Outcomes must be a JSON object keyed by previous note ID');
  const ids = new Set(previous?.notes.map(note => note.id));
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
      return [id, { version, note, status, frames, ...(first ? { frame: first[0],
        ...(first[1] - first[0] > 1 ? { end_frame: first[1] } : {}) } : {}) }];
    }
    const details = typeof outcome === 'string' ? { note: outcome } : outcome;
    if (!record(details) || typeof details.note !== 'string' || !details.note.trim() ||
        Object.keys(details).some(key => !['note', 'frame', 'end_frame'].includes(key))) {
      throw new Error(`Outcome ${id} needs a non-empty explanation as text or {note, frame?, end_frame?}`);
    }
    const { note, frame, end_frame } = details;
    if (frame === undefined && end_frame === undefined) return [id, { version, note }];
    validateTarget(id, version, frameCount, frame, end_frame);
    return [id, { version, note, frame, ...(end_frame === undefined ? {} : { end_frame }) }];
  }));
}
