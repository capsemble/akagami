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

export interface ArtRequest {
  /** sha256 of the chapter, so a re-run of the same chapter pays nothing. */
  hash: string;
  /** The look the story agent asked for, e.g. 'isometric 1950s hill railway'. */
  artStyle: string;
  cast: CastMember[];
  props: PropBrief[];
  emit?: Emit;
  /** Ignore what is on disk and pay for everything again. */
  fresh?: boolean;
}

export type PaintedArt = WorldArt;

const artRoot = join(cacheDir, 'art');
const dirFor = (hash: string) => join(artRoot, hash.slice(0, 16));
/** Served by the route in index.ts. Relative so it works behind any host. */
const urlFor = (hash: string, name: string) => `/api/art/${hash.slice(0, 16)}/${name}.png`;

/** A house style, stated once, so every asset agrees with every other. */
function plate(artStyle: string): string {
  return [
    `Art style plate for a 2D isometric adventure game: ${artStyle}.`,
    'One illustration, flat vector shapes, limited warm palette of teak browns,',
    'wet slate greys, lantern gold and parchment. Soft top-left light, long soft',
    'shadows, no gradients beyond two steps, no text, no watermark, no border.',
  ].join(' ');
}

function characterPrompt(
  member: CastMember,
  artStyle: string,
  kind: 'portrait' | 'sprite',
): string {
  const shared = `${member.name}: ${member.look}. ${artStyle}. Match the supplied style plate exactly.`;
  return kind === 'portrait'
    ? `${shared} Head-and-shoulders portrait, facing the viewer, neutral expression, plain dark background, square framing, no text.`
    : `${shared} Full body game sprite, three-quarter view from slightly above to suit an isometric scene, standing idle, transparent background, crisp edges, no shadow baked in, no text.`;
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
 * Paint everything that can be painted. Never throws: a request that fails
 * entirely returns empty maps and a reason per asset, and the game runs on
 * placeholders exactly as it does today.
 */
export async function paintWorld(
  request: ArtRequest,
  paint: Painter = generateImage,
): Promise<PaintedArt> {
  const { hash, artStyle, cast, props, emit, fresh = false } = request;
  const art: PaintedArt = { portraits: {}, sprites: {}, props: {}, missing: [] };
  const say = (kind: Parameters<typeof event>[1], message: string) =>
    emit?.(event(ART_DIRECTOR, kind, message, MODELS.image));

  const dir = dirFor(hash);
  await mkdir(dir, { recursive: true }).catch(() => undefined);
  const onDisk = fresh ? new Set<string>() : new Set(await listCached(dir));

  /** Paint one asset, or record why not. Cached hits cost nothing. */
  const one = async (name: string, prompt: string, refs: ImageRef[]): Promise<string | null> => {
    if (onDisk.has(name)) return urlFor(hash, name);
    try {
      const image = await paint(prompt, refs);
      await writeFile(join(dir, `${name}.png`), image.bytes);
      onDisk.add(name);
      return urlFor(hash, name);
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

  for (const member of cast) {
    const portrait = await one(
      `portrait-${member.id}`,
      characterPrompt(member, artStyle, 'portrait'),
      refs,
    );
    if (portrait) art.portraits[member.id] = portrait;

    const sprite = await one(
      `sprite-${member.id}`,
      characterPrompt(member, artStyle, 'sprite'),
      refs,
    );
    if (sprite) art.sprites[member.id] = sprite;
  }

  for (const prop of props) {
    const painted = await one(`prop-${prop.id}`, propPrompt(prop, artStyle), refs);
    if (painted) art.props[prop.id] = painted;
  }

  const wanted = 1 + cast.length * 2 + props.length;
  const made = wanted - art.missing.length;
  say(
    art.missing.length === 0 ? 'done' : 'repair',
    `Painted ${made}/${wanted}. ${art.missing.length === 0 ? 'Cast and props are on-model.' : `${art.missing.length} stay placeholders; the scenes still play.`}`,
  );
  return art;
}

async function listCached(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((f) => f.endsWith('.png')).map((f) => f.slice(0, -4));
  } catch {
    return [];
  }
}

async function readRef(dir: string, name: string): Promise<ImageRef | null> {
  try {
    const bytes = await readFile(join(dir, `${name}.png`));
    return { mimeType: 'image/png', data: bytes.toString('base64') };
  } catch {
    return null;
  }
}

/** Where a painted asset lives on disk, for the route that serves it. */
export function artFile(hashPrefix: string, name: string): string {
  return join(artRoot, hashPrefix, name);
}
