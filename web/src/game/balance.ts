/**
 * A balance, drawn: a beam on its support, or a deck on its pier, and the loads
 * sitting on it.
 *
 * Everything on it is read off the simulation. Where a load stands is its
 * position expression evaluated at the dials; how big it is comes from its
 * mass; the green bead is the act's own centre-of-mass output; the tilt is the
 * act's own angle, sample by sample. The only thing this file decides is how
 * those numbers look — so a beam that is level here is a beam the sim says is
 * level, and a beam that tips is one the sim tipped.
 *
 * The one liberty taken is the floor: a sim will happily rotate a beam 25°
 * about a knife-edge 60px off the ground. Drawn honestly the end would go
 * through the floor, so the drawn tilt stops where the end touches it, which
 * is also what "it tipped" looks like in a room.
 */
import Phaser from 'phaser';
import type {
  Balance,
  BalanceMeasure,
  PlacedLoad,
  Point,
  Rect,
  SimSample,
  SimSpec,
} from '@chapter-quest/shared';
import {
  balanceScope,
  compile,
  evaluate,
  explainBalance,
  measureBalance,
  sideTorques,
} from '@chapter-quest/shared';

/** Beam bottom above the floor at the support, screen px, when the stage gives no height. */
const LIFT = 62;
/**
 * Screen px per world px of height. A world square projects to a diamond as
 * wide as its side, and a cube of that side stands about 0.61 of it tall in a
 * 2:1 dimetric view — so a height in sim units, times the beam's own scale,
 * times this, is that height drawn on the same ruler as the floor.
 */
const V = 0.61;
/** The muted teal the target line is drawn in. */
const TEAL = 0x5fa8a0;
/** Beam thickness, screen px. */
const THICK = 13;
/** Half the beam's width across the plane, world px. */
const HALF = 24;
/** A deck's height off the floor, screen px. */
const DECK = 16;
/** Half a target platform's depth across the plane, world px. */
const PLATFORM = 78;

const WOOD_TOP = 0xc08a4e;
const WOOD_FRONT = 0x8a5a30;
const WOOD_END = 0x684222;
const INK = 0x24160b;
const STONE_TOP = 0xb3a893;
const STONE_LEFT = 0x8c8170;
const STONE_RIGHT = 0x6b6254;
const IRON = 0x4a4f57;
const IRON_LIGHT = 0x7b828c;
const TERRACOTTA = 0xc8643c;
const GOLD = 0xd9a441;
const GREEN = 0x6fbf73;
const GREEN_BRIGHT = 0x9be3a0;
const PARCHMENT = 0xf4ecd8;

export interface RigView {
  values: Record<string, number>;
  /** As simulated, in radians. Clamped to the floor when drawn. */
  tilt: number;
  /** The param in the player's hand, if any. */
  held: string | null;
  showCom: boolean;
  verdict: 'won' | 'lost' | null;
  /** One line under the verdict saying why. */
  note?: string;
  time: number;
  /** 0 → 1: the cargo crossing from the beam onto its platform, after a win. */
  delivered?: number;
}

type Placed = PlacedLoad;
type Measured = BalanceMeasure;

type Project = (x: number, y: number) => Point;

export class BalanceRig {
  /** Shadows, rails and rings: on the floor, under everything that stands. */
  private readonly floor: Phaser.GameObjects.Graphics;
  /** The beam, its support and its loads: sorted against the player. */
  private readonly body: Phaser.GameObjects.Graphics;
  private readonly scene: Phaser.Scene;
  /** Reused between redraws and grown on demand: a redraw is every frame while held. */
  private readonly texts: Phaser.GameObjects.Text[] = [];
  private textsUsed = 0;
  /** Load tags placed this redraw, so two crates at one spot do not print over each other. */
  private tags: Phaser.Geom.Rectangle[] = [];
  private readonly balance: Balance;
  private readonly spec: SimSpec;
  private readonly project: Project;
  /** World px per sim unit, along and across. */
  private readonly k: number;
  /** The heaviest anything here can be, so crate sizes mean the same thing all act. */
  private readonly heaviest: number;
  /** True when the centre of mass moves as the dials do. */
  readonly comLive: boolean;

  constructor(
    scene: Phaser.Scene,
    balance: Balance,
    spec: SimSpec,
    params: { name: string; min: number; max: number; default: number; solution: number }[],
    project: Project,
  ) {
    this.balance = balance;
    this.spec = spec;
    this.project = project;
    const beam = balance.beam;
    this.k = (beam.to.x - beam.from.x) / (beam.toValue - beam.fromValue || 1);
    this.scene = scene;
    this.floor = scene.add.graphics().setDepth(0.6);
    this.body = scene.add.graphics();

    const at = (pick: 'min' | 'max' | 'default' | 'solution') =>
      this.measure(Object.fromEntries(params.map((p) => [p.name, p[pick]])));
    const corners = (['min', 'max', 'default', 'solution'] as const).map(at);
    this.heaviest = Math.max(1e-6, ...corners.flatMap((m) => m.loads.map((l) => l.mass)));
    const a = corners[2]!;
    const b = corners[3]!;
    this.comLive = a.com !== b.com || a.comY !== b.comY;
  }

  get isDeck(): boolean {
    return this.balance.across !== undefined;
  }

