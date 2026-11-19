// Adapted from framejam src/core/feedback.ts (formatTime, commentAt, describePosition, feedbackPrompt).
// https://github.com/moritzkremb/framejam/blob/bc45364aff90ba931d350e931291940fdc6e604c/src/core/feedback.ts
// MIT License, Copyright (c) 2026 Moritz Kremb. See third_party/framejam/LICENSE.
// Changes: live frame/range labels, rectangle centers, Lavish delivery and source-frame data.

export function formatTime(seconds) {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${m}:${rest.toFixed(2).padStart(5, '0')}`;
}

export function commentAt(c) {
  if (c.whole_video) return 'whole video';
  return c.end_frame !== undefined ? `F${c.frame}–F${c.end_frame} (end excluded)`
    : `F${c.frame} · ${formatTime(c.time_seconds)}`;
}

export function describePosition(x, y, of = 'frame') {
  const col = x < 0.33 ? 'left' : x > 0.66 ? 'right' : 'center';
  const row = y < 0.33 ? 'top' : y > 0.66 ? 'bottom' : 'middle';
  const where = row === 'middle' && col === 'center' ? 'center' : `${row} ${col}`;
  return `${where} of ${of} (${Math.round(x * 100)}% from left, ${Math.round(y * 100)}% from top)`;
}

export function sortNotes(comments) {
  return [...comments].sort((a, b) => Number(!!b.whole_video) - Number(!!a.whole_video) || a.frame - b.frame);
}

export function feedbackPrompt(version, comments) {
  const lines = [`# Video feedback (${version})`, '',
    `Please make these ${comments.length} change${comments.length === 1 ? '' : 's'}:`, ''];
  for (const [i, c] of sortNotes(comments).entries()) {
    lines.push(`${i + 1}. **[${commentAt(c)}]** ${c.text}`);
    if (c.rect) lines.push(`  - Region centered at ${describePosition(c.rect.x + c.rect.width / 2, c.rect.y + c.rect.height / 2)}`);
    if (c.spoken) lines.push(`  - Spoken in this range: “${c.spoken}”`);
    if (c.spoken_around) lines.push(`  - Spoken around then: “${c.spoken_around}”`);
    lines.push(`  - Comment id: \`${c.id}\``);
  }
  lines.push('', 'Use the version EDL and source frames in the context data when editing footage. Build the next version with a summary and the outcomes for this round.');
  return lines.join('\n');
}
