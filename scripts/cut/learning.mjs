import { parseArgs } from 'node:util';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { latestVersion } from '../workspace.mjs';
import { readJson, readOptional } from './files.mjs';
import { batchReviewer, learningRound, roundEvents, signoffEvents } from './learning-ingest.mjs';
import { projectDecisions, resolveLearning, summaryFor } from './learning-plan.mjs';
import { readDefaults } from './learning-defaults.mjs';
import { eventId, computeProfiles, json, saveEvents, saveProfiles, settingsFor, withLearning } from './learning-store.mjs';
import { chronological, explicit, idPattern, normalizeTaste, params, profileEligible } from './learning-rules.mjs';
import { propose } from './learning-propose.mjs';

export const learnHelp = `  learn ingest [--round vN] [--classified FILE | --signoff]
  learn plan [--round vN] [--reviewer ID]
  learn status [--reviewer ID] [--at ISO] [--rebuild]
  learn forget 'REVIEWER|DIMENSION|CONTEXT|DIRECTION' --quote "reviewer's words"
  learn pause [--reviewer ID] [--resume]
  learn propose
    Learn commands accept --workspace DIR. Round commands also accept --review-root DIR.`;

const string = { type: 'string' };
const boolean = { type: 'boolean' };
const roundOptions = { round: string, 'review-root': string };
const specs = {
  ingest: { ...roundOptions, classified: string, signoff: boolean },
  plan: { ...roundOptions, reviewer: string },
  status: { reviewer: string, at: string, rebuild: boolean },
  forget: { quote: string },
  pause: { reviewer: string, resume: boolean },
  propose: {},
};

function learnResult(result) {
  return { schema_version: 1, params_version: params.params_version, ...result };
}

async function pause(store, records, now, { reviewer, resume }) {
  if (reviewer) {
    const settings = await settingsFor(store, reviewer);
    const profiles = await computeProfiles(store, records, now, new Map([[reviewer, { ...settings, paused: !resume }]]));
    await saveProfiles(store, profiles);
  } else {
    await json(join(store.home, 'settings.json'), { schema_version: 1, paused: !resume });
  }
  return learnResult({ reviewer: reviewer ?? null, paused: !resume });
}

function transitions(before, after) {
  const states = new Map(before.flatMap(record => record.prefs.map(pref => [pref.key, pref.status])));
  return after.flatMap(record => record.prefs.flatMap(pref => {
    const from = states.get(pref.key) ?? 'observed';
    return from === pref.status ? [] : [{ key: pref.key, from, to: pref.status, value: pref.value,
      projects: pref.projects, last_explicit: pref.last_explicit }];
  }));
}

function transitionMessages(changes, notes) {
  const messages = changes.map(item => ({ pref: item.key, from: item.from, to: item.to,
    evidence: `${item.projects} projects${item.last_explicit ? `, last confirmed ${item.last_explicit.slice(0, 10)}` : ''}` }));
  return [...messages, ...notes.filter(e => e.type === 'stated' || e.inferred).map(e => ({
    note: e.note, ...(e.type === 'stated' ? { long_term_context: e.context } : {}),
    ...(e.inferred ? { inferred_reopen: e.outcome } : {}),
  }))];
}

