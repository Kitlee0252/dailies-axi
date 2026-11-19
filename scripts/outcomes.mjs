export function resolveOutcomes(outcomes, previous, version, frameCount) {
  if (!outcomes || Array.isArray(outcomes) || typeof outcomes !== 'object') {
    throw new Error('Outcomes must be a JSON object keyed by previous note ID');
  }
  const ids = new Set(previous?.notes.map(note => note.id));
  return Object.fromEntries(Object.entries(outcomes).map(([id, outcome]) => {
    if (!ids.has(id)) throw new Error(`Outcome refers to unknown previous note ID: ${id}`);
    const details = typeof outcome === 'string' ? { note: outcome } : outcome;
    if (!details || Array.isArray(details) || typeof details.note !== 'string' || !details.note.trim() ||
        Object.keys(details).some(key => !['note', 'frame', 'end_frame'].includes(key))) {
      throw new Error(`Outcome ${id} needs a non-empty explanation as text or {note, frame?, end_frame?}`);
    }
    const { note, frame, end_frame } = details;
    if (frame === undefined && end_frame === undefined) return [id, { version, note }];
    if (!Number.isSafeInteger(frame) || frame < 0 || frame >= frameCount) {
      throw new Error(`Outcome ${id} frame must be an integer from 0 to ${frameCount - 1} in ${version}`);
    }
    if (end_frame === undefined) return [id, { version, note, frame }];
    if (!Number.isSafeInteger(end_frame) || end_frame <= frame || end_frame > frameCount) {
      throw new Error(`Outcome ${id} end_frame must be an integer greater than frame and at most ${frameCount} in ${version}`);
    }
    return [id, { version, note, frame, end_frame }];
  }));
}