  /** What stands on the plane, for colliders: the beam and any platform. A deck is walked on. */
  footprints(): Rect[] {
    if (this.isDeck) return [];
    const beam = this.balance.beam;
    const rects: Rect[] = [
      {
        x: beam.from.x - 8,
        y: beam.from.y - HALF - 8,
        w: beam.to.x - beam.from.x + 16,
        h: HALF * 2 + 16,
      },
    ];
    const target = this.balance.target;
    if (target) {
      const a = this.worldX(target.from);
      const b = this.worldX(target.to);
      rects.push({
        x: Math.min(a, b),
        y: beam.from.y - PLATFORM,
        w: Math.abs(b - a),
        h: PLATFORM * 2,
      });
    }
    return rects;
  }

  /** Front edge of the rig on the plane: anything nearer the viewer is in front of it. */
  frontY(): number {
    const beam = this.balance.beam;
    return this.isDeck ? beam.from.y + this.depthPx() : beam.from.y + HALF;
  }

  /** Where the beacon should stand and point, screen space. */
  beacon(): { ground: Point; apex: Point } {
    const beam = this.balance.beam;
    const midX = (beam.from.x + beam.to.x) / 2;
    const midY = this.isDeck ? beam.from.y + this.depthPx() / 2 : beam.from.y;
    const ground = this.project(midX, midY);
    const rise = this.isDeck ? 90 : this.balance.height ? 230 : LIFT + 120;
    return { ground, apex: { x: ground.x, y: ground.y - rise } };
  }

  /** Where to centre the camera to see the whole machine: beam, support and any platform. */
  frame(): Point {
    if (this.isDeck) return this.beacon().ground;
    const beam = this.balance.beam;
    const t = this.balance.target;
    const lo = Math.min(beam.fromValue, t ? Math.min(t.from, t.to) : beam.fromValue);
    const hi = Math.max(beam.toValue, t ? Math.max(t.from, t.to) : beam.toValue);
    const p = this.project(this.worldX((lo + hi) / 2), beam.from.y);
    return { x: p.x, y: p.y - (this.balance.height ? 60 : 0) };
  }

  setDepth(depth: number): void {
    this.body.setDepth(depth);
  }

  /** Every number the drawing needs, from the act's own expressions. */
  measure(values: Record<string, number>): Measured {
    return measureBalance(this.balance, this.spec, values);
  }

  /** The sim's tilt at each sample, in radians. */
  tilts(samples: SimSample[]): number[] {
    if (!this.balance.tilt) return [];
    const expr = compile(this.balance.tilt);
    return samples.map((s) => {
      try {
        return this.toRadians(expr.evaluate(s));
      } catch {
        return 0;
      }
    });
  }

  /** Where the beam lies before anything happens: the sim's own initial state. */
  restTilt(values: Record<string, number>): number {
    if (!this.balance.tilt) return 0;
    try {
      return this.toRadians(evaluate(this.balance.tilt, balanceScope(this.spec, values)));
    } catch {
      return 0;
    }
  }

  private toRadians(value: number): number {
    if (!Number.isFinite(value)) return 0;
    if (this.balance.tiltUnit === 'deg') return (value * Math.PI) / 180;
    if (this.balance.tiltUnit === 'sin') return Math.asin(Phaser.Math.Clamp(value, -1, 1));
    return value;
  }

  /** True when the stage has somewhere for a load to be delivered. */
  get delivers(): boolean {
    return this.balance.target !== undefined;
  }

  /** True once the drawn beam has come down onto the floor. */
  grounded(tilt: number, values: Record<string, number>): boolean {
    const m = this.measure(values);
    return Math.abs(this.clampTilt(tilt, m.pivot, this.lift(m))) < Math.abs(tilt) - 1e-6;
  }

  /** Why it did what it did, in one line — from shared/balance.ts, so it is tested. */
  explain(
    values: Record<string, number>,
    tilt: number,
    won: boolean,
    outputs?: Record<string, number>,
  ): string {
    return explainBalance(this.balance, this.spec, values, {
      won,
      tilt,
      ...(outputs ? { outputs } : {}),
    });
  }

  draw(view: RigView): void {
    this.floor.clear();
    this.body.clear();
    this.textsUsed = 0;
    this.tags = [];
    const m = this.measure(view.values);
    if (this.isDeck) this.drawDeck(view, m);
    else this.drawBeam(view, m);
    for (let i = this.textsUsed; i < this.texts.length; i++) this.texts[i]!.setVisible(false);
  }

  /** The canvas draws over the DOM: labels stand down while a React panel is up. */
  showLabels(visible: boolean): void {
    for (const text of this.texts.slice(0, this.textsUsed)) text.setVisible(visible);
  }

  destroy(): void {
    this.floor.destroy();
    this.body.destroy();
    for (const text of this.texts) text.destroy();
  }

  // --- the beam -------------------------------------------------------------

  private worldX(s: number): number {
    const beam = this.balance.beam;
    return beam.from.x + (s - beam.fromValue) * this.k;
  }

  /** Height of the support in world px: the stage's own when it gives one. */
  private lift(m: Measured): number {
    return m.height !== null ? m.height * this.k : LIFT / V;
  }

  /** How far the drawn beam may turn before an end meets the floor. */
  private clampTilt(tilt: number, pivot: number, lift: number): number {
    const beam = this.balance.beam;
    const reach = tilt >= 0 ? (beam.toValue - pivot) * this.k : (pivot - beam.fromValue) * this.k;
    if (reach <= lift) return tilt;
    const limit = Math.asin(lift / reach);
    return Phaser.Math.Clamp(tilt, -limit, limit);
  }

