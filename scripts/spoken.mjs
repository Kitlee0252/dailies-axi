// Adapted from framejam src/core/feedback.ts (AROUND and transcript overlap).
// https://github.com/moritzkremb/framejam/blob/bc45364aff90ba931d350e931291940fdc6e604c/src/core/feedback.ts
// MIT License, Copyright (c) 2026 Moritz Kremb. See third_party/framejam/LICENSE.
// Changes: source-time spans, neighboring sentences, whole-video notes and unspaced scripts.
import { joinWords, wordsBetween } from './transcript.mjs';

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
  if (!transcript?.words.length) return undefined;
  const cues = transcriptCues(transcript);
  const first = cues.findIndex(cue => cue.end > seconds - AROUND);
  if (first < 0) return cues.length ? joinWords(cues.at(-1).words.map(word => word.text)) : undefined;
  let last = first;
  while (last + 1 < cues.length && cues[last + 1].start < seconds + AROUND) last++;
  const start = Math.max(0, first - 1);
  const end = cues[first].start > seconds + AROUND ? first + 1 : last + 2;
  return joinWords(cues.slice(start, end).flatMap(cue => cue.words.map(word => word.text)));
}

// Words in the order this version plays them, timed in composition seconds.
// Speech trimmed out of the edit is left out, and each cut starts a new cue.
// Any overlap counts, as in wordsBetween, because Whisper word times are approximate.
export function playedTranscript(edl, transcripts) {
  const words = [], paragraphs = [];
  for (const segment of edl.segments) {
    const offset = segment.start_frame / edl.fps - segment.source_in_seconds;
    const kept = (transcripts[segment.asset]?.words ?? []).filter(word =>
      word.end > segment.source_in_seconds && word.start < segment.source_out_seconds);
    if (kept.length) paragraphs.push(words.length);
    words.push(...kept.map(word => ({ text: word.text, start: word.start + offset, end: word.end + offset })));
  }
  return { words, paragraphs };
}

export function withSpoken(note, spans, transcripts, edl) {
  const source = spans.map(span => ({ ...span,
    ...(note.kind === 'pin'
      ? { spoken_around: spokenAround(transcripts[span.asset], span.source_seconds) }
      : { spoken: wordsBetween(transcripts[span.asset], span.source_seconds, span.source_end_seconds) }),
  }));
  const field = note.kind === 'pin' ? 'spoken_around' : 'spoken';
  let quote;
  if (edl) {
    // The note-level quote is what the reviewer heard in this version.
    const played = playedTranscript(edl, transcripts);
    quote = note.kind === 'pin' ? spokenAround(played, note.frame / edl.fps)
      : wordsBetween(played, note.frame / edl.fps, (note.end_frame ?? note.frame + 1) / edl.fps);
  } else {
    quote = [...new Set(source.map(span => span[field]).filter(Boolean))].join(' / ');
  }
  return { ...note, source, ...(quote ? { [field]: quote } : {}) };
}
