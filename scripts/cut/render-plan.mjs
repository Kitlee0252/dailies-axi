import { union } from './ranges.mjs';

export function renderPlan(frameCount, fps, splices, overlays, mode) {
  if (frameCount / fps <= 180 || mode === 'full') return [[0, frameCount]];
  if (mode !== 'windows') {
    throw new Error('This edit is over 3 minutes. Ask whether to render fully; use --render for full or --windows for localized verification.');
  }
  const pad = Math.ceil(fps * 2);
  const context = [...splices.map(frame => [frame, frame]), ...overlays];
  if (!context.length) context.push([0, 0], [frameCount, frameCount]);
  return union(context.map(([a, b]) => [Math.max(0, a - pad), Math.min(frameCount, b + pad)]));
}
