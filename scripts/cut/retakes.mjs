// Adapted from FrameJam playbooks/clean-cut/scripts/find_retakes.py (MIT).
// Copyright 2026 Moritz Kremb. See THIRD_PARTY_NOTICES.md.
import { edlSegments, locateAnchor } from './model.mjs';
import { overlaps } from './ranges.mjs';
import { snapBoundary } from './operations.mjs';

const normalize = text => text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{M}\p{N}']/gu, '');

export function replacementCandidates(reviewed, edl, assets, analysis) {
  // FrameJam detects repeats by sliding normalized word windows, including
  // three-word possible restarts. Compare those seeds across takes too.
  const transcripts = Object.fromEntries(Object.entries(analysis).map(([asset, data]) =>
    [asset, (data.speech?.words ?? []).map(word => ({ ...word, token: normalize(word.text) }))]));
  const seeds = new Map();
  const before = edlSegments(edl);
  const key = (words, i) => {
    const tokens = words.slice(i, i + 3).map(word => word.token);
    return tokens.length === 3 && tokens.every(Boolean) ? tokens.join(' ') : null;
  };
  for (const [asset, words] of Object.entries(transcripts)) {
    for (let i = 0; i + 2 < words.length; i++) {
      const phrase = key(words, i);
      if (!phrase) continue;
      if (!seeds.has(phrase)) seeds.set(phrase, []);
      seeds.get(phrase).push({ asset, i });
    }
  }
  function snapped(asset, words, first, end) {
    try {
      const range = [Math.floor(words[first].start * edl.fps), Math.ceil(words[end - 1].end * edl.fps)]
        .map(frame => snapBoundary(frame, assets[asset], analysis[asset]));
      return range[0] >= 0 && range[0] < range[1] && range[1] <= assets[asset].frame_count ? { asset, range } : null;
    } catch {
      return null;
    }
  }
  const matches = new Map();
  for (const { asset, range } of reviewed) {
    const words = transcripts[asset] ?? [];
    const first = words.findIndex(word => word.end * edl.fps > range[0]);
    if (first < 0) continue;
    let end = first;
    while (words[end]?.start * edl.fps < range[1]) end++;
    if (end === first) continue;
    const lastSeed = Math.max(first, end - 3);
    for (let i = Math.max(0, first - (end - first < 3 ? 2 : 0)); i <= lastSeed; i++) {
      const start = Math.min(first, i);
      const stop = Math.max(end, i + 3);
      const target = words[stop - 1] && snapped(asset, words, start, stop);
      if (!target || !locateAnchor(before, target)) continue;
      for (const hit of seeds.get(key(words, i)) ?? []) {
        const other = transcripts[hit.asset];
        const offset = hit.i - i;
        const aligned = words.slice(start, stop);
        if (!aligned.every((word, j) => word.token && word.token === other[start + offset + j]?.token)) continue;
        const alternate = snapped(hit.asset, other, start + offset, stop + offset);
        if (!alternate || before.some(segment => segment.asset === alternate.asset && overlaps(segment.range, alternate.range))) continue;
        const id = JSON.stringify([target, alternate]);
        matches.set(id, { target, with: alternate, phrase: aligned.map(word => word.text).join(' ') });
      }
    }
  }
  return [...matches.values()].slice(0, 8);
}