  /**
   * A point on the beam: `s` along it in sim units, `dy` across it in world px,
   * `up` above its underside in screen px. Positive tilt drops the far end.
   */
  private beamPoint(
    s: number,
    dy: number,
    up: number,
    pivot: number,
    tilt: number,
    lift: number,
  ): Point {
    const d = (s - pivot) * this.k;
    const x = this.worldX(pivot) + d * Math.cos(tilt);
    const p = this.project(x, this.balance.beam.from.y + dy);
    return { x: p.x, y: p.y - (V * (lift - d * Math.sin(tilt)) + up) };
  }

  /** A point on top of the target platform, `s` along the beam's line. */
  private platformPoint(s: number, dy: number, up: number, m: Measured): Point {
    const p = this.project(this.worldX(s), this.balance.beam.from.y + dy);
    return { x: p.x, y: p.y - (V * (m.targetHeight ?? 0) * this.k + up) };
  }

  /**
   * The platform: dressed sandstone with a timber deck, standing on the floor
   * beside the beam's end, as tall as the sim says the target is.
   */
  private drawPlatform(m: Measured): void {
    const target = this.balance.target!;
    const g = this.body;
    const f = this.floor;
    const y = this.balance.beam.from.y;
    const a = Math.min(this.worldX(target.from), this.worldX(target.to));
    const b = Math.max(this.worldX(target.from), this.worldX(target.to));
    const top = V * (m.targetHeight ?? 0) * this.k;
    const rect = { x: a, y: y - PLATFORM, w: b - a, h: PLATFORM * 2 };
    poly(
      f,
      [
        this.project(rect.x + 18, rect.y + 18),
        this.project(rect.x + rect.w + 30, rect.y + 18),
        this.project(rect.x + rect.w + 30, rect.y + rect.h + 30),
        this.project(rect.x + 18, rect.y + rect.h + 30),
      ],
      0x000000,
      0.3,
    );
    box(g, this.project, rect, 0, top - 10, STONE_TOP, STONE_LEFT, STONE_RIGHT);
    // Courses of stone on the two faces you can see.
    g.lineStyle(1, INK, 0.35);
    const rows = Math.max(2, Math.round(top / 26));
    for (let i = 1; i < rows; i++) {
      const h = ((top - 10) * i) / rows;
      const l = this.project(rect.x, rect.y + rect.h);
      const c = this.project(rect.x + rect.w, rect.y + rect.h);
      const r = this.project(rect.x + rect.w, rect.y);
      line(g, { x: l.x, y: l.y - h }, { x: c.x, y: c.y - h });
      line(g, { x: c.x, y: c.y - h }, { x: r.x, y: r.y - h });
      // Staggered joints, so it is laid stone and not a striped box.
      const t = i % 2 ? 0.33 : 0.66;
      const jx = mix(l, c, t);
      const jr = mix(c, r, t);
      line(g, { x: jx.x, y: jx.y - h }, { x: jx.x, y: jx.y - h + (top - 10) / rows });
      line(g, { x: jr.x, y: jr.y - h }, { x: jr.x, y: jr.y - h + (top - 10) / rows });
    }
    // A teak deck on top, its edge catching the light.
    box(g, this.project, rect, top - 10, top, WOOD_TOP, WOOD_FRONT, WOOD_END);
    g.lineStyle(1, darken(WOOD_TOP, 0.7), 0.6);
    for (let k = 1; k < 4; k++) {
      const yy = rect.y + (rect.h * k) / 4;
      const p0 = this.project(rect.x, yy);
      const p1 = this.project(rect.x + rect.w, yy);
      line(g, { x: p0.x, y: p0.y - top }, { x: p1.x, y: p1.y - top });
    }
    const tagAt = this.project(rect.x + rect.w / 2, rect.y);
    this.text(
      { x: tagAt.x, y: tagAt.y - top - 10 },
      `${target.label ?? 'platform'} · ${fmt2(m.targetHeight ?? 0)}${this.balance.beam.unit ? ` ${this.balance.beam.unit}` : ''}`,
      '#a9dcd5',
      13,
      '#0b0806cc',
    );
  }

