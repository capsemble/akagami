/**
 * Drawing the set dressing.
 *
 * The placement is not decided here — the server does that in
 * `shared/dressing.ts` and ships the result on the scene fixture, exactly as
 * it ships colliders and interactables, so the client never invents geometry
 * the fixture does not carry. This file is only the half that puts pixels on
 * the screen.
 *
 * Three things it has to get right, all of them the usual isometric traps:
 *
 * - **Ground contact.** A decoration's (x, y) is where it *touches the floor*,
 *   not its centre. The sprites are trimmed so their bottom edge is that
 *   contact line, so an upright is anchored at (0.5, 1) over its projected
 *   point and sits on the floor at any scale. A centred anchor would float
 *   everything by half its own height, and the taller the asset the worse it
 *   would look.
 * - **Depth.** `isoDepth(x, y)` is the same ordering the props, the cast and
 *   the player already use, so walking behind a tree works for free and a
 *   boulder in front of you stays in front of you.
 * - **Flatness.** A ground decal lies down. It is drawn at the asset's spread
 *   wide and half that tall — the same 2:1 foreshortening the floor plane has
 *   — rather than at the image's own aspect, which would stand paving up on
 *   its edge.
 *
 * Nothing here collides, is interactable, or reports anything to the bus. If
 * every call in this file were deleted the act would still be winnable; it
 * would just be played in an empty room.
 */
import Phaser from 'phaser';
import type { Decoration, IsoView } from '@chapter-quest/shared';
import { dressingAsset, isoDepth, isoProject } from '@chapter-quest/shared';

/** Committed, chapter-independent, and the same set for every world. */
const DIR = '/dressing';

export const dressKey = (asset: string): string => `dress-${asset}`;

/**
 * Over the painted floor, under the footprint rings and the props.
 *
 * Deliberately not depth-sorted with everything else: paving is flat, and a
 * flat thing sorted by its own y would flicker in and out from under the
 * player's feet as they walked across it.
 */
const GROUND_DEPTH = 0.3;
/** Over the decals, under the footprint rings the props draw at 0.6. */
const SHADOW_DEPTH = 0.45;

/**
 * Light the room is lit by.
 *
 * The same multiply the painted props and cast get. These were painted on a
 * white studio field in full daylight and the room is a ravine at four in the
 * afternoon; without it the scrub is the brightest thing on screen.
 */
const WARM = 0xfff0de;
/**
 * And a stronger one for what is lying on the floor.
 *
 * Paving came back from the painter in cool greys and greens, which is what
 * stone is, and dropped onto a plate of ochre dust it read as something that
 * had been pasted on. Ground decals are the one layer that has to disappear
 * into the floor rather than sit on it, so they take a warmer multiply and a
 * little transparency and let the plate's own colour come up through them.
 */
const GROUND_WARM = 0xffd9a8;

/** Queue every sprite a scene's dressing needs. Call from `preload`. */
export function preloadDressing(scene: Phaser.Scene, dressing: Decoration[] = []): void {
  const seen = new Set<string>();
  for (const item of dressing) {
    if (seen.has(item.asset)) continue;
    seen.add(item.asset);
    const key = dressKey(item.asset);
    if (scene.textures.exists(key)) continue;
    scene.load.image(key, `${DIR}/${item.asset}.png`);
  }
}

/**
 * Place it all. Returns how many pieces actually made it in, so the caller can
 * tell "this room has no dressing" from "this room's dressing did not load".
 *
 * An asset that is missing from the catalogue or failed to load is skipped
 * individually. Dressing is the one layer in the room that is allowed to be
 * absent, so it never throws and never stops the scene being built.
 */
export function placeDressing(
  scene: Phaser.Scene,
  dressing: Decoration[] = [],
  view: IsoView,
): number {
  let placed = 0;

  // One Graphics for every contact shadow in the room.
  //
  // A room dresses to something like thirty uprights, and one Graphics each
  // is thirty objects in the display list and thirty draw calls a frame to
  // paint sixty ellipses that never move. They all sit at the same depth and
  // none of them is ever redrawn, so they are one object.
  const shadows = scene.add.graphics().setDepth(SHADOW_DEPTH);

  // Flat patches first, so an upright standing in a scrub patch is standing in
  // it rather than behind it. Within a layer the fixture's own order holds.
  const order = [...dressing].sort(
    (a, b) => Number(a.layer === 'upright') - Number(b.layer === 'upright'),
  );

  for (const item of order) {
    const asset = dressingAsset(item.asset);
    const key = dressKey(item.asset);
    if (!asset || !scene.textures.exists(key)) continue;

    const at = isoProject(item.x, item.y, view);

    if (item.layer === 'ground') {
      const wide = (asset.spreadPx ?? 150) * item.scale;
      scene.add
        .image(at.x, at.y, key)
        .setOrigin(0.5, 0.5)
        // Half as tall as it is wide: the floor's own foreshortening. Taking
        // the image's aspect instead is what makes a decal look like a sign
        // someone dropped face-up.
        .setDisplaySize(wide, wide / 2)
        .setFlipX(item.flip)
        .setDepth(GROUND_DEPTH)
        .setTint(GROUND_WARM)
        .setAlpha(0.85);
      placed++;
      continue;
    }

    const image = scene.add.image(at.x, at.y, key).setOrigin(0.5, 1);
    const tall = (asset.heightPx ?? 100) * item.scale;
    image
      .setDisplaySize(tall * (image.width / image.height), tall)
      .setFlipX(item.flip)
      .setDepth(isoDepth(item.x, item.y))
      .setTint(WARM);

    // The contact shadow. Without one the sprite is a sticker on the plate —
    // and these are standing on a painted floor that already has its own
    // shadows, so the eye notices immediately which things cast none.
    //
    // Sized off whichever of the sprite's dimensions is smaller, because a
    // tree is mostly canopy: billing the shadow to the full displayed width
    // puts a car-sized disc on the ground under a trunk the width of a leg.
    shadow(shadows, at.x, at.y, Math.min(image.displayWidth, image.displayHeight) * 0.6);
    placed++;
  }

  if (placed === 0) shadows.destroy();
  return placed;
}

/**
 * A soft dark ellipse on the floor. Two passes, the outer one weaker, so the
 * edge falls off instead of ending — Graphics has no blur, and one flat
 * ellipse reads as a hole rather than a shadow.
 */
function shadow(g: Phaser.GameObjects.Graphics, x: number, y: number, width: number): void {
  g.fillStyle(0x000000, 0.26);
  g.fillEllipse(x, y, width * 0.78, width * 0.3);
  g.fillStyle(0x000000, 0.16);
  g.fillEllipse(x, y, width, width * 0.42);
}
