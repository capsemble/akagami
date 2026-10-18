/**
 * The art director.
 *
 * The build story has always claimed this stage existed — "Art director (Nano
 * Banana): painting scene 1/3" — while `design.ts` set `artStyle: ''` and never
 * made a single image call. This is that stage.
 *
 * Two rules shape it:
 *
 * 1. **Nothing it produces may be load-bearing.** Colliders, paths and win
 *    bands come from the scene fixtures and the sim spec. Art is decoration
 *    laid over geometry that is already correct, so a missing key, a wrong
 *    model id or a refused prompt costs you a nicer picture and nothing else.
 *    Every asset is independently optional and every failure is an event, not
 *    an exception.
 *
 * 2. **Props are sprites, not backdrops.** A generated backdrop has to agree
 *    with collider rectangles it knows nothing about, and when it does not the
 *    player walks through a wall that is visibly there. Generating one sprite
 *    per interactable and placing it on its own rect keeps the art aligned by
 *    construction.
 *
 * Everything is cached by chapter hash, because images are the most expensive
 * thing in the pipeline and a re-run should cost nothing.
 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CastMember, WorldArt } from '@chapter-quest/shared';
import { cacheDir } from '../cache.js';
import { MODELS, generateImage } from '../gemini.js';
import type { GeneratedImage, ImageRef } from '../gemini.js';
import { event } from './agents.js';
import type { Emit } from './agents.js';

const ART_DIRECTOR = 'Art director';

/** Injected so the stage can be tested without a key or a network. */
export type Painter = (prompt: string, refs: ImageRef[]) => Promise<GeneratedImage>;

export interface PropBrief {
  id: string;
  label: string;
  look: string;
}

/** One act's room, as the design pass described it. */
export interface RoomBrief {
  /** The act this room belongs to; the mapper keys its scene off the same id. */
  id: string;
  name: string;
  description: string;
}

export interface ArtRequest {
  /** sha256 of the chapter, so a re-run of the same chapter pays nothing. */
  hash: string;
  /** The look the story agent asked for, e.g. 'isometric 1950s hill railway'. */
  artStyle: string;
  cast: CastMember[];
  props: PropBrief[];
  /** The rooms to paint a floor for. Absent paints none, as before. */
  rooms?: RoomBrief[];
  emit?: Emit;
  /** Ignore what is on disk and pay for everything again. */
  fresh?: boolean;
}

export type PaintedArt = WorldArt;

const artRoot = join(cacheDir, 'art');
const dirFor = (hash: string) => join(artRoot, hash.slice(0, 16));
/**
 * Assets keep the extension their bytes actually are.
 *
 * They were all written as `.png` whatever came back, and nano-banana through
 * a router returns JPEG — so the route served `Content-Type: image/png` over
 * JPEG bytes, and worse, the style plate was handed back to the painter as a
 * `data:image/png` URI containing a JPEG. Browsers sniff and forgive; a model
 * being shown its own reference should not have to.
 */
const EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp'] as const;
type Extension = (typeof EXTENSIONS)[number];

const extensionFor = (mimeType: string): Extension => {
  const subtype = mimeType.split('/')[1]?.toLowerCase() ?? 'png';
  return (EXTENSIONS as readonly string[]).includes(subtype) ? (subtype as Extension) : 'png';
};

const mimeFor = (extension: string): string =>
  extension === 'jpg' ? 'image/jpeg' : `image/${extension}`;

/** Served by the route in index.ts. Relative so it works behind any host. */
const urlFor = (hash: string, file: string) => `/api/art/${hash.slice(0, 16)}/${file}`;

/** A house style, stated once, so every asset agrees with every other. */
function plate(artStyle: string): string {
  return [
    `Art style plate for a 2D isometric adventure game: ${artStyle}.`,
    'One illustration, flat vector shapes, limited warm palette of teak browns,',
    'wet slate greys, lantern gold and parchment. Soft top-left light, long soft',
    'shadows, no gradients beyond two steps, no text, no watermark, no border.',
  ].join(' ');
}

