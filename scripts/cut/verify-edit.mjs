import { attribute, frameTiming, parseComposition } from '../composition.mjs';
import { attributesFor, nativeAudio, reframeRect, reframeStyle, spliceTreatments } from './attributes.mjs';
import { edlSegments, locateAnchor, placed, reusesFootage, sameFootage } from './model.mjs';
import { inSilence } from './operations.mjs';
import { byAsset, difference, intersection, length } from './ranges.mjs';

export const flashRanges = (cuts, frameCount, fps) => {
  const boundaries = [0, ...new Set(cuts.filter(cut => cut > 0 && cut < frameCount)), frameCount].sort((a, b) => a - b);
  return boundaries.slice(1).flatMap((end, i) =>
    end - boundaries[i] < Math.max(2, Math.round(fps * 0.25)) ? [[boundaries[i], end]] : []);
};

const continuous = (left, right) => left?.asset === right?.asset && left?.range[1] === right?.range[0];

export function footageCuts(edl, analysis, ignoreContinuous = false) {
  const timeline = placed(edlSegments(edl));
  return timeline.flatMap(({ asset, range: [start, end], output }, i) =>
    [...(ignoreContinuous && continuous(timeline[i - 1], timeline[i]) ? [] : [output[0]]),
      ...analysis[asset].visual_cuts.filter(cut => (cut > start && cut < end) || (ignoreContinuous && cut === start))
        .map(cut => output[0] + cut - start)]).filter(Boolean);
}

// Identify genuinely changed boundaries by source neighbors so inherited cuts
// remain valid even when earlier edits change their output offsets.
function sourceBoundaries(segments, ignoreContinuous = false) {
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
  return ignoreContinuous ? markers.filter((_, i) => !continuous(timeline[i - 1], timeline[i])) : markers;
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

function verifyAttributes(html, cut, actual, assets, fades) {
  const { root, videos } = parseComposition(html);
  const dimensions = { width: Number(attribute(root, 'data-width')), height: Number(attribute(root, 'data-height')) };
  const errors = [];
  const audio = [];
  const reframes = [];
  for (const segment of placed(edlSegments(actual))) {
    const { clip, asset, range, output } = segment;
    const { audio: gain, reframe } = attributesFor(cut, segment);
    const node = videos.find(node => attribute(node, 'id') === clip);
    const report = kind => errors.push({ check: 'attributes', code: 'attribute-mismatch', kind, clip, output });
    for (const item of [gain, reframe].filter(Boolean)) {
      if (item.anchor.range[0] > range[0] || item.anchor.range[1] < range[1]) report(item.kind);
    }
    const splice = fades.get(clip);
    if (gain) {
      const settings = nativeAudio(gain, range, cut.fps, splice);
      if (attribute(node, 'muted') !== undefined || attribute(node, 'data-has-audio') !== 'true' ||
          Object.entries(settings).some(([key, value]) => attribute(node, key) !== String(value))) report('audio');
      audio.push({ asset, range, output, volume: settings['data-volume'],
        fade_in: settings['data-fade-in'], fade_out: settings['data-fade-out'] });
    } else if (splice) {
      for (const [field, seconds] of Object.entries(splice)) {
        const key = `data-${field.replace('_', '-')}`;
        if (!(Number(attribute(node, key)) >= seconds)) report('splice-fade');
      }
    } else if (attribute(node, 'data-dailies-cut-audio-base') !== undefined) report('audio');
    if (reframe) {
      const rect = reframeRect(reframe, assets[asset], dimensions);
      if (!attribute(node, 'style')?.endsWith(reframeStyle(rect))) report('reframe');
      reframes.push({ asset, range, output, rect });
    } else if (attribute(node, 'data-dailies-cut-style-base') !== undefined) report('reframe');
  }
  return { errors, audio, reframes };
}

export function inspectEdit({ base, actual, html, cut, changes, analysis, assets = {} }) {
  const { errors, ...conform } = verifyConform(base, actual, cut, changes.operations);
  const ignoreContinuous = cut.attributes !== undefined;
  const originalKeys = new Set(sourceBoundaries(edlSegments(base), ignoreContinuous).map(boundary => boundary.key));
  const altered = sourceBoundaries(edlSegments(actual), ignoreContinuous).filter(boundary => !originalKeys.has(boundary.key));
  for (const boundary of altered) {
    for (const { asset, frame } of boundary.sides) {
      if (frame === 0 || frame === assets[asset]?.frame_count || inSilence(analysis[asset], frame)) continue;
      errors.push({ check: 'C2', code: 'cut-in-speech', output_frame: boundary.frame, asset, frame });
    }
  }
  const cuts = footageCuts(actual, analysis, ignoreContinuous);
  for (const range of flashRanges(cuts, actual.frame_count, actual.fps)) {
    errors.push({ check: 'C3', code: 'flash-shot', range });
  }
  const expectedFrames = placed(cut.segments).at(-1).output[1];
  if (actual.frame_count !== expectedFrames || actual.fps !== cut.fps) {
    errors.push({ check: 'duration', code: 'timeline-mismatch', expectedFrames, actualFrames: actual.frame_count });
  }
  const { errors: anchorErrors, overlays } = verifyAnchors(html, cut, actual);
  errors.push(...anchorErrors);
  const { clips, joins } = spliceTreatments(cut);
  const { errors: attributeErrors, audio, reframes } = verifyAttributes(html, cut, actual, assets, clips);
  const changed_frames = altered.map(boundary => boundary.frame);
  const hasSequence = changes.operations.some(item => ['move', 'insert', 'replace'].includes(item.op));
  const oldClips = sourceBoundaries(edlSegments(base));
  const oldEdges = new Set(oldClips.map(item => item.key));
  const treatedSplits = cut.attributes?.length ? sourceBoundaries(edlSegments(actual))
    .filter(item => !oldEdges.has(item.key) && !changed_frames.includes(item.frame)).map(item => item.frame) : [];
  const click_frames = [...new Set([...joins.map(item => item.frame),
    ...(hasSequence ? changed_frames : []), ...treatedSplits])];
  errors.push(...attributeErrors);
  return { errors, conform, cuts, changed_frames, click_frames, splice_fades: joins, overlays, audio, reframes };
}
