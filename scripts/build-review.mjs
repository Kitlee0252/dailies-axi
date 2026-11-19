import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const [version, outputRoot = 'review'] = process.argv.slice(2);
if (!/^v[1-9]\d*$/.test(version ?? '')) throw new Error('Usage: node scripts/build-review.mjs vN [output-directory]');
const here = path => new URL(`../${path}`, import.meta.url);
const text = path => readFile(here(path), 'utf8');
const [composition, gsap, runtime, template, regions, review, bridge] = await Promise.all([
  text('composition/index.html'), text('node_modules/gsap/dist/gsap.min.js'),
  text('node_modules/hyperframes/dist/hyperframe.runtime.iife.js'), text('scripts/review.html'),
  text('scripts/regions.mjs'), text('scripts/review.mjs'), text('scripts/composition-bridge.js'),
]);
const inline = code => `<script>${code.replace(/<\/script/gi, '<\\/script')}</script>`;
const liveComposition = composition.replace('<script src="gsap.min.js"></script>', () => inline(gsap))
  .replace('</body>', () => `${inline(runtime)}${inline(`${regions.replace(/^export /gm, '')}\n${bridge}`)}</body>`);
const reviewCode = review.replace(/^import .*;\n/, '');
const config = JSON.stringify({ version, liveComposition }).replace(/</g, '\\u003c');
const page = template.replace('<!-- REVIEW_SCRIPT -->', () => inline(
  `const config = ${config};\n${regions.replace(/^export /gm, '')}\n${reviewCode}`));

const folder = resolve(outputRoot, version);
const project = join(folder, 'composition');
await mkdir(resolve(outputRoot), { recursive: true });
await mkdir(folder);
await mkdir(project);
await writeFile(join(project, 'index.html'), composition);
await copyFile(here('node_modules/gsap/dist/gsap.min.js'), join(project, 'gsap.min.js'));
await writeFile(join(folder, 'review.html'), page);
console.log(folder);
