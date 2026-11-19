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

export async function lockNotes(folder, latest, data) {
  if (data.version !== latest) throw new Error(`Version ${data.version} is not the latest; comment on ${latest}`);
  if (data.schema_version !== 2 || !Array.isArray(data.notes) || !data.notes.length ||
      data.notes.some(note => !note.id || typeof note.text !== 'string' || !note.text.trim()) ||
      new Set(data.notes.map(note => note.id)).size !== data.notes.length) {
    throw new Error('Nothing valid to send: add a note first');
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
  await projectState(folder, 'notes.js', { notes: record.notes, sentAt: record.sentAt });
  return record;
}
