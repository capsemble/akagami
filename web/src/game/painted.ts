/**
 * Painted art, turned into something that can stand in a room.
 *
 * The art director has been painting a sprite per cast member and a sprite per
 * interactable since the day it was written, and the scene has never once
 * loaded them: props and people are drawn from primitives, so a world paid for
 * twenty images and then showed you none of them. This is the missing step.
 *
 * It is a step and not just a `load.image` because of what comes back. The
 * prompt asks for a transparent background and the model returns a JPEG, which
 * cannot have one — every asset is a subject alone on a flat studio field,
 * 1376x768, with the subject occupying a fraction of it. Dropped into the scene
 * as-is you get a rectangle with a dial in the middle of it.
 *
 * Which colour that field is, is not ours to decide: most come back on white,
 * and `prop-winch-drum` in the Kusunda world came back on flat charcoal. So
 * the field is read off the frame's own corners rather than assumed, and a
 * frame whose corners disagree has no field to remove — it is a subject
 * standing somewhere — and is left alone.
 *
 * So each texture is keyed and cropped once, on the way in:
 *
 *   1. draw it down to a working size — it is displayed about 140px wide, and
 *      keying a million pixels to show a hundred thousand is wasted work;
 *   2. flood the background *inward from the border*, so white that is part of
 *      the subject (a dial face, a lamp glass, a shirt) survives while the
 *      field around it does not;
 *   3. key the pockets of studio the border flood cannot reach — the white
 *      showing through a gap between two legs, or between a wheel's spokes —
 *      but only big, flat, pure ones on a white studio (see `POCKET_MIN`);
 *   4. soften the pixels left on the boundary, or every asset gets a hard white
 *      halo where the JPEG blurred into its own edge;
 *   5. crop to what is left, so the sprite's own height is its subject's height
 *      and placing it by its feet actually puts its feet on the floor.
 *
 * Nothing here is load-bearing. A missing asset, a failed decode or a frame
 * that keys to nothing returns null and the caller draws the prop it has always
 * drawn.
 */
import Phaser from 'phaser';

/** Painted assets come off the design cache; placeholders are SVGs in /public. */
export const isPaintedUrl = (url?: string): url is string =>
  typeof url === 'string' && url.startsWith('/api/art/');

export const propKey = (id: string): string => `art-prop-${id}`;
export const castKey = (id: string): string => `art-cast-${id}`;

type Rgb = [number, number, number];

/** How far apart two colours are, summed over the channels. */
const apart = (a: Rgb, r: number, g: number, b: number): number =>
  Math.abs(a[0] - r) + Math.abs(a[1] - g) + Math.abs(a[2] - b);

/** Within this of the field colour is the field. JPEG noise is a few counts. */
const FIELD = 60;
/** Within this, and touching the field, is the blur between the two. */
const HALO = 150;
/**
 * A pocket of studio sealed inside the subject is keyed when every pixel is
 * within POCKET of the field, the pocket averages within POCKET_FLAT, and it
 * covers at least POCKET_MIN pixels. Painted whites are shaded and fail the
 * flatness test; a highlight is too small. Measured over every painted asset
 * on disk: it opens the gaps in a governor frame, a bell wheel, a weighing
 * scale and between a player's legs, and leaves a white kurta and a cream dial
 * face alone. The one thing it takes that was paint is a glass tube.
 */
const POCKET = 30;
const POCKET_FLAT = 15;
const POCKET_MIN = 40;

/**
 * The flat colour this subject was painted against, read from the four
 * corners, or null when they disagree — which means there is no studio field,
 * and cutting one out would take a bite out of a painting instead.
 */
function fieldColour(data: Uint8ClampedArray, w: number, h: number): Rgb | null {
  const patch = (left: number, top: number): Rgb => {
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    for (let y = top; y < top + 5; y++) {
      for (let x = left; x < left + 5; x++) {
        const i = (y * w + x) * 4;
        r += data[i]!;
        g += data[i + 1]!;
        b += data[i + 2]!;
        n++;
      }
    }
    return [r / n, g / n, b / n];
  };

  const corners = [patch(1, 1), patch(w - 6, 1), patch(1, h - 6), patch(w - 6, h - 6)];
  for (const a of corners) {
    for (const b of corners) {
      if (apart(a, b[0], b[1], b[2]) > 48) return null;
    }
  }
  return corners[0]!;
}

/** A texture drawn down to a working size, with its studio field keyed out. */
interface Keyed {
  canvas: HTMLCanvasElement;
  frame: ImageData;
  w: number;
  h: number;
}

/**
 * Steps 1–4: draw it down, flood the field in from the border, key the sealed
 * pockets, soften what is left on the boundary. Shared by the single cut-out and the walk sheet, which
 * differ only in what they do with the transparent result.
 */
