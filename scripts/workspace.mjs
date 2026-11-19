import { constants } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const footageTemplate = new URL('../composition/footage.html', import.meta.url);
const sampleTemplate = new URL('../composition/index.html', import.meta.url);
export const samplePath = fileURLToPath(sampleTemplate);
export const compositionPath = root => join(root, 'source', 'index.html');

export async function initWorkspace(root, sample) {
  const composition = compositionPath(root);
  await Promise.all([mkdir(dirname(composition), { recursive: true }), mkdir(join(root, 'media'), { recursive: true })]);
  try {
    await copyFile(sample ? sampleTemplate : footageTemplate, composition, constants.COPYFILE_EXCL);
    return true;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    return false;
  }
}

export async function readComposition(file) {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

export async function isFootageStarter(contents) {
  return contents !== undefined && contents === await readFile(footageTemplate, 'utf8');
}

export async function populateStarter(file, ingest) {
  const contents = await readComposition(file);
  if (!await isFootageStarter(contents)) return false;
  const { asset, width, height, fps, duration, audio } = ingest;
  const ready = contents
    .replace("Use ingest's dimensions, fps and duration. Reuse the proxy across cuts and give each segment a stable ID.",
      'Reuse the proxy across cuts and give each segment a stable ID.')
    .replace('width: 720px; height: 1280px', `width: ${width}px; height: ${height}px`)
    .replace('data-width="720" data-height="1280" data-fps="30"', `data-width="${width}" data-height="${height}" data-fps="${fps}"`)
    .replaceAll('data-duration="10"', `data-duration="${duration}"`)
    .replace('data-review-clip="camera" src="media/camera.mp4"', `data-review-clip="${asset}" src="media/${asset}.mp4"`)
    .replace('data-has-audio="true"', audio ? 'data-has-audio="true"' : 'muted');

  const stage = await mkdtemp(join(dirname(file), '.dailies-init-'));
  try {
    const output = join(stage, 'index.html');
    await writeFile(output, ready);
    if (contents !== await readComposition(file)) return false;
    await rename(output, file);
    return true;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

export async function latestVersion(root) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return 0;
    throw error;
  }
  return entries.reduce((latest, entry) => entry.isDirectory() && /^v[1-9]\d*$/.test(entry.name)
    ? Math.max(latest, Number(entry.name.slice(1))) : latest, 0);
}
