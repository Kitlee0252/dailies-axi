// Selection lives independently from the playhead. All bounds are half-open.
export function updateSelection(selection, action) {
  switch (action.type) {
    case 'clear':
      return null;
    case 'range':
      return { start: action.start, end: action.end };
    case 'cue': {
      const { cue } = action;
      const anchor = selection?.anchor ?? cue;
      return { start: Math.min(anchor.start, cue.start), end: Math.max(anchor.end, cue.end), anchor };
    }
    case 'adjust-end': {
      if (!selection) return null;
      const end = Math.max(selection.start + 1, Math.min(action.frameCount, selection.end + action.delta));
      return { ...selection, end };
    }
  }
}
