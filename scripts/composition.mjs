import { parse, serialize } from 'parse5';
import { dirname, isAbsolute, resolve } from 'node:path';

function* elements(node) {
  if (node.tagName) yield node;
  for (const child of node.childNodes ?? []) yield* elements(child);
}

export const attribute = (node, name) => node.attrs.find(attr => attr.name === name)?.value;
export const proxyPath = id => `media/${id}.mp4`;
const originalAttribute = node => {
  if (attribute(node, 'data-review-source') !== undefined) return 'data-review-source';
  const src = attribute(node, 'src');
  if (src !== undefined && src !== proxyPath(attribute(node, 'data-review-clip'))) return 'src';
};
export const referencesOriginal = node => originalAttribute(node) !== undefined;
const label = node => attribute(node, 'id') ? `#${attribute(node, 'id')}` : `<${node.tagName}>`;

export function parseComposition(html) {
  const document = parse(html);
  const root = [...elements(document)].find(node => attribute(node, 'data-composition-id') !== undefined);
  if (!root) throw new Error('Missing the HyperFrames composition root');
  const fps = Number(attribute(root, 'data-fps'));
  if (!(fps > 0 && Number.isFinite(fps))) throw new Error('Composition needs a numeric data-fps');
  const nodes = [...elements(root)];
  return { document, root, fps, nodes, videos: nodes.filter(node => node.tagName === 'video') };
}

function setAttribute(node, name, value) {
  const attr = node.attrs.find(attr => attr.name === name);
  if (attr) attr.value = value;
  else node.attrs.push({ name, value });
}

function removeAttribute(node, name) {
  node.attrs = node.attrs.filter(attr => attr.name !== name);
}

export function frameTiming(node, key, fps, fallback) {
  const value = attribute(node, key);
  const frameValue = attribute(node, `${key}-frame`);
  const name = `${label(node)} ${key}`;
  let secondsFrame;
  if (value !== undefined) {
    const position = Number(value) * fps;
    secondsFrame = Math.round(position);
    if (!value.trim() || position < 0 || !Number.isSafeInteger(secondsFrame) ||
        Math.abs(position - secondsFrame) > 1e-5) {
      const nearest = Number.isSafeInteger(secondsFrame) && secondsFrame >= 0 && value.trim()
        ? `; nearest is F${secondsFrame} (${secondsFrame / fps} s)` : '';
      throw new Error(`${name} must land on a frame boundary at ${fps} fps${nearest}`);
    }
  }
  if (frameValue === undefined) {
    if (secondsFrame !== undefined || fallback !== undefined) return secondsFrame ?? fallback;
    throw new Error(`${name} or ${key}-frame is required`);
  }
  const frame = Number(frameValue);
  if (!/^\d+$/.test(frameValue) || !Number.isSafeInteger(frame)) {
    throw new Error(`${name}-frame must be a non-negative integer`);
  }
  if (secondsFrame !== undefined && secondsFrame !== frame) {
    throw new Error(`${name} and ${key}-frame disagree: F${secondsFrame} vs F${frame}`);
  }
  return frame;
}

export function normalizeComposition(html, composition) {
  let changed = false;
  for (const node of composition.nodes) {
    for (const key of ['data-start', 'data-duration', 'data-media-start']) {
      const value = attribute(node, key);
      const hasFrame = attribute(node, `${key}-frame`) !== undefined;
      // HyperFrames also accepts timing expressions on other elements.
      if (!hasFrame && (value === undefined || !Number.isFinite(Number(value)))) continue;
      const exact = String(frameTiming(node, key, composition.fps) / composition.fps);
      if (exact !== value || hasFrame) {
        setAttribute(node, key, exact);
        removeAttribute(node, `${key}-frame`);
        changed = true;
      }
    }
  }
  for (const node of composition.videos) {
    if (!referencesOriginal(node)) continue;
    setAttribute(node, 'src', proxyPath(attribute(node, 'data-review-clip')));
    removeAttribute(node, 'data-review-source');
    changed = true;
  }
  return changed ? serialize(composition.document) : html;
}

export function compositionSources(composition, file) {
  const sources = new Map();
  for (const node of composition.videos) {
    const id = attribute(node, 'data-review-clip');
    if (!/^[a-zA-Z0-9][\w-]*$/.test(id ?? '')) throw new Error(`${label(node)} needs a valid data-review-clip`);
    const key = originalAttribute(node);
    const source = key && attribute(node, key);
    if (!sources.has(id)) sources.set(id, undefined);
    if (source === undefined) continue;
    if (!source.trim() || /^[a-z][a-z\d+.-]*:/i.test(source) || source.startsWith('//')) {
      throw new Error(`${label(node)} needs a local file path in ${key}`);
    }
    const original = resolve(dirname(file), source);
    if (sources.get(id) && sources.get(id) !== original) {
      throw new Error(`Asset ${id} references multiple originals; give each original a distinct asset ID`);
    }
    sources.set(id, original);
  }
  return sources;
}

export function relocateComposition(html, composition, file) {
  let changed = false;
  for (const node of composition.videos) {
    const key = originalAttribute(node);
    if (!key) continue;
    const source = attribute(node, key);
    if (isAbsolute(source)) continue;
    setAttribute(node, key, resolve(dirname(file), source));
    changed = true;
  }
  return changed ? serialize(composition.document) : html;
}
