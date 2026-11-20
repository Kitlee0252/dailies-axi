import { checkSpan, elementId, locateAnchor, nextVersion, placed, requireSchema, reviewedSpans,
  reusesFootage, schema, sourceFrameAfter, validateCut } from './model.mjs';
import { byAsset, difference, intersection, overlaps, subtract, union } from './ranges.mjs';
import { outcomeMetadata } from '../outcomes.mjs';

const SNAP_RADIUS = 6;
const MIN_PAD_SECONDS = 0.03;
const nonempty = value => typeof value === 'string' && value.trim() !== '';
const authorities = new Set(['explicit', 'inferred', 'taste']);

export const inSilence = (data, frame) => data.silences.some(([start, end]) => start <= frame && frame <= end);
const nearest = (values, frame) => [...new Set(values)].sort((a, b) =>
  Math.abs(a - frame) - Math.abs(b - frame) || a - b)[0];

export function snapBoundary(frame, asset, data) {
  if (frame === 0 || frame === asset.frame_count) return frame;
  const visual = nearest(data.visual_cuts.filter(cut =>
    Math.abs(cut - frame) <= SNAP_RADIUS && inSilence(data, cut)), frame);
  if (visual !== undefined) return visual;
  if (inSilence(data, frame)) return frame;
  const edge = nearest(data.silences.flat().filter(cut => Math.abs(cut - frame) <= SNAP_RADIUS), frame);
  if (edge !== undefined) return edge;
  throw new Error(`F${frame} is inside speech or other audible sound with no quiet boundary within ${SNAP_RADIUS} frames`);
}

export function validRect(rect) {
  const { x, y, width, height } = rect ?? {};
  return [x, y, width, height].every(Number.isFinite) && x >= 0 && y >= 0 && width > 0 && height > 0 &&
    x + width <= 1 && y + height <= 1;
}

function validateOp(op, note) {
  if (!note || !nonempty(op.intent) || !authorities.has(op.authority) ||
      !['local', 'global'].includes(op.scope) || !nonempty(op.op)) {
    throw new Error('Every operation needs a locked note ID, intent, authority, scope and op');
  }
  if (op.scope === 'global' && !(note.whole_video || note.kind === 'general') && !nonempty(op.scope_reason)) {
    throw new Error(`Note ${op.note} needs an explanation of the authorized global scope`);
  }
}

function deleteOp(op, note, reviewed, assets, analysis) {
  checkSpan(op, assets, op.note);
  const reviewedRanges = reviewed.filter(span => span.asset === op.asset).map(span => span.range);
  if (op.scope === 'local' && !reviewedRanges.some(range => overlaps(range, op.range))) {
    throw new Error(`Note ${op.note} does not target the requested source range`);
  }
  const range = op.range.map(frame => snapBoundary(frame, assets[op.asset], analysis[op.asset]));
  checkSpan({ asset: op.asset, range }, assets, op.note);
  const required = [{ asset: op.asset, range: op.range }];
  if (op.authority === 'explicit' && op.scope === 'local' && note.kind === 'range') {
    // A range delete covers the locked selection on each affected asset.
    // Prevent an accidentally shortened translation from blessing a partial delete.
    required.push(...reviewed);
    if (!reviewedRanges.some(([start, end]) => op.range[0] >= start - SNAP_RADIUS && op.range[1] <= end + SNAP_RADIUS)) {
      throw new Error(`Note ${op.note} extends beyond the reviewed selection`);
    }
  }
  return { removed: [{ asset: op.asset, range }], required };
}

