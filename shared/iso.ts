/**
 * Isometric projection.
 *
 * The world stays a flat plane with axis-aligned rectangles, exactly as the
 * top-down scenes do, so Arcade physics and the collider fixtures are unchanged.
 * Only rendering is projected. A world square of side s draws as a diamond s
 * wide and s/2 tall (the usual 2:1 dimetric).
 */
import type { Point, Rect } from './types.js';

export const ISO_X = 0.5;
export const ISO_Y = 0.25;

export interface IsoView {
  /** Pixel size of the projected image. */
  width: number;
  height: number;
  /** Added to every projected point so nothing lands at a negative x. */
  originX: number;
  originY: number;
}

/** The screen box a world plane of worldW x worldH projects into. */
export function isoView(worldW: number, worldH: number, pad = 0): IsoView {
  return {
    width: (worldW + worldH) * ISO_X + pad * 2,
    height: (worldW + worldH) * ISO_Y + pad * 2,
    originX: worldH * ISO_X + pad,
    originY: pad,
  };
}

/** World plane → screen pixels. */
export function isoProject(x: number, y: number, view: IsoView): Point {
  return {
    x: (x - y) * ISO_X + view.originX,
    y: (x + y) * ISO_Y + view.originY,
  };
}

/** Screen pixels → world plane. The inverse of isoProject. */
export function isoUnproject(sx: number, sy: number, view: IsoView): Point {
  const dx = (sx - view.originX) / ISO_X;
  const dy = (sy - view.originY) / ISO_Y;
  return { x: (dy + dx) / 2, y: (dy - dx) / 2 };
}

/** The four corners of a world rect, projected, clockwise from its top corner. */
export function isoDiamond(rect: Rect, view: IsoView): Point[] {
  return [
    isoProject(rect.x, rect.y, view),
    isoProject(rect.x + rect.w, rect.y, view),
    isoProject(rect.x + rect.w, rect.y + rect.h, view),
    isoProject(rect.x, rect.y + rect.h, view),
  ];
}

/**
 * Draw order for a sprite standing at a world point. Things further "back"
 * (smaller x + y) must paint first, so the player can walk behind a shelf.
 */
export function isoDepth(x: number, y: number): number {
  return x + y;
}

/**
 * Screen-relative movement. On an isometric plane, pressing "up" should walk
 * away from the camera, which is -x -y in world terms — so the raw input vector
 * is rotated into world space before it reaches the physics body.
 */
export function isoInputToWorld(ix: number, iy: number): Point {
  if (ix === 0 && iy === 0) return { x: 0, y: 0 };
  const x = iy / ISO_Y + ix / ISO_X;
  const y = iy / ISO_Y - ix / ISO_X;
  const length = Math.hypot(x, y);
  return { x: x / length, y: y / length };
}
