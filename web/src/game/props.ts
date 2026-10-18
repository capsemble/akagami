/**
 * The prop library.
 *
 * Every blocked rect and every interactable used to be extruded into the same
 * isometric box, which meant a room read as a scatter of identical crates in
 * two colours — you could not tell the brake lever from the water tank without
 * walking into it. The geometry was right and the silhouette was missing.
 *
 * So each prop is drawn as the thing it is: a board has posts and pinned cards,
 * a tank is a riveted cylinder with a spout, a lever has a quadrant and a knob
 * you can see which way is thrown. The collider is untouched — a prop is only
 * ever drawn inside the rect the mapper already placed, so art and physics
 * still cannot drift apart.
 *
 * The kind comes from the object's own words. A generated world names its props
 * ("brake-lever", "the signed timetable"), so the keyword table below turns
 * those names into silhouettes without a model call, and anything unrecognised
 * falls to one of the generic kinds picked off the id's hash — a strange room
 * is still a room with a crate, a barrel and a table in it rather than three
 * identical blocks.
 */
import Phaser from 'phaser';
import type { Interactable, IsoView, Point, PropKind, Rect } from '@chapter-quest/shared';
import {
  isoDiamond,
  isoProject,
  propHeight,
  propKindFor,
  propTint,
  seedOf,
} from '@chapter-quest/shared';

const SLATE = 0x2b3a3f;
const PARCHMENT = 0xe4d8b4;
const GOLD = 0xd9a441;
const EMBER = 0xe2a33c;
const GLASS = 0x6fb6ff;

// --- the local frame ------------------------------------------------------

interface Frame {
  /** u along the rect's width, v along its depth, z in pixels off the floor. */
  at(u: number, v: number, z?: number): Point;
  /** This prop's standing height, so every part can be sized off it. */
  lift: number;
  /** The rect's world size, for turning a length in pixels into u or v. */
  spanU: number;
  spanV: number;
  /** A stable 0..1 from the prop's id, so one room never reshuffles itself. */
  rand(n: number): number;
}

function frame(rect: Rect, view: IsoView, lift: number, id: string): Frame {
  const seed = seedOf(id);
  return {
    lift,
    spanU: rect.w,
    spanV: rect.h,
    at(u, v, z = 0) {
      const p = isoProject(rect.x + rect.w * u, rect.y + rect.h * v, view);
      return { x: p.x, y: p.y - z };
    },
    rand(n) {
      const x = Math.sin(seed * 12.9898 + n * 78.233) * 43758.5453;
      return x - Math.floor(x);
    },
  };
}

// --- primitives -----------------------------------------------------------

function poly(g: Phaser.GameObjects.Graphics, pts: Point[], color: number, alpha = 1): void {
  if (pts.length < 3) return;
  g.fillStyle(color, alpha);
  g.beginPath();
  g.moveTo(pts[0]!.x, pts[0]!.y);
  for (const p of pts.slice(1)) g.lineTo(p.x, p.y);
  g.closePath();
  g.fillPath();
}

const quad = (
  g: Phaser.GameObjects.Graphics,
  a: Point,
  b: Point,
  c: Point,
  d: Point,
  color: number,
  alpha = 1,
) => poly(g, [a, b, c, d], color, alpha);

function edge(
  g: Phaser.GameObjects.Graphics,
  pts: Point[],
  color: number,
  width = 1.6,
  alpha = 0.85,
  closed = true,
): void {
  g.lineStyle(width, color, alpha);
  g.strokePoints(
    pts.map((p) => new Phaser.Geom.Point(p.x, p.y)),
    closed,
  );
}

function line(
  g: Phaser.GameObjects.Graphics,
  from: Point,
  to: Point,
  color: number,
  width = 1.5,
  alpha = 0.8,
): void {
  g.lineStyle(width, color, alpha);
  g.beginPath();
  g.moveTo(from.x, from.y);
  g.lineTo(to.x, to.y);
  g.strokePath();
}

interface Span {
  u0: number;
  u1: number;
  v0: number;
  v1: number;
  z0: number;
  z1: number;
}

/**
 * An axis-aligned block inside the prop's own frame. The two faces turned
 * toward the camera are the +v and +u ones, which is why only those are drawn.
 */
function block(
  g: Phaser.GameObjects.Graphics,
  f: Frame,
  s: Span,
  tint: number,
  opts: { rim?: boolean; outline?: boolean } = {},
): { top: Point[]; south: Point[]; east: Point[] } {
  const top = [
    f.at(s.u0, s.v0, s.z1),
    f.at(s.u1, s.v0, s.z1),
    f.at(s.u1, s.v1, s.z1),
    f.at(s.u0, s.v1, s.z1),
  ];
  const bot = [
    f.at(s.u0, s.v0, s.z0),
    f.at(s.u1, s.v0, s.z0),
    f.at(s.u1, s.v1, s.z0),
    f.at(s.u0, s.v1, s.z0),
  ];
  const south = [bot[3]!, bot[2]!, top[2]!, top[3]!];
  const east = [bot[1]!, bot[2]!, top[2]!, top[1]!];

  poly(g, south, darken(tint, 0.58));
  poly(g, east, darken(tint, 0.76));
  poly(g, top, tint);
  if (opts.outline !== false) edge(g, top, darken(tint, 0.3), 1.6, 0.85);
  // A rim along the two lit edges. Three flat fills read as a diagram; the
  // same three with a highlight on them read as an object.
  if (opts.rim !== false) edge(g, [top[3]!, top[0]!, top[1]!], lighten(tint, 1.4), 1.6, 0.7, false);
  return { top, south, east };
}

