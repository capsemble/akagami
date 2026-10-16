/**
 * The people.
 *
 * Everyone in the room used to be one static SVG with `setFlipX` on it. There
 * were no arms and no legs to move — the figure slid around the floor facing
 * two directions, and it read as a chess piece being dragged rather than a
 * person walking.
 *
 * So a character is drawn here instead of loaded: a head, a torso, two arms and
 * two legs with a knee and an elbow each, redrawn every frame from one phase
 * that advances with distance walked. Distance, not time — tie a walk cycle to
 * the clock and the feet slide whenever the speed changes, which is the thing
 * that makes a character look like it is on wheels.
 *
 * Three views, picked from the direction of travel on the isometric plane:
 * head-on, from behind, and side-on. Head-on you see a face and the legs
 * scissor; side-on you see the whole stride. The painted portraits still do the
 * talking in the dialogue box — a painted plate cannot walk, and this can.
 */
import Phaser from 'phaser';
import type { Point } from '@chapter-quest/shared';
import { seedOf } from '@chapter-quest/shared';

export interface ActorLook {
  coat: number;
  trouser: number;
  skin: number;
  hat: number;
  accent: number;
}

type Facing = 'front' | 'back' | 'side';

const SKIN = [0xc9a37a, 0xa87c52, 0x8a5c3a, 0xd9b894];

/** Coats for a cast nobody has drawn yet. Distinct at a glance, and stable. */
const COATS: { coat: number; hat: number; accent: number }[] = [
  { coat: 0x7a3b3b, hat: 0x4a2222, accent: 0xd9a441 },
  { coat: 0x3b5a7a, hat: 0x22384a, accent: 0xc9d4e0 },
  { coat: 0x4a5240, hat: 0x2e3327, accent: 0xc9a37a },
  { coat: 0x6b4a7a, hat: 0x3f2b4a, accent: 0xe0cbe8 },
  { coat: 0x7a6a3b, hat: 0x4a4022, accent: 0xf4ecd8 },
  { coat: 0x3b7a6a, hat: 0x224a40, accent: 0xd8f0e8 },
];

/**
 * The fixture cast keep the colours they have always had, so the people the
 * player already knows do not change clothes when the renderer changes. The
 * hexes match the sprites in scripts/gen-mock-art.mjs.
 */
const KNOWN: Record<string, { coat: number; hat: number; accent: number }> = {
  player: { coat: 0xd9a441, hat: 0x8a6520, accent: 0xf4ecd8 },
  rane: { coat: 0x4a5240, hat: 0x2e3327, accent: 0xc9a37a },
  dalvi: { coat: 0x2f3a52, hat: 0x1c2333, accent: 0xc9a37a },
  oracle: { coat: 0x2c4a8a, hat: 0x1a2c52, accent: 0x6fb6ff },
  archivist: { coat: 0x4a2f18, hat: 0x2c1c0e, accent: 0xf4ecd8 },
};

export function lookFor(id: string): ActorLook {
  const seed = seedOf(id);
  const base = KNOWN[id] ?? COATS[seed % COATS.length]!;
  return {
    ...base,
    skin: SKIN[seed % SKIN.length]!,
    trouser: shade(base.coat, 0.6),
  };
}

export class Actor {
  /** The object that is positioned and depth-sorted. Drawn in local space,
   *  feet at the origin, so the camera can follow it directly. */
  readonly root: Phaser.GameObjects.Graphics;

  private readonly look: ActorLook;
  private readonly height: number;
  /** Where in the stride we are. Advanced by distance, never by time. */
  private phase = 0;
  /** Standing still still moves: shoulders rise and fall. */
  private breath = Math.random() * Math.PI * 2;
  private facing: Facing = 'front';
  /** 1 when turned toward screen-right, -1 when turned left. */
  private flip = 1;
  private speed = 0;

  constructor(scene: Phaser.Scene, look: ActorLook, height = 58) {
    this.root = scene.add.graphics();
    this.look = look;
    this.height = height;
  }

  /**
   * Point them along a direction on the world plane.
   *
   * On an isometric plane, x + y runs toward the camera and x − y runs across
   * the screen, so whichever of the two is larger decides whether you are
   * looking at a face, a back, or a profile.
   */
  turn(vx: number, vy: number): void {
    const toward = vx + vy;
    const across = vx - vy;
    if (Math.abs(toward) < 0.01 && Math.abs(across) < 0.01) return;
    if (Math.abs(toward) >= Math.abs(across)) {
      this.facing = toward > 0 ? 'front' : 'back';
    } else {
      this.facing = 'side';
      this.flip = across > 0 ? 1 : -1;
    }
  }