function trimOp(op, reviewed, cut, assets, analysis) {
  const target = cut.segments.find(segment => segment.clip === op.clip);
  if (!target || op.asset !== target.asset ||
      (op.scope === 'local' && !reviewed.some(span => span.asset === op.asset && overlaps(span.range, target.range)))) {
    throw new Error(`Note ${op.note} trim must name its reviewed clip and asset`);
  }
  checkSpan(op, assets, op.note);
  if (!overlaps(op.range, target.range)) throw new Error('Trim must retain part of its clip');
  const range = op.range.map((boundary, i) => boundary === target.range[i] ? boundary :
    snapBoundary(boundary, assets[op.asset], analysis[op.asset]));
  checkSpan({ asset: op.asset, range }, assets, op.note);
  if (!overlaps(range, target.range)) throw new Error('Snapped trim must retain part of its clip');
  const { asset } = target;
  const added = subtract(range, [target.range]).map(range => ({ asset, range }));
  if (added.some(span => [...cut.protected, ...cut.segments].some(previous =>
    previous.asset === asset && overlaps(previous.range, span.range)))) {
    throw new Error('Trim would restore previously removed footage or duplicate another clip');
  }
  return {
    trim: { clip: op.clip, range }, added,
    removed: subtract(target.range, [range]).map(range => ({ asset, range })),
    required: subtract(target.range, [op.range]).map(range => ({ asset, range })),
  };
}

function tightenOp(op, reviewed, cut, assets, analysis) {
  if (!(Number.isFinite(op.min_pause) && Number.isFinite(op.keep_pad) && op.keep_pad >= MIN_PAD_SECONDS &&
      op.min_pause > op.keep_pad * 2)) throw new Error('Tighten needs min_pause > 2 × keep_pad and keep_pad ≥ 0.03 s');
  const min = Math.ceil(op.min_pause * cut.fps);
  const pad = Math.max(1, Math.round(op.keep_pad * cut.fps));
  if (op.range !== undefined) {
    checkSpan(op, assets, op.note);
    if (op.scope !== 'local' || !reviewed.some(span => span.asset === op.asset && overlaps(span.range, op.range))) {
      throw new Error(`Tighten range for ${op.note} must overlap its local note`);
    }
  }
  const spans = op.scope === 'global' ? cut.segments : op.range
    ? reviewed.filter(span => span.asset === op.asset).flatMap(span => {
      const range = intersection(span.range, op.range);
      return range ? [{ asset: span.asset, range }] : [];
    }) : reviewed;
  const removed = spans.filter(({ asset }) => assets[asset].audio).flatMap(({ asset, range }) => analysis[asset].silences.flatMap(([start, end]) => {
    if (end - start < min || end - start <= pad * 2) return [];
    const middle = [start + pad, end - pad];
    // Expanding within silence can absorb a tiny remnant at a nearby visual
    // transition. Keep at least one quiet frame on each side of the splice.
    const cuts = analysis[asset].visual_cuts.filter(cut => start < cut && cut < end &&
      range[0] <= cut && cut <= range[1]);
    const left = nearest(cuts.filter(cut => cut < middle[0] && middle[0] - cut <= SNAP_RADIUS), middle[0]);
    const right = nearest(cuts.filter(cut => cut > middle[1] && cut - middle[1] <= SNAP_RADIUS), middle[1]);
    const adjusted = [left ?? middle[0], right ?? middle[1]];
    return range[0] <= adjusted[0] && adjusted[1] <= range[1] ? [{ asset, range: adjusted }] : [];
  }));
  return { removed };
}