/** A circle on the floor plane, projected — so it comes out as the right ellipse. */
function disc(f: Frame, u: number, v: number, ru: number, rv: number, z: number, n = 26): Point[] {
  const pts: Point[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    pts.push(f.at(u + ru * Math.cos(a), v + rv * Math.sin(a), z));
  }
  return pts;
}

function cylinder(
  g: Phaser.GameObjects.Graphics,
  f: Frame,
  o: { u: number; v: number; ru: number; rv: number; z0: number; z1: number },
  tint: number,
): { top: Point[] } {
  const top = disc(f, o.u, o.v, o.ru, o.rv, o.z1);
  const bottom = disc(f, o.u, o.v, o.ru, o.rv, o.z0);
  for (let i = 0; i < top.length; i++) {
    const j = (i + 1) % top.length;
    const a = (i / top.length) * Math.PI * 2;
    // Lit from behind the camera's left shoulder, same as every block face.
    const shade = 0.52 + 0.3 * Math.cos(a - Math.PI * 0.7);
    quad(g, bottom[i]!, bottom[j]!, top[j]!, top[i]!, darken(tint, shade));
  }
  poly(g, top, lighten(tint, 1.06));
  edge(g, top, darken(tint, 0.38));
  return { top };
}

/**
 * A hoop round a cylinder — the front half only. A whole ellipse puts the back
 * of the band above the body it is supposed to be strapped around, and a barrel
 * comes out as two rings hovering in mid-air.
 */
function hoop(
  g: Phaser.GameObjects.Graphics,
  f: Frame,
  o: { u: number; v: number; ru: number; rv: number; z: number },
  color: number,
  width = 2.5,
): void {
  const pts: Point[] = [];
  const steps = 16;
  for (let i = 0; i <= steps; i++) {
    // Screen depth is u + v, so the near half runs from -45° to 135°.
    const a = -Math.PI / 4 + (i / steps) * Math.PI;
    pts.push(f.at(o.u + o.ru * Math.cos(a), o.v + o.rv * Math.sin(a), o.z));
  }
  edge(g, pts, color, width, 0.8, false);
}

/** A thick strut between two points in the frame — rods, barrels, cables. */
function strut(
  g: Phaser.GameObjects.Graphics,
  from: Point,
  to: Point,
  tint: number,
  width: number,
): void {
  g.lineStyle(width + 2, darken(tint, 0.55), 1);
  g.beginPath();
  g.moveTo(from.x, from.y);
  g.lineTo(to.x, to.y);
  g.strokePath();
  g.lineStyle(Math.max(1, width - 1.5), lighten(tint, 1.2), 0.9);
  g.beginPath();
  g.moveTo(from.x, from.y);
  g.lineTo(to.x, to.y);
  g.strokePath();
}

/**
 * A wheel, standing in the world rather than painted on the screen.
 *
 * It used to be a screen-space circle, which is what a disc lying flat looks
 * like — so a gun carriage came out with two coins stuck to the side of it. A
 * wheel stands in a vertical plane, and this projection foreshortens that plane
 * to half width while leaving height alone and shearing the whole thing. So the
 * rim is built by walking a circle in the wheel's own plane and pushing every
 * point through `f.at`: the ellipse, its tilt and its shear all fall out of the
 * projection instead of being guessed at. The spokes go round the same way, or
 * they fan out across a wheel they are supposed to be inside.
 *
 * `along` is the axis the wheel rolls down. A cart facing up the room rolls
 * along u; one facing across it rolls along v.
 */
function isoWheel(
  g: Phaser.GameObjects.Graphics,
  f: Frame,
  o: { u: number; v: number; z: number; r: number; along?: 'u' | 'v' },
  tint: number,
): void {
  const axis = o.along ?? 'u';
  // A world offset of r along the roll axis, expressed in that axis's units.
  const reach = o.r / (axis === 'u' ? f.spanU : f.spanV);
  const steps = 24;

  const ring = (k: number): Point[] => {
    const pts: Point[] = [];
    for (let i = 0; i < steps; i++) {
      const a = (i / steps) * Math.PI * 2;
      const side = reach * k * Math.cos(a);
      const up = o.r * k * Math.sin(a);
      pts.push(
        axis === 'u' ? f.at(o.u + side, o.v, o.z + up) : f.at(o.u, o.v + side, o.z + up),
      );
    }
    return pts;
  };

  const tyre = ring(1);
  poly(g, tyre, darken(tint, 0.4));
  edge(g, tyre, lighten(tint, 1.35), Math.max(2, o.r * 0.17), 0.95);

  // Spokes, in the wheel's own plane, from the hub to just short of the rim.
  const inner = ring(0.22);
  const outer = ring(0.8);
  for (let i = 0; i < 8; i++) {
    const at = Math.round((i / 8) * steps) % steps;
    line(g, inner[at]!, outer[at]!, lighten(tint, 1.2), Math.max(1.3, o.r * 0.09), 0.8);
  }

  const hub = ring(0.26);
  poly(g, hub, lighten(tint, 1.3));
  edge(g, hub, darken(tint, 0.5), 1.4, 0.85);
}

// --- the props ------------------------------------------------------------