async function ingest(store, global, local, now, round, values) {
  if (values.signoff && values.classified) throw new Error('Choose --classified or --signoff');
  const classified = values.classified ? await readJson(resolve(values.classified)) : undefined;
  const wasClassified = await readOptional(join(store.dir, `transitions-${round.version}-classified.json`));
  const additions = values.signoff ?
    signoffEvents(store, round, local, projectDecisions(local, store.brief)) :
    roundEvents(store, round, local, classified);
  const before = await computeProfiles(store, global, now);
  const { events, decisions, added } = await saveEvents(store, global, local, additions);
  const after = await computeProfiles(store, events, now);
  const reviewers = new Set([batchReviewer(store, round), ...additions.map(e => e.reviewer)]);
  // If a prior cache still had an active preference, report time-driven downgrade as well.
  const previous = await Promise.all(before.map(async record => {
    if (!reviewers.has(record.reviewer)) return record;
    return await readOptional(join(store.home, 'reviewers', `${record.reviewer}.json`)) ?? record;
  }));
  const phase = values.signoff ? 'signoff' : values.classified ? 'classified' : 'capture';
  const transitionFile = join(store.dir, `transitions-${round.version}-${phase}.json`);
  const saved = await readOptional(transitionFile);
  const relevant = after.filter(item => reviewers.has(item.reviewer));
  const changes = transitions(previous, relevant);
  const state = learnResult({ round: round.version, transitions: changes,
    notices: transitionMessages(changes, additions) });
  if (added || !saved || changes.length) await json(transitionFile, state);
  await saveProfiles(store, after);
  const pending = learnResult({ round: round.version, reviewer: batchReviewer(store, round),
    notes: classified || values.signoff || wasClassified ? [] : round.batch.notes.map(note => {
      const { id, text, reopens, kind, whole_video } = note;
      return { note: id, reviewer: batchReviewer(store, round, note), text, kind, whole_video,
        ...(reopens ? { reopens } : {}) };
    }) });
  const classificationFile = join(store.dir, `to-classify-${round.version}.json`);
  await json(classificationFile, pending);
  const result = added || !saved || changes.length ? state : saved;
  return { ...result, classification_file: classificationFile, transitions_file: transitionFile, added,
    decisions: decisions.filter(d => !d.valid_to).length, to_classify: pending.notes };
}

async function makeLearningPlan(store, global, local, now, round, reviewerArg) {
  const reviewer = reviewerArg ?? batchReviewer(store, round);
  if (reviewer !== batchReviewer(store, round)) throw new Error('Plan for the reviewer recorded in the locked feedback');
  const settings = await settingsFor(store, reviewer);
  const globalSettings = await readOptional(join(store.home, 'settings.json'));
  const paused = process.env.DAILIES_LEARN === 'off' || store.brief?.learning?.enabled === false ||
    globalSettings?.paused;
  const defaults = store.brief?.learning?.enabled === false ? [] : await readDefaults();
  const brief = store.brief && { ...store.brief, constraints: (store.brief.constraints ?? []).map(normalizeTaste) };
  if (brief?.context.target_s && !brief.constraints.some(item => item.dimension === 'pacing.total_length')) {
    const value = brief.context.target_s;
    const duration = round.edl.frame_count / round.edl.fps;
    brief.constraints.push({ dimension: 'pacing.total_length', direction: duration < value ? 'more' : 'less', value, unit: 's' });
  }
  const records = await computeProfiles(store, global, now);
  const decisions = projectDecisions(local, store.brief);
  const current = local.filter(e => e.round === round.version && e.note?.startsWith(`${round.version}:`) &&
    explicit.has(e.type) && !e.rejected);
  const reviewers = new Set([reviewer, ...current.map(note => note.reviewer)]);
  const prefs = records.filter(item => reviewers.has(item.reviewer) && !item.settings.paused).flatMap(item => item.prefs);
  const offeredPath = join(store.dir, 'offers.json');
  const offers = (await readOptional(offeredPath))?.offers ?? {};
  const offered = new Set(Object.entries(offers).filter(([, first]) => first !== round.version).map(([dimension]) => dimension));
  const entries = resolveLearning({ brief, reviewer, current, decisions, prefs, defaults, paused,
    auto_apply: settings.auto_apply, offered, round: round.version });
  const generated = [];
  for (const entry of entries.filter(item => !item.note && item.mode === 'default' && item.source === 'reviewer')) {
    const id = `L${generated.length + 1}`;
    entry.note = `${round.version}:${id}`;
    generated.push({ id, kind: 'general', whole_video: true, frame: 0, end_frame: round.edl.frame_count,
      text: `Automatic preference · ${entry.dimension} ${entry.direction}` });
  }
  const result = learnResult({ project: store.project, round: round.version, reviewer,
    summary: paused ? [] : summaryFor(prefs, reviewer, store.brief?.context.key), entries, generated_notes: generated,
    decisions: decisions.filter(d => !d.valid_to), paused: Boolean(paused || settings.paused) });
  await mkdir(store.dir, { recursive: true, mode: 0o700 });
  await json(join(store.dir, `plan-${round.version}.json`), result);
  for (const entry of entries.filter(item => item.mode === 'offer')) offers[entry.dimension] ??= round.version;
  await json(offeredPath, { schema_version: 1, offers });
  return result;
}