  private drawBeam(view: RigView, m: Measured): void {
    const beam = this.balance.beam;
    const lift = this.lift(m);
    const LIFT = V * lift; // the support's height on screen, shadowing the default
    const tilt = this.clampTilt(view.tilt, m.pivot, lift);
    const at = (s: number, dy: number, up: number) =>
      this.beamPoint(s, dy, up, m.pivot, tilt, lift);
    const g = this.body;
    const f = this.floor;

    // Shadow: the beam's own footprint, falling away from the light at the top left.
    const sh = (x: number, y: number) => this.project(x, y);
    const x0 = this.worldX(m.pivot) + (beam.fromValue - m.pivot) * this.k * Math.cos(tilt);
    const x1 = this.worldX(m.pivot) + (beam.toValue - m.pivot) * this.k * Math.cos(tilt);
    poly(
      f,
      [
        sh(x0, beam.from.y - HALF + 10),
        sh(x1, beam.from.y - HALF + 10),
        sh(x1, beam.from.y + HALF + 26),
        sh(x0, beam.from.y + HALF + 26),
      ],
      0x000000,
      0.22,
    );

    // A support that can slide gets the groove it slides in, so it reads as movable.
    const movable = this.balance.pivot !== '0' && !/^-?[\d.]+$/.test(this.balance.pivot);
    if (movable && view.values[this.balance.pivot] !== undefined) {
      const a = sh(beam.from.x + 20, beam.from.y);
      const b = sh(beam.to.x - 20, beam.from.y);
      f.lineStyle(7, 0x120b06, 0.55);
      line(f, a, b);
      f.lineStyle(2, IRON_LIGHT, 0.5);
      line(f, a, b);
    }

    // The platform stands behind the beam's near end, so it is drawn first.
    if (this.balance.target) this.drawPlatform(m);

    // The support: a dressed-stone pedestal on a wider footing, and the iron
    // edge the beam rests on. Grey stone and dark iron, so it can never be
    // mistaken for one of the wooden loads.
    const px = this.worldX(m.pivot);
    const py = beam.from.y;
    const plinthTop = LIFT - 28;
    const held = view.held !== null && view.held === this.balance.pivot;
    f.fillStyle(0x000000, 0.32);
    f.fillEllipse(sh(px, py).x + 8, sh(px, py).y + 5, 104, 44);
    if (held) {
      f.lineStyle(3, GOLD, 0.9);
      f.strokeEllipse(sh(px, py).x, sh(px, py).y, 120, 56);
    }
    box(
      g,
      this.project,
      { x: px - 30, y: py - 30, w: 60, h: 60 },
      0,
      9,
      darken(STONE_TOP, 0.8),
      darken(STONE_LEFT, 0.8),
      darken(STONE_RIGHT, 0.8),
    );
    box(
      g,
      this.project,
      { x: px - 21, y: py - 21, w: 42, h: 42 },
      9,
      plinthTop,
      STONE_TOP,
      STONE_LEFT,
      STONE_RIGHT,
    );
    // A course line in the stone, so it is masonry rather than a box.
    g.lineStyle(1, INK, 0.4);
    const course = (plinthTop + 9) / 2;
    line(
      g,
      { x: this.project(px - 21, py + 21).x, y: this.project(px - 21, py + 21).y - course },
      { x: this.project(px + 21, py + 21).x, y: this.project(px + 21, py + 21).y - course },
    );
    line(
      g,
      { x: this.project(px + 21, py + 21).x, y: this.project(px + 21, py + 21).y - course },
      { x: this.project(px + 21, py - 21).x, y: this.project(px + 21, py - 21).y - course },
    );
    const wedge = (dy: number, h: number, dx: number) => {
      const p = this.project(px + dx, py + dy);
      return { x: p.x, y: p.y - h };
    };
    poly(
      g,
      [
        wedge(-22, LIFT, 0),
        wedge(22, LIFT, 0),
        wedge(22, plinthTop, -20),
        wedge(-22, plinthTop, -20),
      ],
      darken(IRON, 0.8),
      1,
    );
    poly(
      g,
      [
        wedge(-22, LIFT, 0),
        wedge(22, LIFT, 0),
        wedge(22, plinthTop, 20),
        wedge(-22, plinthTop, 20),
      ],
      IRON,
      1,
    );
    poly(
      g,
      [wedge(22, LIFT, 0), wedge(22, plinthTop, 20), wedge(22, plinthTop, -20)],
      IRON_LIGHT,
      1,
    );
    g.lineStyle(held ? 3 : 1.5, held ? GOLD : INK, held ? 1 : 0.85);
    g.strokePoints(
      [wedge(22, LIFT, 0), wedge(22, plinthTop, 20), wedge(22, plinthTop, -20)].map(pt),
      true,
    );
    // The edge itself catches the light: this line is the pivot.
    g.lineStyle(2, TERRACOTTA, 1);
    line(g, wedge(-22, LIFT, 0), wedge(22, LIFT, 0));

    // The beam: top, the long face toward the viewer, and the near end.
    const top = [
      at(beam.fromValue, -HALF, THICK),
      at(beam.toValue, -HALF, THICK),
      at(beam.toValue, HALF, THICK),
      at(beam.fromValue, HALF, THICK),
    ];
    const front = [
      at(beam.fromValue, HALF, THICK),
      at(beam.toValue, HALF, THICK),
      at(beam.toValue, HALF, 0),
      at(beam.fromValue, HALF, 0),
    ];
    const end = [
      at(beam.toValue, -HALF, THICK),
      at(beam.toValue, HALF, THICK),
      at(beam.toValue, HALF, 0),
      at(beam.toValue, -HALF, 0),
    ];
    const glow = view.verdict === 'won' ? GREEN_BRIGHT : null;
    poly(g, front, WOOD_FRONT, 1);
    poly(g, end, WOOD_END, 1);
    poly(g, top, WOOD_TOP, 1);
    // Grain, and the planks it is pegged from.
    g.lineStyle(1, darken(WOOD_TOP, 0.75), 0.55);
    for (const dy of [-HALF * 0.45, HALF * 0.1, HALF * 0.6]) {
      line(g, at(beam.fromValue, dy, THICK), at(beam.toValue, dy, THICK));
    }
    g.lineStyle(1.5, INK, 0.9);
    g.strokePoints(top.map(pt), true);
    g.strokePoints(front.map(pt), true);
    g.strokePoints(end.map(pt), true);
    if (glow) {
      g.lineStyle(3, glow, 0.9);
      line(g, top[3]!, top[2]!);
    }

    // The scale, notched into the near edge, numbered at the round ones only.
    const span = beam.toValue - beam.fromValue;
    const step = niceStep(span);
    const every = niceStep(span * 2.5);
    for (let s = Math.ceil(beam.fromValue / step) * step; s <= beam.toValue + 1e-9; s += step) {
      const major = Math.abs(s / every - Math.round(s / every)) < 1e-6;
      g.lineStyle(major ? 2.5 : 1.5, INK, 0.85);
      line(g, at(s, HALF, THICK), at(s, HALF, major ? THICK - 9 : THICK - 5));
      // Not under the support, where the number would sit on the iron.
      if (major && Math.abs(s - m.pivot) * this.k > 34) {
        const label = at(s, HALF, -3);
        this.text({ x: label.x, y: label.y + 16 }, fmt(s), '#f4ecd8bb', 12, null);
      }
    }

    // How high is high enough: a teal line at the target's height, run from
    // the platform's edge out over the cargo, so a crate that stops short is
    // seen to stop short.
    const target = this.balance.target;
    const cargo = target ? m.loads.find((l) => l.load.mass === target.cargo) : undefined;
    if (target && cargo && !(view.delivered && view.delivered > 0)) {
      const edge = Math.max(target.from, target.to);
      g.lineStyle(2, TEAL, 0.85);
      dashed(
        g,
        this.platformPoint(edge, PLATFORM, 0, m),
        this.platformPoint(cargo.at + 0.5, PLATFORM, 0, m),
        6,
      );
      dashed(
        g,
        this.platformPoint(edge, -PLATFORM, 0, m),
        this.platformPoint(cargo.at + 0.5, -PLATFORM, 0, m),
        6,
      );
    }

    // The loads, back to front. The cargo, once delivered, slides from the
    // beam onto the platform: the same corners, eased from one surface to the other.
    const placed = [...m.loads].sort((a, b) => a.at - b.at);
    for (const load of placed) {
      const moving = target && load === cargo && view.delivered ? view.delivered : 0;
      if (moving > 0 && target) {
        const landing = (target.from + target.to) / 2 - load.at;
        const ease = moving < 0.5 ? 2 * moving * moving : 1 - (-2 * moving + 2) ** 2 / 2;
        this.drawLoad(
          view,
          load,
          (s, dy, up) =>
            mix(at(s, dy, up + THICK), this.platformPoint(s + landing, dy, up, m), ease),
          m,
        );
      } else {
        this.drawLoad(view, load, (s, dy, up) => at(s, dy, up + THICK), m);
      }
    }

    // The support's own tag, low and in front, in the support's colour.
    const tag = this.project(px, py + 46);
    const unit = beam.unit ? ` ${beam.unit}` : '';
    this.text(
      { x: tag.x, y: tag.y + 26 },
      `▲ ${this.balance.pivotLabel ?? 'pivot'} · ${fmt(m.pivot)}${unit}`,
      '#e8a07e',
      13,
      held ? '#3a1d10ee' : '#0b0806cc',
    );

    // The centre of mass: a bead on the beam with a plumb line to the floor.
    if (view.showCom && m.com !== null) {
      const bead = at(m.com, 0, THICK + 30);
      const onBeam = at(m.com, 0, THICK);
      const ground = this.project(
        this.worldX(m.pivot) + (m.com - m.pivot) * this.k * Math.cos(tilt),
        beam.from.y,
      );
      // How far it is from the support, on the floor where both can be seen.
      const support = this.project(px, py);
      if (Math.abs(m.com - m.pivot) * this.k > 6) {
        f.lineStyle(3, GOLD, 0.7);
        dashed(f, support, ground, 7);
      }
      f.lineStyle(2, GREEN, 0.75);
      f.strokeEllipse(ground.x, ground.y, 28, 14);
      g.lineStyle(2, GREEN, 0.8);
      dashed(g, { x: onBeam.x, y: onBeam.y }, { x: ground.x, y: ground.y }, 5);
      diamond(g, bead, 9, GREEN, view.verdict === 'won' ? GREEN_BRIGHT : 0x1f3a22);
      line(g, bead, onBeam);
      this.text(
        { x: bead.x, y: bead.y - 12 },
        `centre of mass · ${fmt(m.com)}${unit}`,
        '#9be3a0',
        14,
        '#0b0806dd',
      );
    }

    if (view.verdict) {
      const over = this.project(px, py);
      // Low enough to clear the panels along the top of the screen.
      this.verdictTag(
        view,
        // A delivery lever's load is to the right: lean the note that way,
        // between the panels along the top of the screen.
        {
          x: over.x + (this.balance.target ? 90 : 0),
          y: over.y - LIFT - (this.balance.target ? 95 : 150),
        },
        m,
      );
    }
  }