/** A pinboard: two posts, a slate face, cards pinned to it and string between. */
function board(g: Phaser.GameObjects.Graphics, f: Frame, tint: number): void {
  const L = f.lift;
  block(g, f, { u0: 0.02, u1: 0.12, v0: 0.3, v1: 0.5, z0: 0, z1: L * 0.98 }, darken(tint, 0.8));
  block(g, f, { u0: 0.88, u1: 0.98, v0: 0.3, v1: 0.5, z0: 0, z1: L * 0.98 }, darken(tint, 0.8));

  const face = block(
    g,
    f,
    { u0: 0, u1: 1, v0: 0.32, v1: 0.46, z0: L * 0.2, z1: L },
    tint,
  );
  // The face itself, inset inside its frame, in slate — the thing you read.
  const panel = [
    f.at(0.04, 0.46, L * 0.26),
    f.at(0.96, 0.46, L * 0.26),
    f.at(0.96, 0.46, L * 0.94),
    f.at(0.04, 0.46, L * 0.94),
  ];
  poly(g, panel, SLATE);
  edge(g, panel, darken(tint, 0.45), 2, 0.9);

  // Cards, and the string between them. Three pins and two lines is enough to
  // say "someone has been working this out" from across the room.
  const cards: Point[] = [];
  for (let i = 0; i < 4; i++) {
    const u = 0.14 + i * 0.23 + f.rand(i) * 0.03;
    const z = L * (0.4 + f.rand(i + 9) * 0.38);
    const w = 0.1;
    const h = L * 0.16;
    poly(
      g,
      [
        f.at(u, 0.455, z),
        f.at(u + w, 0.455, z),
        f.at(u + w, 0.455, z + h),
        f.at(u, 0.455, z + h),
      ],
      PARCHMENT,
      0.92,
    );
    cards.push(f.at(u + w / 2, 0.45, z + h / 2));
  }
  for (let i = 0; i < cards.length - 1; i++) {
    line(g, cards[i]!, cards[i + 1]!, 0xc05746, 1.4, 0.7);
  }
  void face;
}

/** A floor-mounted lever: base plate, notched quadrant, rod thrown forward. */
function lever(g: Phaser.GameObjects.Graphics, f: Frame, tint: number): void {
  const L = f.lift;
  block(g, f, { u0: 0.12, u1: 0.88, v0: 0.2, v1: 0.85, z0: 0, z1: L * 0.16 }, darken(tint, 0.85));

  // The quadrant: a thin plate standing along the rod's swing, with notches.
  const quadrant = [
    f.at(0.3, 0.52, L * 0.16),
    f.at(0.82, 0.52, L * 0.16),
    f.at(0.82, 0.52, L * 0.52),
    f.at(0.3, 0.52, L * 0.86),
  ];
  poly(g, quadrant, darken(tint, 0.62));
  edge(g, quadrant, lighten(tint, 1.2), 1.8, 0.8);
  for (let i = 1; i < 6; i++) {
    const t = i / 6;
    const outer = f.at(0.3 + 0.52 * t, 0.5, L * (0.86 - 0.34 * t));
    const inner = f.at(0.34 + 0.46 * t, 0.5, L * (0.78 - 0.3 * t));
    line(g, outer, inner, lighten(tint, 1.5), 1.6, 0.6);
  }

  const pivot = f.at(0.3, 0.5, L * 0.2);
  const tip = f.at(0.74, 0.5, L * 0.95);
  strut(g, pivot, tip, 0x8e949c, 7);
  // The knob, so it is obvious this is a thing a hand goes on.
  g.fillStyle(0xc05746, 1);
  g.fillCircle(tip.x, tip.y, 9);
  g.lineStyle(2, 0xe8a79a, 0.8);
  g.strokeCircle(tip.x, tip.y, 9);
  g.fillStyle(darken(tint, 0.5), 1);
  g.fillCircle(pivot.x, pivot.y, 5);
}

/** A standing tank: riveted cylinder, hoops, a domed lid and a spout. */
function tank(g: Phaser.GameObjects.Graphics, f: Frame, tint: number): void {
  const L = f.lift;
  // Legs, so it reads as standing rather than sunk into the floor.
  for (const [u, v] of [
    [0.22, 0.3],
    [0.78, 0.3],
    [0.22, 0.74],
    [0.78, 0.74],
  ] as [number, number][]) {
    block(
      g,
      f,
      { u0: u - 0.05, u1: u + 0.05, v0: v - 0.05, v1: v + 0.05, z0: 0, z1: L * 0.22 },
      darken(tint, 0.7),
      { rim: false },
    );
  }
  cylinder(g, f, { u: 0.5, v: 0.5, ru: 0.4, rv: 0.4, z0: L * 0.18, z1: L * 0.88 }, tint);
  for (const t of [0.3, 0.52, 0.74]) {
    hoop(g, f, { u: 0.5, v: 0.5, ru: 0.4, rv: 0.4, z: L * t }, darken(tint, 0.45), 3);
  }
  // Lid.
  cylinder(g, f, { u: 0.5, v: 0.5, ru: 0.22, rv: 0.22, z0: L * 0.88, z1: L }, lighten(tint, 1.15));
  // Spout, down the near side into the floor.
  strut(g, f.at(0.5, 0.9, L * 0.3), f.at(0.5, 0.98, L * 0.06), 0x6e7682, 6);
}

