import { attribute, frameTiming, parseComposition, proxyPath, referencesOriginal } from './composition.mjs';
import { mapInterval } from './edl.mjs';

export function compositionEdl(html, assets) {
  return documentEdl(parseComposition(html), assets);
}

export function documentEdl({ root, fps, videos }, assets) {
  const frameCount = frameTiming(root, 'data-duration', fps);
  if (!frameCount) throw new Error('The composition must contain at least one frame');

  const ids = new Set();
  const segments = videos.map(node => {
    const id = attribute(node, 'id'), assetId = attribute(node, 'data-review-clip');
    if (!id || ids.has(id)) throw new Error('Each footage segment needs a unique HTML id');
    ids.add(id);
    if (!assetId || !Object.hasOwn(assets, assetId)) throw new Error(`Unknown footage asset on #${id}: ${assetId}`);
    const asset = assets[assetId];
    const src = attribute(node, 'src');
    if ((!referencesOriginal(node) && src !== asset.proxy) ||
        asset.proxy !== proxyPath(assetId) || Math.abs(asset.proxy_fps - fps) > 1e-7) {
      throw new Error(`#${id} needs the manifest proxy at the composition frame rate`);
    }
    if (Number(attribute(node, 'data-playback-rate') ?? 1) !== 1) throw new Error(`#${id} needs 1× playback for source mapping`);
    const start = frameTiming(node, 'data-start', fps);
    const media = frameTiming(node, 'data-media-start', fps, 0);
    const duration = frameTiming(node, 'data-duration', fps);
    if (!duration || start + duration > frameCount || media + duration > asset.frame_count) {
      throw new Error(`#${id} is outside the composition or proxy`);
    }
    return { clip: id, asset: assetId, start_frame: start, end_frame: start + duration, media_in: media };
  }).sort((a, b) => a.start_frame - b.start_frame);
  const cuts = new Set();
  for (const segment of segments) {
    const [span] = mapInterval({ segments: [segment] }, assets, segment.start_frame, segment.end_frame);
    segment.media_out = span.media_end_frame;
    if (segment.start_frame > 0) cuts.add(segment.start_frame);
    if (segment.end_frame < frameCount) cuts.add(segment.end_frame);
    for (const cut of assets[segment.asset].scene_cuts ?? []) {
      if (cut > segment.media_in && cut < segment.media_out) cuts.add(segment.start_frame + cut - segment.media_in);
    }
    segment.source_in = span.source_frame;
    segment.source_out = span.last_source_frame + 1;
    segment.source_in_seconds = span.source_seconds;
    segment.source_out_seconds = span.source_end_seconds;
  }
  // Composition frames where a new shot starts: segment edges and cuts detected in the footage.
  return { schema_version: 1, fps, frame_count: frameCount, cuts: [...cuts].sort((a, b) => a - b), segments };
}
