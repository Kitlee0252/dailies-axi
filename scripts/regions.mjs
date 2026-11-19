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

export function frameMidpoint(frame, fps) {
  return (frame + .5) / fps;
}

// Coordinates share the same viewport. CSS scale/translation is recovered from the
// ratio of the painted element bounds to its untransformed content box.
export function rectInSource(rect, box, width, height, fit, position, layout = box) {
  if (!intersects(rect, box) || !(width > 0 && height > 0)) return null;
  const contain = Math.min(layout.width / width, layout.height / height);
  const cover = Math.max(layout.width / width, layout.height / height);
  const scale = { contain, cover, none: 1, 'scale-down': Math.min(1, contain) }[fit];
  const paintedWidth = scale === undefined ? box.width : width * scale * box.width / layout.width;
  const paintedHeight = scale === undefined ? box.height : height * scale * box.height / layout.height;
  const [horizontal, vertical] = position.split(/\s+/);
  const offset = (token, free, magnification) => {
    if (token?.endsWith('%')) return parseFloat(token) / 100 * free;
    if (token?.endsWith('px')) return parseFloat(token) * magnification;
    return free / 2;
  };
  const left = box.x + offset(horizontal, box.width - paintedWidth, box.width / layout.width);
  const top = box.y + offset(vertical, box.height - paintedHeight, box.height / layout.height);
  const x = clamp((Math.max(rect.x, box.x) - left) / paintedWidth);
  const y = clamp((Math.max(rect.y, box.y) - top) / paintedHeight);
  const right = clamp((Math.min(rect.x + rect.width, box.x + box.width) - left) / paintedWidth);
  const bottom = clamp((Math.min(rect.y + rect.height, box.y + box.height) - top) / paintedHeight);
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
}
