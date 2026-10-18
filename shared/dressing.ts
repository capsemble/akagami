/**
 * Set dressing: everything in the room that is scenery and nothing else.
 *
 * The rooms this project generates were empty, and no amount of prop art was
 * going to fix that. A chapter's design pass names two or three objects, the
 * mapper lays them out on a plane the size of a tennis court, and the result
 * is two things and three people standing in a field. The reference art this
 * was measured against is dense — trees, scrub, paving, pots, rocks, a wall —
 * and almost none of that density is interactive. It is *dressing*.
 *
 * So dressing is its own layer, with its own rules:
 *
 * 1. **It never touches physics.** A decoration produces no collider, no hit
 *    area and no gameplay state. `blocked` is untouched by everything here, so
 *    a dressed room and an undressed one collide identically and `walkable()`
 *    returns the same answer for both. That is not a limitation to be fixed
 *    later by quietly adding rects — it is the contract that makes it safe to
 *    scatter a hundred objects into a room nobody re-tested.
 * 2. **It stays out of the way.** Placement avoids the colliders, the props
 *    and their name plates, the cast, the spawn, the exits and the lane a run
 *    is acted out along. The player should never have to walk through a tree,
 *    not because the tree would stop them but because it looks wrong.
 * 3. **It is the same room every time.** Every choice comes off a hash of the
 *    scene id, so reopening a world does not rearrange its furniture.
 *
 * The catalogue below is deliberately *not* per-world. One set of assets is
 * painted once, committed, and selected from by tag, so act two costs nothing
 * that act one did not already pay. A world picks a palette of tags; the rooms
 * pick from inside it.
 *
 * ## Asset convention
 *
 * Files live in `web/public/dressing/<id>.png`, one PNG per entry below, with
 * a real alpha channel and the subject trimmed to the edges of the image. See
 * `scripts/bake-sprites.mjs` for the step that gets them there, and
 * `server/scripts/dress.ts` for the one that paints them.
 *
 * - **upright**: drawn in 2:1 dimetric, light from the top left, standing on
 *   nothing. The bottom edge of the image is the ground-contact line, so the
 *   sprite is anchored at (0.5, 1) and `heightPx` is how tall it stands on
 *   screen. No ground, no baked shadow — the renderer lays its own, which is
 *   what keeps it sitting on the floor the plate painted rather than on a
 *   lighter rectangle of its own.
 * - **ground**: a flat patch seen from the same angle, anchored at its centre
 *   and drawn as a `spreadPx` wide, `spreadPx / 2` tall diamond-ish blot — the
 *   same 2:1 foreshortening the floor has, so paving laid by this reads as
 *   lying down rather than standing up.
 */
import { seedOf } from './props.js';
import type { Decoration, DressingLayer, Point, Rect, Scene } from './types.js';

/**
 * How tall a person is on screen, in pixels.
 *
 * `CAST_HEIGHT` in WorldScene, and the default height of a drawn `Actor`, both
 * land here — so this is the ruler everything else in the room is measured
 * against, and `metres()` below is how a brief in the real world becomes a
 * number in this file. Sizing by eye is what produced the first pass: waist
 * high grass, pots you could bathe in, and baskets a clerk could sleep in.
 */
export const PERSON_PX = 62;
/** Roughly 1.7m to a person, so this many pixels to the metre. */
const metres = (m: number): number => Math.round((m * PERSON_PX) / 1.7);

export interface DressingAsset {
  /** Also the file stem: `web/public/dressing/<id>.png`. */
  id: string;
  layer: DressingLayer;
  /**
   * Upright only: how tall it stands on screen, in pixels, at scale 1.
   * Always written as `metres(n)` so the number has a reason.
   */
  heightPx?: number;
  /** Ground only: how wide the patch lies, in pixels, at scale 1. */
  spreadPx?: number;
  /** What a room selects on. A room takes everything matching any of its tags. */
  tags: string[];
  /**
   * How much floor to keep clear around it, in world units. Big things need
   * more room or the scatter stacks a tree on a boulder.
   */
  clearance: number;
  /** Relative frequency within its tag. A room wants more scrub than gates. */
  weight: number;
}

