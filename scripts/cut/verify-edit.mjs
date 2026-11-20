import { attribute, frameTiming, parseComposition } from '../composition.mjs';
import { edlSegments, locateAnchor, placed, reusesFootage, sameFootage } from './model.mjs';
import { inSilence } from './operations.mjs';
import { byAsset, difference, intersection, length } from './ranges.mjs';

export const flashRanges = (cuts, frameCount, fps) => {
  const boundaries = [0, ...new Set(cuts.filter(cut => cut > 0 && cut < frameCount)), frameCount].sort((a, b) => a - b);
  return boundaries.slice(1).flatMap((end, i) =>
    end - boundaries[i] < Math.max(2, Math.round(fps * 0.25)) ? [[boundaries[i], end]] : []);
};

export function footageCuts(edl, analysis) {
  return placed(edlSegments(edl)).flatMap(({ asset, range: [start, end], output }) =>
    [output[0], ...analysis[asset].visual_cuts.filter(cut => cut > start && cut < end)
      .map(cut => output[0] + cut - start)]).filter(Boolean);
}

// Identify genuinely changed boundaries by source neighbors so inherited cuts
// remain valid even when earlier edits change their output offsets.
function sourceBoundaries(segments) {
  const timeline = placed(segments);
  const pair = (left, right) => JSON.stringify([left && [left.asset, left.range[1]], right && [right.asset, right.range[0]]]);
  const markers = timeline.map((segment, i) => {
    const left = timeline[i - 1];
    return { frame: segment.output[0], key: pair(left, segment), sides: [
      ...(left ? [{ asset: left.asset, frame: left.range[1] }] : []), { asset: segment.asset, frame: segment.range[0] },
    ] };
  });
  const last = timeline.at(-1);
  markers.push({ frame: last.output[1], key: pair(last), sides: [{ asset: last.asset, frame: last.range[1] }] });
  return markers;
}

function verifyConform(base, actual, cut, operations) {
  const before = edlSegments(base);
  const after = edlSegments(actual);
  const removed = difference(before, after);
  const added = difference(after, before);
  const authorizedRemoved = operations.flatMap(item => item.removed ?? []);
  const authorizedAdded = operations.flatMap(item => item.added ?? []);
  const errors = [];
  if (reusesFootage(after)) errors.push({ check: 'C1', code: 'reused-source-footage' });
  const unexpected_removed = difference(removed, authorizedRemoved);
  const unexpected_added = difference(added, authorizedAdded);
  const missing_edits = difference(difference(before, cut.segments), removed);
  const missing_additions = difference(difference(cut.segments, before), added);
  if (unexpected_removed.length || unexpected_added.length || missing_edits.length || missing_additions.length ||
      !sameFootage(after, cut.segments)) {
    errors.push({ check: 'C1', code: 'conform-mismatch', unexpected_removed, unexpected_added, missing_edits, missing_additions });
  }
  const keptByAsset = byAsset(after);
  for (const note of new Set(operations.map(op => op.note))) {
    const required = byAsset(operations.filter(op => op.note === note).flatMap(op => op.required ?? []));
    const missing = [...required].flatMap(([asset, ranges]) =>
      ranges.flatMap(range => (keptByAsset.get(asset) ?? []).flatMap(kept => {
        const shared = intersection(range, kept);
        return shared ? [{ asset, range: shared }] : [];
      })));
    if (missing.length) errors.push({ check: 'C1', code: 'under-deleted', note, retained: missing,
      missing_frames: missing.reduce((sum, span) => sum + length(span.range), 0) });
  }
  return { errors, removed, added, unexpected_removed, unexpected_added };
}

function verifyAnchors(html, cut, actual) {
  const { nodes } = parseComposition(html);
  const errors = [];
  const overlays = [];
  for (const overlay of cut.overlays) {
    const { element, anchor, rect } = overlay;
    const report = code => errors.push({ check: 'C5', code, element, anchor });
    const node = nodes.find(node => attribute(node, 'id') === element);
    const anchored = locateAnchor(edlSegments(actual), anchor);
    if (!anchored) report('anchor-lost');
    if (!node) {
      if (anchored) report('overlay-missing');
      continue;
    }
    try {
      const start = frameTiming(node, 'data-start', actual.fps);
      const duration = frameTiming(node, 'data-duration', actual.fps);
      if (!duration || start + duration > actual.frame_count) report('overlay-out-of-range');
      else if (start !== anchored?.[0] || start + duration !== anchored?.[1]) report('overlay-misaligned');
      else overlays.push({ element, rect, output: anchored });
    } catch (error) {
      report(error.message);
    }
  }
  return { errors, overlays };
}

export function inspectEdit({ base, actual, html, cut, changes, analysis, assets = {} }) {
  const { errors, ...conform } = verifyConform(base, actual, cut, changes.operations);
  const originalKeys = new Set(sourceBoundaries(edlSegments(base)).map(boundary => boundary.key));
  const altered = sourceBoundaries(edlSegments(actual)).filter(boundary => !originalKeys.has(boundary.key));
  for (const boundary of altered) {
    for (const { asset, frame } of boundary.sides) {
      if (frame === 0 || frame === assets[asset]?.frame_count || inSilence(analysis[asset], frame)) continue;
      errors.push({ check: 'C2', code: 'cut-in-speech', output_frame: boundary.frame, asset, frame });
    }
  }
  const cuts = footageCuts(actual, analysis);
  for (const range of flashRanges(cuts, actual.frame_count, actual.fps)) {
    errors.push({ check: 'C3', code: 'flash-shot', range });
  }
  const expectedFrames = placed(cut.segments).at(-1).output[1];
  if (actual.frame_count !== expectedFrames || actual.fps !== cut.fps) {
    errors.push({ check: 'duration', code: 'timeline-mismatch', expectedFrames, actualFrames: actual.frame_count });
  }
  const { errors: anchorErrors, overlays } = verifyAnchors(html, cut, actual);
  errors.push(...anchorErrors);
  return { errors, conform, cuts, changed_frames: altered.map(boundary => boundary.frame), overlays };
}
