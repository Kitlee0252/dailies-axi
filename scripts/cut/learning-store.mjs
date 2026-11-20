import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { readBrief } from '../brief.mjs';
import { readOptional, withLock, writeText } from './files.mjs';
import { chronological, idPattern, normalizeTaste, params, profiles } from './learning-rules.mjs';
import { projectDecisions } from './learning-plan.mjs';

export const json = (file, data) => writeText(file, JSON.stringify(data, null, 2) + '\n');
const digest = value => createHash('sha256').update(value).digest('hex').slice(0, 24);
export const eventId = (...parts) => `ev-${digest(JSON.stringify(parts))}`;
export const learningHome = () => resolve(process.env.DAILIES_HOME || join(homedir(), '.dailies'));

async function readLedger(file) {
  const content = await readFile(file, 'utf8').catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return '';
  });
  const events = content.split('\n').filter(Boolean).map(line => JSON.parse(line));
  if (events.some(e => e?.schema_version !== 1 || typeof e.id !== 'string' ||
    typeof e.reviewer !== 'string' || typeof e.project !== 'string' || typeof e.context !== 'string' ||
    !Object.hasOwn(params.weights, e.type) || !Number.isFinite(Date.parse(e.at)))) {
    throw new Error('Invalid learning ledger event');
  }
  for (const e of events) normalizeTaste(e);
  return events;
}

async function appendMissing(file, old, next) {
  const ids = new Set(old.map(e => e.id));
  const missing = next.filter(e => !ids.has(e.id));
  if (missing.length) {
    // Publish one complete JSON line per write under the home lock.
    for (const e of missing) await appendFile(file, JSON.stringify(e) + '\n', { mode: 0o600, flush: true });
  }
}

export async function settingsFor(store, reviewer) {
  if (!idPattern.test(reviewer ?? '') || reviewer === 'anonymous') return { auto_apply: false, paused: false };
  const profile = await readOptional(join(store.home, 'reviewers', `${reviewer}.json`));
  return { auto_apply: profile?.settings?.auto_apply === true, paused: profile?.settings?.paused === true };
}

export async function computeProfiles(store, events, now, settings = new Map()) {
  const prefs = profiles(events, now);
  const records = [];
  const ids = new Set([...prefs.map(pref => pref.key.split('|')[0]), ...settings.keys(),
    ...(store.brief?.reviewers ?? []).map(item => item.id)]);
  for (const reviewer of [...ids].sort()) {
    const role = store.brief?.reviewers.find(item => item.id === reviewer)?.role ??
      chronological(events).findLast(e => e.reviewer === reviewer && e.role)?.role;
    records.push({ schema_version: 1, reviewer, ...(role ? { role } : {}),
      params_version: params.params_version, computed_at: new Date(now).toISOString(),
      settings: settings.get(reviewer) ?? await settingsFor(store, reviewer),
      prefs: prefs.filter(pref => pref.key.startsWith(`${reviewer}|`)) });
  }
  return records;
}

export async function saveProfiles(store, records) {
  await mkdir(join(store.home, 'reviewers'), { recursive: true, mode: 0o700 });
  for (const profile of records) await json(join(store.home, 'reviewers', `${profile.reviewer}.json`), profile);
}

export async function readLearning(workspace) {
  const home = learningHome();
  const dir = join(workspace, 'learning');
  const brief = await readBrief(workspace);
  const project = brief?.project ?? `anonymous-${digest(workspace)}`;
  return { dir, home, brief, project,
    localFile: join(dir, 'events.jsonl'), globalFile: join(home, 'ledger.jsonl') };
}

export async function readEvents(store) {
  const [global, local] = await Promise.all([readLedger(store.globalFile), readLedger(store.localFile)]);
  return { global, local };
}

export const readProjectEvents = store => readLedger(store.localFile);

export async function withLearning(workspace, operation) {
  const store = await readLearning(workspace);
  await mkdir(store.home, { recursive: true, mode: 0o700 });
  return withLock(join(store.home, '.learning-lock'), async () => {
    const { global, local } = await readEvents(store);
    return operation(store, global, local);
  });
}

export async function saveEvents(store, global, local, additions) {
  await mkdir(store.dir, { recursive: true, mode: 0o700 });
  const allLocal = new Map([...local, ...global.filter(e => e.project === store.project)].map(e => [e.id, e]));
  const allGlobal = new Map(global.map(e => [e.id, e]));
  for (const e of additions) {
    const original = allLocal.get(e.id);
    if (original && JSON.stringify(original) !== JSON.stringify(e)) {
      throw new Error('This feedback was already ingested with a different classification');
    }
    allLocal.set(e.id, e);
  }
  for (const e of allLocal.values()) {
    if (e.project === store.project && e.reviewer !== 'anonymous' && !e.dimension.startsWith('other:') && e.context) allGlobal.set(e.id, e);
  }
  // Local first, so a retry can repair a partial write and rebuild all views.
  await appendMissing(store.localFile, local, chronological([...allLocal.values()]));
  await appendMissing(store.globalFile, global, chronological([...allGlobal.values()]));
  await json(join(store.dir, 'params.json'), params);
  const decisions = projectDecisions([...allLocal.values()], store.brief);
  await json(join(store.dir, 'decisions.json'), { schema_version: 1, project: store.project,
    params_version: params.params_version, decisions });
  await writeText(join(store.dir, 'decisions.md'), [
    '# Strategy', '', 'Follow the latest applicable reviewer decision.', '', '# Decisions', '',
    ...decisions.filter(d => !d.valid_to).map(d => `- ${d.id} · ${d.dimension} ${d.direction}${d.value === undefined ? '' : ` = ${d.value}`}`),
    '', '# Reasoning log', '',
    ...decisions.map(d => `- ${d.id} · ${d.from.join(', ')}${d.valid_to ? ` · superseded ${d.valid_to}` : ''}`),
    '', '# Outstanding', '', 'See the current learning plan for conflicting or undecided treatments.', '',
  ].join('\n'));
  return { events: chronological([...allGlobal.values()]), decisions,
    added: additions.filter(e => !local.some(old => old.id === e.id)).length };
}