function keyed(scene: Phaser.Scene, key: string, working: number): Keyed | null {
  if (!scene.textures.exists(key)) return null;

  const source = scene.textures.get(key).getSourceImage();
  const sw = 'width' in source ? source.width : 0;
  const sh = 'height' in source ? source.height : 0;
  if (!sw || !sh) return null;

  const scale = Math.min(1, working / sw);
  const w = Math.max(1, Math.round(sw * scale));
  const h = Math.max(1, Math.round(sh * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(source as CanvasImageSource, 0, 0, w, h);

  let frame: ImageData;
  try {
    frame = ctx.getImageData(0, 0, w, h);
  } catch {
    return null; // tainted canvas: an asset served cross-origin without CORS
  }
  const data = frame.data;

  const studio = fieldColour(data, w, h);
  if (!studio) return null;

  // --- 2. flood the field inward from the border --------------------------
  const field = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  let head = 0;
  let tail = 0;

  const push = (p: number) => {
    if (field[p]) return;
    const i = p * 4;
    if (apart(studio, data[i]!, data[i + 1]!, data[i + 2]!) > FIELD) return;
    field[p] = 1;
    queue[tail++] = p;
  };

  for (let x = 0; x < w; x++) {
    push(x);
    push((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    push(y * w);
    push(y * w + w - 1);
  }

  while (head < tail) {
    const p = queue[head++]!;
    const x = p % w;
    const y = (p / w) | 0;
    if (x > 0) push(p - 1);
    if (x < w - 1) push(p + 1);
    if (y > 0) push(p - w);
    if (y < h - 1) push(p + w);
  }

  // --- 3. pockets the border flood could not reach -------------------------
  // Only on a white studio. On charcoal the subject's own shadows are "pure
  // field colour" too: tried on the winch drum, this punched holes in it.
  if (Math.min(...studio) >= 215) {
    const seen = new Uint8Array(w * h);
    const stack = new Int32Array(w * h);
    const near = (p: number) => {
      const i = p * 4;
      return apart(studio, data[i]!, data[i + 1]!, data[i + 2]!);
    };
    for (let start = 0; start < w * h; start++) {
      if (field[start] || seen[start] || near(start) > POCKET) continue;
      const pocket: number[] = [];
      let total = 0;
      let top = 0;
      stack[top++] = start;
      seen[start] = 1;
      while (top > 0) {
        const p = stack[--top]!;
        pocket.push(p);
        total += near(p);
        const x = p % w;
        const y = (p / w) | 0;
        for (const q of [
          x > 0 ? p - 1 : -1,
          x < w - 1 ? p + 1 : -1,
          y > 0 ? p - w : -1,
          y < h - 1 ? p + w : -1,
        ]) {
          if (q < 0 || seen[q] || field[q] || near(q) > POCKET) continue;
          seen[q] = 1;
          stack[top++] = q;
        }
      }
      if (pocket.length >= POCKET_MIN && total / pocket.length <= POCKET_FLAT) {
        for (const p of pocket) field[p] = 1;
      }
    }
  }

  // --- 4. soften what is left on the boundary -----------------------------
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (field[p]) continue;
      const i = p * 4;
      if (apart(studio, data[i]!, data[i + 1]!, data[i + 2]!) > HALO) continue;
      const edge =
        (x > 0 && field[p - 1]) ||
        (x < w - 1 && field[p + 1]) ||
        (y > 0 && field[p - w]) ||
        (y < h - 1 && field[p + w]);
      if (edge) data[i + 3] = 110;
    }
  }
  for (let p = 0; p < field.length; p++) if (field[p]) data[p * 4 + 3] = 0;

  ctx.putImageData(frame, 0, 0);
  return { canvas, frame, w, h };
}

/**
 * Key and crop one loaded texture, returning the key of the result.
 *
 * Idempotent: the cut texture is made once per Phaser game and handed back on
 * every later call, so an act that re-enters a room pays nothing.
 */
export function cutout(scene: Phaser.Scene, key: string, working = 512): string | null {
  const cut = `${key}:cut`;
  if (scene.textures.exists(cut)) return cut;
  const keyedImage = keyed(scene, key, working);
  if (!keyedImage) return null;
  const { canvas, frame, w, h } = keyedImage;
  const data = frame.data;

  // --- 5. crop to the subject ---------------------------------------------
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] === 0) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  // Keyed to nothing, or to everything: either way it is not a cut-out, and a
  // painted rectangle in the middle of the room is worse than the drawn prop.
  const cropW = maxX - minX + 1;
  const cropH = maxY - minY + 1;
  if (maxX < 0 || cropW < 8 || cropH < 8) return null;
  if (cropW > w * 0.97 && cropH > h * 0.97) return null;

  const texture = scene.textures.createCanvas(cut, cropW, cropH);
  if (!texture) return null;
  texture.context.drawImage(canvas, minX, minY, cropW, cropH, 0, 0, cropW, cropH);
  texture.refresh();
  // The game runs pixelArt, which is right for the drawn world and wrong for a
  // painted plate shown at a quarter of the size it was painted at: nearest
  // neighbour turns every soft edge into a staircase.
  texture.setFilter(Phaser.Textures.FilterMode.LINEAR);
  return cut;
}

