/**
 * Paint the ground plate for one act of a world that already exists.
 *
 *   npm run room -- world-d129fc2754b3          # every act that has no plate
 *   npm run room -- world-d129fc2754b3 act1     # just this one
 *   npm run room -- world-d129fc2754b3 act1 --fresh
 *
 * Why this exists: rooms are painted last in `paintWorld`, deliberately, so a
 * build that runs out of quota runs out on the floor rather than on a face.
 * The consequence is that worlds built on a tight day have a full cast and a
 * full set of props and no ground under any of it — which is exactly the
 * worlds that look worst, because the floor is most of the screen.
 *
 * Re-running the whole design pass to get one image back is absurd: it would
 * pay for the curriculum, the writers' room and the judge again. This takes
 * the outline and acts straight off the stage cache, hands them to the same
 * `paintWorld` the pipeline uses, and asks for nothing but the rooms. Cached
 * assets cost nothing, so it never repaints a face by accident.
 */
// ES imports are hoisted, so dotenv has to run from a module of its own or
// art.js → gemini.ts reads the environment before .env has been opened.
import '../src/env.js';
import { readdir } from 'node:fs/promises';
import type { ActSpec, Outline } from '@chapter-quest/shared';
import { cacheDir, readCache } from '../src/cache.js';
import { paintWorld } from '../src/pipeline/art.js';
import type { RoomBrief } from '../src/pipeline/art.js';

const args = process.argv.slice(2);
const fresh = args.includes('--fresh');
const [worldId, ...actIds] = args.filter((a) => !a.startsWith('--'));

if (!worldId) {
  console.error('usage: npm run room -- <worldId> [actId...] [--fresh]');
  process.exit(1);
}

/** Ids are `world-<12 hex>`; the cache files carry 16, so match on the prefix. */
const prefix = worldId.replace(/^world-/, '');
const hashes = (await readdir(cacheDir))
  .filter((f) => f.endsWith('.script.json'))
  .map((f) => f.slice(0, -'.script.json'.length))
  .filter((h) => h.startsWith(prefix));

const hash = hashes[0];
if (!hash) {
  console.error(`no built world matching ${worldId} in ${cacheDir}`);
  process.exit(1);
}

const outline = await readCache<Outline>('outline', hash);
const acts = await readCache<ActSpec[]>('script', hash);
if (!outline || !acts?.length) {
  console.error(`${hash} has no finished outline + script on disk`);
  process.exit(1);
}

const wanted = acts.filter((act) => actIds.length === 0 || actIds.includes(act.id));
const rooms: RoomBrief[] = wanted.map((act) => ({
  id: act.id,
  name: act.scene.name,
  description: act.scene.description,
}));

console.log(`${outline.title} [${hash}]`);
console.log(`style: ${outline.artStyle}`);
for (const room of rooms) console.log(`  room-${room.id}: ${room.name}`);

// Cast and props empty: everything else this world needed is already on disk,
// and `paintWorld` skips what it finds there. The style plate is the one
// exception it will repaint, and only if that is missing too — which is the
// right call, since every other asset was painted against it.
const art = await paintWorld({
  hash,
  artStyle: outline.artStyle,
  cast: [],
  props: [],
  rooms,
  fresh,
  emit: (event) => console.log(`  [${event.kind}] ${event.message}`),
});

for (const [id, url] of Object.entries(art.rooms ?? {})) console.log(`  painted ${id} → ${url}`);
for (const miss of art.missing) console.log(`  missing ${miss.asset}: ${miss.reason}`);