  /** Face the camera and stand still — for someone waiting to be talked to. */
  idle(): void {
    this.speed = 0;
  }

  /**
   * Advance the cycle and redraw at a screen point.
   * `vx`/`vy` are world-plane velocity in px/s; pass zeros for standing still.
   *
   * Returns true on the frame a foot lands, so a footstep is a sound made by
   * this leg hitting this floor rather than a loop on a timer. Walk into a wall
   * and the steps stop, because the phase stops.
   */
  step(deltaMs: number, vx: number, vy: number, at: Point, depth: number): boolean {
    const dt = deltaMs / 1000;
    this.speed = Math.hypot(vx, vy);
    this.turn(vx, vy);
    // One full cycle per ~56px walked: two steps, roughly a stride for someone
    // this tall. Tie it to the clock instead and the feet skate.
    const before = this.phase;
    this.phase += (this.speed * dt * Math.PI * 2) / 56;
    this.breath += dt * 2.2;
    this.root.setPosition(at.x, at.y).setDepth(depth);
    this.paint();
    // A foot is down at each half-cycle, where the legs are furthest apart.
    return (
      this.speed > 8 &&
      Math.floor(before / Math.PI + 0.5) !== Math.floor(this.phase / Math.PI + 0.5)
    );
  }

  destroy(): void {
    this.root.destroy();
  }

