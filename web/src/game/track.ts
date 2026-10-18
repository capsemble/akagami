/**
 * The railway.
 *
 * The route an act runs along used to be a pale dashed line with tick marks on
 * it — a diagram of a track rather than a track. For an act whose whole subject
 * is a train coming down a grade, the one object the player stares at for the
 * entire run was the one object nobody had drawn.
 *
 * Two things live here: permanent way (ballast, sleepers, rails, buffer stop)
 * and the engine that runs on it. Both are built from the path the mechanic
 * already defines, so the rails go exactly where the physics says the train
 * goes — move the lane and the track moves with it, and they cannot disagree.
 *
 * Everything across the track is worked out in world space and then projected,
 * never in screen space. A sleeper is a plank lying on the ground; measure it
 * across the screen instead and it stops lying flat and starts floating.
 */
import Phaser from 'phaser';
import type { Point } from '@chapter-quest/shared';

/** Tuned in world pixels, for a hall a couple of thousand across. */
const GAUGE = 42;
const SLEEPER_LENGTH = 76;
const SLEEPER_SPACING = 40;
const SLEEPER_WIDTH = 13;
const BALLAST = 58;

const BALLAST_DARK = 0x3a2e22;
const BALLAST_LIGHT = 0x574636;
const SLEEPER = 0x4a3524;
const RAIL_DARK = 0x3f4349;
const RAIL_TOP = 0xb9c0c7;

export interface Projector {
  (x: number, y: number): Point;
}

interface Basis {
  /** Unit vector along the track, on the world plane. */
  along: Point;
  /** Unit vector across it, on the world plane. */
  across: Point;
  /** World length of the run. */
  length: number;
}

function basis(from: Point, to: Point): Basis | null {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  if (length < 1) return null;
  return {
    along: { x: dx / length, y: dy / length },
    across: { x: -dy / length, y: dx / length },
    length,
  };
}

function poly(g: Phaser.GameObjects.Graphics, pts: Point[], color: number, alpha = 1): void {
  g.fillStyle(color, alpha);
  g.beginPath();
  g.moveTo(pts[0]!.x, pts[0]!.y);
  for (const p of pts.slice(1)) g.lineTo(p.x, p.y);
  g.closePath();
  g.fillPath();
}

