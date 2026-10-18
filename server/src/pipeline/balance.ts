/**
 * Recognising a balance, and laying one out.
 *
 * A centre-of-mass act used to be staged as a journey: the knife-edge became a
 * marker on a rail line, and the run was a train driven along it by the beam's
 * *angle*. Nothing in the room looked like the thing the chapter was about.
 *
 * Nothing here is a model call or a bespoke world. A balance is read off the
 * simulation the writers' room already produced: masses multiplied by
 * positions, a support the masses are measured against, and either a tilt that
 * evolves or a centre of mass that is judged. Any chapter on levers, moments,
 * see-saws or centres of mass produces that shape, and gets a beam.
 */
import type {
  ActStage,
  Balance,
  BalanceLoad,
  Mechanic,
  ParamBinding,
  ParamSpec,
  Point,
  Rect,
  Scene,
  SimSpec,
} from '@chapter-quest/shared';
import { evaluate, simulate } from '@chapter-quest/shared';

const WALL = 40;

const MASS_NAME = /(^m_?\d*$|mass|weight|load|^w_?\d+$|kg)/i;
/** Something pressing or hanging on a lever, given in newtons rather than kilograms. */
const FORCE_NAME = /(force|thrust|push|pull|tension|bag)/i;
const POSITION_NAME = /(^[xyrd]_?\d*$|^[xy]_?[a-z]?\d|arm|pos|dist|length|lever|offset)/i;
const PIVOT_NAME = /(knife|pivot|fulcrum|support|pier|axle|hinge|wedge|prop(?!ort))/i;
const TILT_NAME = /^(angle|tilt|theta|phi)$|angle|tilt/i;
const COM_NAME = /(com|centre|center|^cm|cm$|cog)/i;
const TORQUE_NAME = /(torque|moment)/i;

/** What the stage needs from the act besides its mechanic: its own words. */
export interface ActWords {
  title?: string;
  goal?: string;
  dialogue?: { line: string }[];
}

/**
 * The balance in this simulation, if it is one.
 *
 * Masses times positions are the loads. A name like `knifePos` or `pierX` is
 * the support. A state called `angle` is the tilt, and an output called `comX`
 * is the centre of mass. Needs loads, and needs either a tilt or a centre of
 * mass — a mass times a distance on its own is just as often an energy.
 */
