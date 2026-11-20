import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { sha256 } from './manifest.mjs';
import { structuredOutcomes } from './outcomes.mjs';

// The review side validates the delivery receipt and its inputs as files.
export async function readReviewProof({ html, outcomes, outcomesText, file, parentFolder, media, assets, frameCount, fps }) {
  if (!structuredOutcomes(outcomes)) {
    if (html.includes('<!-- dailies-cut:segments -->')) {
      throw new Error('Pass the verified changes.json with --outcomes for a managed cut');
    }
    return;
  }
  let proof;
  try {
    proof = JSON.parse(await readFile(join(dirname(file), 'verify.json'), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    throw new Error('changes.json needs a successful render verification receipt next to it');
  }
  const renderCoverage = proof.coverage === 'full' || (proof.coverage === 'windows' && frameCount / fps > 180);
  const hash = text => createHash('sha256').update(text).digest('hex');
  if (proof.schema_version !== 1 || proof.kind !== 'dailies-cut-verification' || !renderCoverage ||
      proof.passed !== true || proof.errors?.length !== 0 || !proof.renders?.length ||
      proof.candidate !== outcomes.candidate || proof.from !== outcomes.from || proof.to !== outcomes.to ||
      !/^[0-9a-f]{64}$/.test(proof.cut_sha256 ?? '') ||
      hash(outcomesText) !== proof.changes_sha256 || hash(html) !== proof.composition_sha256 ||
      await sha256(join(parentFolder, 'notes.json')) !== proof.notes_sha256 ||
      await sha256(join(parentFolder, 'edl.json')) !== proof.edl_sha256) {
    throw new Error('The edit or its locked review differs from the successful render verification');
  }
  for (const asset of assets) {
    if (await sha256(join(media, `${asset}.mp4`)) !== proof.proxy_sha256?.[asset]) {
      throw new Error(`Proxy ${asset} differs from the verified media`);
    }
  }
  return { cut_sha256: proof.cut_sha256, verification_coverage: proof.coverage, proxy_sha256: proof.proxy_sha256 };
}