function overlayOp(op, reviewed, assets) {
  const element = typeof op.element === 'string' ? op.element.replace(/^#/, '') : '';
  if (!elementId.test(element) || (!nonempty(op.text) && !elementId.test(op.template ?? '')) || !validRect(op.rect)) {
    throw new Error(`Note ${op.note} overlay needs an element, text or a template ID, and a normalized rect`);
  }
  checkSpan(op.anchor, assets, op.note);
  if (op.scope === 'local' && !reviewed.some(span =>
    span.asset === op.anchor.asset && overlaps(span.range, op.anchor.range))) {
    throw new Error(`Overlay ${element} must overlap the note's source footage`);
  }
  if (op.replace !== undefined && (op.replace !== true || op.authority !== 'explicit')) {
    throw new Error('Re-anchoring an existing overlay requires explicit authorization');
  }
  return { replace_overlay: op.replace === true, overlay: { element, anchor: op.anchor, rect: op.rect,
    ...(nonempty(op.text) ? { text: op.text } : { template: op.template }) } };
}

function snappedSpan(span, assets, analysis, label) {
  checkSpan(span, assets, label);
  const { asset, range } = span;
  const snapped = { asset, range: range.map(frame => snapBoundary(frame, assets[asset], analysis[asset])) };
  checkSpan(snapped, assets, label);
  return snapped;
}

function sequenceOp(op, reviewed, cut, assets, analysis) {
  let target;
  if (op.op !== 'insert') {
    target = snappedSpan(op, assets, analysis, op.note);
    if (op.scope === 'local' && !reviewed.some(span => span.asset === op.asset && overlaps(span.range, op.range))) {
      throw new Error(`Note ${op.note} does not target the requested source range`);
    }
    if (!locateAnchor(cut.segments, target)) throw new Error('Move or replace needs a contiguous reviewed source span');
  }
  const addition = op.op === 'move' ? null : snappedSpan(op.op === 'insert' ? op : op.with, assets, analysis, op.note);
  if (addition) {
    if (Math.abs(assets[addition.asset].proxy_fps - cut.fps) > 1e-7) {
      throw new Error(`Ingest ${addition.asset} at the composition frame rate before editing`);
    }
    if (cut.segments.some(span => span.asset === addition.asset &&
      (op.op === 'insert' || overlaps(span.range, addition.range)))) {
      throw new Error(`${op.op} would reuse source footage; insert requires an asset outside the reviewed cut`);
    }
    if (op.authority !== 'explicit' && cut.protected.some(span =>
      span.asset === addition.asset && overlaps(span.range, addition.range))) {
      throw new Error('Explicit authority is required to restore protected footage');
    }
  }
  let after;
  if (op.op !== 'replace') {
    if (op.after === 'start') after = 'start';
    else {
      const { asset, frame } = op.after ?? {};
      const anchor = { asset, range: [frame, frame + 1] };
      checkSpan(anchor, assets, 'Sequence destination');
      if (!locateAnchor(cut.segments, anchor) || (target?.asset === asset && overlaps(target.range, anchor.range))) {
        throw new Error('Sequence destination needs a reviewed frame outside the moved span');
      }
      if (op.op === 'insert' && op.scope === 'local' && !reviewed.some(span =>
        span.asset === asset && overlaps(span.range, anchor.range))) {
        throw new Error('Local insert must follow a reviewed frame in the note');
      }
      after = { asset, frame };
    }
    if (op.op === 'insert' && after === 'start' && op.scope === 'local' && !reviewed.some(span => {
      const first = cut.segments[0];
      return first.asset === span.asset && first.range[0] >= span.range[0] && first.range[0] < span.range[1];
    })) throw new Error('Local insert at the start needs a note covering the first frame');
  }
  return { ...(target ? { target } : {}), ...(after ? { after } : {}),
    ...(addition ? { added: [addition] } : {}),
    ...(op.op === 'replace' ? { removed: [target], required: [target] } : {}) };
}

function sequenceEdits(segments, decisions, allocateId, removals) {
  function splitAt(frame) {
    const timeline = placed(segments);
    const i = timeline.findIndex(segment => segment.output[0] <= frame && frame < segment.output[1]);
    if (i === -1) return segments.length;
    const { output, ...segment } = timeline[i];
    if (output[0] === frame) return i;
    const boundary = segment.range[0] + frame - output[0];
    segments.splice(i, 1, { ...segment, range: [segment.range[0], boundary] },
      { ...segment, range: [boundary, segment.range[1]], clip: allocateId(segment.clip, boundary) });
    return i + 1;
  }
  for (const item of decisions.filter(item => ['move', 'insert', 'replace'].includes(item.op))) {
    let moved, position;
    if (item.target) {
      const output = locateAnchor(segments, item.target);
      if (!output) throw new Error('Sequence operations conflict on the same source span');
      position = splitAt(output[0]);
      const end = splitAt(output[1]);
      moved = segments.splice(position, end - position);
    }
    if (item.after === 'start') position = 0;
    else if (item.after) {
      const { asset, frame } = item.after;
      const range = [frame, frame + 1];
      const output = locateAnchor(segments, { asset, range });
      if (!output || (removals.get(asset) ?? []).some(span => overlaps(span, range))) {
        throw new Error('The sequence destination frame was removed by another edit');
      }
      position = splitAt(output[1]);
    }
    const [span] = item.added ?? [];
    if (span && segments.some(existing => existing.asset === span.asset && overlaps(existing.range, span.range))) {
      throw new Error('Sequence operations would reuse source footage');
    }
    segments.splice(position, 0, ...(span ? [{ ...span, clip: allocateId(`shot-${span.asset}`, span.range[0]) }] : moved));
  }
  return segments;
}

function makeDecisions(cut, edl, notes, ops, assets, analysis) {
  const notesById = new Map(notes.map(note => [note.id, note]));
  return ops.map(op => {
    const note = notesById.get(op?.note);
    validateOp(op, note);
    const reviewed = reviewedSpans(edl, note);
    let details;
    switch (op.op) {
      case 'delete': details = deleteOp(op, note, reviewed, assets, analysis); break;
      case 'trim': details = trimOp(op, reviewed, cut, assets, analysis); break;
      case 'tighten': details = tightenOp(op, reviewed, cut, assets, analysis); break;
      case 'move':
      case 'insert':
      case 'replace': details = sequenceOp(op, reviewed, cut, assets, analysis); break;
      case 'overlay': details = overlayOp(op, reviewed, assets); break;
      case 'ask':
      case 'decline':
        if (!nonempty(op.reason)) throw new Error(`${op.op} requires a reason`);
        details = { deferred: op.reason };
        break;
      default: throw new Error(`Unsupported edit operation: ${op.op}`);
    }
    const { note: id, op: type, intent, authority, scope, scope_reason } = op;
    return { note: id, op: type, intent, authority, scope,
      ...(scope_reason ? { scope_reason } : {}), ...(op.basis ? { basis: op.basis } : {}), ...details };
  });
}

function outcomesFor(notes, decisions, before, cut, anchorLosses, metadata = {}) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) ||
    Object.keys(metadata).some(id => !notes.some(note => note.id === id))) throw new Error('Outcome metadata must use locked note IDs');
  const direct = byAsset(decisions.filter(item => item.op !== 'tighten').flatMap(item => item.removed ?? []));
  return Object.fromEntries(notes.map(note => {
    const items = decisions.filter(item => item.note === note.id);
    const frames = [];
    const messages = [];
    let status = 'applied';
    const details = Object.hasOwn(metadata, note.id) ? metadata[note.id] : {};
    const extra = outcomeMetadata(details);
    if (details.note !== undefined && !nonempty(details.note)) throw new Error('Outcome explanation must be non-empty text');
    if (!items.length) return [note.id, { status: 'pending', note: details.note ?? 'Awaiting an edit decision.', frames, ...extra }];
    for (const item of items) {
      messages.push(item.deferred ?? item.intent);
      if (item.scope_reason) messages.push(item.scope_reason);
      const removed = item.removed ?? [];
      const effective = item.op === 'tighten' ? removed.filter(span =>
        subtract(span.range, direct.get(span.asset) ?? []).length) : removed;
      if (item.op === 'tighten') messages.push(`Tightened ${effective.length} pause(s).`);
      if ((item.deferred || (item.op === 'tighten' && !effective.length)) && status === 'applied') status = 'pending';
      if (item.overlay) {
        const frame = locateAnchor(cut.segments, item.overlay.anchor);
        if (frame) frames.push(frame);
        else {
          status = 'anchor-lost';
          messages.push(`Anchor lost for #${item.overlay.element}.`);
        }
      }
      for (const span of item.op === 'move' ? [item.target] : item.added ?? []) {
        frames.push(...placed(cut.segments).flatMap(segment => {
          const hit = segment.asset === span.asset && intersection(segment.range, span.range);
          return hit ? [hit.map(frame => frame + segment.output[0] - segment.range[0])] : [];
        }));
      }
      for (const span of effective) {
        const start = sourceFrameAfter(before.segments, cut.segments, span);
        if (start !== undefined) frames.push([start, start + 1]);
      }
    }
    for (const loss of anchorLosses.filter(loss => loss.notes.includes(note.id))) {
      status = 'anchor-lost';
      if (!items.some(item => item.overlay?.element === loss.element)) messages.push(`Anchor lost for #${loss.element}.`);
    }
    if (details.note) messages.push(details.note);
    return [note.id, { status, note: messages.join(' '), frames: union(frames), ...extra }];
  }));
}

