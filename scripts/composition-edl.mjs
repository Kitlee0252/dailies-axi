import { parse } from 'parse5';
import { mapInterval } from './edl.mjs';

function* elements(node) {
  if (node.tagName) yield node;
  for (const child of node.childNodes ?? []) yield* elements(child);
}

const attrs = node => Object.fromEntries(node.attrs.map(({ name, value }) => [name, value]));

function onFrame(value, fps, name) {
  const frame = Number(value) * fps;
  if (value === undefined || value === '' || !Number.isFinite(frame) || frame < 0 ||
      Math.abs(frame - Math.round(frame)) > 1e-5) {
    throw new Error(`${name} must land on a frame boundary at ${fps} fps`);
  }
  return Math.round(frame);
}

export function compositionEdl(html, assets) {
  const nodes = [...elements(parse(html))];
  const root = nodes.find(node => Object.hasOwn(attrs(node), 'data-composition-id'));
  if (!root) throw new Error('Missing the HyperFrames composition root');
  const meta = attrs(root);
  const fps = Number(meta['data-fps']);
  if (!(fps > 0 && Number.isFinite(fps))) throw new Error('Composition needs a numeric data-fps');
  const frameCount = onFrame(meta['data-duration'], fps, 'Composition duration');
  if (!frameCount) throw new Error('The composition must contain at least one frame');

  const ids = new Set();
  const segments = [...elements(root)].filter(node => node.tagName === 'video').map(node => {
    const el = attrs(node), id = el.id, assetId = el['data-review-clip'];
    if (!id || ids.has(id)) throw new Error('Each footage segment needs a unique HTML id');
    ids.add(id);
    if (!assetId || !Object.hasOwn(assets, assetId)) throw new Error(`Unknown footage asset on #${id}: ${assetId}`);
    const asset = assets[assetId];
    if (el.src !== asset.proxy || asset.proxy !== `media/${assetId}.mp4` || Math.abs(asset.proxy_fps - fps) > 1e-7) {
      throw new Error(`#${id} needs the manifest proxy at the composition frame rate`);
    }
    if (Number(el['data-playback-rate'] ?? 1) !== 1) throw new Error(`#${id} needs 1× playback for source mapping`);
    const start = onFrame(el['data-start'], fps, `#${id} start`);
    const media = onFrame(el['data-media-start'] ?? '0', fps, `#${id} media start`);
    const duration = onFrame(el['data-duration'], fps, `#${id} duration`);
    if (!duration || start + duration > frameCount || media + duration > asset.frame_count) {
      throw new Error(`#${id} is outside the composition or proxy`);
    }
    return { clip: id, asset: assetId, start_frame: start, end_frame: start + duration, media_in: media };
  }).sort((a, b) => a.start_frame - b.start_frame);
  const edl = { schema_version: 1, fps, frame_count: frameCount, segments };
  for (const segment of segments) {
    const [span] = mapInterval({ segments: [segment] }, assets, segment.start_frame, segment.end_frame);
    segment.media_out = span.media_end_frame;
    segment.source_in = span.source_frame;
    segment.source_out = span.last_source_frame + 1;
    segment.source_in_seconds = span.source_seconds;
    segment.source_out_seconds = span.source_end_seconds;
  }
  return edl;
}