/** A barrel: bulged staves, two bright hoops, a dark lid. */
function barrel(g: Phaser.GameObjects.Graphics, f: Frame, tint: number): void {
  const L = f.lift;
  cylinder(g, f, { u: 0.5, v: 0.5, ru: 0.3, rv: 0.3, z0: 0, z1: L * 0.12 }, darken(tint, 0.8));
  cylinder(g, f, { u: 0.5, v: 0.5, ru: 0.38, rv: 0.38, z0: L * 0.12, z1: L * 0.84 }, tint);
  cylinder(g, f, { u: 0.5, v: 0.5, ru: 0.3, rv: 0.3, z0: L * 0.84, z1: L }, darken(tint, 0.88));
  for (const t of [0.22, 0.7]) {
    hoop(g, f, { u: 0.5, v: 0.5, ru: 0.385, rv: 0.385, z: L * t }, 0x8e949c, 3.5);
  }
  // Staves down the near face, for the same reason as the hoops.
  for (let i = 0; i < 7; i++) {
    const a = -Math.PI / 4 + ((i + 0.5) / 7) * Math.PI;
    line(
      g,
      f.at(0.5 + 0.38 * Math.cos(a), 0.5 + 0.38 * Math.sin(a), L * 0.14),
      f.at(0.5 + 0.38 * Math.cos(a), 0.5 + 0.38 * Math.sin(a), L * 0.82),
      darken(tint, 0.5),
      1.2,
      0.5,
    );
  }
  poly(g, disc(f, 0.5, 0.5, 0.28, 0.28, L), darken(tint, 0.9));
}

/** A launcher: a braced carriage, a wheel each side, a barrel up at an angle. */
function launcher(g: Phaser.GameObjects.Graphics, f: Frame, tint: number): void {
  const L = f.lift;
  const iron = 0x5a4330;
  // Sized so the rim touches the floor: a hub at any other height either sinks
  // the wheel into the ground or hangs the carriage off it.
  const r = L * 0.34;
  const axleU = 0.34;

  // Far wheel first, then the axle, then the carriage — the body belongs
  // between the pair, not in front of both of them.
  // Outside the body, which is where a gun carriage keeps them. Tucked any
  // closer and the carriage swallows the far wheel whole — the prop came out
  // looking like it ran on one.
  isoWheel(g, f, { u: axleU, v: 0.05, z: r, r }, darken(iron, 0.72));
  strut(g, f.at(axleU, 0.05, r), f.at(axleU, 0.95, r), darken(iron, 0.55), 5);

  block(g, f, { u0: 0.12, u1: 0.88, v0: 0.34, v1: 0.66, z0: L * 0.22, z1: L * 0.56 }, tint);
  // The trail, raked back to the floor behind.
  poly(
    g,
    [f.at(0.14, 0.5, L * 0.54), f.at(0.14, 0.5, L * 0.24), f.at(-0.08, 0.5, 0)],
    darken(tint, 0.6),
  );

  const pivot = f.at(0.38, 0.5, L * 0.6);
  const muzzle = f.at(0.95, 0.5, L * 1.16);
  strut(g, pivot, muzzle, 0x7b828c, 15);
  // Muzzle ring and a sight, which is what makes it point rather than lean.
  g.fillStyle(0x9aa2ac, 1);
  g.fillCircle(muzzle.x, muzzle.y, 9);
  g.lineStyle(2.5, darken(0x7b828c, 0.5), 1);
  g.strokeCircle(muzzle.x, muzzle.y, 9);
  g.fillStyle(SLATE, 1);
  g.fillCircle(muzzle.x, muzzle.y, 4.5);
  g.fillStyle(GOLD, 1);
  g.fillCircle(pivot.x, pivot.y, 7);

  // Near wheel last, so it sits in front of the carriage it carries.
  isoWheel(g, f, { u: axleU, v: 0.95, z: r, r }, iron);
}

/** A ledge: a thick slab with a lip and a cracked face. Something to land on. */
function ledge(g: Phaser.GameObjects.Graphics, f: Frame, tint: number): void {
  const L = f.lift;
  const slab = block(g, f, { u0: 0, u1: 1, v0: 0, v1: 1, z0: 0, z1: L }, tint);
  // A lip along the near edges, so the drop has a line on it.
  block(g, f, { u0: 0, u1: 1, v0: 0.92, v1: 1, z0: L, z1: L + 9 }, lighten(tint, 1.18));
  block(g, f, { u0: 0.92, u1: 1, v0: 0, v1: 1, z0: L, z1: L + 9 }, lighten(tint, 1.1));
  // Courses on the face, and a crack. Stone that is all one colour is a box.
  for (const t of [0.35, 0.68]) {
    line(g, f.at(0, 1, L * t), f.at(1, 1, L * t), darken(tint, 0.42), 1.5, 0.6);
  }
  for (let i = 0; i < 4; i++) {
    const u = 0.18 + i * 0.22;
    line(g, f.at(u, 1, 0), f.at(u + f.rand(i) * 0.04 - 0.02, 1, L), darken(tint, 0.48), 1.3, 0.45);
  }
  // Flagstones across the top, because a ledge is mostly top and a bare fill
  // that size is a coloured polygon rather than a piece of ground.
  for (let i = 1; i < 4; i++) {
    const t = i / 4;
    line(g, f.at(t, 0.04, L), f.at(t + 0.03, 0.96, L), darken(tint, 0.66), 1.8, 0.6);
  }
  line(g, f.at(0.04, 0.46, L), f.at(0.96, 0.52, L), darken(tint, 0.66), 1.8, 0.6);
  void slab;
}

