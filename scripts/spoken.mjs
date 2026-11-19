// Adapted from framejam src/core/feedback.ts (AROUND and transcript overlap).
// https://github.com/moritzkremb/framejam/blob/bc45364aff90ba931d350e931291940fdc6e604c/src/core/feedback.ts
// MIT License, Copyright (c) 2026 Moritz Kremb. See third_party/framejam/LICENSE.
// Changes: source-time spans, neighboring sentences and whole-video notes.
import { wordsBetween } from './transcript.mjs';

const AROUND = 1;

export function transcriptCues(transcript) {
  if (!transcript?.words.length) return [];
  const breaks = new Set(transcript.paragraphs);
  const cues = [];
  let cue;
  for (const [i, word] of transcript.words.entries()) {
    if (!cue || breaks.has(i) || /[.!?…。！？]["'”’）)]*$/.test(cue.words.at(-1)?.text) ||
        word.start - cue.end > .25) {
      cue = { start: word.start, end: word.end, words: [] };
      cues.push(cue);
    }
    cue.words.push(word);
    cue.end = Math.max(cue.end, word.end);
  }
  return cues;
}

export function spokenAround(transcript, seconds) {
  const cues = transcriptCues(transcript);
  const first = cues.findIndex(cue => cue.end > seconds - AROUND);
  if (first < 0) return cues.at(-1)?.words.map(word => word.text).join(' ');
  let last = first;
  while (last + 1 < cues.length && cues[last + 1].start < seconds + AROUND) last++;
  const start = Math.max(0, first - 1);
  const end = cues[first].start > seconds + AROUND ? first + 1 : last + 2;
  return cues.slice(start, end).flatMap(cue => cue.words.map(word => word.text)).join(' ');
}

export function withSpoken(note, spans, transcripts) {
  const source = spans.map(span => ({ ...span,
    ...(note.kind === 'pin'
      ? { spoken_around: spokenAround(transcripts[span.asset], span.source_seconds) }
      : { spoken: wordsBetween(transcripts[span.asset], span.source_seconds, span.source_end_seconds) }),
  }));
  const field = note.kind === 'pin' ? 'spoken_around' : 'spoken';
  const quotes = [...new Set(source.map(span => span[field]).filter(Boolean))];
  return { ...note, source, ...(quotes.length ? { [field]: quotes.join(' / ') } : {}) };
}
