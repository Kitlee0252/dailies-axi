import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { compositionEdl } from '../composition-edl.mjs';
import { readManifest, sha256, writeJson } from '../manifest.mjs';
import { compositionPath, latestVersion } from '../workspace.mjs';
import { supportedNotes } from '../notes.mjs';
import { analyzeAssets } from './analyze.mjs';
import { readJson, readOptional, withLock, writeText } from './files.mjs';
import { alignComposition } from './generate.mjs';
import { cutFromEdl, edlSegments, nextVersion, requireSchema, reviewedSpans, sameFootage, schema } from './model.mjs';
import { applyOperations } from './operations.mjs';
import { makePlan } from './plan.mjs';
import { inspectEdit } from './verify-edit.mjs';
import { verifyRenders } from './verify-render.mjs';
import { readEvents, readLearning, readProjectEvents, settingsFor } from './learning-store.mjs';
import { learnedBasis, projectDecisions } from './learning-plan.mjs';
import { evaluate } from './learning-rules.mjs';
import { learningErrors } from './learning-verify.mjs';

const candidateId = /^[a-zA-Z0-9][\w-]*$/;

function candidatePath(workspace, name) {
  if (!candidateId.test(name ?? '')) throw new Error('Use a candidate name containing letters, digits, hyphens or underscores');
  return join(workspace, 'cut-candidates', name);
}

async function lockedRound(workspace, reviewRoot, version) {
  nextVersion(version);
  const folder = join(reviewRoot, version);
  const media = join(folder, 'media');
  const notesPath = join(folder, 'notes.json');
  const edlPath = join(folder, 'edl.json');
  const [record, edl, manifest, brief, notesHash, edlHash, reviewed, learningPlan] = await Promise.all([
    readJson(notesPath), readJson(edlPath), readManifest(media),
    readFile(join(workspace, 'brief.md'), 'utf8').catch(error => {
      if (error.code !== 'ENOENT') throw error;
      return '';
    }), sha256(notesPath), sha256(edlPath), readJson(join(folder, 'version.json')),
    readOptional(join(workspace, 'learning', `plan-${version}.json`)),
  ]);
  if (!supportedNotes(record) || record.version !== version || reviewed.version !== version || !record.batch?.id || !Array.isArray(record.notes)) {
    throw new Error('Plan against a locked review batch');
  }
  const { assets } = manifest;
  const cache = join(workspace, 'media');
  await mkdir(cache, { recursive: true, mode: 0o700 });
  const analysis = await analyzeAssets(media, assets, cache);
  const generated = (learningPlan?.generated_notes ?? []).map(note => ({ ...note, generated: true }));
  return { workspace, reviewRoot, version, edl, media, brief: brief.trim(), reviewed,
    assets, analysis, notes: [...record.notes, ...generated], learningPlan, batch: record.batch.id, notesHash, edlHash };
}

function frozenInputs(round) {
  return { from: round.version, review_root: round.reviewRoot,
    notes_sha256: round.notesHash, edl_sha256: round.edlHash,
    proxy_sha256: Object.fromEntries(Object.entries(round.analysis).map(([id, data]) => [id, data.proxy_sha256])) };
}

export async function plan(workspace, reviewRoot, version) {
  const round = await lockedRound(workspace, reviewRoot, version);
  return makePlan(round);
}

async function inspectLearning(round, input, changes) {
  const store = await readLearning(round.workspace);
  const local = await readProjectEvents(store);
  const plan = round.learningPlan;
  const anchors = new Map(round.notes.map(note => [note.id, reviewedSpans(round.edl, note)]));
  const errors = learningErrors({ ops: input.ops, changes, plan, version: round.version, anchors,
    current: local.filter(e => e.round === round.version),
    decisions: projectDecisions(local, store.brief), planRequired: true });
  const reviewerOps = input.ops.filter(op => op.basis?.layer === 'reviewer' &&
    !['ask', 'decline'].includes(op.op) && learnedBasis(op.basis));
  if (!reviewerOps.length) return errors;
  const [{ global }, globalSettings] = await Promise.all([
    readEvents(store), readOptional(join(store.home, 'settings.json')),
  ]);
  const paused = process.env.DAILIES_LEARN === 'off' || store.brief?.learning?.enabled === false ||
    globalSettings?.paused;
  const now = Date.now();
  const generated = new Set((plan?.generated_notes ?? []).map(note => note.id));
  for (const op of reviewerOps) {
    if (typeof op.basis.pref !== 'string') continue;
    const settings = await settingsFor(store, op.basis.pref.split('|')[0]);
    const pref = evaluate(global, now, op.basis.pref);
    const eligible = { default: ['active'], suggest: ['candidate', 'active'], contested: ['contested'] };
    if (paused || settings.paused || !eligible[op.basis.mode]?.includes(pref.status) ||
      (generated.has(op.note) && !settings.auto_apply)) {
      errors.push({ check: 'C-learn', code: 'stale-learning-plan', note: op.note,
        message: 'The preference changed or was paused. Run learn plan again before applying it.' });
    }
  }
  return errors;
}

