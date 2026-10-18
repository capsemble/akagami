/**
 * The player, painted.
 *
 * Everything else in a generated room is painted now — the floor, the props,
 * the cast — and the one figure the player actually controls was still a gold
 * rectangle with stick legs, drawn from primitives. It walked properly, which
 * is why it was drawn: a single painted plate cannot stride, and a figure that
 * slides about the floor reads as a chess piece being dragged.
 *
 * A walk sheet solves both. The art director paints one picture of the player
 * in a 3 × 4 grid — facing the viewer, facing away, in profile; standing, then
 * three poses of a stride — and `sliceSheet` cuts it into frames. This class
 * drives them with the same rules the drawn figure uses, so nothing that moves
 * the player had to change:
 *
 * - which way it faces comes from the direction of travel on the isometric
 *   plane, exactly as in `Actor.turn`;
 * - the stride is advanced by distance walked, never by time, so the feet do
 *   not skate when the speed changes;
 * - a footfall is reported on the frame a foot lands, for the step sound.
 *
 * The sheet's figures are painted facing right; walking left mirrors them.
 */
import Phaser from 'phaser';
import type { Point } from '@chapter-quest/shared';
import type { Sheet } from './painted';

type Facing = 'front' | 'back' | 'side';

const ROW: Record<Facing, number> = { front: 0, back: 1, side: 2 };
/** Columns of a stride: left foot forward, passing, right foot forward, passing. */
const STRIDE = [1, 2, 3, 2];
/** One full stride — two steps — per this many pixels walked. */
const STRIDE_PX = 64;

export class PaintedActor {
  /** Positioned and depth-sorted; feet at the origin, so the camera can follow it. */
  readonly root: Phaser.GameObjects.Image;

  private readonly sheet: Sheet;
  private phase = 0;
  /** Standing still still moves: a slow rise and fall. */
  private breath = Math.random() * Math.PI * 2;
  private facing: Facing = 'front';
  /** 1 while heading screen-right, -1 while heading left. */
  private flip = 1;

  constructor(scene: Phaser.Scene, sheet: Sheet, height: number, tint?: number) {
    this.sheet = sheet;
    this.root = scene.add.image(0, 0, sheet.key, sheet.frames[0]![0]).setOrigin(0.5, 1);
    // One scale for every frame, from the tallest: a stride frame is wider than
    // a standing one, and scaling each to fit would make the player swell.
    this.root.setScale(height / sheet.height);
    if (tint !== undefined) this.root.setTint(tint);
  }

  /**
   * Point them along a direction on the world plane. On an isometric plane
   * x + y runs toward the camera and x − y runs across the screen; whichever is
   * larger decides face, back or profile. Same rule as the drawn figure.
   */
  turn(vx: number, vy: number): void {
    const toward = vx + vy;
    const across = vx - vy;
    if (Math.abs(toward) < 0.01 && Math.abs(across) < 0.01) return;
    if (Math.abs(across) > 0.01) this.flip = across > 0 ? 1 : -1;
    this.facing = Math.abs(toward) >= Math.abs(across) ? (toward > 0 ? 'front' : 'back') : 'side';
  }

  /**
   * Advance the stride and show the frame for it. `vx`/`vy` are world-plane
   * velocity in px/s. Returns true on the frame a foot lands.
   */
  step(deltaMs: number, vx: number, vy: number, at: Point, depth: number): boolean {
    const dt = deltaMs / 1000;
    const speed = Math.hypot(vx, vy);
    this.turn(vx, vy);
    const before = this.phase;
    this.phase += (speed * dt * Math.PI * 2) / STRIDE_PX;
    this.breath += dt * 2.2;

    const moving = speed > 8;
    const column = moving ? STRIDE[Math.floor((this.phase / (Math.PI * 2)) * 4) % 4]! : 0;
    this.root.setFrame(this.sheet.frames[ROW[this.facing]]![column]!);
    this.root.setFlipX(this.flip < 0);
    const bob = moving ? 0 : Math.sin(this.breath) * 0.8;
    this.root.setPosition(at.x, at.y + bob).setDepth(depth);

    // A foot is down at each half-stride, where the legs are furthest apart.
    return moving && Math.floor(before / Math.PI + 0.5) !== Math.floor(this.phase / Math.PI + 0.5);
  }
}