export function balanceOf(
  scene: Scene,
  spec: SimSpec,
  params: ParamSpec[],
  act: ActWords,
): Balance | null {
  const known = new Set([...Object.keys(spec.constants), ...params.map((p) => p.name)]);
  const sources = [
    ...Object.values(spec.state),
    ...Object.values(spec.step),
    ...Object.values(spec.outputs),
    spec.win,
  ];

  const loads = new Map<string, BalanceLoad>();
  for (const source of sources) {
    for (const [mass, position, negated] of products(source)) {
      if (!known.has(mass) || !known.has(position)) continue;
      const load = loads.get(mass) ?? { mass, at: '0' };
      const across = /^y/i.test(position);
      if (across) load.atY ??= position;
      else if (load.at === '0') load.at = negated ? `-${position}` : position;
      loads.set(mass, load);
    }
  }
  // A lever written in arms rather than positions — `boltForce * pivotDist`
  // and `bagForce * (beamLength - pivotDist)`, the pivot measured from one end.
  // Then the first load sits at that end (0) and the second at the far end.
  const armPivot = [...known].find((name) => PIVOT_NAME.test(name) && !isAcross(name));
  if (loads.size === 0 && armPivot) {
    for (const source of sources) {
      for (const [load, at] of armProducts(source, armPivot)) {
        if (!known.has(load) || (at !== '0' && !known.has(at)) || loads.has(load)) continue;
        const force = FORCE_NAME.test(load) && !MASS_NAME.test(load);
        loads.set(load, { mass: load, at, ...(force ? { force: true } : {}) });
      }
    }
  }
  if (loads.size === 0) return null;

  const tiltKey = Object.keys(spec.state).find((key) => TILT_NAME.test(key));
  const named = [...Object.keys(spec.outputs), ...Object.keys(spec.state)];
  const comKeys = named.filter((key) => COM_NAME.test(key) && !TILT_NAME.test(key));
  const comAlong = comKeys.find((key) => !isAcross(key));
  const comAcross = comKeys.find((key) => isAcross(key));
  if (!tiltKey && !comAlong) return null;

  const pivots = [...known].filter((name) => PIVOT_NAME.test(name));
  const pivotAlong = pivots.find((name) => !isAcross(name)) ?? '0';
  const pivotAcross = pivots.find((name) => isAcross(name));

  // The torque the act judges, split into the loads it already found and the
  // constant terms left over. Those are real turning effects with no arm of
  // their own, so they are drawn as what they are rather than given a mass.
  const torque = Object.entries(spec.outputs).find(([name]) => TORQUE_NAME.test(name))?.[1];
  const moments = torque ? momentTerms(torque, spec) : { plus: [], minus: [] };

  const text = [act.title, act.goal, ...(act.dialogue ?? []).map((d) => d.line)]
    .join(' ')
    .toLowerCase();
  const units = unitsFrom(text);

  const labelled = labelLoads([...loads.values()], scene);
  const all: BalanceLoad[] = [...labelled];

  // How far the beam has to reach: every place a load or the support can be.
  const values: number[] = [];
  const reach = (expr: string) => values.push(...envelope(expr, spec, params));
  for (const load of labelled) reach(load.at);
  if (pivotAlong !== '0') reach(pivotAlong);
  else values.push(0);
  let from = Math.min(...values);
  let to = Math.max(...values);
  if (moments.plus.length || moments.minus.length) {
    // A moment acts at an end, so the beam needs two of them around the axle.
    const half = Math.max(Math.abs(from), Math.abs(to), 1);
    from = -half;
    to = half;
  }
  const pad = Math.max((to - from) * 0.08, 0.5);
  const step = niceStep(to - from + pad * 2);
  from = Math.floor((from - pad) / step) * step;
  to = Math.ceil((to + pad) / step) * step;

  if (moments.plus.length) all.push(momentLoad(moments.plus, `${to}`));
  if (moments.minus.length) all.push(momentLoad(moments.minus, `${from}`));

  const twoD = labelled.some((load) => load.atY) && (comAcross || pivotAcross);
  if (twoD) {
    const ys: number[] = [];
    for (const load of labelled) if (load.atY) ys.push(...envelope(load.atY, spec, params));
    if (pivotAcross) ys.push(...envelope(pivotAcross, spec, params));
    let yFrom = Math.min(...ys);
    let yTo = Math.max(...ys);
    const yPad = Math.max((yTo - yFrom) * 0.08, 0.5);
    yFrom = Math.floor((yFrom - yPad) / step) * step;
    yTo = Math.ceil((yTo + yPad) / step) * step;
    const deck = deckSquare(scene, (yTo - yFrom) / (to - from));
    return {
      beam: {
        from: { x: deck.x, y: deck.y },
        to: { x: deck.x + deck.w, y: deck.y },
        fromValue: from,
        toValue: to,
        ...(units.length ? { unit: units.length } : {}),
      },
      pivot: pivotAlong,
      pivotLabel: pivotName(pivotAlong, text),
      loads: all,
      ...(comAlong ? { com: comAlong } : {}),
      across: {
        fromValue: yFrom,
        toValue: yTo,
        pivot: pivotAcross ?? '0',
        ...(comAcross ? { com: comAcross } : {}),
      },
      ...(units.mass ? { massUnit: units.mass } : {}),
    };
  }

  const line = beamLine(scene);
  return {
    beam: {
      from: { x: line.from, y: line.y },
      to: { x: line.to, y: line.y },
      fromValue: from,
      toValue: to,
      ...(units.length ? { unit: units.length } : {}),
    },
    pivot: pivotAlong,
    pivotLabel: pivotName(pivotAlong, text),
    loads: all,
    ...(tiltKey ? { tilt: tiltKey, tiltUnit: tiltUnitOf(spec, tiltKey) } : {}),
    ...(comAlong ? { com: comAlong } : {}),
    ...(units.mass ? { massUnit: units.mass } : {}),
  };
}

/**
 * Bind every param to a dial at the beam.
 *
 * Not three: a balance with four loads has four positions, and leaving one
 * frozen at its default is how an act ships that nobody can win.
 */
export function balanceBindings(balance: Balance, params: ParamSpec[]): ParamBinding[] {
  const beam = balance.beam;
  const midX = (beam.from.x + beam.to.x) / 2;
  // In front of a beam; beside a deck, at its middle, because a deck big enough
  // to matter often runs down to the wall and there is no front left to stand at.
  const at: Point = balance.across
    ? { x: beam.to.x + 70, y: beam.from.y + ((beam.to.x - beam.from.x) * spanRatio(balance)) / 2 }
    : { x: midX, y: beam.from.y + 78 };
  const prompt = balance.across ? 'the deck' : 'the beam';

  return params.map((param) => {
    const label = dialLabel(param.name, balance);
    const unit = balance.loads.some((l) => l.mass === param.name) ? balance.massUnit : beam.unit;
    return {
      kind: 'needle',
      param: param.name,
      at,
      prompt,
      ...(label ? { label } : {}),
      ...(unit ? { unit } : {}),
    } satisfies ParamBinding;
  });
}

