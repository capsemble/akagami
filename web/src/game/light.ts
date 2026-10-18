/**
 * Light.
 *
 * Every room was lit identically everywhere — the far corner of a station cabin
 * was exactly as bright as the spot under the lamp — so a scene read as a flat
 * diagram of objects rather than a place with a time of day. The props were
 * fine; nothing was telling the eye where to look.
 *
 * Two cheap pieces do most of the work. A vignette pulls the corners down so
 * the middle of the frame is where the attention goes, and a warm pool under
 * anything that burns says that object is a light rather than a lamp-shaped
 * thing. Both are radial gradients, which Graphics cannot draw, so they are
 * baked once into a canvas texture and then stamped as blended images.
 *
 * Deliberately not Phaser's Light2D pipeline: that lights textured sprites
 * through normal maps, and almost everything in this game is a Graphics object
 * drawn at runtime, which the pipeline does not touch.
 */
import Phaser from 'phaser';
import type { Point } from '@chapter-quest/shared';

/** Above every world layer, below every label. */
const VIGNETTE_DEPTH = 8900;
/** On the floor: over the ground and the flat walls, under the reach rings. */
const POOL_DEPTH = 0.5;

/**
 * A radial gradient baked into a texture, made once per scene.
 * `stops` run from the centre outwards as `[offset, css colour]`.
 */
function gradient(
  scene: Phaser.Scene,
  key: string,
  size: number,
  stops: [number, string][],
): boolean {
  if (scene.textures.exists(key)) return true;
  const texture = scene.textures.createCanvas(key, size, size);
  if (!texture) return false;
  const ctx = texture.getContext();
  const half = size / 2;
  const fill = ctx.createRadialGradient(half, half, 0, half, half, half);
  for (const [at, colour] of stops) fill.addColorStop(at, colour);
  ctx.fillStyle = fill;
  ctx.fillRect(0, 0, size, size);
  texture.refresh();
  return true;
}

/**
 * Pull the corners of the frame down.
 *
 * Screen-space and fixed to the camera, so it does not slide around as the
 * player walks — a vignette that moves is a stain, not lighting.
 */
export function addVignette(scene: Phaser.Scene, strength = 0.88): void {
  const key = 'light-vignette';
  if (
    !gradient(scene, key, 512, [
      [0, 'rgba(0,0,0,0)'],
      [0.34, 'rgba(0,0,0,0)'],
      [0.62, 'rgba(10,6,3,0.34)'],
      [0.84, 'rgba(10,6,3,0.74)'],
      [1, 'rgba(10,6,3,1)'],
    ])
  ) {
    return;
  }

  const { width, height } = scene.scale;
  scene.add
    .image(width / 2, height / 2, key)
    // Over-sized, because the corners of a rectangle are further out than the
    // edge of the circle that is supposed to be darkening them.
    .setDisplaySize(width * 1.62, height * 1.62)
    .setScrollFactor(0)
    .setDepth(VIGNETTE_DEPTH)
    .setAlpha(strength);
}

export interface Pool {
  /** Flicker, breathe, gutter. 1 is the pool at rest. */
  level(value: number): void;
}

/**
 * A pool of light on the floor under something that burns.
 *
 * Added, not drawn: light falls on top of whatever is already there, so the
 * tiles and the ballast underneath keep their own texture instead of being
 * replaced by a disc of orange.
 */
export function addLightPool(
  scene: Phaser.Scene,
  at: Point,
  radius: number,
  tint = 0xe2a33c,
  alpha = 0.5,
): Pool {
  const key = 'light-pool';
  if (
    !gradient(scene, key, 256, [
      [0, 'rgba(255,255,255,0.95)'],
      [0.35, 'rgba(255,255,255,0.45)'],
      [1, 'rgba(255,255,255,0)'],
    ])
  ) {
    return { level: () => undefined };
  }

  const image = scene.add
    .image(at.x, at.y, key)
    // Squashed into the ground plane, so the pool lies on the floor instead of
    // standing up facing the camera.
    .setDisplaySize(radius * 2, radius)
    .setDepth(POOL_DEPTH)
    .setBlendMode(Phaser.BlendModes.ADD)
    .setTint(tint)
    .setAlpha(alpha);

  return {
    level: (value) => image.setAlpha(alpha * Math.max(0, value)),
  };
}

/**
 * Dust in the light.
 *
 * Only ever drawn inside a pool, which is the honest place for it: a mote is
 * visible because something is lighting it, and specks drifting through an
 * unlit corner look like dead pixels. Each one runs on its own pair of slow
 * waves, so the drift never falls into a pattern you can see repeating.
 */
export class Motes {
  private readonly seeds: number[];

  constructor(
    private readonly g: Phaser.GameObjects.Graphics,
    private readonly at: Point,
    private readonly radius: number,
    count = 7,
  ) {
    this.seeds = Array.from({ length: count }, (_, i) => i * 37.4 + at.x * 0.013);
  }

  draw(time: number): void {
    this.g.clear();
    for (const seed of this.seeds) {
      const t = time / 1000;
      const x = this.at.x + Math.sin(t * 0.21 + seed) * this.radius * 0.8;
      // Half the vertical travel, because a pool is an ellipse lying down.
      const y = this.at.y + Math.cos(t * 0.17 + seed * 1.7) * this.radius * 0.34;
      const lift = Math.sin(t * 0.33 + seed * 2.3);
      this.g.fillStyle(0xf4ecd8, 0.1 + 0.1 * (1 + lift) * 0.5);
      this.g.fillCircle(x, y - 10 - lift * 10, 1.4);
    }
  }
}

/**
 * A lamp never sits still. Small, slow and irregular — a flicker you can see
 * counting is worse than none, so the two waves are deliberately out of step.
 */
export function flicker(time: number, seed: number): number {
  return (
    0.9 +
    0.07 * Math.sin(time / 420 + seed) +
    0.05 * Math.sin(time / 137 + seed * 3.1)
  );
}
