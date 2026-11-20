// Adapted from framejam src/server/json-store.ts (addComment and submit).
// https://github.com/moritzkremb/framejam/blob/bc45364aff90ba931d350e931291940fdc6e604c/src/server/json-store.ts
// MIT License, Copyright (c) 2026 Moritz Kremb. See third_party/framejam/LICENSE.
// Changes: one batch per Lavish version, committed to disk by the poll wrapper.
import { randomUUID } from 'node:crypto';
import { link, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

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
  reviewer: record?.reviewer, reactions: record?.reactions });

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
  if (!data.notes.length && (data.schema_version !== 3 || !data.reactions.length)) {
    throw new Error('Nothing valid to send: add a note or reaction first');
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
  await projectState(folder, 'notes.js', notesState(record));
  return record;
}
