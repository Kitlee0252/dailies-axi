// Adapted from framejam src/server/json-store.ts (addComment and submit).
// https://github.com/moritzkremb/framejam/blob/bc45364aff90ba931d350e931291940fdc6e604c/src/server/json-store.ts
// MIT License, Copyright (c) 2026 Moritz Kremb. See third_party/framejam/LICENSE.
// Changes: one batch per Lavish version, committed to disk by the poll wrapper.
import { randomUUID } from 'node:crypto';
import { link, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { mapInterval } from './edl.mjs';
import { readManifest, writeJson } from './manifest.mjs';
import { correctTranscript, withSpoken } from './spoken.mjs';

export async function projectState(folder, file, state) {
  const path = join(folder, file);
  const temp = `${path}.${randomUUID()}.tmp`;
  // Lavish's opaque-origin iframe can load classic scripts, while JSON fetches
  // from its local static asset route are blocked by CORS.
  await writeFile(temp, `window.reviewState(${JSON.stringify(state)});\n`);
  await rename(temp, path);
}

export async function readNotes(folder) {
  try {
    return JSON.parse(await readFile(join(folder, 'notes.json'), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return null;
  }
}

export const supportedNotes = record => [2, 3].includes(record?.schema_version);
export const notesState = record => ({ notes: record?.notes ?? null, sentAt: record?.sentAt,
  reviewer: record?.reviewer, reactions: record?.reactions, transcript_edits: record?.transcript_edits,
  overlay_position: record?.overlay_position });

const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
const optionalJson = file => readJson(file).catch(error => {
  if (error.code !== 'ENOENT') throw error;
});

async function prepareCorrections(folder, edits) {
  const { transcript_media: media } = await readJson(join(folder, 'version.json'));
  if (typeof media !== 'string') throw new Error('This review does not support transcript corrections');
  const snapshot = join(folder, 'media');
  const { assets } = await readManifest(snapshot);
  const sources = await readManifest(media);
  const transcripts = {};
  const changes = new Map();
  for (const edit of edits) {
    if (!edit || !Object.hasOwn(assets, edit.asset) || !Object.hasOwn(sources.assets, edit.asset) ||
        sources.assets[edit.asset].source_sha256 !== assets[edit.asset].source_sha256) {
      throw new Error('Unknown or changed asset for transcript correction');
    }
    const batch = changes.get(edit.asset) ?? [];
    batch.push(edit);
    changes.set(edit.asset, batch);
  }
  const plan = [];
  for (const asset of Object.keys(assets)) {
    const name = `${asset}.transcript.json`;
    const original = await optionalJson(join(snapshot, name));
    const batch = changes.get(asset);
    const corrected = batch ? correctTranscript(original, batch) : original;
    if (corrected) transcripts[asset] = corrected;
    if (batch) plan.push({ asset, file: join(media, name), original, corrected });
  }
  return { media, assets, transcripts, plan };
}

export async function persistTranscriptEdits(folder, record) {
  if (!record?.transcript_edits?.length) return;
  const marker = join(folder, '.transcript-edits-applied.json');
  if ((await optionalJson(marker))?.batch === record.batch.id) return;
  const { media, plan } = await prepareCorrections(folder, record.transcript_edits);
  for (const { asset, file, original, corrected } of plan) {
    const lock = join(media, `.${asset}.transcribe-lock`);
    await mkdir(lock);
    try {
      const current = await optionalJson(file);
      if (isDeepStrictEqual(current, corrected)) continue;
      if (!isDeepStrictEqual(current, original)) throw new Error(`Transcript changed after this review was built: ${asset}`);
      await writeJson(file, corrected);
    } finally {
      await rm(lock, { recursive: true });
    }
  }
  await writeJson(marker, { batch: record.batch.id });
}

async function validateCapture(folder, data) {
  const review = JSON.parse(await readFile(join(folder, 'version.json'), 'utf8'));
  const reviewers = review.reviewers ?? [];
  const reviewer = data.reviewer ?? (reviewers.length === 1 ? reviewers[0].id : 'anonymous');
  const validReviewer = id => id === 'anonymous' || reviewers.some(item => item.id === id);
  if (!validReviewer(reviewer) || data.notes.some(note => note.reviewer !== undefined && !validReviewer(note.reviewer))) {
    throw new Error('Choose a reviewer from the brief');
  }
  const outcome = ref => {
    if (typeof ref !== 'string' || !review.parent || !ref.startsWith(`${review.parent}:`)) return;
    const id = ref.slice(review.parent.length + 1);
    if (Object.hasOwn(review.resolutions, id)) return review.resolutions[id];
  };
  const reactions = data.reactions ?? [];
  const seen = new Set();
  if (!Array.isArray(reactions) || reactions.some(reaction => {
    const result = outcome(reaction?.outcome);
    const choice = reaction?.choice !== undefined;
    const actor = reaction?.reviewer ?? reviewer;
    const key = `${actor}:${reaction?.outcome}:${choice ? 'choice' : 'verdict'}`;
    if (!result || !validReviewer(actor) || seen.has(key) || (choice ? reaction.verdict !== undefined ||
      !result.alternatives?.some(alt => alt.id === reaction.choice) : !['accept', 'reject'].includes(reaction.verdict))) return true;
    seen.add(key);
    return false;
  }) || data.notes.some(note => note.reopens !== undefined && !outcome(note.reopens))) {
    throw new Error('Invalid reaction, alternative or reopened note for the previous round');
  }
  return { ...data, reviewer, reactions };
}

export async function lockNotes(folder, latest, data) {
  if (data.version !== latest) throw new Error(`Version ${data.version} is not the latest; comment on ${latest}`);
  if (!supportedNotes(data) || !Array.isArray(data.notes) ||
      data.notes.some(note => !note?.id || typeof note.text !== 'string' || !note.text.trim()) ||
      new Set(data.notes.map(note => note.id)).size !== data.notes.length) {
    throw new Error('Nothing valid to send: add a note first');
  }
  if (data.schema_version === 3) data = await validateCapture(folder, data);
  const edits = data.transcript_edits ?? [];
  if (!Array.isArray(edits) || (edits.length && data.schema_version !== 3) ||
      (data.overlay_position !== undefined && (!Number.isFinite(data.overlay_position) ||
        data.overlay_position < 0 || data.overlay_position > 1))) {
    throw new Error('Invalid transcript review data');
  }
  if (!data.notes.length && (data.schema_version !== 3 || (!data.reactions.length && !edits.length))) {
    throw new Error('Nothing valid to send: add a note, reaction or transcript correction first');
  }
  if (edits.length) {
    const { assets, transcripts, plan } = await prepareCorrections(folder, edits);
    for (const { asset, file, original } of plan) {
      if (!isDeepStrictEqual(await optionalJson(file), original)) {
        throw new Error(`Transcript changed after this review was built: ${asset}`);
      }
    }
    const edl = await readJson(join(folder, 'edl.json'));
    data.notes = data.notes.map(({ source, spoken, spoken_around, ...note }) =>
      withSpoken(note, mapInterval(edl, assets, note.frame, note.end_frame ?? note.frame + 1), transcripts, edl));
  }
  const createdAt = new Date().toISOString();
  const batch = { id: randomUUID(), createdAt, commentIds: data.notes.map(note => note.id) };
  const record = { ...data, sentAt: createdAt, batch, notes: data.notes.map(note => ({
    ...note, status: 'sent', sentAt: createdAt, batchId: batch.id,
  })) };
  const file = join(folder, 'notes.json');
  const temp = `${file}.${batch.id}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(record, null, 2) + '\n', { flag: 'wx', mode: 0o400 });
    // Publish the full file atomically without overwriting any prior round.
    await link(temp, file);
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Version ${latest} was already sent`);
    throw error;
  } finally {
    await rm(temp, { force: true });
  }
  await persistTranscriptEdits(folder, record);
  await projectState(folder, 'notes.js', notesState(record));
  return record;
}
