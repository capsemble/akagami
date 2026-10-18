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
  Interactable,
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
import {
  checkBalance,
  compile,
  dressScene,
  dressingTagsFor,
  propFootprint,
  simulate,
} from '@chapter-quest/shared';
import { balanceBindings, balanceOf } from './balance.js';

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
  /**
   * Whether to scatter decorative crates in the corners. Default true.
   *
   * False for a room with a painted floor: the painting already has its own
   * clutter, and a generic drawn crate standing on top of it is the one thing
   * in the room that still looks like a placeholder.
   */
  furnish?: boolean;
  /**
   * Which dressing tags this room draws from. Absent reads them off the
   * scene's own name and description with `dressingTagsFor`.
   *
   * Dressing is scenery with no collider — see shared/dressing.ts — so this
   * changes what the room looks like and nothing about how it plays.
   */
  dressing?: string[];
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
  const spawn = placeSpawn(spec.exitSide, width, height, isRun, exits[0]!, interactables);
  const npcSpots = placeCast(options.castIds ?? [], { width, height, isRun, interactables, spawn });

  // Decoration goes in last and only if it changes nothing: a generated room
  // that looks furnished but strands the player is worse than a bare one.
  const furniture =
    options.furnish === false ? [] : cornerFurniture(width, height, seed, interactables, spawn);
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

  // Dressing goes on last and is deliberately outside the walkability check:
  // it produces no colliders, so there is nothing for the flood fill to find.
  // It reads the finished room, so the scatter can avoid the furniture that
  // was only just decided.
  const dress = (room: Scene): Scene => {
    const decorations = dressScene(room, {
      // Read off the room's own description unless the caller insists: a
      // candlelit library and a ravine toll-gate want different scenery, and
      // the design pass already wrote down which one this is.
      tags: options.dressing ?? dressingTagsFor(spec),
    });
    return decorations.length > 0 ? { ...room, dressing: decorations } : room;
  };

  if (walkable(scene).ok) return dress(scene);
  return dress({ ...scene, blocked });
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
 * What the player actually has to do, in order.
 *
 * Derived from the bindings rather than written by the model, for two reasons:
 * it costs nothing, and the bindings are the only thing that knows the truth.
 * A model asked for instructions will cheerfully tell the player to drag a
 * lever that the stage bound to a dial, and then the one piece of text whose
 * whole job is to be correct is the one that is wrong.
 */
export function stepsFor(stage: ActStage | undefined, scene: Scene): string[] {
  const steps: string[] = [];
  const named = (fallback: string, prompt?: string) => prompt ?? fallback;
  const binding = stage?.bindings[0];

  if (stage?.balance && binding?.kind === 'needle') {
    const dials = stage.bindings.length;
    const thing = stage.balance.across ? 'deck' : 'beam';
    steps.push(
      `Walk up to the ${thing} — WASD or the arrow keys.`,
      dials > 1
        ? 'Press E to take hold. Up and down pick what to move; left and right slide it.'
        : `Press E to take hold. Left and right slide the ${(binding.label ?? binding.param).split(' — ')[0]}.`,
      stage.balance.tilt
        ? `Press E again to let go of the ${thing} and watch which way it tips.`
        : 'Press E again to check where the centre of mass has landed.',
      'R puts everything back where it started.',
    );
    return steps;
  }

  switch (binding?.kind) {
    case 'needle': {
      const dials = stage?.bindings.filter((b) => b.kind === 'needle').length ?? 1;
      steps.push(
        `Walk up to ${named('the dial', binding.prompt)} — WASD or the arrow keys.`,
        'Press E to take hold of it.',
        binding.band
          ? `Left and right move the needle. It starts inside the ${binding.band.label ?? 'band'}, and the answer is not.`
          : 'Left and right move the needle.',
        ...(dials > 1
          ? [
              `Up and down pick which of the ${dials} dials you are holding — both have to be right.`,
            ]
          : []),
        'Press E again to commit to the reading.',
      );
      break;
    }
    case 'control': {
      // Anything set before the run is set at the board first.
      const set = (stage?.bindings ?? []).filter(
        (b): b is Extract<typeof b, { kind: 'needle' }> => b.kind === 'needle',
      );
      if (set.length > 0) {
        const names = set.map((b) => b.param.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase());
        steps.push(
          `Walk up to ${set[0]!.prompt ?? 'the board'} and press E to set the ${names.join(' and ')}. E again when it is set.`,
        );
      }
      const label = binding.label ?? 'brake';
      steps.push(
        `Press F to ${named('start the run', binding.prompt)}.`,
        label === 'brake'
          ? 'Hold SPACE to brake. When you let go decides where it stops.'
          : `Hold SPACE for full ${label}; let go and it drops to its lowest. When and how long you hold is the answer.`,
        'F runs it again and keeps the old attempts; R clears them.',
      );
      break;
    }
    case 'marker':
      steps.push(
        'Walk along the line to the point you want to act at.',
        `Press E to ${named('plant the marker', binding.prompt)}.`,
        'Press F to run it, R to move the marker and try again.',
      );
      break;
    case 'aim':
      steps.push(
        `Walk up to ${named('the launcher', binding.prompt)}.`,
        'Press E to take aim.',
        'Drag away from it and let go. Further is harder, higher is steeper.',
        'R to take the shot again.',
      );
      break;
    default:
      steps.push('Walk up to what the goal names and press E.');
  }

  const readable = Object.keys(stage?.readables ?? {})[0];
  if (readable) {
    const label = scene.interactables.find((it) => it.id === readable)?.label;
    steps.push(
      `E on the ${label ?? readable.replace(/[-_]/g, ' ')} reads it, if you want the detail.`,
    );
  }
  return steps;
}

