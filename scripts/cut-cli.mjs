#!/usr/bin/env node
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { readManifest } from './manifest.mjs';
import { analyzeAssets } from './cut/analyze.mjs';
import { apply, plan, select, verify } from './cut/session.mjs';

const help = `Usage: dailies-cut <command> [options]

Run in the review workspace, or pass --workspace DIR.
  analyze [asset] [--media DIR]                      Cache source picture and audio analysis
  plan <vN> [--review-root DIR]                       Draft operations and extract evidence from locked notes
  apply <ops.json> [--candidate NAME] [--review-root DIR]
                                                     Stage a candidate cut, composition and changes
  verify <candidate> [--render | --windows | --edl-only]
                     [--composition FILE]            Check the candidate (alternate HTML is diagnostic only)
  select <candidate>                                 Install a verified candidate as the working cut

Verification renders the full edit up to 3 minutes. For a longer edit,
ask whether to render the whole film (--render) or cut windows (--windows).`;

const [command, ...args] = process.argv.slice(2);
const specs = {
  analyze: { positionals: 0, max: 1, options: { media: { type: 'string' } } },
  plan: { positionals: 1, options: { 'review-root': { type: 'string' } } },
  apply: { positionals: 1, options: { 'review-root': { type: 'string' }, candidate: { type: 'string' } } },
  verify: { positionals: 1, options: { render: { type: 'boolean' }, windows: { type: 'boolean' },
    'edl-only': { type: 'boolean' }, composition: { type: 'string' } } },
  select: { positionals: 1, options: {} },
};

try {
  if (!command || ['--help', '-h'].includes(command) || args.includes('--help')) console.log(help);
  else {
    const spec = Object.hasOwn(specs, command) && specs[command];
    if (!spec) throw new Error(help);
    const { positionals, values } = parseArgs({
      args, allowPositionals: true, options: { ...spec.options, workspace: { type: 'string' } },
    });
    if (positionals.length < spec.positionals || positionals.length > (spec.max ?? spec.positionals)) throw new Error(help);
    if ([values.render, values.windows, values['edl-only']].filter(Boolean).length > 1) {
      throw new Error('Choose one verification mode: --render, --windows or --edl-only');
    }
    const [arg] = positionals;
    const workspace = resolve(values.workspace ?? '.');
    const reviewRoot = resolve(workspace, values['review-root'] ?? 'review');
    let result;
    switch (command) {
      case 'analyze': {
        const media = resolve(workspace, values.media ?? 'media');
        const { assets } = await readManifest(media);
        if (arg && !Object.hasOwn(assets, arg)) throw new Error(`Unknown asset ${arg}`);
        if (!Object.keys(assets).length) throw new Error(`No ingested assets in ${media}`);
        const results = await analyzeAssets(media, arg ? { [arg]: assets[arg] } : assets);
        result = Object.fromEntries(Object.entries(results).map(([asset, { visual_cuts, silences }]) =>
          [asset, { file: join(media, `${asset}.analysis.json`), visual_cuts, silences }]));
        break;
      }
      case 'plan': result = await plan(workspace, reviewRoot, arg); break;
      case 'apply': result = await apply(workspace, reviewRoot, resolve(arg), values.candidate); break;
      case 'verify':
        result = await verify(workspace, arg, {
          mode: values.render ? 'full' : values.windows ? 'windows' : undefined,
          edlOnly: values['edl-only'], composition: values.composition && resolve(values.composition),
        });
        if (!result.passed) process.exitCode = 1;
        break;
      case 'select': result = await select(workspace, arg); break;
    }
    console.log(JSON.stringify(result, null, 2));
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