/** A desk with papers on it: the prop for anything you walk up to and read. */
function document(g: Phaser.GameObjects.Graphics, f: Frame, tint: number): void {
  const L = f.lift;
  const legZ = L * 0.74;
  for (const [u, v] of [
    [0.12, 0.26],
    [0.88, 0.26],
    [0.12, 0.8],
    [0.88, 0.8],
  ] as [number, number][]) {
    block(
      g,
      f,
      { u0: u - 0.045, u1: u + 0.045, v0: v - 0.05, v1: v + 0.05, z0: 0, z1: legZ },
      darken(tint, 0.72),
      { rim: false },
    );
  }
  block(g, f, { u0: 0.04, u1: 0.96, v0: 0.14, v1: 0.9, z0: legZ, z1: L }, tint);

  // Sheets, fanned, with ruled lines and a red stamp on the top one.
  for (let i = 0; i < 3; i++) {
    const u = 0.16 + i * 0.07 + f.rand(i) * 0.04;
    const v = 0.3 + i * 0.1;
    const sheet = [
      f.at(u, v, L + 1),
      f.at(u + 0.42, v - 0.05, L + 1),
      f.at(u + 0.47, v + 0.34, L + 1),
      f.at(u + 0.05, v + 0.39, L + 1),
    ];
    poly(g, sheet, i === 2 ? PARCHMENT : darken(PARCHMENT, 0.88));
    edge(g, sheet, darken(PARCHMENT, 0.6), 1.2, 0.7);
    if (i === 2) {
      for (let r = 1; r <= 4; r++) {
        line(
          g,
          f.at(u + 0.04, v + 0.07 * r, L + 2),
          f.at(u + 0.4, v + 0.02 + 0.07 * r, L + 2),
          0x9a8f74,
          1.2,
          0.8,
        );
      }
      const stamp = f.at(u + 0.36, v + 0.3, L + 2);
      g.lineStyle(2, 0xc05746, 0.9);
      g.strokeCircle(stamp.x, stamp.y, 7);
    }
  }
}

/** A crate: planked faces and a brace across each one. */
function crate(g: Phaser.GameObjects.Graphics, f: Frame, tint: number): void {
  const L = f.lift;
  block(g, f, { u0: 0, u1: 1, v0: 0, v1: 1, z0: 0, z1: L }, tint);
  // Frame edges.
  for (const [a, b] of [
    [f.at(0, 1, 0), f.at(0, 1, L)],
    [f.at(1, 1, 0), f.at(1, 1, L)],
    [f.at(1, 0, 0), f.at(1, 0, L)],
  ] as [Point, Point][]) {
    line(g, a, b, darken(tint, 0.45), 4, 0.9);
  }
  line(g, f.at(0, 1, L * 0.52), f.at(1, 1, L * 0.52), darken(tint, 0.45), 3.5, 0.85);
  line(g, f.at(1, 0, L * 0.52), f.at(1, 1, L * 0.52), darken(tint, 0.6), 3.5, 0.85);
  // The brace. A crate without a diagonal on it is a block.
  line(g, f.at(0.05, 1, L * 0.08), f.at(0.95, 1, L * 0.95), lighten(tint, 1.2), 3, 0.7);
  line(g, f.at(1, 0.05, L * 0.08), f.at(1, 0.95, L * 0.95), lighten(tint, 1.05), 3, 0.6);
}

/** A bookcase: uprights, shelves, and spines in the gaps. */
function shelf(g: Phaser.GameObjects.Graphics, f: Frame, tint: number): void {
  const L = f.lift;
  block(g, f, { u0: 0, u1: 1, v0: 0.18, v1: 0.72, z0: 0, z1: L }, darken(tint, 0.9));
  // The recess, so the shelves sit inside a carcass.
  const back = [f.at(0.05, 0.7, L * 0.06), f.at(0.95, 0.7, L * 0.06), f.at(0.95, 0.7, L * 0.94), f.at(0.05, 0.7, L * 0.94)];
  poly(g, back, darken(tint, 0.5));

  const rows = 4;
  const spines = [0x8a3f34, 0x3f5a6b, 0x6b5a2b, 0x4a5d3a, 0x6b3f5a];
  for (let r = 0; r < rows; r++) {
    const z0 = L * (0.08 + (r * 0.86) / rows);
    const z1 = z0 + (L * 0.86) / rows - L * 0.03;
    let u = 0.08;
    let i = 0;
    while (u < 0.9) {
      const w = 0.035 + f.rand(r * 7 + i) * 0.03;
      const lean = f.rand(r * 13 + i) > 0.85;
      const top = z1 - (lean ? (z1 - z0) * 0.25 : 0);
      poly(
        g,
        [f.at(u, 0.695, z0), f.at(u + w, 0.695, z0), f.at(u + w, 0.695, top), f.at(u, 0.695, top)],
        spines[(r + i) % spines.length]!,
      );
      u += w + 0.012;
      i++;
    }
    // The shelf board itself, drawn over the spines' feet.
    line(g, f.at(0.05, 0.69, z0), f.at(0.95, 0.69, z0), lighten(tint, 1.25), 3.5, 0.95);
  }
}