  private paint(): void {
    const g = this.root;
    g.clear();

    const H = this.height;
    const walking = this.speed > 8;
    const swing = walking ? Math.sin(this.phase) : 0;
    // Weight drops onto each foot, so the body dips twice a cycle.
    const bob = walking
      ? -Math.abs(Math.sin(this.phase)) * H * 0.03
      : Math.sin(this.breath) * H * 0.01;

    const hipY = -H * 0.44 + bob;
    const shoulderY = -H * 0.72 + bob;
    const headY = -H * 0.87 + bob;
    const headR = H * 0.14;
    const legLen = H * 0.48;
    const armLen = H * 0.34;
    const torsoW = H * 0.3;

    // How much of a stride shows across the screen. Head-on, a walk is mostly
    // legs scissoring and feet lifting; side-on you see the whole thing.
    // Tuned per view rather than shared: side-on, a full-width stride reads as
    // the splits at this size; head-on, the same number barely separates the
    // feet at all.
    const across = this.facing === 'side' ? 0.7 : 0.4;
    const lift = this.facing === 'side' ? 0 : H * 0.07;
    const dark = this.facing === 'back' ? 0.82 : 1;

    const hip = (side: number) => ({ x: side * torsoW * 0.22, y: hipY });
    const shoulder = (side: number) => ({ x: side * torsoW * 0.42, y: shoulderY });

    // A limb in two segments with a joint that bulges the right way.
    const limb = (
      from: Point,
      to: Point,
      bulge: number,
      width: number,
      color: number,
      joint: number,
    ) => {
      const mid = { x: (from.x + to.x) / 2 + bulge, y: (from.y + to.y) / 2 };
      g.lineStyle(width, color, 1);
      g.beginPath();
      g.moveTo(from.x, from.y);
      g.lineTo(mid.x, mid.y);
      g.lineTo(to.x, to.y);
      g.strokePath();
      g.fillStyle(color, 1);
      g.fillCircle(mid.x, mid.y, width / 2);
      g.fillStyle(joint, 1);
      g.fillCircle(to.x, to.y, width * 0.52);
    };

    const leg = (side: number, forward: number, tint: number) => {
      const root = hip(side);
      const foot = {
        x: root.x + forward * legLen * 0.62 * across * this.flip,
        y: hipY + legLen - Math.abs(forward) * legLen * 0.06 - Math.max(0, forward) * lift,
      };
      limb(root, foot, forward * 2.5 * this.flip, H * 0.085, tint, shade(tint, 0.6));
    };

    const arm = (side: number, forward: number, tint: number) => {
      const root = shoulder(side);
      const hand = {
        x: root.x + forward * armLen * 0.72 * across * this.flip,
        y: shoulderY + armLen - Math.abs(forward) * armLen * 0.08,
      };
      limb(root, hand, -forward * 2 * this.flip, H * 0.07, tint, this.look.skin);
    };

    // Contact shadow. Without it they hover a few pixels off the tiles.
    g.fillStyle(0x000000, 0.3);
    g.fillEllipse(0, 2, H * 0.48, H * 0.22);

    // Back limbs first. Side-on, the far side of the body is the one behind.
    const far = this.facing === 'side' ? -this.flip : -1;
    const near = -far;
    leg(far, -swing, shade(this.look.trouser, 0.72 * dark));
    arm(far, swing, shade(this.look.coat, 0.72 * dark));

    // Side-on, a body is narrow and sits a little ahead of the feet. Drawing
    // the same trapezoid for every heading is what made the profile views look
    // like the front view with the face rubbed off.
    const w = this.facing === 'side' ? torsoW * 0.64 : torsoW;
    const nose = this.facing === 'side' ? this.flip * torsoW * 0.08 : 0;
    const torso = [
      { x: nose - w * 0.5, y: shoulderY },
      { x: nose + w * 0.5, y: shoulderY },
      { x: nose + w * 0.38, y: hipY + 1 },
      { x: nose - w * 0.38, y: hipY + 1 },
    ];
    g.fillStyle(shade(this.look.coat, dark), 1);
    g.fillPoints(
      torso.map((p) => new Phaser.Geom.Point(p.x, p.y)),
      true,
    );
    // A collar, and a front seam that only shows when you are looking at them.
    g.fillStyle(this.look.accent, 1);
    g.fillRect(nose - w * 0.5, shoulderY, w, H * 0.035);
    if (this.facing !== 'back') {
      g.lineStyle(1.4, shade(this.look.coat, 0.6), 0.85);
      g.beginPath();
      g.moveTo(this.facing === 'side' ? this.flip * torsoW * 0.26 : 0, shoulderY + H * 0.04);
      g.lineTo(this.facing === 'side' ? this.flip * torsoW * 0.2 : 0, hipY);
      g.strokePath();
    }

    leg(near, swing, shade(this.look.trouser, dark));
    arm(near, -swing, shade(this.look.coat, dark));

    // Head, turned a little the way they are going.
    const lean = this.facing === 'side' ? this.flip * headR * 0.34 : 0;
    g.fillStyle(shade(this.look.skin, dark), 1);
    g.fillCircle(lean, headY, headR);

    if (this.facing === 'front' || this.facing === 'side') {
      const eyes: number[] = this.facing === 'front' ? [-0.36, 0.36] : [this.flip * 0.42];
      g.fillStyle(0x1a1208, 1);
      for (const ex of eyes) g.fillCircle(lean + ex * headR, headY - headR * 0.08, headR * 0.17);
      g.lineStyle(1.3, shade(this.look.skin, 0.55), 0.9);
      g.beginPath();
      g.moveTo(lean - headR * 0.22, headY + headR * 0.42);
      g.lineTo(lean + headR * 0.22, headY + headR * 0.42);
      g.strokePath();
      if (this.facing === 'side') {
        // A nose. At this size it is the one mark that says which way a head
        // is pointing, and without it a profile is a circle.
        g.fillStyle(shade(this.look.skin, dark), 1);
        g.fillTriangle(
          lean + this.flip * headR * 0.8,
          headY - headR * 0.02,
          lean + this.flip * headR * 1.3,
          headY + headR * 0.2,
          lean + this.flip * headR * 0.7,
          headY + headR * 0.34,
        );
      }
    }

    // Hat: a brim and a crown. The brim is what reads at this size.
    const brim = this.facing === 'side' ? this.flip * headR * 0.3 : 0;
    g.fillStyle(shade(this.look.hat, dark), 1);
    g.fillEllipse(lean + brim, headY - headR * 0.52, headR * 2.7, headR * 0.8);
    g.fillRect(lean - headR * 0.78, headY - headR * 1.5, headR * 1.56, headR * 1.05);
    g.fillStyle(this.look.accent, 0.9);
    g.fillRect(lean - headR * 0.78, headY - headR * 0.78, headR * 1.56, headR * 0.26);
  }
}

/** Scale every channel, clamped. Under 1 darkens, over 1 lightens. */
function shade(color: number, factor: number): number {
  const channel = (shift: number) => Math.min(255, Math.round(((color >> shift) & 0xff) * factor));
  return (channel(16) << 16) | (channel(8) << 8) | channel(0);
}
