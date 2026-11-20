import { readFile } from 'node:fs/promises';
import { normalizeTaste } from './learning-rules.mjs';

// Approved defaults are versioned documentation containing a fenced JSON array.
export const defaultsFile = new URL('../../skills/dailies-edit/references/defaults.md', import.meta.url);

export async function readDefaults() {
  return (await defaultsDocument()).rules;
}

export async function defaultsDocument() {
  const page = await readFile(defaultsFile, 'utf8');
  const code = page.match(/^```json\n([\s\S]*?)\n```/m);
  if (!code) throw new Error('Learning defaults need a fenced JSON array');
  const raw = JSON.parse(code[1]);
  if (!Array.isArray(raw) || raw.some(rule => !rule || typeof rule.context !== 'string' ||
    Object.keys(rule).some(field => !['dimension', 'context', 'direction', 'value', 'unit'].includes(field)))) {
    throw new Error('General defaults contain an invalid field');
  }
  return { text: code[1], line: page.slice(0, code.index).split('\n').length + 1,
    rules: raw.map(rule => ({ ...normalizeTaste(rule), context: rule.context })) };
}
