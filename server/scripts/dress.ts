/**
 * Paint the set-dressing sheet.
 *
 *   npm run dress                       # anything not already on disk
 *   npm run dress -- tree-neem pot-water
 *   npm run dress -- --fresh            # repaint everything
 *
 * Unlike every other art stage in this project, this one is **not** keyed by
 * chapter. Dressing is scenery — scrub, paving, pots, a boulder — and scrub
 * looks the same in every world that has scrub in it. Painting a fresh set per
 * chapter would be paying sixteen times over for the same sixteen pictures, so
 * the output goes to `web/public/dressing/`, is committed, and is selected
 * from by tag at mapping time. A world costs nothing to dress.
 *
 * Output is raw from the model: JPEG on a flat white field, because the router
 * returns JPEG whatever the prompt asks for and a JPEG cannot carry alpha.
 * `scripts/bake-sprites.mjs` is the step that keys that field out and writes
 * the trimmed PNG the game actually loads. Run it after this.
 *
 * The catalogue is `shared/dressing.ts`. Add an entry there, write a brief
 * here, run both scripts. Nothing else needs to know.
 */
// ES imports are hoisted, so dotenv has to run from a module of its own or
// gemini.ts reads the environment before .env has been opened.
import '../src/env.js';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DRESSING } from '@chapter-quest/shared';
import type { DressingAsset } from '@chapter-quest/shared';
import { cacheDir } from '../src/cache.js';
import { generateImage } from '../src/gemini.js';

/**
 * Raw plates land in the design cache, which is gitignored and — more to the
 * point — is not inside `web/public`. Anything under that folder is served
 * verbatim and copied into `dist` by Vite, so leaving five megabytes of
 * uncut JPEGs there would ship every one of them to the browser to sit next
 * to the trimmed PNGs that replaced them.
 */
const RAW = join(cacheDir, 'dressing');

/**
 * What each asset is, in words.
 *
 * Separate from the catalogue on purpose: `shared/dressing.ts` is the contract
 * the game compiles against and it has no business carrying paragraphs of
 * prompt. A missing brief means the asset is skipped rather than painted from
 * its id, because "cart-handbarrow" as a prompt gets you a shopping trolley.
 */
const BRIEFS: Record<string, string> = {
  // --- ground patches ----------------------------------------------------
  'paving-slab':
    'a small patch of old fitted stone paving, four or five flat dressed slabs with dusty joints between them',
  'paving-worn':
    'a worn patch of broken stone paving half buried in dust, cracked slabs with sand drifted over their edges',
  'dust-drift': 'a soft drift of pale ochre dust and fine sand with a few tiny pebbles in it',
  'scrub-patch':
    'a low patch of dry khaki grass and thin weeds growing flat against sun-baked earth',

  // --- vegetation --------------------------------------------------------
  'tree-neem':
    'a mature neem tree with a dark crooked trunk and a broad dense canopy of small dusty green leaves',
  'tree-babul':
    'a thorny babul acacia, thin dark trunk, sparse flat-topped canopy, bare twisted branches',
  'shrub-thorn': 'a dry thorn bush, a tangle of grey woody twigs with a few small leaves',
  'grass-tuft': 'a single tuft of tall dry khaki grass blades splaying out from the base',

  // --- terrain -----------------------------------------------------------
  'rock-boulder': 'one large weathered sandstone boulder, flat-faceted, pale ochre and grey',
  'rock-cluster': 'a low cluster of three or four weathered sandstone rocks of different sizes',

  // --- clutter -----------------------------------------------------------
  'pot-water': 'a round terracotta water pot with a narrow neck, the kind kept by a village gate',
  'sack-grain':
    'two bulging jute grain sacks stacked, the top one tied at the neck, coarse woven cloth',
  'basket-cane': 'a wide shallow woven cane basket, empty, with a frayed rim',
  'cart-handbarrow':
    'a small empty two-wheeled wooden handcart with its shafts tipped down to the ground',

  // --- architecture ------------------------------------------------------
  'awning-post':
    'a tattered canvas awning stretched between two rough timber poles, sagging, its cloth bleached and frayed',
  'milestone-pillar':
    'a short carved stone milestone pillar, chipped, with a rounded top and worn lettering gone smooth',
};

/** The house style, matching the one the per-world art director locks. */
const STYLE =
  'Flat vector shapes, limited warm palette of teak browns, ochre dust, bleached khaki, ' +
  'wet slate grey and parchment. Soft warm light from the top left. ' +
  'No gradients beyond two steps, crisp clean edges, no outline sketch lines, no text, no watermark, no border.';

function promptFor(asset: DressingAsset, brief: string): string {
  if (asset.layer === 'ground') {
    return [
      `A single flat ground decal for a 2D isometric adventure game: ${brief}.`,
      'Seen from above and to the side in true 2:1 dimetric projection, lying flat',
      'on the ground, twice as wide as it is deep, nothing standing upright.',
      STYLE,
      'The patch alone, centred, on a plain pure white background. No other ground,',
      'no base plate, no frame, no cast shadow.',
    ].join(' ');
  }
  return [
    `A single game asset for a 2D isometric adventure game: ${brief}.`,
    'Seen in true 2:1 dimetric projection from above and to the side, standing upright,',
    'its base at the very bottom edge of the frame.',
    STYLE,
    'The object completely alone, centred, on a plain pure white background.',
    'CRITICAL: no ground underneath it, no patch of sand, soil, grass or stone beneath it,',
    'no base, no platform, no plinth, no cast shadow on the ground, nothing else in frame.',
  ].join(' ');
}

const args = process.argv.slice(2);
const fresh = args.includes('--fresh');
const only = args.filter((a) => !a.startsWith('--'));

await mkdir(RAW, { recursive: true });
const onDisk = fresh
  ? new Set<string>()
  : new Set(
      (await readdir(RAW).catch(() => []))
        .filter((f) => /\.(png|jpg|jpeg|webp)$/i.test(f))
        .map((f) => f.slice(0, f.lastIndexOf('.'))),
    );

const wanted = DRESSING.filter((asset) => only.length === 0 || only.includes(asset.id));
let painted = 0;
let skipped = 0;
const failed: string[] = [];

for (const asset of wanted) {
  const brief = BRIEFS[asset.id];
  if (!brief) {
    console.log(`  — ${asset.id}: no brief in dress.ts, skipped`);
    failed.push(asset.id);
    continue;
  }
  if (onDisk.has(asset.id)) {
    skipped++;
    continue;
  }
  const started = Date.now();
  try {
    const image = await generateImage(promptFor(asset, brief), []);
    const extension = image.mimeType.split('/')[1]?.replace('jpeg', 'jpg') ?? 'png';
    await writeFile(join(RAW, `${asset.id}.${extension}`), image.bytes);
    painted++;
    console.log(`  ✓ ${asset.id}.${extension} (${Date.now() - started} ms)`);
  } catch (error) {
    failed.push(asset.id);
    console.log(`  ✗ ${asset.id}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

console.log(`\npainted ${painted}, cached ${skipped}, failed ${failed.length}`);
console.log(`raw plates in ${RAW}`);
console.log('next: node scripts/bake-sprites.mjs');
if (failed.length > 0) console.log(`still missing: ${failed.join(', ')}`);
