import { length, overlaps, subtract } from './ranges.mjs';

export const attributeCutSchema = 2;
const bounded = (value, min, max) => Number.isFinite(value) && value >= min && value <= max;

export function attributeValue(kind, input) {
  if (kind === 'audio') {
    const { gain_db, mute, fade_in, fade_out } = input;
    if ((gain_db === undefined && mute === undefined && fade_in === undefined && fade_out === undefined) ||
        (gain_db !== undefined && !bounded(gain_db, -60, 12)) ||
        (mute !== undefined && typeof mute !== 'boolean') ||
        [fade_in, fade_out].some(fade => fade !== undefined && (!Number.isFinite(fade) || fade < 0))) {
      throw new Error('Audio needs gain_db between -60 and 12, boolean mute, or nonnegative fade seconds');
    }
    return Object.fromEntries(Object.entries({ gain_db, mute, fade_in, fade_out }).filter(([, value]) => value !== undefined));
  }
  const { scale, x, y } = input;
  if (kind !== 'reframe' || !Number.isFinite(scale) || scale < 1 || !bounded(x, 0, 1) || !bounded(y, 0, 1)) {
    throw new Error('Reframe needs scale ≥ 1 and normalized x/y within [0, 1] to fill the output');
  }
  return { scale, x, y };
}

export function updateAttributes(attributes, next) {
  const { kind, anchor } = next;
  return [...attributes.flatMap(item =>
    item.kind === kind && item.anchor.asset === anchor.asset
      ? subtract(item.anchor.range, [anchor.range]).map(range => ({ ...item, anchor: { asset: anchor.asset, range } }))
      : [item]), next];
}

export function splitByAttributes(segments, attributes, allocateId) {
  return segments.flatMap(segment => {
    const [start, end] = segment.range;
    const boundaries = [...new Set(attributes.filter(item => item.anchor.asset === segment.asset)
      .flatMap(item => item.anchor.range).filter(frame => start < frame && frame < end))].sort((a, b) => a - b);
    return [...boundaries, end].map((stop, i) => {
      const begin = boundaries[i - 1] ?? start;
      return { ...segment, range: [begin, stop], clip: i ? allocateId(segment.clip, begin) : segment.clip };
    });
  });
}

export function attributesFor(cut, segment) {
  return Object.fromEntries((cut.attributes ?? []).filter(({ anchor }) => anchor.asset === segment.asset &&
    overlaps(anchor.range, segment.range)).map(item => [item.kind, item]));
}

export function nativeAudio(audio, range, fps, splice = {}) {
  const { gain_db = 0, mute = false } = audio;
  const fade_in = Math.max(audio.fade_in ?? 0, splice.fade_in ?? 0);
  const fade_out = Math.max(audio.fade_out ?? 0, splice.fade_out ?? 0);
  const duration = length(range) / fps;
  const factor = fade_in + fade_out > duration ? duration / (fade_in + fade_out) : 1;
  return { 'data-volume': mute ? 0 : 10 ** (gain_db / 20),
    'data-fade-in': fade_in * factor, 'data-fade-out': fade_out * factor };
}

export function reframeRect({ scale, x, y }, asset, composition) {
  const source = asset.width / asset.height;
  const output = composition.width / composition.height;
  if (![source, output].every(ratio => Number.isFinite(ratio) && ratio > 0)) {
    throw new Error('Reframe requires source and composition width and height');
  }
  const width = Math.min(1, output / source) / scale;
  const height = Math.min(1, source / output) / scale;
  if (width * asset.width < 1 || height * asset.height < 1) {
    throw new Error('Reframe scale would crop to less than one source pixel');
  }
  return { x: x * (1 - width), y: y * (1 - height), width, height };
}

const percent = ratio => `${Number((ratio * 100).toFixed(9))}%`;

export function reframeStyle({ x, y, width, height }) {
  const clip = [y, Math.max(0, 1 - x - width), Math.max(0, 1 - y - height), x].map(percent).join(' ');
  return 'position:absolute!important;inset:auto!important;' +
    `left:${percent(-x / width)}!important;top:${percent(-y / height)}!important;` +
    `width:${percent(1 / width)}!important;height:${percent(1 / height)}!important;` +
    'box-sizing:border-box!important;max-width:none!important;max-height:none!important;' +
    'padding:0!important;border:0!important;margin:0!important;transform:none!important;object-fit:fill!important;' +
    `clip-path:inset(${clip})!important;`;
}

const minSpliceFade = .03;
const spliceKey = (left, right) => JSON.stringify([left.asset, left.range[1], right.asset, right.range[0]]);
const sourcePairs = segments => segments.slice(1).map((right, i) => [segments[i], right]);

export function planSpliceFades(cut, footage, changes, assets, analysis, ordinary) {
  const inherited = new Map((cut.splice_fades ?? []).map(item => [item.key, item]));
  const ordinaryJoins = new Set(ordinary ? sourcePairs(ordinary).map(pair => spliceKey(...pair)) : []);
  const reviewedJoins = new Set(sourcePairs(cut.segments).map(pair => spliceKey(...pair)));
  const audioEdits = changes.filter(item => item.attribute?.kind === 'audio').map(item => item.attribute.anchor);
  function quiet(segment, edge) {
    if (!assets[segment.asset].audio) return true;
    const data = analysis[segment.asset];
    const t = segment.range[edge] / footage.fps;
    const side = edge ? [t - .01, t] : [t, t + .01];
    const silences = data.silence_seconds ?? data.silences.map(range => range.map(frame => frame / footage.fps));
    return silences.some(([start, end]) => start <= side[0] && side[1] <= end);
  }
  function level(segment, fade) {
    if (!assets[segment.asset].audio) return 0;
    const { audio } = attributesFor(footage, segment);
    return audio?.mute || audio?.[fade] ? 0 : 10 ** ((audio?.gain_db ?? 0) / 20);
  }
  return sourcePairs(footage.segments).flatMap(([left, right]) => {
    const key = spliceKey(left, right);
    if (left.asset === right.asset && left.range[1] === right.range[0] && !audioEdits.length) {
      return inherited.has(key) ? [inherited.get(key)] : [];
    }
    const sequence = ordinary && !ordinaryJoins.has(key) && !reviewedJoins.has(key);
    const audioEdited = audioEdits.some(anchor => [left, right].some(segment =>
      segment.asset === anchor.asset && overlaps(segment.range, anchor.range)));
    if (!sequence && !audioEdited) return inherited.has(key) ? [inherited.get(key)] : [];
    const out = level(left, 'fade_out');
    const input = level(right, 'fade_in');
    if (!(sequence || inherited.get(key)?.sequence || out !== input) || (quiet(left, 1) && quiet(right, 0))) return [];
    if (!out && !input) return inherited.has(key) ? [inherited.get(key)] : [];
    return [{ key, sequence: Boolean(sequence || inherited.get(key)?.sequence), out: out > 0, in: input > 0 }];
  });
}

export function spliceTreatments(cut) {
  const planned = new Map((cut.splice_fades ?? []).map(item => [item.key, item]));
  const clips = new Map();
  const joins = [];
  let frame = 0;
  for (const [left, right] of sourcePairs(cut.segments)) {
    frame += length(left.range);
    const item = planned.get(spliceKey(left, right));
    if (!item) continue;
    if (item.out) clips.set(left.clip, { ...clips.get(left.clip), fade_out: minSpliceFade });
    if (item.in) clips.set(right.clip, { ...clips.get(right.clip), fade_in: minSpliceFade });
    joins.push({ frame, sequence: item.sequence });
  }
  return { clips, joins };
}