  /** A crate, an iron weight or a fixed moment, standing on whatever `on` maps. */
  private drawLoad(
    view: RigView,
    placed: Placed,
    on: (s: number, dy: number, up: number) => Point,
    m: Measured,
    onDeck = false,
  ): void {
    const { load } = placed;
    const g = this.body;
    const held =
      view.held !== null &&
      (view.held === load.mass ||
        view.held === load.at.replace(/^-/, '') ||
        view.held === load.atY);
    const bob = held ? 3 + Math.sin(view.time / 170) * 2.5 : 0;
    const iron =
      Boolean(load.moment) || /(lead|iron|counter|weight|collar)/i.test(load.label ?? '');
    const size = load.moment
      ? 40
      : load.size
        ? load.size * this.k
        : 22 + 34 * Math.cbrt(Math.max(placed.mass, 0) / this.heaviest);
    // Along in sim units, across in world px: a crate on a beam overhangs it a
    // little at most, one on a deck is as deep as it is wide.
    const half = size / 2 / this.k;
    const halfY = onDeck ? size / 2 : Math.min(size / 2, HALF + 6);
    const corner = (ds: number, dy: number, up: number) => on(placed.at + ds, dy, up + bob);
    const height = load.moment ? 34 : size * 0.72;

    const b0 = corner(-half, -halfY, 0);
    const b1 = corner(half, -halfY, 0);
    const b2 = corner(half, halfY, 0);
    const b3 = corner(-half, halfY, 0);
    const lift = (p: Point) => ({ x: p.x, y: p.y - height });
    const topFace = [lift(b0), lift(b1), lift(b2), lift(b3)];
    const frontFace = [b3, b2, lift(b2), lift(b3)];
    const sideFace = [b1, b2, lift(b2), lift(b1)];

    const [cTop, cFront, cSide] = iron
      ? [IRON_LIGHT, IRON, darken(IRON, 0.75)]
      : [0xd2a46a, 0xa0703e, 0x7a522b];
    if (held) {
      // Lifted a touch and outlined: this is the one the arrows move.
      const shadow = corner(0, 0, -bob);
      g.fillStyle(0x000000, 0.25);
      g.fillEllipse(shadow.x, shadow.y, size * 0.9, size * 0.4);
    }
    poly(g, frontFace, cFront, 1);
    poly(g, sideFace, cSide, 1);
    poly(g, topFace, cTop, 1);
    if (!iron) {
      // Battens: what makes a box a crate.
      g.lineStyle(2, darken(cFront, 0.7), 0.9);
      line(g, mix(b3, lift(b3), 0.5), mix(b2, lift(b2), 0.5));
      line(g, mix(b3, b2, 0.5), mix(lift(b3), lift(b2), 0.5));
      if (load.size) {
        // A crate of known size is a heavy one: iron straps over it, front to back.
        g.lineStyle(4, IRON, 1);
        for (const t of [0.22, 0.78]) {
          line(g, mix(b3, b2, t), mix(lift(b3), lift(b2), t));
          line(g, mix(lift(b3), lift(b2), t), mix(lift(b0), lift(b1), t));
          line(g, mix(b2, b1, t), mix(lift(b2), lift(b1), t));
        }
        g.lineStyle(1, IRON_LIGHT, 0.6);
        for (const t of [0.22, 0.78])
          line(g, mix(lift(b3), lift(b2), t), mix(lift(b0), lift(b1), t));
      }
    } else {
      g.lineStyle(1.5, PARCHMENT, 0.25);
      line(g, mix(lift(b3), lift(b2), 0.15), mix(lift(b0), lift(b1), 0.15));
    }
    g.lineStyle(held ? 3 : 1.5, held ? GOLD : INK, held ? 1 : 0.9);
    g.strokePoints(topFace.map(pt), true);
    g.strokePoints(frontFace.map(pt), true);
    g.strokePoints(sideFace.map(pt), true);

    const crown = mix(lift(b0), lift(b2), 0.5);
    const unit = this.balance.beam.unit ? ` ${this.balance.beam.unit}` : '';
    // A bare "300" could be anything; with no unit to hand, say what it is.
    const mass = load.force
      ? `${fmt(placed.mass)} N`
      : this.balance.massUnit
        ? `${fmt(placed.mass)} ${this.balance.massUnit}`
        : `mass ${fmt(placed.mass)}`;
    const name = load.label && !/^load \d+$/.test(load.label) ? `${load.label}\n` : '';
    // With torque shown, a load says its arm and its turning effect — the two
    // numbers the lesson is about — rather than where it sits on the scale.
    const arm = Math.abs(placed.at - m.pivot);
    const what = load.moment
      ? `${load.label ?? 'fixed load'}\nmoment ${fmt(placed.moment)}`
      : onDeck
        ? `${name}${mass} · (${fmt(placed.at)}, ${fmt(placed.atY)})`
        : this.balance.showTorque
          ? `${load.label ?? 'load'} · ${mass}\narm ${fmt2(arm)}${unit} · τ ${Math.round(placed.mass * (load.force ? 1 : m.g) * arm)} N·m`
          : `${name}${mass} · at ${fmt(placed.at)}${unit}`;
    this.text(
      { x: crown.x, y: crown.y - 10 },
      what,
      held ? '#f4d58a' : '#f4ecd8',
      13,
      held ? '#2b1c0aee' : '#0b0806cc',
    );
    // Stacked upward out of each other's way: loads can share a position.
    const tag = this.texts[this.textsUsed - 1]!;
    if (held) tag.setDepth(9150);
    const box = tag.getBounds();
    for (
      let tries = 0;
      tries < 8 && this.tags.some((r) => Phaser.Geom.Intersects.RectangleToRectangle(r, box));
      tries++
    ) {
      tag.setY(tag.y - box.height - 2);
      box.y -= box.height + 2;
    }
    this.tags.push(box);
  }

