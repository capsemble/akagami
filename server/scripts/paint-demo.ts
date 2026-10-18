/**
 * Paint the kinematics demo world, without running the design pipeline.
 *
 *   npm run paint
 *
 * The art director normally runs as the last stage of a design run, but a full
 * run needs Argon, and on the free tier Argon and Nano Banana share a daily
 * quota you will spend twice over. The demo world already exists as fixtures,
 * so this takes its cast and its interactables straight from `mocks/` and
 * paints those — one quota window, one set of assets.
 *
 * Output goes to `web/public/painted/`, not the design cache: the cache is
 * gitignored and would never reach Cloud Run, and art that only exists on one
 * laptop is not art the demo has.
 *
 * Safe to re-run. paintWorld skips anything already on disk, so a run that dies
 * halfway through a quota window picks up exactly where it stopped.
 */
// First: ES imports are hoisted, so dotenv has to run from a module of its own
// or art.js → gemini.ts reads the environment before .env has been opened and
// paints with no key at all.
import '../src/env.js';
import { copyFile, mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { CastMember, Scene, World } from '@chapter-quest/shared';
import { paintWorld } from '../src/pipeline/art.js';
import { mocksDir, repoRoot } from '../src/paths.js';


/** Stable, so re-runs reuse the same cache folder rather than paying again. */
const HASH = 'demo-kinematics0';
const PUBLIC_ART = join(repoRoot, 'web/public/painted');

/** The fixtures carry a persona but no physical description. These do. */
const LOOKS: Record<string, string> = {
  rane: 'a tired police inspector in a soaked khaki raincoat, grey at the temples, notebook in hand',
  dalvi:
    'a proud station master in a brass-buttoned navy coat, ink on his fingers, small round spectacles',
};

const PROP_LOOKS: Record<string, { label: string; look: string }> = {
  'deduction-board': {
    label: 'a wooden deduction board on a cast-iron stand',
    look: 'chalk-scored teak with a brass needle gauge across its face, lantern-lit',
  },
  'signed-timetable': {
    label: 'an open signed railway timetable ledger',
    look: 'a heavy leather ledger on a sloped desk, columns of ink, a pen resting in the gutter',
  },
  'brake-lever': {
    label: 'a trackside brake lever',
    look: 'a tall iron lever in a slotted quadrant, red-painted handle, bolted to sleepers',
  },
  'water-tank': {
    label: 'a cast-iron railway water tank on brick legs',
    look: 'riveted iron, rust streaks, a canvas hose hanging from its spout',
  },
  'satchel-launcher': {
    label: 'an improvised rope-and-spring satchel launcher',
    look: 'a timber frame with a tensioned spring arm and a leather mail satchel in its cradle',
  },
  'far-ledge': {
    label: 'a narrow rock ledge across a gorge',
    look: 'wet slate shelf with scrub grass clinging to its lip',
  },
};

async function main() {
  if (!process.env.GEMINI_API_KEY) {
    console.error('GEMINI_API_KEY missing — put it in .env first.');
    process.exit(1);
  }

  const world = JSON.parse(
    await readFile(join(mocksDir, 'world.kinematics.json'), 'utf8'),
  ) as World;

  const cast: CastMember[] = world.cast.map((member) => ({
    id: member.id,
    name: member.name,
    look: LOOKS[member.id] ?? member.persona,
    persona: member.persona,
  }));

  // Every interactable across the acts' scenes, deduplicated.
  const sceneIds = [...new Set(world.acts.map((a) => a.sceneId))];
  const seen = new Set<string>();
  const props: { id: string; label: string; look: string }[] = [];
  for (const id of sceneIds) {
    const scene = JSON.parse(
      await readFile(join(mocksDir, 'scenes', `${id}.json`), 'utf8'),
    ) as Scene;
    for (const it of scene.interactables) {
      if (seen.has(it.id)) continue;
      seen.add(it.id);
      const described = PROP_LOOKS[it.id];
      props.push({
        id: it.id,
        label: described?.label ?? it.id.replace(/-/g, ' '),
        look: described?.look ?? 'a weathered object in a 1950s Indian hill railway station',
      });
    }
  }

  console.log(`painting ${cast.length} cast + ${props.length} props for "${world.title}"`);
  const art = await paintWorld({
    hash: HASH,
    artStyle:
      'isometric 1950s Indian hill railway in monsoon, wet slate and teak, lantern light, flat vector shapes',
    cast,
    props,
    emit: (e) => console.log(`  [${e.kind}] ${e.message}`),
  });

  // Into the web bundle, so the art deploys with everything else.
  await mkdir(PUBLIC_ART, { recursive: true });
  const cacheArt = join(repoRoot, 'server/.cache/art', HASH);
  let copied = 0;
  for (const file of await readdir(cacheArt).catch(() => [] as string[])) {
    if (!file.endsWith('.png')) continue;
    await copyFile(join(cacheArt, file), join(PUBLIC_ART, file));
    copied++;
  }

  console.log(`\n${copied} file(s) in web/public/painted/`);
  if (art.missing.length > 0) {
    console.log(`${art.missing.length} still unpainted:`);
    for (const m of art.missing) console.log(`  ${m.asset} — ${m.reason.slice(0, 90)}`);
    console.log('\nRe-run when the quota window reopens; finished assets are skipped.');
    process.exit(1);
  }
  console.log('all painted — commit web/public/painted/ so the demo ships with it.');
}

main().catch((err) => {
  console.error('FAIL', err instanceof Error ? err.message : err);
  process.exit(1);
});