/**
 * Objects along the far side of a room, or down the length of a hall. Both keep
 * the middle clear, because the middle is where the act is played.
 *
 * Each object is sized by what it is: `propFootprint` reads the design pass's
 * own words for it, so a notice board gets a wide shallow rect and a pillar a
 * square one, and the renderer draws into that same rect. The label and look
 * ride along for the same reason — without them every prop in a generated room
 * is the identical box in a different colour.
 */
function placeObjects(
  spec: SceneSpec,
  ctx: { width: number; height: number; isRun: boolean; seed: number },
): Interactable[] {
  const objects = spec.objects ?? [];
  if (objects.length === 0) return [];

  const left = WALL + MARGIN;
  const span = Math.max(0, ctx.width - WALL - MARGIN - left);

  // Pack the row with whatever is left over as even gaps. If the widths the
  // props asked for do not fit, every one of them shrinks to make them fit:
  // props that overlap mean E picks whichever the loop happened to see first.
  const wanted = objects.map((object) => propFootprint(object, PROP));
  const asked = wanted.reduce((sum, size) => sum + size.w, 0);
  const sizes =
    asked <= span
      ? wanted
      : wanted.map((size) => ({ ...size, w: Math.max(60, Math.floor((size.w * span) / asked)) }));
  const used = sizes.reduce((sum, size) => sum + size.w, 0);
  const gap = objects.length > 1 ? Math.max(0, (span - used) / (objects.length - 1)) : 0;

  let x = objects.length === 1 ? left + (span - used) / 2 : left;
  return objects.map((object, i) => {
    const size = sizes[i]!;
    // A hall keeps everything north of the lane; a room alternates rows so
    // four objects do not end up in a single line across the back.
    const y = ctx.isRun
      ? Math.round(ctx.height * 0.26)
      : Math.round(ctx.height * (i % 2 === 0 ? 0.16 : 0.44));
    const placed: Interactable = {
      id: object.id,
      label: object.label,
      look: object.look,
      x: Math.round(x),
      y,
      ...size,
    };
    x += size.w + gap;
    return placed;
  });
}

/**
 * Where the player arrives: the open spot furthest from the way out.
 *
 * It used to be beside the exit — same wall, 220 px in — so the door onward
 * was one step behind you. Now the exit is a gate that opens when the act is
 * won, and a gate you can back straight through is not a journey. Arrive on
 * the far side, cross the room past the act, leave.
 *
 * "Open" means clear of every prop and its name plate, and in a hall off the
 * lane a run is acted out along. A strict opposite-wall rule would not do: the
 * props stand in rows across the north half, and a north spawn lands in them.
 * If nothing qualifies, the old spot stands.
 */