  private verdictTag(view: RigView, at: Point, m: Measured): void {
    const won = view.verdict === 'won';
    this.text(at, this.verdictWord(won, m), won ? '#9be3a0' : '#f08a76', 20, '#0b0806ee');
    if (view.note) {
      this.text({ x: at.x, y: at.y + 4 }, view.note, '#f4ecd8', 14, '#0b0806ee', 500);
      this.texts[this.textsUsed - 1]!.setOrigin(0.5, 0);
    }
  }

  /** One word for the outcome, chosen by the same torques the explanation quotes. */
  private verdictWord(won: boolean, m: Measured): string {
    const target = this.balance.target;
    if (!target) return won ? 'BALANCED' : 'TIPPED';
    if (won) return 'DELIVERED';
    const cargo = m.loads.find((l) => l.load.mass === target.cargo);
    const { low, high } = sideTorques(m);
    const cargoLow = cargo ? cargo.at < m.pivot : true;
    return (cargoLow ? high <= low : low <= high) ? 'STUCK' : 'TOO LOW';
  }

  // --- the deck -------------------------------------------------------------

  private depthPx(): number {
    const across = this.balance.across!;
    return (across.toValue - across.fromValue) * this.k;
  }

  private drawDeck(view: RigView, m: Measured): void {
    const beam = this.balance.beam;
    const across = this.balance.across!;
    const g = this.body;
    const f = this.floor;
    const w = beam.to.x - beam.from.x;
    const d = this.depthPx();
    const wx = (s: number) => beam.from.x + (s - beam.fromValue) * this.k;
    const wy = (s: number) => beam.from.y + (s - across.fromValue) * this.k;
    const deckRect = { x: beam.from.x, y: beam.from.y, w, h: d };

    poly(
      f,
      [
        this.project(deckRect.x + 14, deckRect.y + 14),
        this.project(deckRect.x + w + 22, deckRect.y + 14),
        this.project(deckRect.x + w + 22, deckRect.y + d + 22),
        this.project(deckRect.x + 14, deckRect.y + d + 22),
      ],
      0x000000,
      0.25,
    );
    box(f, this.project, deckRect, 0, DECK, 0xb98b57, 0x8a5f34, 0x6c4825);
    // Planks run along x, with a joint every so often.
    f.lineStyle(1, INK, 0.35);
    for (let y = deckRect.y + 28; y < deckRect.y + d - 4; y += 28) {
      const a = this.project(deckRect.x, y);
      const b = this.project(deckRect.x + w, y);
      line(f, { x: a.x, y: a.y - DECK }, { x: b.x, y: b.y - DECK });
    }
    // A grid every scale step, faint, so a position is something you can read.
    const step = niceStep(beam.toValue - beam.fromValue);
    f.lineStyle(1, PARCHMENT, 0.12);
    for (let s = Math.ceil(beam.fromValue / step) * step; s <= beam.toValue + 1e-9; s += step) {
      const a = this.project(wx(s), deckRect.y);
      const b = this.project(wx(s), deckRect.y + d);
      line(f, { x: a.x, y: a.y - DECK }, { x: b.x, y: b.y - DECK });
      const t = this.project(wx(s), deckRect.y + d);
      this.text({ x: t.x - 6, y: t.y + 16 }, fmt(s), '#f4ecd888', 11, null);
    }
    for (let s = Math.ceil(across.fromValue / step) * step; s <= across.toValue + 1e-9; s += step) {
      const a = this.project(deckRect.x, wy(s));
      const b = this.project(deckRect.x + w, wy(s));
      line(f, { x: a.x, y: a.y - DECK }, { x: b.x, y: b.y - DECK });
      const t = this.project(deckRect.x + w, wy(s));
      this.text({ x: t.x + 14, y: t.y + 4 }, fmt(s), '#f4ecd888', 11, null);
    }

    const on = (x: number, y: number, up: number): Point => {
      const p = this.project(wx(x), wy(y));
      return { x: p.x, y: p.y - DECK - up };
    };

    // The pier, as a target under the deck boards.
    const pier = on(m.pivot, m.pivotY, 0);
    const over =
      m.com !== null &&
      m.comY !== null &&
      Math.hypot(m.com - m.pivot, m.comY - m.pivotY) * this.k < 10;
    const ring = view.verdict === 'won' || over ? GREEN : TERRACOTTA;
    f.lineStyle(4, ring, 0.9);
    f.strokeEllipse(pier.x, pier.y, 54, 27);
    f.lineStyle(2, ring, 0.6);
    f.strokeEllipse(pier.x, pier.y, 30, 15);
    f.fillStyle(IRON, 1);
    f.fillEllipse(pier.x, pier.y, 10, 5);
    this.text(
      { x: pier.x, y: pier.y + 36 },
      `▲ ${this.balance.pivotLabel ?? 'pier'} (${fmt(m.pivot)}, ${fmt(m.pivotY)})`,
      '#e8a07e',
      13,
      '#0b0806cc',
    );

    const placed = [...m.loads].sort((a, b) => a.at + a.atY - (b.at + b.atY));
    for (const load of placed) {
      this.drawLoad(view, load, (s, dy, up) => on(s, load.atY + dy / this.k, up), m, true);
    }

    if (view.showCom && m.com !== null && m.comY !== null) {
      const ground = on(m.com, m.comY, 0);
      const bead = on(m.com, m.comY, 70);
      if (!over) {
        f.lineStyle(3, GOLD, 0.7);
        dashed(f, pier, ground, 7);
      }
      f.lineStyle(2, GREEN, 0.8);
      f.strokeEllipse(ground.x, ground.y, 26, 13);
      g.lineStyle(2, GREEN, 0.8);
      dashed(g, bead, ground, 5);
      diamond(g, bead, 9, GREEN, view.verdict === 'won' ? GREEN_BRIGHT : 0x1f3a22);
      this.text(
        { x: bead.x, y: bead.y - 12 },
        `centre of mass (${fmt(m.com)}, ${fmt(m.comY)})`,
        '#9be3a0',
        14,
        '#0b0806dd',
      );
    }

    if (view.verdict) {
      const mid = on(
        (beam.fromValue + beam.toValue) / 2,
        (across.fromValue + across.toValue) / 2,
        150,
      );
      this.verdictTag(view, mid, m);
    }
  }