/**
 * Sprites ask for plain white, never "transparent": an image model cannot
 * paint alpha, so it paints a grey checkerboard that looks like it, and the
 * client's keyer (which floods one flat field colour) cannot lift that off.
 * The guide on a live build stood in front of its own checkerboard and fell
 * back to the drawn figure.
 */
function characterPrompt(
  member: CastMember,
  artStyle: string,
  kind: 'portrait' | 'sprite',
): string {
  const shared = `${member.name}: ${member.look}. ${artStyle}. Match the supplied style plate exactly.`;
  return kind === 'portrait'
    ? `${shared} Head-and-shoulders portrait, facing the viewer, neutral expression, plain dark background, square framing, no text.`
    : `${shared} Full body game sprite, three-quarter view from slightly above to suit an isometric scene, standing idle, exactly one figure in one pose (not a character sheet or turnaround), on a flat plain white background, crisp edges, no shadow baked in, no text.`;
}

/**
 * The player, as one sheet of twelve poses.
 *
 * One image rather than twelve because consistency is the whole problem: the
 * model draws a different person every time it is asked, but within a single
 * picture it keeps the coat, the face and the scarf the same. The grid is
 * spelled out exactly because the client cuts it by finding the empty space
 * between figures — overlap two of them and the sheet is refused, and the
 * player falls back to being drawn.
 *
 * The scarf is gameplay, not costume: the player is the one figure in a room
 * of painted strangers that has to be found at a glance.
 */
function playerSheetPrompt(artStyle: string): string {
  return [
    'Character sprite sheet for a 2D isometric adventure game. The player character:',
    'a young apprentice investigator with a satchel across one shoulder and a bright',
    `golden-yellow scarf, dressed to belong in this world: ${artStyle}.`,
    'Match the supplied style plate exactly.',
    'Exactly 3 rows and 4 columns on a flat plain white background. The SAME character',
    'in every cell — same face, same outfit, same size — evenly spaced, with clear empty',
    'white space between every figure and nothing overlapping.',
    'Row 1: facing the viewer. Row 2: facing away from the viewer, back turned.',
    'Row 3: facing right, in profile.',
    'Columns, left to right: standing still; left foot forward mid-stride; legs passing',
    'under the body; right foot forward mid-stride.',
    'Full body in every cell, seen from slightly above to suit an isometric game.',
    'No text, no labels, no numbers, no grid lines, no shadows, no border.',
  ].join(' ');
}

function propPrompt(prop: PropBrief, artStyle: string): string {
  return [
    `A single game prop seen in 2:1 isometric projection: ${prop.label}. ${prop.look}.`,
    `${artStyle}. Match the supplied style plate exactly.`,
    'Transparent background, the object alone, nothing else in frame, no ground,',
    'no shadow baked in, no text, no border.',
  ].join(' ');
}

/**
 * The terrain for one room.
 *
 * "Empty" used to be the whole specification, and empty is what came back: a
 * flat slab with a few scuff marks on it. The player then walks across eighty
 * per cent of a screen that has nothing in it, and no amount of prop art fixes
 * that, because the props are two objects on a plane the size of a tennis
 * court. Density has to come from the ground itself.
 *
 * So the rule is no longer "nothing" — it is **terrain, yes; objects, no**.
 *
 * - *Terrain* is anything the ground is made of and cannot be picked up:
 *   paving, worn dirt tracks, kerbs, steps, retaining walls, parapets, level
 *   changes, rooted trees, scrub, puddles, dust. All of it welcome, all of it
 *   detail the room cannot get any other way.
 * - *Objects* are still forbidden: every crate, cart, machine, sign and person
 *   is painted separately and placed on a rect the mapper chose, so one here
 *   is a second copy of a thing the player can walk up to, sitting where
 *   nothing is.
 *
 * Architecture is allowed but pinned to the **outer edge**. The mapper's only
 * colliders are the four perimeter walls, so a building painted around the rim
 * sits where something solid actually is, while a shed painted mid-floor is a
 * wall the player walks straight through. Keeping the centre open is what
 * keeps the picture honest about the room.
 *
 * 2:1 is not a stylistic choice either: `isoView` projects a world plane of
 * any size into a box exactly twice as wide as it is tall, and the client
 * stretches this plate onto that box.
 */
