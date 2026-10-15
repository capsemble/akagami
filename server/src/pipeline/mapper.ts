/**
 * SceneSpec → Scene. The missing link.
 *
 * The design pipeline describes a room in prose — a name, a few objects, which
 * wall the door is on. The game needs a plane with collider rectangles, an
 * exit, a spawn and somewhere for each character to stand. Nothing converted
 * one into the other, so a generated world arrived with acts, dialogue and a
 * twist and no room to walk around in.
 *
 * This is deliberately **not** a model call. Three reasons:
 *
 * 1. A layout is a constraint problem, not a creative one. Walls must enclose,
 *    props must not overlap, and the spawn must reach every interactable. A
 *    sampler gets that wrong occasionally and occasionally is fatal.
 * 2. It costs no quota, so a chapter can be turned into a playable room when
 *    the image and design models are rate-limited to nothing.
 * 3. It is checkable. `walkable()` floods the finished plane and proves the
 *    player can reach everything the act asks them to touch — the guarantee
 *    the build story has always claimed under "Scene QA".
 *
 * Same spec in, same room out: every choice is driven by a hash of the scene
 * id, so a world does not rearrange itself between runs.
 */
import type {
  ActStage,
  Mechanic,
  ParamBinding,
  ParamSpec,
  Playback,
  Point,
  Rect,
  Scene,
  SceneSpec,
  SimSpec,
  Verb,
  WorldPath,
} from '@chapter-quest/shared';
import { compile, simulate } from '@chapter-quest/shared';

const WALL = 40;
/** Keeps props off the walls so the player can always walk behind them. */
const MARGIN = 170;
/** Footprint of a placed object. */
const PROP = { w: 180, h: 110, height: 120 };
/** Flood-fill cell size, and how far a body is inflated off a wall. */
const CELL = 40;
const BODY = 24;

/** Acts that travel need a hall; everything else gets a room. */
const RUN_VERBS: Verb[] = ['drive', 'plant_marker', 'aim_launch'];

export interface MapOptions {
  /** How the act is played. Decides the shape of the room. */
  verbs?: Verb[];
  /** Characters who need somewhere to stand. */
  castIds?: string[];
}

const HALL = { width: 2000, height: 900 };
const ROOM = { width: 1400, height: 1100 };