  // --- helpers ----------------------------------------------------------------

  private text(
    at: Point,
    value: string,
    color: string,
    size: number,
    background: string | null,
    wrap = 0,
  ): void {
    let text = this.texts[this.textsUsed];
    if (!text) {
      text = this.scene.add
        .text(0, 0, '', { fontFamily: 'monospace', fontSize: '13px', padding: { x: 5, y: 2 } })
        .setOrigin(0.5, 1)
        .setDepth(9100);
      this.texts.push(text);
    }
    this.textsUsed++;
    text
      .setOrigin(0.5, 1)
      .setDepth(9100)
      .setWordWrapWidth(wrap > 0 ? wrap : null)
      .setText(value)
      .setColor(color)
      .setFontSize(size)
      .setBackgroundColor(background ?? 'transparent')
      .setAlign('center')
      .setPosition(Math.round(at.x), Math.round(at.y))
      .setVisible(true);
  }
}

// --- drawing primitives -------------------------------------------------------

const pt = (p: Point) => new Phaser.Geom.Point(p.x, p.y);

function poly(g: Phaser.GameObjects.Graphics, points: Point[], color: number, alpha: number): void {
  g.fillStyle(color, alpha);
  g.fillPoints(points.map(pt), true);
}

function line(g: Phaser.GameObjects.Graphics, a: Point, b: Point): void {
  g.beginPath();
  g.moveTo(a.x, a.y);
  g.lineTo(b.x, b.y);
  g.strokePath();
}