function placeSpawn(
  side: SceneSpec['exitSide'],
  width: number,
  height: number,
  isRun: boolean,
  exit: Rect,
  interactables: Interactable[],
): Point {
  const inset = WALL + 220;
  const candidates: Point[] = [
    { x: width / 2, y: height - inset },
    { x: inset, y: height - inset },
    { x: width - inset, y: height - inset },
    { x: inset, y: height / 2 },
    { x: width - inset, y: height / 2 },
    { x: width / 2, y: inset },
    { x: inset, y: inset },
    { x: width - inset, y: inset },
  ].map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) }));
  const lane = Math.round(height * 0.52);
  const open = candidates.filter(
    (p) =>
      !interactables.some((it) => contains(it, p, 90)) && !(isRun && Math.abs(p.y - lane) < 110),
  );
  if (open.length === 0) return besideTheDoor(side, width, height, isRun);

  const ex = exit.x + exit.w / 2;
  const ey = exit.y + exit.h / 2;
  const far = (p: Point) => Math.hypot(p.x - ex, p.y - ey);
  return open.reduce((best, p) => (far(p) > far(best) ? p : best));
}

/** The spawn as it was: by the door. Only for a room with nowhere better. */
function besideTheDoor(
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
    interactables: Interactable[];
    spawn: Point;
  },
): Record<string, Point> {
  const spots: Record<string, Point> = {};
  const standing = castIds.slice(0, 4);
  const base = ctx.isRun ? 0.72 : 0.62;
  standing.forEach((id, i) => {
    // Across most of the room, not huddled in the middle third. Four people
    // packed into 40% of a hall put their name plates on top of each other,
    // and the plates are the only way to tell who is who.
    const t = standing.length === 1 ? 0.5 : 0.14 + (0.72 * i) / Math.max(1, standing.length - 1);
    // Staggered in depth too, so neighbours are never on the same screen line.
    const row = base + (i % 2 === 0 ? 0 : ctx.isRun ? 0.1 : 0.12);
    spots[id] = { x: Math.round(ctx.width * t), y: Math.round(ctx.height * row) };
  });
  return spots;
}