/**
 * The catalogue.
 *
 * Tags are the whole interface: a world says "arid, stone, vegetation" and
 * gets a ravine; a later world says "indoor, stone" and gets the same paving
 * and none of the trees. Adding a world's look is adding tags, not adding a
 * renderer.
 */
export const DRESSING: DressingAsset[] = [
  // --- ground ------------------------------------------------------------
  { id: 'paving-slab', layer: 'ground', spreadPx: 96, tags: ['path'], clearance: 0, weight: 3 },
  { id: 'paving-worn', layer: 'ground', spreadPx: 104, tags: ['path'], clearance: 0, weight: 2 },
  { id: 'dust-drift', layer: 'ground', spreadPx: 150, tags: ['arid'], clearance: 40, weight: 2 },
  {
    id: 'scrub-patch',
    layer: 'ground',
    spreadPx: 128,
    tags: ['vegetation', 'arid'],
    clearance: 40,
    weight: 2,
  },

  // --- vegetation --------------------------------------------------------
  {
    id: 'tree-neem',
    layer: 'upright',
    heightPx: metres(7),
    tags: ['vegetation'],
    clearance: 210,
    weight: 2,
  },
  {
    id: 'tree-babul',
    layer: 'upright',
    heightPx: metres(5),
    tags: ['vegetation', 'arid'],
    clearance: 180,
    weight: 2,
  },
  {
    id: 'shrub-thorn',
    layer: 'upright',
    heightPx: metres(1),
    tags: ['vegetation', 'arid'],
    clearance: 80,
    weight: 4,
  },
  {
    id: 'grass-tuft',
    layer: 'upright',
    heightPx: metres(0.5),
    tags: ['vegetation', 'arid'],
    clearance: 56,
    weight: 5,
  },

  // --- terrain -----------------------------------------------------------
  {
    id: 'rock-boulder',
    layer: 'upright',
    heightPx: metres(1.3),
    tags: ['terrain'],
    clearance: 110,
    weight: 3,
  },
  {
    id: 'rock-cluster',
    layer: 'upright',
    heightPx: metres(0.6),
    tags: ['terrain'],
    clearance: 90,
    weight: 3,
  },

  // --- clutter -----------------------------------------------------------
  {
    id: 'pot-water',
    layer: 'upright',
    heightPx: metres(0.6),
    tags: ['clutter'],
    clearance: 70,
    weight: 2,
  },
  {
    id: 'sack-grain',
    layer: 'upright',
    heightPx: metres(0.8),
    tags: ['clutter'],
    clearance: 80,
    weight: 2,
  },
  {
    id: 'basket-cane',
    layer: 'upright',
    heightPx: metres(0.35),
    tags: ['clutter'],
    clearance: 70,
    weight: 1,
  },
  {
    id: 'cart-handbarrow',
    layer: 'upright',
    heightPx: metres(1.1),
    tags: ['clutter'],
    clearance: 130,
    weight: 2,
  },

  // --- architecture ------------------------------------------------------
  {
    id: 'awning-post',
    layer: 'upright',
    heightPx: metres(2.6),
    tags: ['structure'],
    clearance: 180,
    weight: 3,
  },
  {
    id: 'milestone-pillar',
    layer: 'upright',
    heightPx: metres(1),
    tags: ['structure', 'terrain'],
    clearance: 90,
    weight: 2,
  },
];

export const dressingAsset = (id: string): DressingAsset | undefined =>
  DRESSING.find((a) => a.id === id);

/**
 * What kind of place is this, from what the design pass called it.
 *
 * The same trick `propKindFor` plays on a prop's name, for the same reasons: a
 * room's look should not need a network round trip, and a table of words is
 * something you can read and correct. It exists because the first version
 * dressed every room from the whole catalogue, and a candlelit library full of
 * torn scrolls came out with thorn trees growing through the floor and water
 * pots along the walls.
 *
 * Indoors is checked first and wins. The cost of guessing wrong in that
 * direction is a bare room; the cost of guessing wrong in the other is a tree
 * indoors, which is the single most obviously broken thing a renderer can do.
 */
