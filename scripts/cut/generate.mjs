import { attribute, parseComposition, proxyPath } from '../composition.mjs';
import { locateAnchor, placed } from './model.mjs';
import { length } from './ranges.mjs';

const segmentStart = '<!-- dailies-cut:segments -->';
const segmentEnd = '<!-- /dailies-cut:segments -->';
const overlayStart = '<!-- dailies-cut:overlays -->';
const overlayEnd = '<!-- /dailies-cut:overlays -->';
const esc = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
const managedVideo = /^(id|src|data-review-(clip|source)|data-(start|duration|media-start)(-frame)?)$/;
const percent = n => `${n * 100}%`;

function regionMatches(html, start, end) {
  const spans = [];
  let cursor = 0;
  for (;;) {
    const a = html.indexOf(start, cursor);
    const b = html.indexOf(end, cursor);
    if (a === -1 && b === -1) return spans;
    const next = html.indexOf(start, a + start.length);
    if (a === -1 || b < a || (next !== -1 && next < b)) throw new Error('Malformed dailies-cut markers');
    cursor = b + end.length;
    spans.push({ startOffset: a, endOffset: cursor });
  }
}

function serializeVideo(node, segment, assets) {
  const { clip, asset, range, output } = segment;
  const attrs = Object.fromEntries(node.attrs.filter(attr => !managedVideo.test(attr.name))
    .map(({ name, value }) => [name, value]));
  if (!Object.hasOwn(attrs, 'data-has-audio') && !Object.hasOwn(attrs, 'muted')) {
    if (assets[asset].audio) attrs['data-has-audio'] = 'true';
    else attrs.muted = '';
  }
  return '<video ' + Object.entries({ ...attrs, id: clip, src: proxyPath(asset), 'data-review-clip': asset,
    'data-start-frame': output[0], 'data-duration-frame': length(range), 'data-media-start-frame': range[0] })
    .map(([key, value]) => `${key}="${esc(value)}"`).join(' ') + '></video>';
}

function serializeOverlay(overlay, segments, nodes, html) {
  const output = locateAnchor(segments, overlay.anchor);
  if (!output) return '';
  const { element, text, template, rect: { x, y, width, height } } = overlay;
  let content = esc(text ?? '');
  if (template) {
    const node = nodes.find(node => node.tagName === 'template' && attribute(node, 'id') === template);
    if (!node?.sourceCodeLocation?.endTag) throw new Error(`Missing overlay template #${template}`);
    const { startTag, endTag } = node.sourceCodeLocation;
    content = html.slice(startTag.endOffset, endTag.startOffset);
  }
  const layout = `position:absolute;left:${percent(x)};top:${percent(y)};width:${percent(width)};height:${percent(height)};z-index:1000;`;
  const style = template ? layout : layout + 'display:flex;align-items:center;justify-content:center;color:white;' +
    'font:700 clamp(12px,4vw,80px) sans-serif;text-shadow:0 1px 4px black;';
  return `<div id="${element}" class="clip dailies-cut-overlay" data-dailies-cut-overlay="" data-track-index="1000" data-start-frame="${output[0]}" data-duration-frame="${length(output)}" style="${style}">${content}</div>`;
}

export function alignComposition(html, cut, assets) {
  const { root, videos, fps, nodes } = parseComposition(html, { sourceCodeLocationInfo: true });
  if (fps !== cut.fps) throw new Error('Composition frame rate changed after review');
  const segments = placed(cut.segments);
  const slots = regionMatches(html, segmentStart, segmentEnd).map(location => ({ location, rendered: [] }));
  const overlays = regionMatches(html, overlayStart, overlayEnd);
  if (overlays.length > 1) throw new Error('Expected a single managed overlay region');
  const { startTag, endTag } = root.sourceCodeLocation;
  if (!endTag) throw new Error('Composition root requires a closing tag');
  function templateFor(node) {
    const location = node.sourceCodeLocation;
    if (!location?.endTag) throw new Error('Managed video requires a closing tag');
    let slot = slots.find(slot => location.startOffset >= slot.location.startOffset &&
      location.endOffset <= slot.location.endOffset);
    if (!slot) {
      slot = { location, rendered: [] };
      slots.push(slot);
    }
    return { node, slot, id: attribute(node, 'id') };
  }
  const templates = videos.map(templateFor).sort((a, b) => b.id.length - a.id.length);
  for (const segment of segments) {
    const template = templates.find(({ id }) => segment.clip === id || segment.clip.startsWith(`${id}--f`));
    if (!template) throw new Error(`Missing video template for ${segment.clip}`);
    template.slot.rendered.push(serializeVideo(template.node, segment, assets));
  }
  const authoredIds = new Set(nodes.filter(node => attribute(node, 'data-dailies-cut-overlay') === undefined)
    .map(node => attribute(node, 'id')));
  const clipIds = new Set(segments.map(segment => segment.clip));
  const renderedOverlays = cut.overlays.map(overlay => {
    if (authoredIds.has(overlay.element) || clipIds.has(overlay.element)) {
      throw new Error(`Overlay ID conflicts with authored #${overlay.element}`);
    }
    return serializeOverlay(overlay, cut.segments, nodes, html);
  }).filter(Boolean);
  const total = segments.at(-1).output[1];
  // Replace only the duration attributes on the opening tag. The seconds value
  // remains available to authored timelines using dataset.duration.
  const tag = html.slice(startTag.startOffset, startTag.endOffset);
  const rewrittenTag = Object.entries(startTag.attrs).filter(([name]) =>
    name === 'data-duration' || name === 'data-duration-frame').map(([, location]) => location)
    .sort((a, b) => b.startOffset - a.startOffset).reduce((value, location) =>
      value.slice(0, location.startOffset - startTag.startOffset) + value.slice(location.endOffset - startTag.startOffset), tag);
  const edits = [
    ...slots.map(({ location, rendered }) => [location, [segmentStart, ...rendered, segmentEnd].join('\n')]),
    [startTag, rewrittenTag.replace(/\s*>$/, ` data-duration="${total / fps}" data-duration-frame="${total}">`)],
    [overlays[0] ?? { startOffset: endTag.startOffset, endOffset: endTag.startOffset },
      [overlayStart, ...renderedOverlays, overlayEnd].join('\n')],
  ];
  for (const [location, replacement] of edits.sort(([a], [b]) => b.startOffset - a.startOffset)) {
    html = html.slice(0, location.startOffset) + replacement + html.slice(location.endOffset);
  }
  return html;
}