/** Two blocks in the far corners: furniture that cannot get in anyone's way. */
function cornerFurniture(
  width: number,
  height: number,
  seed: number,
  interactables: Interactable[],
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
/**
 * How long the route has to be.
 *
 * Solution and default only. Including the dial at its maximum made act three
 * of a coal world a 450m lane for an 8m target band — the winning stop was
 * under two per cent of the track and the player could not see where they were
 * aiming. A dial wound to its extreme is not the journey the act is about, and
 * an overshoot drawn past the end of the lane is already how losing reads.
 */
function reach(spec: SimSpec, params: ParamSpec[], along: string): number {
  const expr = compile(along);
  let furthest = 0;
  for (const pick of ['solution', 'default'] as const) {
    const dials = Object.fromEntries(params.map((p) => [p.name, p[pick]]));
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
  return furthest > 0 ? Math.ceil((furthest * 1.3) / 5) * 5 : 100;
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
  act: {
    verbs?: Verb[];
    mechanic?: Mechanic;
    title?: string;
    goal?: string;
    dialogue?: { line: string }[];
  },
): ActStage | undefined {
  if (act.mechanic?.type !== 'formula') return undefined;
  const { spec, params } = act.mechanic;
  const verbs = act.verbs ?? [];
  const first = params[0];
  if (!first) return undefined;

  // A balance is asked of the physics before the verbs, like `travels` below:
  // the writers' room tagged a centre-of-mass act `plant_marker`, and got a
  // train driven along a rail line by the beam's angle.
  // Validated before it is trusted: a balance whose loads leave the beam or
  // whose names point at nothing is not drawn; the act keeps its plain dials.
  const found = balanceOf(scene, spec, params, act);
  const balance = found && checkBalance(found, spec, params).length === 0 ? found : null;
  if (balance) {
    const judged = verdictReadout(spec);
    const readout =
      judged && judged.label.startsWith('centre of mass') && balance.beam.unit
        ? { ...judged, unit: ` ${balance.beam.unit}` }
        : judged;
    return {
      bindings: balanceBindings(balance, params),
      balance,
      ...(readout ? { readout } : {}),
    };
  }

  const along = alongKey(spec);
  const lane = (toValue: number): WorldPath => ({
    from: { x: WALL + 220, y: Math.round(scene.height * 0.52) },
    to: { x: scene.width - WALL - 110, y: Math.round(scene.height * 0.52) },
    fromValue: 0,
    toValue,
    unit: 'm',
  });

  const readout = verdictReadout(spec);
  const stage = (bindings: ParamBinding[], playback?: Playback): ActStage => ({
    bindings,
    ...(playback ? { playback } : {}),
    ...(readout ? { readout } : {}),
  });

  // The board: the first prop, named in the prompt. "E — the board" in a room
  // with a winch dial and a weighbridge plate tells the player nothing about
  // which to walk to, and a generated room always has more props than bindings.
  const board = scene.interactables[0];
  const at = board ? { x: board.x + board.w / 2, y: board.y + board.h + 60 } : { ...scene.spawn };
  const named = board?.label?.trim() || board?.id.replace(/[-_]/g, ' ');
  // One dial per param, not one dial full stop — a param left frozen at its
  // default is how acts ship that nobody can win. Three is the ceiling: past
  // that it stops being an instrument and starts being a spreadsheet.
  const dials = (list: ParamSpec[]): ParamBinding[] =>
    list.slice(0, 3).map((param) => ({
      kind: 'needle',
      param: param.name,
      at,
      prompt: named ? named.toLowerCase() : 'the board',
    }));

  // Where a run is acted out. Up a shaft for something that rises; on rails
  // only for something that runs on them; along a plain lane otherwise. Every
  // drive act used to be a locomotive on rails — a service lift going up 80 m
  // was a train rolling 80 m across the floor.
  const playbackFor = (toValue: number, extra: Partial<Playback> = {}): Playback => {
    if (along && rises(along, scene, act)) {
      return {
        actor: 'body',
        track: 'lane',
        shaft: true,
        ...(descends(act) ? { descends: true } : {}),
        path: shaftPath(scene, toValue),
        along,
        ...extra,
      };
    }
    const rolling = onRails(scene, act);
    // A load that slides starts where the room shows it standing, when there
    // is floor enough beyond it for the run to read.
    const cargo = rolling ? undefined : movingProp(scene);
    const start = cargo
      ? { x: Math.round(cargo.x + cargo.w / 2), y: Math.round(cargo.y + cargo.h / 2) }
      : null;
    const end = scene.width - WALL - 110;
    const path =
      start && end - start.x >= 600
        ? { ...lane(toValue), from: start, to: { x: end, y: start.y } }
        : lane(toValue);
    return {
      actor: rolling ? 'train' : 'body',
      track: rolling ? 'rails' : 'lane',
      path,
      along: along!,
      ...extra,
    };
  };

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
    // SPACE goes on the param the hand actually holds during the run — a
    // thrust, a pull, a brake — not on whichever was written first. The lift
    // act put SPACE on the lift's *mass*: hold it and the cage weighed 900 kg.
    const held =
      params.find((p) => controlledDuring(p, spec)) ??
      params.find((p) => CONTROL_WORDS.test(p.name) && !PROPERTY_WORDS.test(p.name)) ??
      first;
    return stage(
      [
        {
          kind: 'control',
          param: held.name,
          held: held.max,
          label: humanise(held.name),
          prompt: 'start the run',
        },
        // Everything else is the situation: set at the board, then lived with.
        ...dials(params.filter((p) => p !== held)),
      ],
      playbackFor(reach(spec, params, along)),
    );
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
    return stage(
      [{ kind: 'marker', param: first.name, path: markerPath }],
      playbackFor(full.toValue, { seconds: 3.2 }),
    );
  }

  // Everything else is a dial you stand at: a deduction, a tuning, a reading.
  const needles = dials(params);

  // A dial with something to watch beats a dial with a verdict.
  //
  // Playback used to be decided by the verb — drive, aim_launch, plant_marker
  // — and every other act got a needle, a number and a win or a loss. But the
  // verb is a label the writers' room picked; whether there is anything to see
  // is a property of the simulation. A coal cage on a cable, a lorry pulling
  // away, a wagon winched to a stop: all three integrate a velocity into a
  // position over seconds, all three were animatable, and all three were
  // played as "turn the knob, read the result" because the verb said 'tune'.
  //
  // So ask the physics instead. If the body actually goes somewhere, lay the
  // route out and act the run out along it.
  if (along && travels(spec, params, along)) {
    // A control stays in the player's hand while the body moves. Everything
    // else is still set at the board and lived with, so one act can be both:
    // pick the load, then drive it.
    const driven = needles.map((needle) => {
      const param = needle.kind === 'needle' ? params.find((p) => p.name === needle.param) : null;
      return param && controlledDuring(param, spec) ? { ...needle, live: true } : needle;
    });
    return stage(driven, playbackFor(reach(spec, params, along), { seconds: 3 }));
  }

  return stage(needles);
}

/** Names that are a hand on a control: something you push, pull or open. */
const CONTROL_WORDS =
  /(tension|pull|thrust|force|throttle|brake|power|push|torque|valve|pump|heat|burn|drive|assigned|workers|servers|staff|open)/i;
/** Names that are the situation: what you are handed, not what you do. */
const PROPERTY_WORDS =
  /(^claimed|mass|tonne|weight|length|radius|height|width|area|density|sigma|multiplier|pct|percent|ratio|count|size|capacity|limit|max|min|k$)/i;

/**
 * Can the player meaningfully change this param while the run is playing?
 *
 * Two tests, in order. First the physics: if no step equation reads it, moving
 * it mid-run changes nothing mid-run, and a control that does nothing is worse
 * than a dial. Then intent, which the maths cannot supply — a mass sits in the
 * step equations exactly where a force does. The act writer says which it
 * meant when it says anything; worlds written before it could fall back on the
 * name, conservatively: anything not plainly a control stays a choice.
 *
 * Making a needle live never makes an act harder to win. Set it to the
 * solution before the run and leave it alone, and the live run is the same
 * run the validator scored — `Run` steps both.
 */
export function controlledDuring(param: ParamSpec, spec: SimSpec): boolean {
  const name = new RegExp(`\\b${param.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
  if (!Object.values(spec.step).some((expr) => name.test(expr))) return false;
  if (param.when) return param.when === 'during';
  return CONTROL_WORDS.test(param.name) && !PROPERTY_WORDS.test(param.name);
}

/**
 * Does the thing that moves here run on rails?
 *
 * Asked of the act's own words and the props in the room, because a track is
 * the most specific-looking object this renderer can draw and getting it wrong
 * is loud: a coal cage on a cable does not need sleepers under it, and a
 * lorry pulling away from a checkpost needs them even less.
 */
function onRails(scene: Scene, act: { title?: string; goal?: string }): boolean {
  const words = [
    act.title ?? '',
    act.goal ?? '',
    ...scene.interactables.map((it) => `${it.id} ${it.label ?? ''}`),
  ]
    .join(' ')
    .toLowerCase();
  return /\b(rail|rails|railway|track|siding|wagon|train|locomotive|trolley|tram|bogie|shunt)/.test(
    words,
  );
}

/**
 * Does the thing that moves here go *up*? Asked of the state it travels along
 * first — a run along `y` with no `x` is a height — then of the act's words.
 */
function rises(along: string, scene: Scene, act: { title?: string; goal?: string }): boolean {
  if (/^(y|z|h|alt|height|altitude|elevation)$/i.test(along)) return true;
  if (/^x$/i.test(along)) return false;
  const words = [
    act.title ?? '',
    act.goal ?? '',
    ...scene.interactables.map((it) => `${it.id} ${it.label ?? ''}`),
  ]
    .join(' ')
    .toLowerCase();
  return /\b(lift|elevator|hoist|cage|rocket|balloon|ascen\w*|climb\w*)\b/.test(words);
}

/**
 * The prop that is the thing being moved, if the room has one: a case, a
 * crate, a cart. Never the first prop, which is the board the dials sit at.
 */
function movingProp(scene: Scene): Interactable | undefined {
  return scene.interactables
    .slice(1)
    .find((it) =>
      /\b(case|crate|cart|wagon|sled|sledge|box|block|trolley|lorry|truck|cargo|chest|safe|load)\b/i.test(
        `${it.id.replace(/[-_]/g, ' ')} ${it.label ?? ''}`,
      ),
    );
}

/** Does the act send it down — a cage lowered, a load sunk — rather than up? */
function descends(act: { title?: string; goal?: string }): boolean {
  return /\b(descen\w*|lower\w*|downward\w*|sink\w*|plung\w*|depth|pit)\b/i.test(
    `${act.title ?? ''} ${act.goal ?? ''}`,
  );
}

/**
 * A shaft rising out of the room. Stood on the prop the act is about when the
 * room has one — the painted lift cage is where the lift goes up from — and in
 * the middle of the floor when it does not.
 */
function shaftPath(scene: Scene, top: number): WorldPath {
  const prop = scene.interactables.find((it) =>
    /(lift|elevator|cage|hoist|shaft|rocket|balloon|crane)/i.test(`${it.id} ${it.label ?? ''}`),
  );
  const base = prop
    ? { x: Math.round(prop.x + prop.w / 2), y: Math.round(prop.y + prop.h / 2) }
    : { x: Math.round(scene.width / 2), y: Math.round(scene.height / 2) };
  return { from: base, to: base, fromValue: 0, toValue: top, unit: 'm' };
}

/**
 * The one number worth saying out loud when a run ends.
 *
 * It used to be whichever output happened to be declared first, labelled
 * "reached" and measured in metres — so an act judged on speed drift reported
 * "reached 2.0m" about a velocity. Feedback you cannot trust is worse than no
 * feedback, because the player believes it and tunes the wrong way.
 *
 * So take the output the win condition actually names, and get the units from
 * what it is rather than from what the first branch of this file assumed.
 */
function verdictReadout(spec: SimSpec): ActStage['readout'] {
  const outputs = Object.keys(spec.outputs);
  if (outputs.length === 0) return undefined;
  const judged = outputs.find((name) => new RegExp(`\\b${name}\\b`).test(spec.win)) ?? outputs[0]!;

  // Matched on the humanised form: "finalV" lowercases to "finalv", where the
  // v is just another letter in the middle of a word, and the velocity goes
  // out unitless. "final v" has a word to match.
  const lower = humanise(judged);
  // Before the position test below, which reads the x in "com x" as a distance
  // travelled and reported a centre of mass as "reached 50m".
  if (/(centre|center|(^|\s)com(\s|$)|(^|\s)cm(\s|$))/.test(lower)) {
    const axis = / y$/.test(lower) ? ' (across)' : '';
    return { output: judged, label: `centre of mass${axis}` };
  }
  if (/(torque|moment)/.test(lower)) return { output: judged, label: lower };
  if (/(^|[^a-z])(v|speed|velocity|drift|rate)/.test(lower)) {
    return { output: judged, label: humanise(judged), unit: ' m/s' };
  }
  if (/(x|y|dist|stop|land|reach|pos|travel)/.test(lower)) {
    return { output: judged, label: 'reached', unit: 'm' };
  }
  if (/(time|secs|seconds|flight|eta)/.test(lower)) {
    return { output: judged, label: humanise(judged), unit: 's' };
  }
  // Unitless by default: a ratio reported in metres is a lie with a decimal
  // point on it.
  return { output: judged, label: humanise(judged) };
}

const humanise = (name: string): string =>
  name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[-_]/g, ' ')
    .toLowerCase();

/**
 * Does this simulation actually move anything?
 *
 * Measured, not parsed: run it at the dial settings that matter and see how
 * far `along` ranges. An expression that only ever computes a number — an
 * implied speed, a ratio — stays still, and animating a body that does not
 * move would be a worse lie than not animating it at all.
 */
function travels(spec: SimSpec, params: ParamSpec[], along: string): boolean {
  const expr = compile(along);
  for (const pick of ['solution', 'default'] as const) {
    const dials = Object.fromEntries(params.map((p) => [p.name, p[pick]]));
    try {
      const run = simulate(spec, dials, { trace: 40 });
      let low = Infinity;
      let high = -Infinity;
      for (const sample of run.samples) {
        const value = expr.evaluate(sample);
        if (!Number.isFinite(value)) continue;
        low = Math.min(low, value);
        high = Math.max(high, value);
      }
      // One body-length of travel. Below that it is drift, not a journey.
      if (high - low >= 2) return true;
    } catch {
      // A spec that blows up on one dial set still has the other to learn from.
    }
  }
  return false;
}