/** Stable per scene id, so a world keeps the same shape between runs. */
function seedOf(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function mapScene(spec: SceneSpec, sceneId: string, options: MapOptions = {}): Scene {
  const verbs = options.verbs ?? [];
  const isRun = verbs.some((v) => RUN_VERBS.includes(v));
  const { width, height } = isRun ? HALL : ROOM;
  const seed = seedOf(sceneId);

  const blocked: Rect[] = [
    { x: 0, y: 0, w: width, h: WALL, height: 120 },
    { x: 0, y: height - WALL, w: width, h: WALL, height: 120 },
    { x: 0, y: WALL, w: WALL, h: height - WALL * 2, height: 120 },
    { x: width - WALL, y: WALL, w: WALL, h: height - WALL * 2, height: 120 },
  ];

  const exits = [exitRect(spec.exitSide, width, height)];
  const interactables = placeObjects(spec, { width, height, isRun, seed });
  const spawn = placeSpawn(spec.exitSide, width, height, isRun);
  const npcSpots = placeCast(options.castIds ?? [], { width, height, isRun, interactables, spawn });

  // Decoration goes in last and only if it changes nothing: a generated room
  // that looks furnished but strands the player is worse than a bare one.
  const furniture = cornerFurniture(width, height, seed, interactables, spawn);
  // No imageUrl: nothing has painted this room. WorldScene draws the plane
  // itself rather than requesting an SVG that was never generated.
  const scene: Scene = {
    id: sceneId,
    projection: 'isometric',
    width,
    height,
    blocked: [...blocked, ...furniture],
    interactables,
    exits,
    spawn,
    npcSpots,
  };

  if (walkable(scene).ok) return scene;
  return { ...scene, blocked };
}

function exitRect(side: SceneSpec['exitSide'], width: number, height: number): Rect {
  const w = 160;
  switch (side) {
    case 'north':
      return { x: (width - w) / 2, y: WALL, w, h: 60 };
    case 'south':
      return { x: (width - w) / 2, y: height - WALL - 60, w, h: 60 };
    case 'west':
      return { x: WALL, y: (height - w) / 2, w: 60, h: w };
    case 'east':
    default:
      return { x: width - WALL - 60, y: (height - w) / 2, w: 60, h: w };
  }
}

/**
 * Objects along the far side of a room, or down the length of a hall. Both keep
 * the middle clear, because the middle is where the act is played.
 */
function placeObjects(
  spec: SceneSpec,
  ctx: { width: number; height: number; isRun: boolean; seed: number },
): (Rect & { id: string })[] {
  const objects = spec.objects ?? [];
  if (objects.length === 0) return [];

  const left = WALL + MARGIN;
  const right = ctx.width - WALL - MARGIN - PROP.w;
  const span = Math.max(0, right - left);

  return objects.map((object, i) => {
    const t = objects.length === 1 ? 0.5 : i / (objects.length - 1);
    const x = Math.round(left + span * t);
    // A hall keeps everything north of the lane; a room alternates rows so
    // four objects do not end up in a single line across the back.
    const y = ctx.isRun
      ? Math.round(ctx.height * 0.26)
      : Math.round(ctx.height * (i % 2 === 0 ? 0.16 : 0.44));
    return { id: object.id, x, y, w: PROP.w, h: PROP.h, height: PROP.height };
  });
}

function placeSpawn(
  side: SceneSpec['exitSide'],
  width: number,
  height: number,
  isRun: boolean,
): Point {
  if (isRun) return { x: WALL + 260, y: Math.round(height * 0.7) };
  const inset = WALL + 220;
  switch (side) {
    case 'north':
      return { x: Math.round(width / 2), y: inset };
    case 'west':
      return { x: inset, y: Math.round(height / 2) };
    case 'east':
      return { x: width - inset, y: Math.round(height / 2) };
    case 'south':
    default:
      return { x: Math.round(width / 2), y: height - inset };
  }
}

function placeCast(
  castIds: string[],
  ctx: {
    width: number;
    height: number;
    isRun: boolean;
    interactables: (Rect & { id: string })[];
    spawn: Point;
  },
): Record<string, Point> {
  const spots: Record<string, Point> = {};
  const y = Math.round(ctx.height * (ctx.isRun ? 0.72 : 0.62));
  castIds.slice(0, 4).forEach((id, i) => {
    const t = castIds.length === 1 ? 0.5 : 0.3 + (0.4 * i) / Math.max(1, castIds.length - 1);
    spots[id] = { x: Math.round(ctx.width * t), y };
  });
  return spots;
}

/** Two blocks in the far corners: furniture that cannot get in anyone's way. */
function cornerFurniture(
  width: number,
  height: number,
  seed: number,
  interactables: (Rect & { id: string })[],
  spawn: Point,
): Rect[] {
  const size = 150 + (seed % 3) * 30;
  const candidates: Rect[] = [
    { x: WALL + 30, y: WALL + 30, w: size, h: size, height: 110 },
    { x: width - WALL - 30 - size, y: WALL + 30, w: size, h: size, height: 110 },
  ];
  return candidates.filter(
    (rect) => !interactables.some((it) => overlaps(rect, it, 70)) && !contains(rect, spawn, 90),
  );
}

const overlaps = (a: Rect, b: Rect, pad = 0) =>
  a.x - pad < b.x + b.w && a.x + a.w + pad > b.x && a.y - pad < b.y + b.h && a.y + a.h + pad > b.y;

const contains = (r: Rect, p: Point, pad = 0) =>
  p.x >= r.x - pad && p.x <= r.x + r.w + pad && p.y >= r.y - pad && p.y <= r.y + r.h + pad;

/**
 * Can the player actually reach everything the act asks them to touch?
 *
 * Floods the plane on a coarse grid with the walls inflated by the body radius,
 * starting at the spawn. This is the check the agent trace has always claimed
 * under "Scene QA: walkability passed".
 */
export function walkable(scene: Scene): { ok: boolean; unreachable: string[] } {
  const cols = Math.ceil(scene.width / CELL);
  const rows = Math.ceil(scene.height / CELL);
  const blockedCell = (cx: number, cy: number) => {
    const x = cx * CELL + CELL / 2;
    const y = cy * CELL + CELL / 2;
    return scene.blocked.some((r) => contains(r, { x, y }, BODY));
  };

  const cellOf = (p: Point) => ({
    cx: Math.min(cols - 1, Math.max(0, Math.floor(p.x / CELL))),
    cy: Math.min(rows - 1, Math.max(0, Math.floor(p.y / CELL))),
  });

  const seen = new Set<number>();
  const start = cellOf(scene.spawn);
  if (blockedCell(start.cx, start.cy)) return { ok: false, unreachable: ['spawn'] };

  const queue: [number, number][] = [[start.cx, start.cy]];
  seen.add(start.cy * cols + start.cx);
  while (queue.length > 0) {
    const [cx, cy] = queue.shift()!;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
      const key = ny * cols + nx;
      if (seen.has(key) || blockedCell(nx, ny)) continue;
      seen.add(key);
      queue.push([nx, ny]);
    }
  }

  /** A target counts as reached if any cell it covers was flooded. */
  const reached = (label: string, p: Point): string | null => {
    for (const [dx, dy] of [
      [0, 0],
      [CELL, 0],
      [-CELL, 0],
      [0, CELL],
      [0, -CELL],
    ] as const) {
      const c = cellOf({ x: p.x + dx, y: p.y + dy });
      if (seen.has(c.cy * cols + c.cx)) return null;
    }
    return label;
  };

  const unreachable = [
    ...scene.interactables.map((it) => reached(it.id, { x: it.x + it.w / 2, y: it.y + it.h / 2 })),
    ...Object.entries(scene.npcSpots).map(([id, p]) => reached(`npc:${id}`, p)),
    ...scene.exits.map((e, i) => reached(`exit:${i}`, { x: e.x + e.w / 2, y: e.y + e.h / 2 })),
  ].filter((x): x is string => x !== null);

  return { ok: unreachable.length === 0, unreachable };
}

