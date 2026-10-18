/**
 * Camera language.
 *
 * The camera followed the player and did nothing else, so the moment the whole
 * act builds towards — the wagon stopping, the box landing — arrived as a
 * colour flash and a sound, with the frame exactly as it had been a second
 * earlier. The player had done the hard part and the picture did not react.
 *
 * Three moves, all short. A push in says *this is the bit*; a shake says
 * something hit something; a hold keeps the frame on the thing that just
 * happened long enough to read it. Everything returns to rest on its own, so
 * nothing here can leave the camera somewhere strange.
 */
import Phaser from 'phaser';

/** Zoom at rest. The camera always comes back here. */
const REST = 1;

export interface PunchOptions {
  /** How much closer, as a fraction. 0.2 is a noticeable but polite push. */
  strength?: number;
  inMs?: number;
  holdMs?: number;
  outMs?: number;
}

/**
 * A quick push in, a beat, then back out.
 *
 * The way out is deliberately three times slower than the way in: a snap in
 * reads as impact, and a snap back reads as a glitch.
 */
export function punch(scene: Phaser.Scene, options: PunchOptions = {}): void {
  const { strength = 0.2, inMs = 130, holdMs = 160, outMs = 430 } = options;
  const camera = scene.cameras.main;
  camera.zoomTo(REST + strength, inMs, 'Quad.easeOut');
  scene.time.delayedCall(inMs + holdMs, () => {
    if (scene.sys.isActive()) camera.zoomTo(REST, outMs, 'Quad.easeInOut');
  });
}

/** Something hit something. Intensity is a fraction of the viewport. */
export function impact(scene: Phaser.Scene, intensity = 0.006, ms = 220): void {
  scene.cameras.main.shake(ms, intensity);
}

/**
 * Settle on a reading. Used when the player leans in to a dial or a sight:
 * the room is not the subject any more, the instrument is.
 */
export function focus(scene: Phaser.Scene, zoom: number, ms = 280): void {
  scene.cameras.main.zoomTo(zoom, ms, 'Quad.easeInOut');
}

/** Back to the room. */
export function relax(scene: Phaser.Scene, ms = 320): void {
  scene.cameras.main.zoomTo(REST, ms, 'Quad.easeInOut');
}

/**
 * The whole arrival, in one call: a knock, a push in, and a flash the colour of
 * the verdict. Losing hits harder than winning, because it should.
 */
export function land(scene: Phaser.Scene, won: boolean): void {
  impact(scene, won ? 0.005 : 0.011, won ? 200 : 320);
  punch(scene, won ? { strength: 0.22 } : { strength: 0.15, inMs: 90 });
  scene.cameras.main.flash(
    won ? 180 : 240,
    ...(won ? ([111, 191, 115] as const) : ([192, 87, 70] as const)),
  );
}