const INDOORS = [
  'library',
  'archive',
  'scriptorium',
  'sanctum',
  'vault',
  'cellar',
  'chamber',
  'hall',
  'room',
  'office',
  'interior',
  'indoor',
  'corridor',
  'workshop',
  'laboratory',
  'warehouse',
  'store',
  'shed',
  'signal box',
  'cabin',
  'booth',
  'kitchen',
  'temple',
  'shrine',
];

const OUTDOORS = [
  'ravine',
  'gorge',
  'valley',
  'road',
  'track',
  'yard',
  'gate',
  'field',
  'hill',
  'quarry',
  'pit',
  'desert',
  'village',
  'bank',
  'quay',
  'dock',
  'platform',
  'street',
  'courtyard',
  'siding',
  'crossing',
  'bridge',
  'river',
  'ghat',
  'outside',
  'open',
  'mouth',
  'slope',
  'terrace',
  'verandah',
];

/**
 * Indoors gets nothing, for now, and that is a statement about the catalogue
 * rather than about indoor rooms.
 *
 * Every asset painted so far is outdoor and arid — dust, scrub, thorn trees,
 * weathered rock, a village water pot. Dressed with that set, the candlelit
 * library came out with thorn trees growing between the shelves; with the
 * vegetation tags removed it came out with twenty identical water pots
 * standing on a reading-room floor. Neither is better than the bare room it
 * replaced, and shipping the second one would be dressing a scene in
 * placeholders and calling it art.
 *
 * So an indoor room keeps the floor it has always had until there is an
 * indoor set to give it — shelves, ledgers, lanterns, a rug, stacked crates.
 * Painting one is `npm run dress` with new briefs and nothing else: that is
 * the whole point of the catalogue being tag-selected rather than per-world.
 */
const INDOOR_TAGS: string[] = [];
const OUTDOOR_TAGS = ['path', 'vegetation', 'arid', 'terrain', 'clutter', 'structure'];

export function dressingTagsFor(place: { name?: string; description?: string }): string[] {
  const words = `${place.name ?? ''} ${place.description ?? ''}`.toLowerCase();
  const has = (list: string[]) => list.some((word) => words.includes(word));
  if (has(INDOORS)) return INDOOR_TAGS;
  if (has(OUTDOORS)) return OUTDOOR_TAGS;
  // Nothing in the name says which. Take the set that is wrong quietly.
  return INDOOR_TAGS;
}

export interface DressOptions {
  /** Which tags this world draws from. Empty dresses nothing. */
  tags?: string[];
  /** Roughly how many upright pieces to aim for. The keep-outs decide the rest. */
  density?: number;
  /** Lay a path between the spawn, the props and the way out. Default true. */
  path?: boolean;
}

/** How wide a frame around the room uprights are scattered into. */
const EDGE = 230;
/** Nothing stands within this of a wall, or it grows out of the stonework. */
const WALL_GAP = 26;
/** Kept clear around a prop, so its ring and its name plate stay readable. */
const PROP_GAP = 130;
/** Kept clear around a person, the spawn, and a way out. */
const CAST_GAP = 120;
const EXIT_GAP = 190;
/**
 * The lane a run is acted out along.
 *
 * `bindStage` lays every playback path across the middle of the room at
 * `height * 0.52`, and a boulder standing on it would sit on top of the train.
 * The band is reserved here rather than read off the stage because the scene
 * is laid out before the act is bound to it, and because every act shape this
 * mapper produces puts its lane in the same place.
 */
const LANE_Y = 0.52;
const LANE_GAP = 125;

