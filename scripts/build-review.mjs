// Video snapshot cloning adapted from framejam src/server/json-store.ts (snapshotVideo).
// https://github.com/moritzkremb/framejam/blob/bc45364aff90ba931d350e931291940fdc6e604c/src/server/json-store.ts
// MIT License, Copyright (c) 2026 Moritz Kremb. See third_party/framejam/LICENSE.
import { constants } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { documentEdl } from './composition-edl.mjs';
import { compositionSources, normalizeComposition, parseComposition } from './composition.mjs';
import { outcomeNotes, resolveOutcomes } from './outcomes.mjs';
import { readReviewProof } from './review-proof.mjs';
import { latestVersion } from './workspace.mjs';
import { readManifest, sha256, writeJson } from './manifest.mjs';
import { projectState, readNotes } from './notes.mjs';
import { readBrief } from './brief.mjs';

export async function buildReview(args) {
  const { positionals: [version, outputRoot = 'review', extra], values } = parseArgs({
    args,
    allowPositionals: true, options: {
      composition: { type: 'string' }, media: { type: 'string', default: 'media' },
      note: { type: 'string', default: '' }, outcomes: { type: 'string' }, workspace: { type: 'string' },
      'initial-version': { type: 'boolean' },
    },
  });
  if (!/^v[1-9]\d*$/.test(version ?? '') || extra) {
    throw new Error('Usage: node scripts/build-review.mjs vN [output-directory] [--composition FILE] [--media DIR] [--note SUMMARY] [--outcomes FILE]');
  }
  const here = path => new URL(`../${path}`, import.meta.url);
  const text = path => readFile(here(path), 'utf8');
  const require = createRequire(import.meta.url);
  const gsapPath = require.resolve('gsap/dist/gsap.min.js');
  const runtimePath = join(dirname(require.resolve('hyperframes/package.json')), 'dist', 'hyperframe.runtime.iife.js');
  const gsapBanner = '/*! GSAP 3.15.1 — GreenSock Standard License — https://gsap.com/standard-license/ */\n';
  const runtimeBanner = '/*! HyperFrames 0.9.69 — Apache-2.0 — https://github.com/heygen-com/hyperframes */\n';
  const [authorHtml, gsap, runtime, template, regions, review, bridge, edlCode, transcriptCode, spokenCode, feedbackCode] =
    await Promise.all([
      values.composition ? readFile(resolve(values.composition), 'utf8') : text('composition/index.html'),
      readFile(gsapPath, 'utf8'), readFile(runtimePath, 'utf8'), text('scripts/review.html'),
      text('scripts/regions.mjs'), text('scripts/review.mjs'), text('scripts/composition-bridge.js'), text('scripts/edl.mjs'),
      text('scripts/transcript.mjs'), text('scripts/spoken.mjs'), text('scripts/feedback-format.mjs'),
    ]);

  const dir = resolve(values.media);
  const manifest = await readManifest(dir);
  const document = parseComposition(authorHtml);
  const edl = documentEdl(document, manifest.assets);
  for (const [id, original] of compositionSources(document, resolve(values.composition ?? 'composition/index.html'))) {
    if (original && original !== manifest.assets[id].source) {
      throw new Error(`Asset ${id} already uses a different original. Give the new original a distinct asset ID.`);
    }
  }
  const composition = normalizeComposition(authorHtml, document);
  const assets = Object.fromEntries(edl.segments.map(({ asset }) => [asset, manifest.assets[asset]]));
  const transcripts = {};
  for (const [id, asset] of Object.entries(assets)) {
    try {
      const transcript = JSON.parse(await readFile(join(dir, `${id}.transcript.json`), 'utf8'));
      if (transcript.source_sha256 === asset.source_sha256) transcripts[id] = transcript;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  const root = resolve(outputRoot);
  const folder = join(root, version);
  const number = Number(version.slice(1));
  await mkdir(root, { recursive: true });
  const lock = join(root, '.build-lock');
  await mkdir(lock);
  let stage;
  try {
    const latest = await latestVersion(root);
    // The open command requests a starting number for a fresh review.
    const startsReview = values['initial-version'] && latest === 0;
    if (!startsReview && number !== latest + 1) throw new Error('Build the next version in order; existing versions are immutable');
    const parent = latest ? `v${latest}` : null;
    const previous = parent ? await readNotes(join(root, parent)) : null;
    if (parent && !previous) throw new Error(`Poll and lock ${parent}'s feedback before building ${version}`);
    const outcomesText = values.outcomes ? await readFile(resolve(values.outcomes), 'utf8') : '{}';
    const outcomes = JSON.parse(outcomesText);
    const resolutions = resolveOutcomes(outcomes, previous, version, edl.frame_count);
    const brief = await readBrief(values.workspace ?? dirname(root));
    const proof = await readReviewProof({ html: authorHtml, outcomes, outcomesText, file: values.outcomes,
      parentFolder: parent ? join(root, parent) : undefined, media: dir,
      assets: Object.keys(assets), frameCount: edl.frame_count, fps: edl.fps });
    const record = { version, parent, note: values.note, resolutions,
      ...(brief ? { reviewers: brief.reviewers } : {}),
      ...(proof ? { cut_sha256: proof.cut_sha256, verification_coverage: proof.verification_coverage } : {}) };
    const inline = code => `<script>${code.replace(/<\/script/gi, '<\\/script')}</script>`;
    const classic = code => code.replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
    const liveComposition = composition.replace('<script src="gsap.min.js"></script>', () => inline(gsapBanner + gsap))
      .replace('</body>', () => `${inline(runtimeBanner + runtime)}${inline(classic(regions) + '\n' + bridge)}</body>`);
    const browserAssets = Object.fromEntries(Object.entries(assets).map(([id, { source, ...asset }]) => [id, asset]));
    const config = JSON.stringify({ version, liveComposition, edl, assets: browserAssets, transcripts, record,
      previousNotes: outcomeNotes(outcomes, previous).map(({ id, text, whole_video }) => ({ id, text, whole_video })) }).replace(/</g, '\\u003c');
    const code = [regions, edlCode, transcriptCode, spokenCode, feedbackCode, review].map(classic).join('\n');
    const page = template.replace('<!-- REVIEW_SCRIPT -->', () => inline(`const config = ${config};\n${code}`));

    stage = await mkdtemp(join(root, '.build-'));
    const project = join(stage, 'composition');
    await mkdir(project);
    await writeFile(join(project, 'index.html'), composition);
    await writeFile(join(project, 'gsap.min.js'), gsapBanner + gsap);
    if (Object.keys(assets).length) {
      await mkdir(join(stage, 'media'));
      await mkdir(join(project, 'media'));
      await writeJson(join(stage, 'media', 'manifest.json'), { schema_version: manifest.schema_version, assets });
      for (const [id, asset] of Object.entries(assets)) {
        const name = basename(asset.proxy);
        const snapshot = join(stage, 'media', name);
        await copyFile(join(dir, name), snapshot, constants.COPYFILE_FICLONE);
        if (proof && await sha256(snapshot) !== proof.proxy_sha256[id]) {
          throw new Error(`Proxy ${id} changed while building the review snapshot`);
        }
        await copyFile(snapshot, join(project, 'media', name), constants.COPYFILE_FICLONE);
        if (transcripts[id]) await writeJson(join(stage, 'media', `${id}.transcript.json`), transcripts[id]);
      }
    }
    await writeJson(join(stage, 'version.json'), record);
    if (proof) await writeFile(join(stage, 'changes.json'), outcomesText, { mode: 0o600 });
    await writeJson(join(stage, 'edl.json'), edl);
    await projectState(stage, 'notes.js', { notes: null });
    await projectState(stage, 'next.js', { next: null });
    await writeFile(join(stage, 'review.html'), page);
    await rename(stage, folder);
    if (parent) await projectState(join(root, parent), 'next.js', { next: record });
  } finally {
    if (stage) await rm(stage, { recursive: true, force: true });
    await rm(lock, { recursive: true });
  }
  return folder;
}

if (import.meta.main) console.log(await buildReview(process.argv.slice(2)));