/** A walk sheet, cut into frames on one texture. */
export interface Sheet {
  /** The texture holding every frame. */
  key: string;
  /** `frames[row][col]`: frame names on that texture. */
  frames: string[][];
  /** The tallest frame in texture pixels, so a sprite can be scaled to a height. */
  height: number;
}

/**
 * Runs of indices that have ink, split wherever there is an empty gap, then
 * cleaned up to exactly `want`: specks far shorter than a real figure are
 * dropped, and the two runs closest together are merged until the count is
 * right — a hand or a foot drawn a few pixels clear of its body. Fewer runs
 * than wanted means figures touch, and the sheet cannot be cut.
 */
function bands(counts: number[], want: number): [number, number][] | null {
  const runs: [number, number][] = [];
  let start = -1;
  let last = -1;
  let gap = 0;
  for (let i = 0; i < counts.length; i++) {
    if (counts[i]! >= 2) {
      if (start < 0) start = i;
      last = i;
      gap = 0;
    } else if (start >= 0 && ++gap >= 3) {
      runs.push([start, last]);
      start = -1;
    }
  }
  if (start >= 0) runs.push([start, last]);

  const lengths = runs.map(([a, b]) => b - a + 1).sort((a, b) => a - b);
  const median = lengths[Math.floor(lengths.length / 2)] ?? 0;
  const kept = runs.filter(([a, b]) => b - a + 1 >= median * 0.15);
  while (kept.length > want) {
    let closest = 0;
    for (let i = 1; i < kept.length - 1; i++) {
      if (kept[i + 1]![0] - kept[i]![1] < kept[closest + 1]![0] - kept[closest]![1]) closest = i;
    }
    kept.splice(closest, 2, [kept[closest]![0], kept[closest + 1]![1]]);
  }
  return kept.length === want ? kept : null;
}

/**
 * Cut a walk sheet into `rows` × `cols` frames.
 *
 * The sheet is keyed exactly like a single prop, then split by the white space
 * between figures — into bands of rows, then each band into columns — and every
 * cell is trimmed to its figure so the feet sit on the frame's bottom edge. A
 * grid that does not come out the right shape, or a cell far shorter than the
 * rest, refuses the whole sheet: the caller keeps drawing the player rather
 * than animate a stranger.
 *
 * Worked at a larger size than a prop, because a frame is a twelfth of the
 * picture: at 512 px across a figure would be about seventy pixels tall before
 * it was ever scaled.
 */
export function sliceSheet(
  scene: Phaser.Scene,
  key: string,
  rows: number,
  cols: number,
  working = 1024,
): Sheet | null {
  const sheetKey = `${key}:sheet`;
  const names = Array.from({ length: rows }, (_, r) =>
    Array.from({ length: cols }, (_, c) => `r${r}c${c}`),
  );
  const made = sheetHeights.get(sheetKey);
  if (made && scene.textures.exists(sheetKey))
    return { key: sheetKey, frames: names, height: made };

  const keyedImage = keyed(scene, key, working);
  if (!keyedImage) return null;
  const { canvas, frame, w, h } = keyedImage;
  const data = frame.data;
  const ink = (x: number, y: number) => data[(y * w + x) * 4 + 3]! > 0;

  const rowInk = new Array<number>(h).fill(0);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (ink(x, y)) rowInk[y]!++;
  const rowBands = bands(rowInk, rows);
  if (!rowBands) return null;

  const cells: { r: number; c: number; x: number; y: number; w: number; h: number }[] = [];
  for (const [r, [y0, y1]] of rowBands.entries()) {
    const colInk = new Array<number>(w).fill(0);
    for (let y = y0; y <= y1; y++) for (let x = 0; x < w; x++) if (ink(x, y)) colInk[x]!++;
    const colBands = bands(colInk, cols);
    if (!colBands) return null;
    for (const [c, [x0, x1]] of colBands.entries()) {
      let top = -1;
      let bottom = -1;
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          if (!ink(x, y)) continue;
          if (top < 0) top = y;
          bottom = y;
          break;
        }
      }
      if (top < 0) return null;
      cells.push({ r, c, x: x0, y: top, w: x1 - x0 + 1, h: bottom - top + 1 });
    }
  }

  const tallest = Math.max(...cells.map((cell) => cell.h));
  if (cells.some((cell) => cell.h < tallest * 0.6)) return null;

  const texture = scene.textures.createCanvas(sheetKey, w, h);
  if (!texture) return null;
  texture.context.drawImage(canvas, 0, 0);
  for (const cell of cells) texture.add(`r${cell.r}c${cell.c}`, 0, cell.x, cell.y, cell.w, cell.h);
  texture.refresh();
  texture.setFilter(Phaser.Textures.FilterMode.LINEAR);
  sheetHeights.set(sheetKey, tallest);
  return { key: sheetKey, frames: names, height: tallest };
}

/** Tallest-frame heights of sheets already cut, by texture key. */
const sheetHeights = new Map<string, number>();
