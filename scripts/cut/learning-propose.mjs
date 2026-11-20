import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { defaultsDocument } from './learning-defaults.mjs';
import { day, generalCandidates, normalizeTaste, params } from './learning-rules.mjs';
import { eventId } from './learning-store.mjs';
import { writeText } from './files.mjs';

const safePlatforms = new Set(['douyin', 'bilibili', 'xhs', 'xiaohongshu', 'youtube', 'instagram', 'tiktok', 'web', 'internal', 'generic']);
const safeFormats = new Set(['koubo', 'vlog', 'interview', 'short', 'documentary', 'tutorial', 'ad', 'demo', 'talking-head', 'explainer']);
const safeRoles = new Map([
  ['marketing', 'marketing'], ['brand-marketing', 'marketing'], ['director', 'director'],
  ['editor', 'editor'], ['creator', 'creator'], ['producer', 'producer'], ['reviewer', 'reviewer'],
]);
const exec = promisify(execFile);
const tests = ['../cut.test.mjs', '../learning.test.mjs'].map(name => fileURLToPath(new URL(name, import.meta.url)));

function scrubRule(rule) {
  const [platform, ...parts] = rule.context.split('-');
  if (!safePlatforms.has(platform) || !safeFormats.has(parts.join('-'))) {
    throw new Error('Proposal scrub check refused an unrecognized platform or format; use a generic context without private names');
  }
  return { ...normalizeTaste(rule), context: rule.context };
}

function proposalEvidence(candidate, events) {
  const accepted = new Set(candidate.active.flatMap(pref => pref.events));
  const supporting = events.filter(e => accepted.has(`${e.project}:${e.id}`));
  const dates = supporting.map(e => new Date(e.at).toISOString().slice(0, 10)).sort();
  const roles = [...new Set(supporting.map(e => safeRoles.get(e.role) ?? 'reviewer'))].sort();
  return { roles: roles.join(', '), dateRange: `${dates[0]} through ${dates.at(-1)}`, count: supporting.length };
}

async function priorProposals(directory, id) {
  const names = await readdir(directory).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return [];
  });
  const matching = names.filter(name => name.startsWith(`${id}-`) && name.endsWith('.md')).sort();
  return Promise.all(matching.map(async name => {
    const front = (await readFile(join(directory, name), 'utf8')).split('---')[1] ?? '';
    return Object.fromEntries(front.trim().split('\n').map(line => line.split(/: (.*)/s).slice(0, 2)));
  }));
}

function diff(original, newDefaults) {
  const old = original.text.split('\n'), next = JSON.stringify(newDefaults, null, 2).split('\n');
  return ['--- a/skills/dailies-edit/references/defaults.md', '+++ b/skills/dailies-edit/references/defaults.md',
    `@@ -${original.line - 1},${old.length + 2} +${original.line - 1},${next.length + 2} @@`, ' ```json',
    ...old.map(line => `-${line}`), ...next.map(line => `+${line}`), ' ```'].join('\n');
}

async function regressions(defaults, rule, enabled) {
  try {
    const input = JSON.stringify({ defaults, rule, enabled });
    const env = { ...process.env, DAILIES_DEFAULTS_FIXTURE: input };
    delete env.NODE_TEST_CONTEXT;
    const { stdout } = await exec(process.execPath, ['--test', '--test-reporter=tap', ...tests], {
      env, timeout: 30000,
    });
    const count = Number(stdout.match(/^# pass (\d+)$/m)?.[1]);
    if (!count) throw new Error('Missing test results');
    return count;
  } catch {
    throw new Error(`Regression checks failed for ${enabled ? 'proposed' : 'approved'} defaults`);
  }
}

function scrubDocument(document) {
  const content = document.replaceAll(/(?:a|b)\/skills\/dailies-edit\/references\/defaults\.md/g, '');
  if (/https?:|www\.|(?:^|[\s"'=])(?:~\/|\/|[a-z]:\\)|[$€£¥]\s*\d|[\w.+-]+@[\w.-]+\.[a-z]{2,}/im.test(content)) {
    throw new Error('Proposal scrub check refused a path, URL, email address or fee');
  }
}

export async function propose(store, events, now) {
  const directory = join(store.home, 'proposals');
  const proposals = [];
  const refused = [];
  for (const candidate of generalCandidates(events, now)) {
    const id = `L3-${eventId(candidate.rule).slice(3, 15)}`;
    try {
      // Only a shared value is portable. No quotes, client strings, project names, IDs or paths enter the template.
      const values = [...new Set(candidate.active.map(item => item.value))];
      const rule = scrubRule({ ...candidate, value: values.length === 1 ? values[0] : undefined });
      const evidence = proposalEvidence(candidate, events);
      const previous = (await priorProposals(directory, id)).at(-1);
      const reviewedAt = Date.parse(previous?.reviewed_at ?? previous?.generated_at ?? '');
      if (previous && (['pending', 'approved'].includes(previous.status) ||
        (now - reviewedAt < params.general.cooldownDays * day &&
          evidence.count < Number(previous.evidence_count) * params.general.retryEvidenceFactor))) continue;
      const original = await defaultsDocument();
      const defaults = original.rules;
      if (defaults.some(item => item.dimension === rule.dimension && item.context === rule.context)) continue;
      // Validate existing rules too. The diff must not copy manually added private text.
      const old = defaults.map(scrubRule);
      const next = [...old, rule];
      const before = await regressions(old, rule, false);
      const after = await regressions(next, rule, true);
      const generated = new Date(now).toISOString();
      const document = [
        '---', 'schema_version: 1', `id: ${id}`, `rule: ${rule.dimension} | ${rule.context} | ${rule.direction}`,
        'status: pending', `params_version: ${params.params_version}`, `generated_at: ${generated}`,
        `evidence_count: ${evidence.count}`, '---', '', '## Proposed change', '', '````diff',
        diff(original, next), '````', '', '## Evidence', '',
        `${candidate.active.length} reviewers (${evidence.roles}), ${candidate.projects} projects, ${evidence.dateRange}.`,
        '', '## Counterevidence', '', 'No reviewer objections or revocations for this rule.', '',
        '## Regression checks', '', `Old defaults ${before}/${before} passed across edit fixtures and learning scenarios. Proposed defaults ${after}/${after} passed.`,
        '', '## Behavior change', '', `In ${rule.context}, a matching taste note for ${rule.dimension} gets ${rule.direction}` +
          `${rule.value === undefined ? '' : ` (${rule.value}${rule.unit ? ` ${rule.unit}` : ''})`} as a general default with alternatives and disclosure.`,
        '', 'Human approval required.', '',
      ].join('\n');
      scrubDocument(document);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const file = join(directory, `${id}-${generated.replaceAll(':', '-')}.md`);
      await writeText(file, document);
      proposals.push({ id, file, notice: 'New general preference proposal awaiting human approval.' });
    } catch (error) {
      refused.push({ id, reason: error.message });
    }
  }
  return { schema_version: 1, params_version: params.params_version, proposals, refused };
}
