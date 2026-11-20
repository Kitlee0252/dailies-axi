import { mkdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { writeJson } from '../manifest.mjs';
import { extractFrame, waveform } from './media.mjs';
import { reviewedSpans, schema } from './model.mjs';
import { snapBoundary } from './operations.mjs';

export async function makePlan({ workspace, media, version, edl, notes, assets, analysis, brief, batch, learningPlan }) {
  const dir = join(workspace, 'cut-plans', version);
  const evidence = join(dir, 'evidence');
  await mkdir(evidence, { recursive: true, mode: 0o700 });
  const entries = [];
  function candidate(frame, asset) {
    try {
      return { requested: frame, frame: snapBoundary(frame, assets[asset], analysis[asset]) };
    } catch (error) {
      return { requested: frame, blocked: error.message };
    }
  }
  for (const [i, note] of notes.entries()) {
    const spans = reviewedSpans(edl, note).map(({ asset, range }) => ({ asset, range,
      ...(note.whole_video ? {} : { boundary_candidates: range.map(frame => candidate(frame, asset)) }) }));
    const files = [];
    if (!note.whole_video) {
      for (const [j, { asset, range }] of spans.entries()) {
        const source = join(media, `${asset}.mp4`);
        const half = Math.round(edl.fps / 2);
        const start = Math.max(0, range[0] - half);
        const end = Math.min(assets[asset].frame_count, range[1] + half);
        for (const frame of new Set([start, range[0], range[1] - 1, end - 1])) {
          const output = join(evidence, `note-${i + 1}-${j + 1}-f${frame}.jpg`);
          await extractFrame(source, frame, output);
          files.push({ asset, frame, file: relative(dir, output) });
        }
        if (assets[asset].audio) {
          const output = join(evidence, `note-${i + 1}-${j + 1}-waveform.png`);
          await waveform(source, start / edl.fps, (end - start) / edl.fps, output);
          files.push({ asset, range: [start, end], waveform: relative(dir, output) });
        }
      }
    }
    const { id, text, kind, spoken, spoken_around, rect } = note;
    entries.push({ id, text, kind, spoken, spoken_around, rect, source: spans, evidence: files });
  }
  const file = join(dir, 'ops.draft.json');
  const languages = [...new Set(Object.values(analysis).map(item => item.speech?.language).filter(Boolean))];
  await writeJson(file, { schema_version: schema, from: version, batch, brief,
    language: languages.length === 1 ? languages[0] : 'zh', notes: entries, ops: [],
    ...(learningPlan ? { learning: { params_version: learningPlan.params_version, entries: learningPlan.entries } } : {}) });
  return { file, evidence, notes: entries.length };
}