function roomPrompt(room: RoomBrief, artStyle: string): string {
  return [
    `Detailed isometric ground plate for a 2D adventure game room: ${room.name}. ${room.description}`,
    `${artStyle}. Match the supplied style plate exactly.`,
    'True 2:1 dimetric projection seen from above and to the side, wide panoramic',
    'framing, the ground filling the whole frame corner to corner with no empty margin.',
    'Richly detailed TERRAIN: layered and worn ground, a beaten path or stone',
    'paving crossing it, kerbs, steps and low retaining walls, changes of level,',
    'rooted trees and scrub, grass tufts, loose stones, dust and tyre ruts.',
    'Buildings, archways and boundary walls ONLY around the outer edge of the',
    'plate — the middle of the ground must stay open and walkable.',
    'No people, no animals, no crates, barrels, carts, machinery, furniture or',
    'signage standing on the floor: those are added separately and anything here',
    'would be a duplicate in the wrong place.',
    'Warm cinematic late-afternoon light from the top left, long soft shadows,',
    'atmospheric depth, no text, no watermark, no border.',
  ].join(' ');
}

/**
 * Paint everything that can be painted. Never throws: a request that fails
 * entirely returns empty maps and a reason per asset, and the game runs on
 * placeholders exactly as it does today.
 */
export async function paintWorld(
  request: ArtRequest,
  paint: Painter = generateImage,
): Promise<PaintedArt> {
  const { hash, artStyle, cast, props, rooms = [], emit, fresh = false } = request;
  const art: PaintedArt = { portraits: {}, sprites: {}, props: {}, rooms: {}, missing: [] };
  const say = (kind: Parameters<typeof event>[1], message: string) =>
    emit?.(event(ART_DIRECTOR, kind, message, MODELS.image));

  // Painting is by far the most expensive thing a build does — about twenty
  // images, and measured on a real run that is roughly twice what every text
  // call in the pipeline costs put together. The scenes play perfectly well on
  // the placeholder art, so iterating on story or mechanics should not have to
  // pay for a new cast each time.
  if ((process.env.PAINT_ART ?? 'on').toLowerCase() === 'off') {
    say('fallback', 'PAINT_ART=off — keeping the placeholder art. The world still plays.');
    return art;
  }

  const dir = dirFor(hash);
  await mkdir(dir, { recursive: true }).catch(() => undefined);
  // name → the file on disk, which carries whatever extension its bytes are.
  const onDisk = fresh ? new Map<string, string>() : await listCached(dir);

  /** Paint one asset, or record why not. Cached hits cost nothing. */
  const one = async (name: string, prompt: string, refs: ImageRef[]): Promise<string | null> => {
    const cached = onDisk.get(name);
    if (cached) return urlFor(hash, cached);
    try {
      const image = await paint(prompt, refs);
      const file = `${name}.${extensionFor(image.mimeType)}`;
      await writeFile(join(dir, file), image.bytes);
      onDisk.set(name, file);
      return urlFor(hash, file);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      art.missing.push({ asset: name, reason });
      say('fallback', `${name} stays a placeholder — ${reason}`);
      return null;
    }
  };

  say('start', `Locking a style: ${artStyle || 'unspecified, using the house palette'}.`);

  // The plate is painted first and then passed as a reference to everything
  // else, which is the only thing keeping a cast of four looking related.
  const styleName = 'style-plate';
  const styleUrl = await one(styleName, plate(artStyle), []);
  if (styleUrl) art.styleUrl = styleUrl;

  const refs: ImageRef[] = [];
  const plateRef = await readRef(dir, styleName);
  if (plateRef) refs.push(plateRef);
  else say('fallback', 'No style plate, so each asset is painted on its own.');

  // Everything after the plate, in the order it matters: faces, then the
  // player, then props, then rooms. A few are painted at once — one at a time
  // took five minutes for a small world, with the forming screen silent the
  // whole way — but the queue is still taken in this order, so when a quota
  // runs out it still runs out on a room rather than a face.
  const queue: { name: string; prompt: string; keep: (url: string) => void }[] = [
    ...cast.flatMap((member) => [
      {
        name: `portrait-${member.id}`,
        prompt: characterPrompt(member, artStyle, 'portrait'),
        keep: (url: string) => (art.portraits[member.id] = url),
      },
      {
        name: `sprite-${member.id}`,
        prompt: characterPrompt(member, artStyle, 'sprite'),
        keep: (url: string) => (art.sprites[member.id] = url),
      },
    ]),
    {
      name: 'player-sheet',
      prompt: playerSheetPrompt(artStyle),
      keep: (url: string) => (art.playerSheet = url),
    },
    ...props.map((prop) => ({
      name: `prop-${prop.id}`,
      prompt: propPrompt(prop, artStyle),
      keep: (url: string) => (art.props[prop.id] = url),
    })),
    ...rooms.map((room) => ({
      name: `room-${room.id}`,
      prompt: roomPrompt(room, artStyle),
      keep: (url: string) => (art.rooms![room.id] = url),
    })),
  ];
  const total = queue.length + 1;
  let finished = 1;
  let next = 0;
  const worker = async () => {
    while (next < queue.length) {
      const task = queue[next++]!;
      const url = await one(task.name, task.prompt, refs);
      if (url) task.keep(url);
      finished++;
      say('progress', `Painted ${finished}/${total}: ${task.name.replace(/-/g, ' ')}.`);
    }
  };
  const width = Math.max(1, Number(process.env.PAINT_CONCURRENCY ?? 3) || 1);
  await Promise.all(Array.from({ length: Math.min(width, queue.length) }, worker));

  const wanted = 1 + cast.length * 2 + 1 + props.length + rooms.length;
  const made = wanted - art.missing.length;
  say(
    art.missing.length === 0 ? 'done' : 'repair',
    `Painted ${made}/${wanted}. ${art.missing.length === 0 ? 'Cast and props are on-model.' : `${art.missing.length} stay placeholders; the scenes still play.`}`,
  );
  return art;
}