/** A console: a sloped desk with a lit screen and a row of buttons. */
function console_(g: Phaser.GameObjects.Graphics, f: Frame, tint: number): void {
  const L = f.lift;
  block(g, f, { u0: 0.06, u1: 0.94, v0: 0.2, v1: 0.84, z0: 0, z1: L * 0.6 }, tint);
  // The sloped face: back edge high, near edge at desk height.
  const slope = [
    f.at(0.08, 0.24, L),
    f.at(0.92, 0.24, L),
    f.at(0.92, 0.8, L * 0.6),
    f.at(0.08, 0.8, L * 0.6),
  ];
  poly(g, slope, darken(tint, 0.68));
  edge(g, slope, lighten(tint, 1.3), 1.8, 0.8);

  // The screen, which is the whole point of a console.
  const screen = [
    f.at(0.16, 0.3, L * 0.94),
    f.at(0.66, 0.3, L * 0.94),
    f.at(0.66, 0.56, L * 0.78),
    f.at(0.16, 0.56, L * 0.78),
  ];
  poly(g, screen, 0x0d1b21);
  edge(g, screen, GLASS, 1.8, 0.55);
  for (let i = 1; i <= 3; i++) {
    const t = i / 4;
    line(
      g,
      f.at(0.19, 0.3 + 0.26 * t, L * (0.94 - 0.16 * t)),
      f.at(0.19 + 0.36 + f.rand(i) * 0.08, 0.3 + 0.26 * t, L * (0.94 - 0.16 * t)),
      GLASS,
      1.6,
      0.6,
    );
  }
  // Buttons and a gauge.
  for (let i = 0; i < 4; i++) {
    const p = f.at(0.74 + i * 0.05, 0.42, L * 0.84);
    g.fillStyle([0xc05746, EMBER, 0x6fbf73, GLASS][i]!, 0.95);
    g.fillCircle(p.x, p.y, 4);
  }
  const dialAt = f.at(0.8, 0.66, L * 0.69);
  g.fillStyle(PARCHMENT, 0.9);
  g.fillCircle(dialAt.x, dialAt.y, 9);
  g.lineStyle(2, SLATE, 0.9);
  g.strokeCircle(dialAt.x, dialAt.y, 9);
  line(g, dialAt, { x: dialAt.x + 5, y: dialAt.y - 6 }, 0xc05746, 2, 1);
}

/** A lamp post with a lit head. Mostly here so a room has somewhere warm in it. */
function lamp(g: Phaser.GameObjects.Graphics, f: Frame, tint: number): void {
  const L = f.lift;
  cylinder(g, f, { u: 0.5, v: 0.5, ru: 0.22, rv: 0.22, z0: 0, z1: L * 0.08 }, darken(tint, 0.8));
  block(g, f, { u0: 0.44, u1: 0.56, v0: 0.44, v1: 0.56, z0: L * 0.08, z1: L * 0.78 }, tint);
  // The head: a glass box in a dark cage, with the glow drawn over it.
  const head = f.at(0.5, 0.5, L * 0.9);
  g.fillStyle(EMBER, 0.14);
  g.fillCircle(head.x, head.y, L * 0.5);
  g.fillStyle(EMBER, 0.2);
  g.fillCircle(head.x, head.y, L * 0.28);
  block(g, f, { u0: 0.3, u1: 0.7, v0: 0.3, v1: 0.7, z0: L * 0.78, z1: L * 0.98 }, EMBER, {
    rim: false,
  });
  block(g, f, { u0: 0.26, u1: 0.74, v0: 0.26, v1: 0.74, z0: L * 0.98, z1: L * 1.1 }, darken(tint, 0.6));
  g.fillStyle(0xfff0c8, 0.85);
  g.fillCircle(head.x, head.y, 6);
}

/** A column: moulded base, fluted shaft, capital. */
function pillar(g: Phaser.GameObjects.Graphics, f: Frame, tint: number): void {
  const L = f.lift;
  block(g, f, { u0: 0.04, u1: 0.96, v0: 0.04, v1: 0.96, z0: 0, z1: L * 0.1 }, darken(tint, 0.88));
  cylinder(g, f, { u: 0.5, v: 0.5, ru: 0.36, rv: 0.36, z0: L * 0.1, z1: L * 0.88 }, tint);
  for (let i = 0; i < 6; i++) {
    const a = -Math.PI / 4 + ((i + 0.5) / 6) * Math.PI;
    line(
      g,
      f.at(0.5 + 0.36 * Math.cos(a), 0.5 + 0.36 * Math.sin(a), L * 0.12),
      f.at(0.5 + 0.36 * Math.cos(a), 0.5 + 0.36 * Math.sin(a), L * 0.86),
      darken(tint, 0.62),
      1.6,
      0.55,
    );
  }
  block(g, f, { u0: 0.02, u1: 0.98, v0: 0.02, v1: 0.98, z0: L * 0.88, z1: L }, lighten(tint, 1.12));
}