async function present(file) {
  return stat(file).then(() => true, error => {
    if (error.code !== 'ENOENT') throw error;
    return false;
  });
}

async function currentCut(round) {
  const path = join(round.workspace, 'cut.json');
  const cut = await readOptional(path);
  if (round.reviewed.cut_sha256) {
    if (!cut || await sha256(path) !== round.reviewed.cut_sha256) {
      throw new Error('The cumulative cut.json differs from the reviewed cut table');
    }
  }
  return cut ?? cutFromEdl(round.edl, round.version);
}

export async function apply(workspace, reviewRoot, file, name) {
  const input = await readJson(file);
  requireSchema(input, 'ops.json');
  const version = nextVersion(input.from);
  const candidate = name ?? version;
  const dir = candidatePath(workspace, candidate);
  if (await present(dir)) throw new Error(`Candidate ${candidate} already exists; choose a new name`);
  const { notes, edl, assets, analysis, ...context } = await lockedRound(workspace, reviewRoot, input.from);
  if (Number(input.from.slice(1)) !== await latestVersion(reviewRoot)) throw new Error('Apply against the latest locked review');
  if (input.batch !== context.batch) throw new Error('ops.json batch must match the locked review (start with dailies-cut plan)');
  const base = await currentCut({ ...context, edl });
  const source = compositionPath(workspace);
  const html = await readFile(source, 'utf8');
  const sourceHash = createHash('sha256').update(html).digest('hex');
  if (!sameFootage(edlSegments(compositionEdl(html, assets)), edlSegments(edl))) {
    throw new Error('The working composition footage differs from the reviewed version');
  }
  const result = applyOperations(base, edl, notes, input, assets, analysis);
  const generated = alignComposition(html, result.cut, assets);
  const parent = join(workspace, 'cut-candidates');
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const stage = await mkdtemp(join(parent, '.apply-'));
  try {
    const dirName = candidatePath(workspace, candidate);
    await withLock(`${dirName}.lock`, async () => {
      if (await present(dir)) throw new Error(`Candidate ${candidate} already exists; choose a new name`);
      const changes = { ...result.changes, candidate };
      await Promise.all([
        writeText(join(stage, 'index.html'), generated),
        writeJson(join(stage, 'cut.json'), result.cut),
        writeJson(join(stage, 'changes.json'), changes),
        writeJson(join(stage, 'ops.json'), input),
        writeJson(join(stage, 'base.json'), { schema_version: schema, ...frozenInputs({ ...context, analysis }),
          source_sha256: sourceHash, cut: base }),
      ]);
      await rename(stage, dir);
    });
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
  return { candidate, version, directory: dir, changes: join(dir, 'changes.json') };
}

async function readCandidate(workspace, name) {
  const dir = candidatePath(workspace, name);
  const [context, input, cut, changes] = await Promise.all(
    ['base', 'ops', 'cut', 'changes'].map(file => readJson(join(dir, `${file}.json`))));
  requireSchema(context, 'candidate base');
  const round = await lockedRound(workspace, resolve(context.review_root), context.from);
  for (const [field, value] of Object.entries(frozenInputs(round))) {
    if (!isDeepStrictEqual(context[field], value)) throw new Error(`Locked review input changed: ${field}`);
  }
  const baseHash = createHash('sha256').update(JSON.stringify(context.cut, null, 2) + '\n').digest('hex');
  const correctBase = round.reviewed.cut_sha256 ? baseHash === round.reviewed.cut_sha256
    : isDeepStrictEqual(context.cut, cutFromEdl(round.edl, context.from));
  if (!correctBase) throw new Error('Candidate base differs from the previously reviewed cut table');
  const expected = applyOperations(context.cut, round.edl, round.notes, input, round.assets, round.analysis);
  if (input.batch !== round.batch || !isDeepStrictEqual(cut, expected.cut) ||
      !isDeepStrictEqual(changes, { ...expected.changes, candidate: name })) {
    throw new Error('Candidate cut or changes differs from the locked operation plan');
  }
  return { dir, context, round, input, cut, changes };
}

async function fileHashes(dir, source) {
  const files = { composition_sha256: source, changes_sha256: join(dir, 'changes.json'),
    cut_sha256: join(dir, 'cut.json'), ops_sha256: join(dir, 'ops.json') };
  return Object.fromEntries(await Promise.all(Object.entries(files).map(async ([key, file]) => [key, await sha256(file)])));
}

export async function verify(workspace, name, { mode, edlOnly, composition } = {}) {
  const dir = candidatePath(workspace, name);
  return withLock(join(dir, '.verify-lock'), async () => {
    const { context, round, input, cut, changes } = await readCandidate(workspace, name);
    const source = composition ?? join(dir, 'index.html');
    const receipt = join(dir, composition ? 'verify.override.json' : edlOnly ? 'verify.edl.json' : 'verify.json');
    // Remove stale success before a re-render writes any candidate artifact.
    await rm(receipt, { force: true });
    const hashes = await fileHashes(dir, source);
    let edit, render;
    const errors = [];
    try {
      const html = await readFile(source, 'utf8');
      const actual = compositionEdl(html, round.assets);
      edit = inspectEdit({ base: round.edl, actual, html, cut, changes, analysis: round.analysis, assets: round.assets });
      errors.push(...edit.errors);
      errors.push(...await inspectLearning(round, input, changes));
      if (!edlOnly && (!errors.length || composition)) {
        render = await verifyRenders({ dir: composition ? await diagnosticDir(dir) : dir, html, edl: actual,
          assets: round.assets, media: round.media, edit, input, mode });
        errors.push(...render.errors);
      }
      if (!isDeepStrictEqual(hashes, await fileHashes(dir, source))) {
        errors.push({ code: 'candidate-changed', message: 'Candidate files changed during verification' });
      }
      for (const [asset, hash] of Object.entries(context.proxy_sha256)) {
        if (await sha256(join(round.media, `${asset}.mp4`)) !== hash) {
          errors.push({ code: 'proxy-changed', asset });
        }
      }
    } catch (error) {
      errors.push({ code: 'verification-failed', message: error.message });
    }
    const verification = { schema_version: schema, kind: 'dailies-cut-verification', candidate: name,
      from: context.from, to: cut.version, ...hashes, ...frozenInputs(round),
      passed: errors.length === 0, coverage: render?.coverage ?? 'edl',
      errors, warnings: render?.warnings ?? [], ...(edit ? { conform: edit.conform, cuts: edit.cuts } : {}),
      renders: render?.rendered ?? [] };
    await writeJson(receipt, verification);
    return { receipt, ...verification };
  });
}

async function diagnosticDir(dir) {
  const out = join(dir, 'diagnostic');
  await mkdir(out, { recursive: true, mode: 0o700 });
  return out;
}

export async function select(workspace, name) {
  const dir = candidatePath(workspace, name);
  return withLock(join(workspace, '.dailies-cut-lock'), () => withLock(join(dir, '.verify-lock'), async () => {
    const { context, cut, round, input, changes } = await readCandidate(workspace, name);
    const index = join(dir, 'index.html');
    const verifyRecord = await readOptional(join(dir, 'verify.json'));
    if (!verifyRecord?.passed || !['full', 'windows'].includes(verifyRecord.coverage)) {
      throw new Error('Run successful render verification before selecting a candidate');
    }
    const hashes = await fileHashes(dir, index);
    if (Object.entries(hashes).some(([key, hash]) => verifyRecord[key] !== hash) ||
        Object.entries(frozenInputs(round)).some(([key, value]) => !isDeepStrictEqual(verifyRecord[key], value))) {
      throw new Error('Candidate or review changed after verification');
    }
    if (Number(context.from.slice(1)) !== await latestVersion(context.review_root)) {
      throw new Error('The reviewed version advanced; select from the latest round');
    }
    const learning = await inspectLearning(round, input, changes);
    if (learning.length) throw new Error(learning.map(error => error.message).join(' '));
    const source = compositionPath(workspace);
    const workingHash = await sha256(source);
    if (workingHash !== context.source_sha256 && workingHash !== hashes.composition_sha256) {
      throw new Error('The working composition changed after this candidate was generated');
    }
    const workspaceMedia = join(workspace, 'media');
    for (const asset of new Set(cut.segments.map(segment => segment.asset))) {
      if (await sha256(join(workspaceMedia, `${asset}.mp4`)) !== context.proxy_sha256[asset]) {
        throw new Error(`Workspace proxy ${asset} differs from the reviewed asset`);
      }
    }
    // Publishing the composition last prevents a concurrent build from
    // seeing the new HTML before its cumulative table is installed.
    await writeText(join(workspace, 'cut.json'), await readFile(join(dir, 'cut.json'), 'utf8'));
    await writeText(source, await readFile(index, 'utf8'));
    return { candidate: name, version: cut.version, composition: source, changes: join(dir, 'changes.json') };
  }));
}