/** Depth over width, on the beam's own scale. */
export function spanRatio(balance: Balance): number {
  if (!balance.across) return 0;
  const along = balance.beam.toValue - balance.beam.fromValue;
  return along === 0 ? 1 : (balance.across.toValue - balance.across.fromValue) / along;
}

/**
 * Make sure the act can still be won with only the dials the stage bound.
 *
 * A stage binds what it has room for — one marker, one control, three needles
 * — and every other param is played at its default. When the win needs one of
 * those to move, the act is unwinnable and nothing on screen says so: two of
 * three acts in a generated centre-of-mass world shipped that way. The repair
 * is to hold each unbound param at its validated solution instead, which the
 * validator has already proved can win.
 */
export function settleUnbound(mechanic: Mechanic, stage: ActStage | undefined): Mechanic {
  if (mechanic.type !== 'formula' || !stage) return mechanic;
  const bound = new Set<string>();
  for (const binding of stage.bindings) {
    if (binding.kind === 'aim') {
      bound.add(binding.paramX);
      bound.add(binding.paramY);
    } else {
      bound.add(binding.param);
    }
  }
  const unbound = mechanic.params.filter((p) => !bound.has(p.name));
  if (unbound.length === 0) return mechanic;

  const dials = Object.fromEntries(
    mechanic.params.map((p) => [p.name, bound.has(p.name) ? p.solution : p.default]),
  );
  try {
    if (simulate(mechanic.spec, dials).won) return mechanic;
  } catch {
    // A run that throws at these dials is as unwinnable as one that loses.
  }
  return {
    ...mechanic,
    params: mechanic.params.map((p) => (bound.has(p.name) ? p : { ...p, default: p.solution })),
  };
}

// --- reading the spec ------------------------------------------------------

/** `a * b` pairs in an expression, mass first, with whether the term is subtracted. */
function products(source: string): [string, string, boolean][] {
  const found: [string, string, boolean][] = [];
  const pattern = /([A-Za-z_]\w*)\s*\*\s*([A-Za-z_]\w*)/g;
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
    const [, a, b] = match as unknown as [string, string, string];
    const before = source.slice(0, match.index).trimEnd();
    const negated = before.endsWith('-');
    if (MASS_NAME.test(a) && POSITION_NAME.test(b) && !MASS_NAME.test(b))
      found.push([a, b, negated]);
    else if (MASS_NAME.test(b) && POSITION_NAME.test(a) && !MASS_NAME.test(a))
      found.push([b, a, negated]);
  }
  return found;
}

/**
 * Loads on a lever whose arms are measured from a sliding pivot: `F * pivot`
 * is a load at the end the pivot is measured from, `F * (L - pivot)` one at L.
 */
function armProducts(source: string, pivot: string): [string, string][] {
  const found: [string, string][] = [];
  const isLoad = (name: string) =>
    name !== pivot && (MASS_NAME.test(name) || FORCE_NAME.test(name));
  const p = pivot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const atStart = new RegExp(
    `\\b([A-Za-z_]\\w*)\\s*\\*\\s*${p}\\b|\\b${p}\\s*\\*\\s*([A-Za-z_]\\w*)`,
    'g',
  );
  for (const m of source.matchAll(atStart)) {
    const load = m[1] ?? m[2];
    if (load && isLoad(load)) found.push([load, '0']);
  }
  const atEnd = new RegExp(
    `\\b([A-Za-z_]\\w*)\\s*\\*\\s*\\(\\s*([A-Za-z_]\\w*)\\s*-\\s*${p}\\s*\\)|\\(\\s*([A-Za-z_]\\w*)\\s*-\\s*${p}\\s*\\)\\s*\\*\\s*([A-Za-z_]\\w*)`,
    'g',
  );
  for (const m of source.matchAll(atEnd)) {
    const load = m[1] ?? m[4];
    const end = m[2] ?? m[3];
    if (load && end && isLoad(load)) found.push([load, end]);
  }
  return found;
}