/** Asset name → the file holding it, for whatever extension it was saved as. */
async function listCached(dir: string): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  try {
    for (const file of await readdir(dir)) {
      const dot = file.lastIndexOf('.');
      if (dot < 1) continue;
      const extension = file.slice(dot + 1).toLowerCase();
      if ((EXTENSIONS as readonly string[]).includes(extension))
        found.set(file.slice(0, dot), file);
    }
  } catch {
    // Nothing painted for this chapter yet.
  }
  return found;
}

async function readRef(dir: string, name: string): Promise<ImageRef | null> {
  const file = (await listCached(dir)).get(name);
  if (!file) return null;
  try {
    const bytes = await readFile(join(dir, file));
    return {
      mimeType: mimeFor(file.slice(file.lastIndexOf('.') + 1)),
      data: bytes.toString('base64'),
    };
  } catch {
    return null;
  }
}

/**
 * What was painted for this chapter last time, read off the disk and costing
 * nothing. `paintWorld` would give the same answer for a fully cached world,
 * but it would also paint anything missing — and reopening a world from the
 * library should never spend a credit.
 */
export async function paintedArt(hash: string): Promise<PaintedArt> {
  const art: PaintedArt = { portraits: {}, sprites: {}, props: {}, rooms: {}, missing: [] };
  for (const [name, file] of await listCached(dirFor(hash))) {
    const url = urlFor(hash, file);
    if (name === 'style-plate') art.styleUrl = url;
    else if (name.startsWith('portrait-')) art.portraits[name.slice(9)] = url;
    else if (name.startsWith('sprite-')) art.sprites[name.slice(7)] = url;
    else if (name.startsWith('prop-')) art.props[name.slice(5)] = url;
    else if (name.startsWith('room-')) art.rooms![name.slice(5)] = url;
    else if (name === 'player-sheet') art.playerSheet = url;
  }
  return art;
}

/** Where a painted asset lives on disk, for the route that serves it. */
export function artFile(hashPrefix: string, name: string): string {
  return join(artRoot, hashPrefix, name);
}
