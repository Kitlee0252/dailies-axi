import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';

export const readJson = async file => JSON.parse(await readFile(file, 'utf8'));

export async function readOptional(file) {
  try {
    return await readJson(file);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

export async function writeText(file, text) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text, { mode: 0o600, flag: 'wx' });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function withLock(path, action) {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    throw new Error(`A dailies-cut operation already holds ${path}`);
  }
  try {
    return await action();
  } finally {
    await rm(path, { recursive: true, force: true });
  }
}