/** Constant terms added straight into a torque, split by which way they turn. */
function momentTerms(source: string, spec: SimSpec): { plus: string[]; minus: string[] } {
  const plus: string[] = [];
  const minus: string[] = [];
  if (/[/()]/.test(source)) return { plus, minus };
  const terms = source.match(/[+-]?\s*[^+-]+/g) ?? [];
  for (const raw of terms) {
    const term = raw.replace(/\s+/g, '');
    const negative = term.startsWith('-');
    const name = term.replace(/^[+-]/, '');
    if (!(name in spec.constants)) continue;
    (negative ? minus : plus).push(name);
  }
  return { plus, minus };
}

function momentLoad(names: string[], at: string): BalanceLoad {
  return { label: names.map(humanise).join(' + '), moment: names.join(' + '), at };
}

function isAcross(name: string): boolean {
  return /(^y|y$|_y|Y$|Y_)/.test(name) && !/(^x|x$|X$)/.test(name);
}

/** Every value an expression takes as each param swings across its range. */
function envelope(expr: string, spec: SimSpec, params: ParamSpec[]): number[] {
  const base = Object.fromEntries(params.map((p) => [p.name, p.default]));
  const scopes = [base];
  for (const p of params) {
    scopes.push({ ...base, [p.name]: p.min }, { ...base, [p.name]: p.max });
  }
  const values: number[] = [];
  for (const scope of scopes) {
    try {
      const value = evaluate(expr, { ...spec.constants, ...scope });
      if (Number.isFinite(value)) values.push(value);
    } catch {
      // an expression that cannot be read at this corner says nothing about range
    }
  }
  return values.length ? values : [0];
}

/** Degrees or radians: a tilt allowed to reach 25 is not in radians. */
function tiltUnitOf(spec: SimSpec, key: string): 'deg' | 'rad' {
  const near = [spec.until ?? '', spec.win].join(' ');
  const limits = [...near.matchAll(new RegExp(`${key}\\s*[<>]=?\\s*-?([\\d.]+)`, 'g'))].map((m) =>
    Number(m[1]),
  );
  const biggest = limits.length ? Math.max(...limits) : 0;
  return biggest > 3.2 ? 'deg' : 'rad';
}

function unitsFrom(text: string): { length?: string; mass?: string } {
  const length = /centimet|\bcm\b/.test(text)
    ? 'cm'
    : /\bmetres?\b|\bmeters?\b|\d\s?m\b/.test(text)
      ? 'm'
      : undefined;
  const mass = /kilogram|\bkg\b/.test(text)
    ? 'kg'
    : /\bgrams?\b|\d\s?g\b/.test(text)
      ? 'g'
      : undefined;
  return { ...(length ? { length } : {}), ...(mass ? { mass } : {}) };
}

function pivotName(pivot: string, text: string): string {
  const source = `${pivot} ${text}`.toLowerCase();
  for (const word of ['knife-edge', 'fulcrum', 'axle', 'pier', 'hinge', 'pivot']) {
    if (source.includes(word.replace('-', '')) || source.includes(word)) return word;
  }
  return 'pivot';
}

/**
 * Loads named after the props they stand for when the room has a numbered set
 * of them — "Battery Cart 3" for `mass3` — and after themselves otherwise.
 */
function labelLoads(loads: BalanceLoad[], scene: Scene): BalanceLoad[] {
  return loads.map((load, i) => {
    const digits = load.mass?.match(/(\d+)$/)?.[1];
    const prop = digits
      ? scene.interactables.find((it) => new RegExp(`\\b${digits}$`).test(it.label ?? it.id))
      : undefined;
    const label =
      prop?.label ??
      (load.mass && /^m_?\d*$/i.test(load.mass)
        ? `load ${digits ?? i + 1}`
        : humanise(load.mass ?? ''));
    return { ...load, label };
  });
}

function dialLabel(param: string, balance: Balance): string | undefined {
  for (const load of balance.loads) {
    const name = load.label ?? 'load';
    if (load.mass === param) {
      return /(mass|weight|force)/i.test(name)
        ? name
        : `${name} — ${load.force ? 'force' : 'mass'}`;
    }
    if (load.at.replace(/^-/, '') === param) {
      if (balance.across) return `${name} — x`;
      return `${name} — ${/arm/i.test(param) ? 'arm' : 'position'}`;
    }
    if (load.atY === param) return `${name} — y`;
  }
  if (balance.pivot === param || balance.across?.pivot === param) {
    return `${balance.pivotLabel ?? 'pivot'} — position`;
  }
  return undefined;
}

