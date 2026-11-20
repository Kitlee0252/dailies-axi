import { byAsset, intersection, length } from './ranges.mjs';

export const assetId = /^[a-zA-Z0-9][\w-]*$/;
export const versionId = /^v[1-9]\d*$/;
export const elementId = /^[a-zA-Z][\w-]*$/;
export const schema = 1;

export function requireSchema(value, name, version = schema) {
  if (value?.schema_version !== version) throw new Error(`Unsupported ${name} schema_version (expected ${version})`);
}

export function nextVersion(version) {
  if (!versionId.test(version) || !Number.isSafeInteger(Number(version.slice(1)) + 1)) {
    throw new Error(`Invalid review version: ${version}`);
  }
  return `v${Number(version.slice(1)) + 1}`;
}

export function checkSpan(span, assets, label) {
  const { asset, range } = span ?? {};
  if (!assetId.test(asset ?? '') || !Object.hasOwn(assets, asset) || !Array.isArray(range) ||
      range.length !== 2 || !range.every(Number.isSafeInteger) ||
      range[0] < 0 || range[0] >= range[1] || range[1] > assets[asset].frame_count) {
    throw new Error(`${label} needs an asset and a nonempty, in-bounds integer source range`);
  }
}

export function edlSegments(edl) {
  requireSchema(edl, 'edl.json');
  let cursor = 0;
  const segments = edl.segments.map(segment => {
    if (segment.start_frame !== cursor || segment.end_frame <= cursor ||
        segment.end_frame - cursor !== segment.media_out - segment.media_in) {
      throw new Error('The edit engine requires a contiguous, single-track 1× footage sequence');
    }
    cursor = segment.end_frame;
    return { asset: segment.asset, range: [segment.media_in, segment.media_out], clip: segment.clip };
  });
  if (cursor !== edl.frame_count) throw new Error('The edit engine requires footage from the first to the last frame');
  return segments;
}

export function cutFromEdl(edl, version) {
  return { schema_version: schema, version, fps: edl.fps, segments: edlSegments(edl), overlays: [], protected: [] };
}

export function placed(segments) {
  let cursor = 0;
  return segments.map(segment => {
    const start = cursor;
    cursor += length(segment.range);
    return { ...segment, output: [start, cursor] };
  });
}

export function sameFootage(a, b) {
  const key = sequence => JSON.stringify(sequence.map(({ clip, asset, range }) => [clip, asset, range]));
  return key(a) === key(b);
}

export function reviewedSpans(edl, note) {
  if (note.whole_video) return placed(edlSegments(edl));
  const { frame, end_frame: end = frame + 1 } = note;
  if (!Number.isSafeInteger(frame) || !Number.isSafeInteger(end) || frame < 0 || end <= frame ||
      end > edl.frame_count) throw new Error(`Note ${note.id} has invalid reviewed frame bounds`);
  return placed(edlSegments(edl)).flatMap(({ asset, range, output }) => {
    const clipped = intersection(output, [frame, end]);
    return clipped ? [{ asset, range: clipped.map(boundary => range[0] + boundary - output[0]) }] : [];
  });
}

export function locateAnchor(segments, anchor) {
  const hits = placed(segments).flatMap(segment => {
    if (segment.asset !== anchor.asset) return [];
    const source = intersection(segment.range, anchor.range);
    return source ? [{ source, output: source.map(frame => frame + segment.output[0] - segment.range[0]) }] : [];
  });
  const first = hits[0];
  if (first?.source[0] !== anchor.range[0] || hits.at(-1)?.source[1] !== anchor.range[1]) return null;
  if (hits.some((hit, i) => i > 0 && (hit.source[0] !== hits[i - 1].source[1] ||
      hit.output[0] !== hits[i - 1].output[1]))) return null;
  return [first.output[0], hits.at(-1).output[1]];
}

export function sourceFrameAfter(before, after, deleted) {
  const original = placed(before);
  const encountered = original.flatMap(segment => {
    const hit = segment.asset === deleted.asset && intersection(segment.range, deleted.range);
    return hit ? [hit[1] + segment.output[0] - segment.range[0]] : [];
  });
  if (!encountered.length) return;
  const anchor = Math.max(...encountered);
  const remainders = placed(after).flatMap(segment => original.flatMap(previous => {
    const hit = segment.asset === previous.asset && intersection(segment.range, previous.range);
    if (!hit) return [];
    return [{ previous: hit.map(frame => frame + previous.output[0] - previous.range[0]),
      output: hit.map(frame => frame + segment.output[0] - segment.range[0]) }];
  })).sort((a, b) => a.previous[0] - b.previous[0]);
  const next = remainders.find(segment => segment.previous[1] > anchor);
  if (next) return next.output[0] + Math.max(0, anchor - next.previous[0]);
  const last = remainders.at(-1);
  return last ? last.output[1] - 1 : undefined;
}

export function reusesFootage(segments) {
  const unique = [...byAsset(segments).values()].flat().reduce((sum, range) => sum + length(range), 0);
  return unique !== segments.reduce((sum, segment) => sum + length(segment.range), 0);
}

export function validateCut(cut, edl, assets, version) {
  requireSchema(cut, 'cut.json');
  if (cut.version !== version || cut.fps !== edl.fps || !sameFootage(cut.segments, edlSegments(edl))) {
    throw new Error('cut.json does not match the locked review. Select/build the intended version first.');
  }
  for (const span of [...cut.segments, ...cut.protected]) checkSpan(span, assets, 'Cut span');
  for (const { anchor } of cut.overlays) checkSpan(anchor, assets, 'Overlay anchor');
  // A source-only edit cannot distinguish occurrences of a duplicated frame.
  if (reusesFootage(cut.segments)) throw new Error('Resolve reused source intervals before editing by source frame');
}