async function forget(store, global, local, now, key, quote) {
  const [reviewer, dimension, context, direction, ...rest] = key.split('|');
  if (!quote?.trim() || !idPattern.test(reviewer ?? '') || !/^[a-zA-Z0-9_-]+$/.test(context ?? '') ||
    rest.length || !profileEligible({ reviewer, dimension, context })) throw new Error('Supply a preference key and the reviewer’s original words in --quote');
  if (store.brief?.reviewers.length && !store.brief.reviewers.some(item => item.id === reviewer)) {
    throw new Error('Use the key of a reviewer in the current brief');
  }
  const at = new Date(now).toISOString();
  const existing = chronological([...global, ...local]).findLast(e => e.reviewer === reviewer && e.dimension === dimension &&
    e.context === context && e.direction === direction && (e.type === 'revoke' || (explicit.has(e.type) && !e.rejected)));
  if (existing?.type === 'revoke' && existing.quote === quote) {
    if (!global.some(e => e.id === existing.id)) {
      const { events } = await saveEvents(store, global, local, []);
      await saveProfiles(store, await computeProfiles(store, events, now));
    }
    return learnResult({ key, status: 'revoked', revoked_at: existing.at, notice: 'Preference revoked.' });
  }
  const event = {
    schema_version: 1, id: eventId(key, 'revoke', at), at, project: store.project, round: null,
    reviewer, context, type: 'revoke', sequence: Number.MAX_SAFE_INTEGER,
    ...normalizeTaste({ dimension, direction }), quote, inferred: false, basis: null,
  };
  const { events } = await saveEvents(store, global, local, [event]);
  await saveProfiles(store, await computeProfiles(store, events, now));
  return learnResult({ key, status: 'revoked', revoked_at: at, notice: 'Preference revoked.' });
}

export async function runLearning([command, ...args], workspaceArg) {
  if (!Object.hasOwn(specs, command)) throw new Error(learnHelp);
  const { values, positionals } = parseArgs({ args, allowPositionals: true,
    options: { ...specs[command], workspace: string } });
  if (positionals.length !== Number(command === 'forget')) throw new Error(learnHelp);
  const workspace = resolve(values.workspace ?? workspaceArg ?? '.');
  const now = values.at === undefined ? Date.now() : Date.parse(values.at);
  if (!Number.isFinite(now)) throw new Error('Use an ISO timestamp for --at');
  if (values.reviewer && (!idPattern.test(values.reviewer) || values.reviewer === 'anonymous')) {
    throw new Error('Use a stable named reviewer ID from the brief');
  }
  return withLearning(workspace, async (store, global, local) => {
    switch (command) {
      case 'pause': return pause(store, global, now, values);
      case 'forget': return forget(store, global, local, now, positionals[0], values.quote);
      case 'propose': return propose(store, global, now);
      case 'status': {
        const records = await computeProfiles(store, global, now);
        if (values.rebuild) await saveProfiles(store, records);
        return learnResult({ profiles: records.filter(item => !values.reviewer || item.reviewer === values.reviewer),
          settings: { paused: process.env.DAILIES_LEARN === 'off' ||
            (await readOptional(join(store.home, 'settings.json')))?.paused === true },
          ...(store.brief ? { project: store.project, decisions: projectDecisions(local, store.brief) } : {}) });
      }
      default: {
        const root = resolve(workspace, values['review-root'] ?? 'review');
        const latest = await latestVersion(root);
        const version = values.round ?? `v${latest}`;
        const round = await learningRound(root, version);
        if (values.signoff && version !== `v${latest}`) throw new Error('Sign off the final review version');
        return command === 'ingest' ? ingest(store, global, local, now, round, values) :
          makeLearningPlan(store, global, local, now, round, values.reviewer);
      }
    }
  });
}
