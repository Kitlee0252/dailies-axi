// Half-open integer frame intervals, always on one axis.
export const overlaps = ([a, b], [c, d]) => a < d && c < b;
export const intersection = (a, b) => overlaps(a, b)
  ? [Math.max(a[0], b[0]), Math.min(a[1], b[1])] : null;
export const length = ([start, end]) => end - start;

export function union(ranges) {
  const result = [];
  for (const [start, end] of [...ranges].sort((a, b) => a[0] - b[0])) {
    const last = result.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(end, last[1]);
    else if (start < end) result.push([start, end]);
  }
  return result;
}

export function subtract(range, removals) {
  const kept = [];
  let cursor = range[0];
  for (const [start, end] of removals) {
    if (end <= cursor) continue;
    if (start >= range[1]) break;
    if (start > cursor) kept.push([cursor, start]);
    cursor = Math.max(cursor, end);
  }
  if (cursor < range[1]) kept.push([cursor, range[1]]);
  return kept;
}

export function byAsset(spans) {
  const grouped = new Map();
  for (const { asset, range } of spans) {
    if (!grouped.has(asset)) grouped.set(asset, []);
    grouped.get(asset).push(range);
  }
  return new Map([...grouped].map(([asset, ranges]) => [asset, union(ranges)]));
}

export function difference(before, after) {
  const remaining = byAsset(after);
  return [...byAsset(before)].flatMap(([asset, ranges]) =>
    ranges.flatMap(range => subtract(range, remaining.get(asset) ?? []).map(range => ({ asset, range }))));
}
