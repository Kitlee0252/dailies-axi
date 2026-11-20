import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const briefId = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const id = value => typeof value === 'string' && briefId.test(value);

export function validateBrief(brief) {
  const { project, context, reviewers = [], decision_owner, learning } = brief ?? {};
  if (brief?.schema_version !== 1 || !id(project) || !record(context) ||
      !id(context.platform) || !id(context.format) ||
      (context.key !== undefined && context.key !== `${context.platform}-${context.format}`) ||
      (context.target_s !== undefined && !(Number.isFinite(context.target_s) && context.target_s > 0)) ||
      !Array.isArray(reviewers) || reviewers.some(item => !record(item) ||
        !id(item.id) || item.id === 'anonymous' ||
        (item.role !== undefined && (typeof item.role !== 'string' || !item.role.trim()))) ||
      new Set(reviewers.map(item => item.id)).size !== reviewers.length ||
      (decision_owner !== undefined && !reviewers.some(item => item.id === decision_owner)) ||
      (brief.constraints !== undefined && (!Array.isArray(brief.constraints) || !brief.constraints.every(record))) ||
      (learning !== undefined && (!record(learning) ||
        (learning.enabled !== undefined && typeof learning.enabled !== 'boolean')))) {
    throw new Error('Invalid brief.json: schema 1 requires a project ID, platform and format, distinct reviewer IDs and a listed decision owner when specified');
  }
  return { ...brief, context: { ...context, key: `${context.platform}-${context.format}` }, reviewers };
}

export async function readBrief(workspace) {
  try {
    return validateBrief(JSON.parse(await readFile(join(workspace, 'brief.json'), 'utf8')));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

export const ownerOf = brief => brief?.decision_owner ??
  (brief?.reviewers.length === 1 ? brief.reviewers[0].id : undefined);