/** A deterministic 0..1 stream. Same scene id in, same room out. */
function stream(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

const near = (a: Point, b: Point, gap: number): boolean => Math.hypot(a.x - b.x, a.y - b.y) < gap;

const nearRect = (p: Point, r: Rect, gap: number): boolean =>
  p.x > r.x - gap && p.x < r.x + r.w + gap && p.y > r.y - gap && p.y < r.y + r.h + gap;

/**
 * Every reason a point is not available, in one place so the path and the
 * scatter agree about what the room is already using.
 */
function keepOut(scene: Scene, p: Point, gap: number): boolean {
  if (scene.blocked.some((r) => nearRect(p, r, Math.max(gap, WALL_GAP)))) return true;
  if (scene.interactables.some((r) => nearRect(p, r, PROP_GAP))) return true;
  if (scene.exits.some((r) => nearRect(p, r, EXIT_GAP))) return true;
  if (Object.values(scene.npcSpots).some((spot) => near(p, spot, CAST_GAP))) return true;
  if (near(p, scene.spawn, CAST_GAP)) return true;
  if (Math.abs(p.y - scene.height * LANE_Y) < LANE_GAP) return true;
  return false;
}

/** Pick by weight from a list, off the given stream. */
function pick<T extends { weight: number }>(items: T[], rng: () => number): T {
  const total = items.reduce((sum, item) => sum + item.weight, 0);
  let roll = rng() * total;
  for (const item of items) {
    roll -= item.weight;
    if (roll <= 0) return item;
  }
  return items[items.length - 1]!;
}

/**
 * The stone path.
 *
 * Laid along the route the player actually has to walk — out of the spawn, to
 * each thing the act asks them to touch, and on to the way out — rather than
 * painted into the backdrop, because the backdrop does not know where any of
 * those are. It is the one piece of dressing that is about the geometry: it
 * tells you where to go before any text does.
 *
 * The stops are visited nearest-first from the spawn rather than in fixture
 * order, or a room whose props happen to be listed west-then-east gets a track
 * that crosses itself twice on the way to a door forty pixels from where the
 * player started.
 *
 * Two rows of slabs, spaced closer than they are wide, so they overlap into a
 * continuous band. The first pass used one row of wide slabs at wide spacing
 * and the result read as rubble someone had dropped, not as a road: a path is
 * recognisable because it is *continuous*, and that costs nothing but slabs.
 *
 * Ground decals only, so it is walked over and never walked into.
 */
function layPath(scene: Scene, assets: DressingAsset[], rng: () => number): Decoration[] {
  const slabs = assets.filter((a) => a.layer === 'ground' && a.tags.includes('path'));
  if (slabs.length === 0) return [];

  const remaining: Point[] = scene.interactables.map((it) => ({
    x: it.x + it.w / 2,
    y: it.y + it.h + 80,
  }));
  const stops: Point[] = [scene.spawn];
  while (remaining.length > 0) {
    const here = stops[stops.length - 1]!;
    let best = 0;
    for (let i = 1; i < remaining.length; i++) {
      if (
        Math.hypot(remaining[i]!.x - here.x, remaining[i]!.y - here.y) <
        Math.hypot(remaining[best]!.x - here.x, remaining[best]!.y - here.y)
      ) {
        best = i;
      }
    }
    stops.push(remaining.splice(best, 1)[0]!);
  }
  for (const exit of scene.exits) stops.push({ x: exit.x + exit.w / 2, y: exit.y + exit.h / 2 });

  /**
   * How far apart slabs are laid, in world units.
   *
   * The two scales in this file are not the same scale, which is the trap.
   * `spreadPx` is how wide a slab is drawn *on screen*, and the projection
   * halves horizontal distance — so a hundred world units along the x axis is
   * fifty pixels of screen. Spacing slabs forty world units apart laid a
   * ninety-six pixel slab every twenty pixels and the "path" came out as a
   * paved river four slabs thick. Just under a slab's own screen width in
   * world terms is what makes a track: continuous, and one slab wide.
   */
  const STEP = 110;
  /** How far a slab may wander across the track, in world units. */
  const HALF = 34;

  const out: Decoration[] = [];
  let n = 0;
  for (let i = 0; i < stops.length - 1; i++) {
    const from = stops[i]!;
    const to = stops[i + 1]!;
    const span = Math.hypot(to.x - from.x, to.y - from.y);
    if (span < 1) continue;
    // Across the direction of travel, so the two rows widen the track rather
    // than lengthening it whichever way the segment happens to run.
    const side = { x: -(to.y - from.y) / span, y: (to.x - from.x) / span };
    const steps = Math.max(1, Math.round(span / STEP));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const mid = { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
      const slab = pick(slabs, rng);
      const off = HALF * (rng() * 2 - 1);
      out.push({
        id: `path-${n++}`,
        asset: slab.id,
        layer: 'ground',
        // Wandered a little across its own direction: a track worn by carts is
        // not a surveyed road, and a dead-straight one looks like a debug aid.
        x: Math.round(mid.x + side.x * off),
        y: Math.round(mid.y + side.y * off),
        scale: 0.82 + rng() * 0.34,
        flip: rng() < 0.5,
      });
    }
  }
  return out;
}

/**
 * Dress one room.
 *
 * Uprights go in a frame around the edge of the plane. That is where the
 * mapper leaves space — it keeps props `MARGIN` off the walls precisely so the
 * player can walk behind them — and it is where scenery belongs anyway: the
 * middle of the room is the stage, and the sides are the set.
 */
export function dressScene(scene: Scene, options: DressOptions = {}): Decoration[] {
  const { tags = [], density = 26, path = true } = options;
  if (tags.length === 0) return [];

  const usable = DRESSING.filter((asset) => asset.tags.some((tag) => tags.includes(tag)));
  if (usable.length === 0) return [];

  const rng = stream(seedOf(scene.id));
  const out: Decoration[] = path ? layPath(scene, usable, rng) : [];

  const uprights = usable.filter((a) => a.layer === 'upright');
  const patches = usable.filter((a) => a.layer === 'ground' && !a.tags.includes('path'));
  const placed: { at: Point; clearance: number }[] = [];

  // Candidates come off a jittered ring around the edge rather than off the
  // whole plane: scattering uniformly and rejecting the middle wastes most of
  // the tries, and on a wide hall it leaves the edges bald.
  const inEdge = (p: Point): boolean =>
    p.x < EDGE || p.y < EDGE || p.x > scene.width - EDGE || p.y > scene.height - EDGE;

  let tries = 0;
  let n = 0;
  while (placed.length < density && tries < density * 60) {
    tries++;
    const at = { x: rng() * scene.width, y: rng() * scene.height };
    if (!inEdge(at)) continue;

    const asset = pick(uprights.length > 0 ? uprights : usable, rng);
    if (keepOut(scene, at, asset.clearance * 0.45)) continue;
    if (placed.some((other) => near(at, other.at, (other.clearance + asset.clearance) * 0.5)))
      continue;

    placed.push({ at, clearance: asset.clearance });
    out.push({
      id: `dress-${n++}`,
      asset: asset.id,
      layer: asset.layer,
      x: Math.round(at.x),
      y: Math.round(at.y),
      // A stand of trees that are all the same height is a wallpaper border.
      scale: 0.78 + rng() * 0.5,
      flip: rng() < 0.5,
    });
  }

  // Flat patches last, under everything, including under the uprights that
  // were just placed — dust and scrub are what the rest of it is standing in.
  if (patches.length > 0) {
    for (let i = 0; i < Math.round(density * 0.45); i++) {
      const at = { x: rng() * scene.width, y: rng() * scene.height };
      if (keepOut(scene, at, 0)) continue;
      const asset = pick(patches, rng);
      out.push({
        id: `patch-${n++}`,
        asset: asset.id,
        layer: 'ground',
        x: Math.round(at.x),
        y: Math.round(at.y),
        scale: 0.7 + rng() * 0.6,
        flip: rng() < 0.5,
      });
    }
  }

  return out;
}