// --- finding floor for it --------------------------------------------------

interface Blocker {
  rect: Rect;
}

function blockers(scene: Scene, inflate: number, people: boolean): Blocker[] {
  const grow = (r: Rect, k: number): Rect => ({
    x: r.x - k,
    y: r.y - k,
    w: r.w + 2 * k,
    h: r.h + 2 * k,
  });
  const around = (p: Point, r: number): Rect => ({ x: p.x - r, y: p.y - r, w: 2 * r, h: 2 * r });
  return [
    ...scene.interactables.map((it) => ({ rect: grow(it, inflate) })),
    ...scene.exits.map((exit) => ({ rect: grow(exit, inflate + 60) })),
    { rect: around(scene.spawn, 70) },
    ...(people ? Object.values(scene.npcSpots).map((p) => ({ rect: around(p, 50) })) : []),
  ];
}

const overlaps = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * The longest clear run of floor across the room, for a beam to lie along.
 * Never more than 60% of the room, so there is always a way round either end.
 */
function beamLine(scene: Scene): { y: number; from: number; to: number } {
  const half = 40;
  const left = WALL + 140;
  const right = scene.width - WALL - 140;
  const blocks = blockers(scene, 50, true);
  let best = { y: Math.round(scene.height * 0.52), from: left, to: right, length: -1 };

  for (let y = Math.round(scene.height * 0.3); y <= scene.height * 0.75; y += 10) {
    const band = blocks
      .map((b) => b.rect)
      .filter((r) => r.y < y + half && y - half < r.y + r.h)
      .sort((a, b) => a.x - b.x);
    let cursor = left;
    const gaps: [number, number][] = [];
    for (const r of band) {
      if (r.x > cursor) gaps.push([cursor, Math.min(r.x, right)]);
      cursor = Math.max(cursor, r.x + r.w);
    }
    if (cursor < right) gaps.push([cursor, right]);
    for (const [a, b] of gaps) {
      const length = b - a;
      const centred = -Math.abs(y - scene.height * 0.5) * 0.01;
      if (length + centred > best.length) best = { y, from: a, to: b, length: length + centred };
    }
  }

  const cap = scene.width * 0.6;
  if (best.to - best.from > cap) {
    const mid = (best.from + best.to) / 2;
    best.from = mid - cap / 2;
    best.to = mid + cap / 2;
  }
  return { y: best.y, from: Math.round(best.from), to: Math.round(best.to) };
}

/**
 * The largest clear patch of floor with the deck's own proportions. People may
 * stand on a deck, so only props, the door and the spawn rule a patch out.
 */
function deckSquare(scene: Scene, ratio: number): Rect {
  const blocks = blockers(scene, 30, false).map((b) => b.rect);
  const room: Rect = {
    x: WALL + 60,
    y: WALL + 60,
    w: scene.width - 2 * WALL - 120,
    h: scene.height - 2 * WALL - 120,
  };
  const centre = { x: scene.width / 2, y: scene.height / 2 };
  for (let w = Math.min(room.w, room.h / Math.max(ratio, 0.01)) * 0.8; w >= 160; w -= 20) {
    const h = w * ratio;
    let found: Rect | null = null;
    let nearest = Infinity;
    for (let x = room.x; x + w <= room.x + room.w; x += 20) {
      for (let y = room.y; y + h <= room.y + room.h; y += 20) {
        const rect = { x, y, w, h };
        if (blocks.some((b) => overlaps(rect, b))) continue;
        const d = Math.hypot(x + w / 2 - centre.x, y + h / 2 - centre.y);
        if (d < nearest) {
          nearest = d;
          found = rect;
        }
      }
    }
    if (found) return roundRect(found);
  }
  return roundRect({ x: centre.x - 120, y: centre.y - 120 * ratio, w: 240, h: 240 * ratio });
}

const roundRect = (r: Rect): Rect => ({
  x: Math.round(r.x),
  y: Math.round(r.y),
  w: Math.round(r.w),
  h: Math.round(r.h),
});

function niceStep(span: number): number {
  const rough = Math.abs(span) / 10;
  const magnitude = 10 ** Math.floor(Math.log10(Math.max(rough, 1e-6)));
  const normalised = rough / magnitude;
  return (normalised >= 5 ? 5 : normalised >= 2 ? 2 : 1) * magnitude;
}

const humanise = (name: string): string =>
  name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[-_]/g, ' ')
    .toLowerCase();