/** A stable 0..1, so the ballast does not crawl when the stage redraws. */
function jitter(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * Lay track between two points on the world plane.
 *
 * `bufferStop` caps the far end, which is what tells the player the line
 * actually finishes there rather than carrying on off the plane.
 */
export function drawTrack(
  g: Phaser.GameObjects.Graphics,
  from: Point,
  to: Point,
  project: Projector,
  opts: { bufferStop?: boolean } = {},
): void {
  const b = basis(from, to);
  if (!b) return;

  // The run overshoots both ends a little: track that stops dead where the
  // physics stops looks like a model, not a line that goes somewhere.
  const tail = 70;
  const head = { x: from.x - b.along.x * tail, y: from.y - b.along.y * tail };
  const tip = { x: to.x + b.along.x * tail, y: to.y + b.along.y * tail };

  const at = (p: Point, side: number, forward = 0): Point =>
    project(p.x + b.across.x * side + b.along.x * forward, p.y + b.across.y * side + b.along.y * forward);

  // Ballast: a shoulder either side, wider than the sleepers it holds.
  poly(
    g,
    [at(head, -BALLAST), at(tip, -BALLAST), at(tip, BALLAST), at(head, BALLAST)],
    BALLAST_DARK,
  );
  poly(
    g,
    [at(head, -BALLAST * 0.7), at(tip, -BALLAST * 0.7), at(tip, BALLAST * 0.7), at(head, BALLAST * 0.7)],
    BALLAST_LIGHT,
    0.75,
  );

  // Gravel. Stable jitter, so a redraw does not make the stones crawl.
  const stones = Math.min(260, Math.round(b.length / 9));
  g.fillStyle(0x7b6a52, 0.6);
  for (let i = 0; i < stones; i++) {
    const t = (i + jitter(i) * 0.9) / stones;
    const p = { x: head.x + (tip.x - head.x) * t, y: head.y + (tip.y - head.y) * t };
    const side = (jitter(i + 900) * 2 - 1) * BALLAST;
    const dot = at(p, side);
    g.fillRect(dot.x, dot.y, 2 + jitter(i + 77) * 2, 2);
  }

  // Sleepers, evenly spaced down the whole run.
  const total = b.length + tail * 2;
  const count = Math.max(2, Math.round(total / SLEEPER_SPACING));
  for (let i = 0; i <= count; i++) {
    const forward = (total * i) / count;
    const foot = { x: head.x + b.along.x * forward, y: head.y + b.along.y * forward };
    const shade = i % 4 === 0 ? 0.88 : 1;
    poly(
      g,
      [
        at(foot, -SLEEPER_LENGTH / 2, -SLEEPER_WIDTH / 2),
        at(foot, SLEEPER_LENGTH / 2, -SLEEPER_WIDTH / 2),
        at(foot, SLEEPER_LENGTH / 2, SLEEPER_WIDTH / 2),
        at(foot, -SLEEPER_LENGTH / 2, SLEEPER_WIDTH / 2),
      ],
      shade === 1 ? SLEEPER : 0x412e1f,
    );
  }

  // Two rails: a dark web with a lit head on top, which is what makes steel
  // read as steel rather than as two more lines on the floor.
  for (const side of [-GAUGE / 2, GAUGE / 2]) {
    const a = at(head, side);
    const z = at(tip, side);
    g.lineStyle(7, RAIL_DARK, 1);
    g.beginPath();
    g.moveTo(a.x, a.y);
    g.lineTo(z.x, z.y);
    g.strokePath();
    g.lineStyle(2.6, RAIL_TOP, 0.9);
    g.beginPath();
    g.moveTo(a.x, a.y - 2);
    g.lineTo(z.x, z.y - 2);
    g.strokePath();
  }

  if (opts.bufferStop) drawBufferStop(g, tip, b, at);
}

/** The thing at the end of the line, which is the point of the end of the line. */
function drawBufferStop(
  g: Phaser.GameObjects.Graphics,
  tip: Point,
  b: Basis,
  at: (p: Point, side: number, forward?: number) => Point,
): void {
  const lift = 26;
  const base = { x: tip.x - b.along.x * 26, y: tip.y - b.along.y * 26 };
  const corners = [
    at(base, -GAUGE * 0.7, -10),
    at(base, GAUGE * 0.7, -10),
    at(base, GAUGE * 0.7, 10),
    at(base, -GAUGE * 0.7, 10),
  ];
  const top = corners.map((p) => ({ x: p.x, y: p.y - lift }));
  poly(g, [corners[3]!, corners[2]!, top[2]!, top[3]!], 0x5b4330);
  poly(g, [corners[1]!, corners[2]!, top[2]!, top[1]!], 0x44311f);
  poly(g, top, 0x6d5239);

  // Hazard stripes on the face, which is the only part anyone ever looks at.
  const left = top[3]!;
  const right = top[2]!;
  for (let i = 0; i < 5; i++) {
    const t0 = i / 5;
    const t1 = (i + 0.5) / 5;
    const lerp = (t: number) => ({ x: left.x + (right.x - left.x) * t, y: left.y + (right.y - left.y) * t });
    const a = lerp(t0);
    const c = lerp(t1);
    poly(
      g,
      [a, c, { x: c.x, y: c.y + lift * 0.8 }, { x: a.x, y: a.y + lift * 0.8 }],
      i % 2 === 0 ? 0xc05746 : 0xe4d8b4,
      0.95,
    );
  }
}

/**
 * A tank engine, drawn side-on along the track.
 *
 * `along` is the track's direction on screen and `squash` is how much a world
 * length along it is foreshortened by the projection — the same number that
 * decides how wide a wheel looks. Passing both means the engine sits on the
 * rails at any angle without being rotated, which would shear its chimney.
 */
export function drawLocomotive(
  g: Phaser.GameObjects.Graphics,
  along: Point,
  squash: number,
  scale = 1,
): void {
  const A = along;
  const U = { x: 0, y: -1 };
  // a runs along the track (+ is forward), u runs up from the railhead.
  const at = (a: number, u: number): Point => ({
    x: A.x * a * scale + U.x * u * scale,
    y: A.y * a * scale + U.y * u * scale,
  });
  const quad = (pts: [number, number][], color: number, alpha = 1) =>
    poly(g, pts.map(([a, u]) => at(a, u)), color, alpha);

  const BODY = 0x6b2f2a;
  const BLACK = 0x241c17;
  const BRASS = 0xc9a24a;
  const STEEL = 0x8e969e;

  // Wheels first — the frame covers their tops, which is how it should look.
  const driver = 17;
  const wheelAt = (a: number, r: number, tint: number) => {
    const pts: Point[] = [];
    for (let i = 0; i < 20; i++) {
      const th = (i / 20) * Math.PI * 2;
      pts.push(at(a + r * squash * Math.cos(th), r + r * Math.sin(th)));
    }
    poly(g, pts, darken(tint, 0.45));
    g.lineStyle(Math.max(2, r * 0.22) * scale, lighten(tint, 1.3), 0.95);
    g.strokePoints(pts.map((p) => new Phaser.Geom.Point(p.x, p.y)), true);
    for (let i = 0; i < 6; i++) {
      const th = (i / 6) * Math.PI;
      const a0 = at(a + r * 0.78 * squash * Math.cos(th), r + r * 0.78 * Math.sin(th));
      const a1 = at(a - r * 0.78 * squash * Math.cos(th), r - r * 0.78 * Math.sin(th));
      g.lineStyle(1.6 * scale, lighten(tint, 1.15), 0.75);
      g.beginPath();
      g.moveTo(a0.x, a0.y);
      g.lineTo(a1.x, a1.y);
      g.strokePath();
    }
    const hub = at(a, r);
    g.fillStyle(lighten(tint, 1.4), 1);
    g.fillCircle(hub.x, hub.y, Math.max(2, r * 0.22) * scale);
    return hub;
  };

  const lead = wheelAt(-34, 10, BLACK);
  const back = wheelAt(-4, driver, BLACK);
  const front = wheelAt(26, driver, BLACK);

  // Coupling rod, tying the drivers together. One line, and the engine has a
  // mechanism instead of a pair of circles.
  g.lineStyle(3.4 * scale, STEEL, 1);
  g.beginPath();
  g.moveTo(back.x, back.y);
  g.lineTo(front.x, front.y);
  g.strokePath();
  void lead;

  // Frame and running board.
  quad(
    [
      [-46, 16],
      [44, 16],
      [44, 25],
      [-46, 25],
    ],
    BLACK,
  );

  // Boiler, with a lit top edge so it reads as a cylinder.
  quad(
    [
      [-20, 25],
      [42, 25],
      [42, 50],
      [-20, 50],
    ],
    BODY,
  );
  quad(
    [
      [-20, 46],
      [42, 46],
      [42, 50],
      [-20, 50],
    ],
    lighten(BODY, 1.35),
  );
  for (const a of [-8, 10, 28]) {
    quad(
      [
        [a, 25],
        [a + 2.5, 25],
        [a + 2.5, 50],
        [a, 50],
      ],
      BRASS,
      0.85,
    );
  }

  // Smokebox, chimney, dome, whistle.
  quad(
    [
      [36, 24],
      [46, 24],
      [46, 52],
      [36, 52],
    ],
    BLACK,
  );
  quad(
    [
      [36, 52],
      [44, 52],
      [45, 68],
      [35, 68],
    ],
    BLACK,
  );
  quad(
    [
      [33, 66],
      [47, 66],
      [47, 72],
      [33, 72],
    ],
    BLACK,
  );
  quad(
    [
      [6, 50],
      [18, 50],
      [18, 60],
      [6, 60],
    ],
    BRASS,
  );

  // Cab: a box with a window you can see daylight through.
  quad(
    [
      [-46, 25],
      [-14, 25],
      [-14, 66],
      [-46, 66],
    ],
    BODY,
  );
  quad(
    [
      [-50, 66],
      [-10, 66],
      [-10, 72],
      [-50, 72],
    ],
    BLACK,
  );
  quad(
    [
      [-40, 44],
      [-22, 44],
      [-22, 60],
      [-40, 60],
    ],
    0x1a2b33,
  );
  quad(
    [
      [-46, 36],
      [-14, 36],
      [-14, 38],
      [-46, 38],
    ],
    BRASS,
    0.8,
  );

  // Buffer beam and buffers.
  quad(
    [
      [46, 14],
      [52, 14],
      [52, 34],
      [46, 34],
    ],
    0xc05746,
  );
  for (const u of [20, 30]) {
    quad(
      [
        [52, u - 2.5],
        [57, u - 2.5],
        [57, u + 2.5],
        [52, u + 2.5],
      ],
      STEEL,
    );
  }

}

/** Where the chimney mouth is, relative to the engine's own origin. */
export function chimneyOffset(along: Point, scale = 1): Point {
  const a = 40 * scale;
  const u = 74 * scale;
  return { x: along.x * a, y: along.y * a - u };
}

/**
 * Steam.
 *
 * Puffs are left behind in the world rather than carried along with the engine,
 * which is the entire difference between smoke and a cloud welded to a chimney.
 * They are spawned by distance covered, not by the clock, so a wagon crawling
 * down the last few metres stops producing a stack-blast it has no business
 * making — the same reason the walk cycle runs on distance.
 */
export class Steam {
  private puffs: { x: number; y: number; r: number; age: number; life: number; drift: number }[] =
    [];
  private owed = 0;

  constructor(private readonly g: Phaser.GameObjects.Graphics) {}

  /**
   * `at` is the chimney on screen, or null when nothing is running. `travelled`
   * is screen pixels covered since the last call.
   */
  update(deltaMs: number, at: Point | null, travelled: number): void {
    const dt = deltaMs / 1000;

    if (at) {
      // One puff every 14px of ground. Stationary engines do not chuff.
      this.owed += travelled / 14;
      while (this.owed >= 1 && this.puffs.length < 60) {
        this.owed -= 1;
        this.puffs.push({
          x: at.x + (Math.random() - 0.5) * 5,
          y: at.y,
          r: 5 + Math.random() * 3,
          age: 0,
          life: 1.1 + Math.random() * 0.7,
          drift: (Math.random() - 0.5) * 18,
        });
      }
    }

    this.g.clear();
    for (const puff of this.puffs) {
      puff.age += dt;
      // Rises, spreads and slows, the way a hot gas does as it cools.
      puff.y -= 26 * dt;
      puff.x += puff.drift * dt;
      puff.r += 17 * dt;
    }
    this.puffs = this.puffs.filter((p) => p.age < p.life);
    for (const puff of this.puffs) {
      const left = 1 - puff.age / puff.life;
      this.g.fillStyle(0xd8d2c6, 0.34 * left * left);
      this.g.fillCircle(puff.x, puff.y, puff.r);
    }
  }

  clear(): void {
    this.puffs = [];
    this.owed = 0;
    this.g.clear();
  }
}

function lighten(color: number, factor: number): number {
  const channel = (shift: number) => Math.min(255, Math.round(((color >> shift) & 0xff) * factor));
  return (channel(16) << 16) | (channel(8) << 8) | channel(0);
}
const darken = lighten;