/** A cart: a planked body on two wheels, with a handle. */
function cart(g: Phaser.GameObjects.Graphics, f: Frame, tint: number): void {
  const L = f.lift;
  const iron = 0x4a3a2a;
  const r = L * 0.28;
  // Four wheels, not two on one axle. A cart body is tall enough to swallow
  // the far wheel of a single axle completely, so the pair that proves it
  // rolls has to be the front and rear of the near side.
  const axles = [0.27, 0.73];

  for (const u of axles) {
    isoWheel(g, f, { u, v: 0.1, z: r, r }, darken(iron, 0.7));
    strut(g, f.at(u, 0.1, r), f.at(u, 0.9, r), darken(iron, 0.55), 4);
  }

  block(g, f, { u0: 0.1, u1: 0.9, v0: 0.26, v1: 0.74, z0: L * 0.34, z1: L }, tint);
  // Hollow it out, or it is a box on wheels rather than a cart.
  const inner = [
    f.at(0.16, 0.32, L * 0.98),
    f.at(0.84, 0.32, L * 0.98),
    f.at(0.84, 0.68, L * 0.98),
    f.at(0.16, 0.68, L * 0.98),
  ];
  poly(g, inner, darken(tint, 0.52));
  for (const t of [0.52, 0.8]) {
    line(g, f.at(0.1, 0.74, L * t), f.at(0.9, 0.74, L * t), darken(tint, 0.42), 2.5, 0.7);
  }
  // The draw-pole, out the front.
  strut(g, f.at(0.9, 0.5, L * 0.8), f.at(1.14, 0.5, L * 1.02), darken(tint, 0.6), 6);

  for (const u of axles) isoWheel(g, f, { u, v: 0.9, z: r, r }, iron);
}

/** A doorway: jambs, a lintel, a dark opening and two leaves. */
function door(g: Phaser.GameObjects.Graphics, f: Frame, tint: number): void {
  const L = f.lift;
  const dark = darken(tint, 0.3);
  poly(
    g,
    [f.at(0.14, 0.6, 0), f.at(0.86, 0.6, 0), f.at(0.86, 0.6, L * 0.86), f.at(0.14, 0.6, L * 0.86)],
    dark,
  );
  block(g, f, { u0: 0, u1: 0.16, v0: 0.4, v1: 0.64, z0: 0, z1: L * 0.92 }, tint);
  block(g, f, { u0: 0.84, u1: 1, v0: 0.4, v1: 0.64, z0: 0, z1: L * 0.92 }, tint);
  block(g, f, { u0: 0, u1: 1, v0: 0.4, v1: 0.64, z0: L * 0.86, z1: L }, lighten(tint, 1.1));
  // Two leaves, one swung ajar, with handles.
  for (const [u0, u1] of [
    [0.16, 0.5],
    [0.52, 0.84],
  ] as [number, number][]) {
    const leaf = [
      f.at(u0, 0.58, L * 0.02),
      f.at(u1, 0.58, L * 0.02),
      f.at(u1, 0.58, L * 0.84),
      f.at(u0, 0.58, L * 0.84),
    ];
    poly(g, leaf, darken(tint, 0.72));
    edge(g, leaf, lighten(tint, 1.2), 1.6, 0.7);
    const knob = f.at(u1 - 0.04, 0.57, L * 0.45);
    g.fillStyle(0xb08d57, 1);
    g.fillCircle(knob.x, knob.y, 4);
  }
}

/** A boulder: one faceted lump, jittered off the id so no two match. */
function rock(g: Phaser.GameObjects.Graphics, f: Frame, tint: number): void {
  const L = f.lift;
  const n = 7;
  const crown: Point[] = [];
  const skirt: Point[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    // Wide and low. A narrow crown on a tall lift is a standing stone, which is
    // not what a rockfall in a railway cutting looks like.
    const r = 0.3 + f.rand(i) * 0.16;
    const z = L * (0.45 + f.rand(i + 5) * 0.4);
    crown.push(f.at(0.5 + r * Math.cos(a), 0.5 + r * Math.sin(a), z));
    skirt.push(f.at(0.5 + (r + 0.08) * Math.cos(a), 0.5 + (r + 0.08) * Math.sin(a), 0));
  }
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const a = (i / n) * Math.PI * 2;
    quad(g, skirt[i]!, skirt[j]!, crown[j]!, crown[i]!, darken(tint, 0.5 + 0.3 * Math.cos(a - 2.2)));
  }
  poly(g, crown, tint);
  edge(g, crown, lighten(tint, 1.2), 1.6, 0.5);
}

const PAINTERS: Record<
  PropKind,
  (g: Phaser.GameObjects.Graphics, f: Frame, tint: number) => void
> = {
  board,
  lever,
  tank,
  barrel,
  launcher,
  ledge,
  document,
  crate,
  shelf,
  console: console_,
  lamp,
  pillar,
  cart,
  door,
  rock,
};

// --- entry points ---------------------------------------------------------

/**
 * Draw one prop into `g`, inside the rect the mapper gave it.
 *
 * The contact shadow goes down first: painted after the prop it tints the very
 * thing it is supposed to be sitting under.
 */
export function drawProp(
  g: Phaser.GameObjects.Graphics,
  target: Interactable,
  view: IsoView,
  opts: { kind?: PropKind; tint?: number } = {},
): { kind: PropKind; lift: number } {
  const kind = opts.kind ?? propKindFor(target);
  const lift = propHeight(target, kind);
  const tint = opts.tint ?? propTint(target, kind);
  const f = frame(target, view, lift, target.id);

  poly(g, isoDiamond(target, view), 0x000000, 0.28);
  PAINTERS[kind](g, f, tint);
  return { kind, lift };
}

/**
 * Is this blocked rect part of the room's shell, or something standing in it?
 *
 * A wall runs along an edge of the plane. Anything else is furniture, and
 * drawing furniture as masonry is how a room ends up looking like a warehouse
 * of identical blocks — which is exactly what it looked like.
 */