export function applyOperations(cut, edl, notes, input, assets, analysis) {
  requireSchema(input, 'ops.json');
  if (input.from !== cut.version || !Array.isArray(input.ops) || !input.ops.length) {
    throw new Error('ops.json needs the current review version and at least one operation');
  }
  validateCut(cut, edl, assets, input.from);
  const decisions = makeDecisions(cut, edl, notes, input.ops, assets, analysis);
  const removals = byAsset(decisions.flatMap(item => item.removed ?? []));
  const trims = new Map(decisions.filter(item => item.trim).map(item => [item.trim.clip, item.trim.range]));
  if (trims.size !== decisions.filter(item => item.trim).length) throw new Error('Combine multiple trims of the same clip');
  const existingIds = new Set(cut.segments.map(segment => segment.clip));
  function allocateId(clip, frame) {
    let id = `${clip}--f${frame}`;
    while (existingIds.has(id)) id += '-';
    existingIds.add(id);
    return id;
  }
  const trimmed = cut.segments.map(segment => ({ ...segment, range: trims.get(segment.clip) ?? segment.range }));
  const segments = sequenceEdits(trimmed, decisions, allocateId, removals).flatMap(({ asset, range, clip }) =>
    subtract(range, removals.get(asset) ?? []).map((range, i) => ({
      asset, range, clip: i ? allocateId(clip, range[0]) : clip,
    })));
  if (decisions.some(item => item.target &&
      item.op === 'move' && !segments.some(segment => segment.asset === item.target.asset &&
        overlaps(segment.range, item.target.range)))) throw new Error('Another edit removes all moved footage');
  if (reusesFootage(segments)) throw new Error('The edits would reuse source footage');
  if (!segments.length) throw new Error('The operations remove all footage');
  const byElement = new Map(cut.overlays.map(overlay => [overlay.element, overlay]));
  const anchorsEdited = new Set();
  for (const decision of decisions.filter(item => item.overlay)) {
    const { overlay, replace_overlay } = decision;
    if (anchorsEdited.has(overlay.element) || byElement.has(overlay.element) !== replace_overlay) {
      throw new Error(`Overlay #${overlay.element} needs a new ID or an explicit replacement of an existing anchor`);
    }
    anchorsEdited.add(overlay.element);
    byElement.set(overlay.element, overlay);
  }
  const overlays = [...byElement.values()].sort((a, b) => a.element.localeCompare(b.element));
  const anchorLosses = overlays.filter(overlay => !locateAnchor(segments, overlay.anchor)).map(({ element, anchor }) => ({
    element, anchor, notes: [...new Set(decisions.filter(op => op.overlay?.element === element ||
      op.removed?.some(span => span.asset === anchor.asset && overlaps(span.range, anchor.range))).map(op => op.note))],
  }));
  const removed = difference(cut.segments, segments);
  const added = difference(segments, cut.segments);
  const protectedSpans = difference([...cut.protected, ...removed], added);
  const version = nextVersion(input.from);
  const next = { schema_version: schema, version, fps: cut.fps, segments, overlays, protected: protectedSpans };
  const timeline = placed(segments);
  const outcomeNotes = notes.filter(note => !note.generated || decisions.some(op => op.note === note.id));
  const changes = { schema_version: schema, kind: 'dailies-cut-changes', from: input.from, to: version,
    frame_count: timeline.at(-1).output[1], removed, added,
    splice_points: timeline.slice(1).map(segment => segment.output[0]),
    operations: decisions, anchor_losses: anchorLosses, outcomes: outcomesFor(outcomeNotes, decisions, cut, next, anchorLosses, input.outcomes) };
  const generated = outcomeNotes.filter(note => note.generated)
    .map(({ id, text, whole_video }) => ({ id, text, whole_video }));
  if (generated.length) changes.generated_notes = generated;
  return { cut: next, changes };
}
