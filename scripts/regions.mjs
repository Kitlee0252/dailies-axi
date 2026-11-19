const clamp = value => Math.min(1, Math.max(0, value));

export function pickRect(start, end, width, height, isClick = false) {
  const x = clamp(start.x), y = clamp(start.y);
  const endX = clamp(end.x), endY = clamp(end.y);
  if (isClick || (start.x === end.x && start.y === end.y)) {
    const boxWidth = Math.min(1, 32 / width), boxHeight = Math.min(1, 32 / height);
    return { x: Math.min(1 - boxWidth, Math.max(0, x - boxWidth / 2)),
      y: Math.min(1 - boxHeight, Math.max(0, y - boxHeight / 2)), width: boxWidth, height: boxHeight };
  }
  return { x: Math.min(x, endX), y: Math.min(y, endY),
    width: Math.abs(x - endX), height: Math.abs(y - endY) };
}

export function intersects(first, second) {
  return first.width > 0 && first.height > 0 && second.width > 0 && second.height > 0 &&
    first.x < second.x + second.width && second.x < first.x + first.width &&
    first.y < second.y + second.height && second.y < first.y + first.height;
}

export function frameAt(seconds, fps, count) {
  return Math.max(0, Math.min(count - 1, Math.floor(seconds * fps + 1e-8)));
}