function dashed(g: Phaser.GameObjects.Graphics, from: Point, to: Point, dash: number): void {
  const total = Math.hypot(to.x - from.x, to.y - from.y);
  if (total < 1) return;
  const steps = Math.ceil(total / (dash * 2));
  for (let i = 0; i < steps; i++) {
    const a = (i * 2 * dash) / total;
    const b = Math.min(1, (i * 2 * dash + dash) / total);
    line(g, mix(from, to, a), mix(from, to, b));
  }
}

function diamond(
  g: Phaser.GameObjects.Graphics,
  at: Point,
  r: number,
  edge: number,
  fill: number,
): void {
  const points = [
    { x: at.x, y: at.y - r },
    { x: at.x + r, y: at.y },
    { x: at.x, y: at.y + r },
    { x: at.x - r, y: at.y },
  ];
  g.fillStyle(fill, 1);
  g.fillPoints(points.map(pt), true);
  g.lineStyle(2.5, edge, 1);
  g.strokePoints(points.map(pt), true);
}

/** An isometric box on the plane: `rect` is its footprint, heights in screen px. */
function box(
  g: Phaser.GameObjects.Graphics,
  project: Project,
  rect: Rect,
  bottom: number,
  top: number,
  topColor: number,
  leftColor: number,
  rightColor: number,
): void {
  const at = (x: number, y: number, h: number) => {
    const p = project(x, y);
    return { x: p.x, y: p.y - h };
  };
  const { x, y, w, h } = rect;
  const front = [
    at(x, y + h, top),
    at(x + w, y + h, top),
    at(x + w, y + h, bottom),
    at(x, y + h, bottom),
  ];
  const side = [
    at(x + w, y, top),
    at(x + w, y + h, top),
    at(x + w, y + h, bottom),
    at(x + w, y, bottom),
  ];
  const lid = [at(x, y, top), at(x + w, y, top), at(x + w, y + h, top), at(x, y + h, top)];
  poly(g, front, leftColor, 1);
  poly(g, side, rightColor, 1);
  poly(g, lid, topColor, 1);
  g.lineStyle(1.5, INK, 0.85);
  for (const face of [front, side, lid]) g.strokePoints(face.map(pt), true);
}

function mix(a: Point, b: Point, t: number): Point {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

function darken(color: number, factor: number): number {
  const channel = (shift: number) => Math.min(255, Math.round(((color >> shift) & 0xff) * factor));
  return (channel(16) << 16) | (channel(8) << 8) | channel(0);
}

function niceStep(span: number): number {
  const rough = Math.abs(span) / 10;
  const magnitude = 10 ** Math.floor(Math.log10(Math.max(rough, 1e-6)));
  const normalised = rough / magnitude;
  return (normalised >= 5 ? 5 : normalised >= 2 ? 2 : 1) * magnitude;
}

function fmt(value: number): string {
  return `${Math.round(value * 10) / 10}`;
}

function fmt2(value: number): string {
  return `${Math.round(value * 100) / 100}`;
}