export function isWall(rect: Rect, room: { width: number; height: number }): boolean {
  return (
    rect.x <= 1 ||
    rect.y <= 1 ||
    rect.x + rect.w >= room.width - 1 ||
    rect.y + rect.h >= room.height - 1
  );
}

/**
 * Furniture: a blocked rect that is not part of the shell, drawn as something
 * a room would actually contain. Shape decides — long and shallow is a counter
 * or a bookcase, square is a crate or a barrel — and the rest comes off the
 * rect's own position, so a room is furnished the same way every time.
 */
export function drawFurniture(
  g: Phaser.GameObjects.Graphics,
  rect: Rect,
  view: IsoView,
): PropKind {
  const id = `furniture-${rect.x}-${rect.y}`;
  const aspect = rect.w / Math.max(1, rect.h);
  const short = Math.min(rect.w, rect.h);
  const long: PropKind[] = ['shelf', 'document', 'console'];
  const squat: PropKind[] = ['crate', 'barrel', 'rock', 'cart'];

  // A wide, low blocker is not furniture, it is ground: the far side of a
  // gorge, a loading platform, a plinth. Drawn as a crate it puts a shipping
  // container across the scenery — which is what the gorge looked like.
  const terrain = short >= 240 && (rect.height ?? short) < short / 2.5;
  const pool = terrain ? (['ledge'] as PropKind[]) : aspect > 2.2 || aspect < 0.45 ? long : squat;
  const kind = pool[seedOf(id) % pool.length]!;
  // The declared height was picked for a generic box. Let it cap the prop but
  // not stretch it: a boulder drawn to a 110px blocker is a standing stone.
  const natural = propHeight({ ...rect, id, height: undefined }, kind);
  const height = Math.min(rect.height ?? natural, natural);
  drawProp(g, { ...rect, id, height }, view, { kind });
  return kind;
}

/**
 * A wall, which has to read as a wall and not as a very large crate — so it
 * gets coursed stone and a cap, and never the rim light a prop gets.
 *
 * `flat` is for the two sides nearest the camera: extruding those would put the
 * player behind a wall from the viewer's side, so an isometric room is drawn as
 * a cutaway and the near sides stay painted on the floor.
 */
export function drawWall(
  g: Phaser.GameObjects.Graphics,
  rect: Rect,
  view: IsoView,
  flat: boolean,
): void {
  const tint = 0x4a3426;
  if (flat) {
    const base = isoDiamond(rect, view);
    poly(g, base, darken(tint, 0.72));
    edge(g, base, darken(tint, 0.5), 1.5, 0.8);
    return;
  }

  const lift = rect.height ?? 70;
  const f = frame(rect, view, lift, `${rect.x},${rect.y}`);
  poly(g, isoDiamond(rect, view), 0x000000, 0.22);
  block(g, f, { u0: 0, u1: 1, v0: 0, v1: 1, z0: 0, z1: lift }, tint, { rim: false });

  // Courses, with the joints staggered row to row. Four lines is the whole
  // difference between a stone wall and a brown rectangle.
  const courses = Math.max(2, Math.round(lift / 26));
  for (let i = 1; i < courses; i++) {
    const z = (lift * i) / courses;
    line(g, f.at(0, 1, z), f.at(1, 1, z), darken(tint, 0.44), 1.4, 0.55);
    line(g, f.at(1, 0, z), f.at(1, 1, z), darken(tint, 0.6), 1.4, 0.45);
    const offset = i % 2 === 0 ? 0 : 0.5;
    for (let j = 0; j < 3; j++) {
      const u = (j + offset) / 3;
      if (u <= 0 || u >= 1) continue;
      line(g, f.at(u, 1, z), f.at(u, 1, z - lift / courses), darken(tint, 0.44), 1.3, 0.4);
    }
  }
  // A cap course, lighter, which is what gives a wall its top edge.
  block(g, f, { u0: -0.01, u1: 1.01, v0: -0.01, v1: 1.01, z0: lift, z1: lift + 7 }, lighten(tint, 1.2), {
    rim: false,
  });
}

/**
 * The ring on the floor under an interactable. Dim always, gold when the player
 * is close enough for E to do something — so "which of these can I use" is
 * answered without walking into each one in turn.
 */
export function drawFootprint(
  g: Phaser.GameObjects.Graphics,
  target: Interactable,
  view: IsoView,
  active: boolean,
): void {
  const pad = 26;
  const grown: Rect = {
    x: target.x - pad,
    y: target.y - pad,
    w: target.w + pad * 2,
    h: target.h + pad * 2,
  };
  const ring = isoDiamond(grown, view);
  poly(g, ring, active ? GOLD : 0x000000, active ? 0.14 : 0.18);
  edge(g, ring, active ? GOLD : 0x6b5a3a, active ? 2.4 : 1.4, active ? 0.9 : 0.4);
}

// --- colour ---------------------------------------------------------------

/** Scale every channel, clamped. Two names because the call sites read better:
 *  `darken(tint, 0.6)` and `lighten(tint, 1.4)` say which way they are going. */
function shade(color: number, factor: number): number {
  const channel = (shift: number) => Math.min(255, Math.round(((color >> shift) & 0xff) * factor));
  return (channel(16) << 16) | (channel(8) << 8) | channel(0);
}

export const lighten = shade;
export const darken = shade;