// ---------------------------------------------------------------------------
// Binding the act to the room that was just built for it.
// ---------------------------------------------------------------------------

/**
 * How far the run actually goes, in sim units, so the lane can be drawn to
 * scale. Measured rather than guessed: simulate at the solution and at the
 * defaults and take the furthest either reaches, with headroom for an overshoot.
 */
function reach(spec: SimSpec, params: ParamSpec[], along: string): number {
  const expr = compile(along);
  let furthest = 0;
  for (const pick of ['solution', 'default', 'max'] as const) {
    const dials = Object.fromEntries(params.map((p) => [p.name, pick === 'max' ? p.max : p[pick]]));
    try {
      const run = simulate(spec, dials, { trace: 40 });
      for (const sample of run.samples) {
        const value = expr.evaluate(sample);
        if (Number.isFinite(value)) furthest = Math.max(furthest, value);
      }
    } catch {
      // a spec that blows up on one dial set still has the others to learn from
    }
  }
  return furthest > 0 ? Math.ceil((furthest * 1.12) / 5) * 5 : 100;
}

/** The state key a run travels along. `x` by convention, else the first one. */
function alongKey(spec: SimSpec): string | null {
  const keys = Object.keys(spec.state);
  if (keys.includes('x')) return 'x';
  return keys[0] ?? null;
}

/**
 * Bind a formula act to the room it was given.
 *
 * The verbs already say how the act is meant to be played — they have been in
 * the type since the start and nothing ever read them. `drive` is a control you
 * hold, `plant_marker` is a place you walk to, `aim_launch` is a vector you
 * drag, and a deduction is a needle you push. That is the whole mapping.
 */
export function bindStage(
  scene: Scene,
  act: { verbs?: Verb[]; mechanic?: Mechanic },
): ActStage | undefined {
  if (act.mechanic?.type !== 'formula') return undefined;
  const { spec, params } = act.mechanic;
  const verbs = act.verbs ?? [];
  const first = params[0];
  if (!first) return undefined;

  const along = alongKey(spec);
  const lane = (toValue: number): WorldPath => ({
    from: { x: WALL + 220, y: Math.round(scene.height * 0.52) },
    to: { x: scene.width - WALL - 110, y: Math.round(scene.height * 0.52) },
    fromValue: 0,
    toValue,
    unit: 'm',
  });

  const readout = Object.keys(spec.outputs)[0];
  const stage = (bindings: ParamBinding[], playback?: Playback): ActStage => ({
    bindings,
    ...(playback ? { playback } : {}),
    ...(readout ? { readout: { output: readout, label: 'reached', unit: 'm' } } : {}),
  });

  if (verbs.includes('aim_launch') && params.length >= 2 && along) {
    const anchor = scene.interactables[0];
    const at = anchor
      ? { x: anchor.x + anchor.w / 2, y: anchor.y + anchor.h / 2 }
      : { ...scene.spawn };
    const lift = Object.keys(spec.state).includes('y') ? 'y' : undefined;
    const path = lane(reach(spec, params, along));
    return stage(
      [{ kind: 'aim', at, paramX: params[0]!.name, paramY: params[1]!.name, maxDrag: 170 }],
      {
        actor: 'satchel',
        path,
        along,
        ...(lift ? { lift, liftScale: 14 } : {}),
        seconds: 2.2,
      },
    );
  }

  if (verbs.includes('drive') && along) {
    return stage([{ kind: 'control', param: first.name, held: first.max, prompt: 'let her go' }], {
      actor: 'train',
      path: lane(reach(spec, params, along)),
      along,
    });
  }

  if (verbs.includes('plant_marker') && along) {
    const full = lane(reach(spec, params, along));
    const fraction = full.toValue > 0 ? Math.min(1, first.max / full.toValue) : 1;
    const markerPath: WorldPath = {
      ...full,
      to: {
        x: Math.round(full.from.x + (full.to.x - full.from.x) * fraction),
        y: full.to.y,
      },
      fromValue: first.min,
      toValue: first.max,
    };
    return stage([{ kind: 'marker', param: first.name, path: markerPath }], {
      actor: 'train',
      path: full,
      along,
      seconds: 3.2,
    });
  }

  // Everything else is a dial you stand at: a deduction, a tuning, a reading.
  const board = scene.interactables[0];
  const at = board ? { x: board.x + board.w / 2, y: board.y + board.h + 60 } : { ...scene.spawn };
  return stage([{ kind: 'needle', param: first.name, at, prompt: 'the board' }]);
}
