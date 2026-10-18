/**
 * Worlds that have already been built.
 *
 * A design run is the expensive thing this project does — minutes of model
 * calls and, if it painted, most of the credits. Until now the result lived
 * only in the in-memory job registry, so a server restart threw away every
 * world anyone had made and the only way back was to pay for it again.
 *
 * Nothing new is written to make this work. The stage cache already keeps the
 * outline and the acts next to each other, keyed by the chapter's hash, and
 * the art sits in its own folder under the same key. So a built world is
 * simply reassembled from what the build left behind: no database, no second
 * copy to fall out of step with the first, and reopening one costs nothing.
 *
 * Ids are the short form the client already uses, `world-<12 hex>`, and the
 * cache files carry 16, so a lookup matches on the prefix.
 */
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ActSpec, Curriculum, GameScript, Outline, Scene, World } from '@chapter-quest/shared';
import { cacheDir, readCache } from './cache.js';
import { paintedArt } from './pipeline/art.js';
import { mapScenes, toWorld } from './world.js';

/** Enough to list a world without loading it. */
export interface LibraryEntry {
  id: string;
  title: string;
  logline: string;
  acts: number;
  /** When the build finished, from the script cache's own mtime. */
  builtAt: number;
}

const idFor = (hash: string): string => `world-${hash.slice(0, 12)}`;

/** The 16-char hashes that have a finished script on disk. */
async function builtHashes(): Promise<string[]> {
  try {
    return (await readdir(cacheDir))
      .filter((f) => f.endsWith('.script.json'))
      .map((f) => f.slice(0, -'.script.json'.length));
  } catch {
    return [];
  }
}

/**
 * Every world on disk, newest first.
 *
 * A half-finished build leaves an outline with no script, so listing only the
 * scripts is also what keeps unfinished worlds out of the library.
 */
export async function listBuilt(): Promise<LibraryEntry[]> {
  const entries: LibraryEntry[] = [];
  for (const hash of await builtHashes()) {
    const outline = await readCache<Outline>('outline', hash);
    const acts = await readCache<ActSpec[]>('script', hash);
    if (!outline || !acts?.length) continue;
    let builtAt = 0;
    try {
      builtAt = (await stat(join(cacheDir, `${hash}.script.json`))).mtimeMs;
    } catch {
      // Listed a moment ago and gone now; the timestamp is cosmetic.
    }
    entries.push({
      id: idFor(hash),
      title: outline.title,
      logline: outline.logline,
      acts: acts.length,
      builtAt,
    });
  }
  return entries.sort((a, b) => b.builtAt - a.builtAt);
}

/** The cache key behind a world id, or null if it was never built here. */
async function hashOf(id: string): Promise<string | null> {
  const wanted = id.replace(/^world-/, '');
  if (!/^[0-9a-f]{4,16}$/.test(wanted)) return null;
  return (await builtHashes()).find((h) => h.startsWith(wanted)) ?? null;
}

/**
 * What a built world was designed *from*: the concepts with their verbatim
 * quotes, and the cast with the misconceptions they carry. The runtime World
 * drops both, and anything that has to reason about the chapter — the guide,
 * above all — needs them back.
 */
export async function designOf(
  id: string,
): Promise<{ curriculum: Curriculum | null; outline: Outline | null } | null> {
  const hash = await hashOf(id);
  if (!hash) return null;
  return {
    curriculum: await readCache<Curriculum>('curriculum', hash),
    outline: await readCache<Outline>('outline', hash),
  };
}

/** Reassemble one, or null if that id was never built here. */
export async function loadBuilt(
  id: string,
): Promise<{ world: World; scenes: Map<string, Scene> } | null> {
  const hash = await hashOf(id);
  if (!hash) return null;

  const outline = await readCache<Outline>('outline', hash);
  const acts = await readCache<ActSpec[]>('script', hash);
  if (!outline || !acts?.length) return null;

  const curriculum = await readCache<Curriculum>('curriculum', hash);
  const script = {
    id: idFor(hash),
    ...(curriculum ? { curriculum } : {}),
    outline,
    acts,
    art: await paintedArt(hash),
    sourceHash: hash,
  } as GameScript;

  const scenes = mapScenes(script);
  return { world: toWorld(script, scenes), scenes };
}

/** The chapter a world was built from, as kept by the build — its retrieval acts' library. */
export async function sourceOf(id: string): Promise<string | null> {
  const hash = await hashOf(id);
  if (!hash) return null;
  return (await readCache<{ text: string }>('source', hash))?.text ?? null;
}
