/**
 * Stage cache keyed by sha256 of the chapter text. A design run costs real
 * Argon calls, so re-running the same chapter should cost nothing.
 *
 * JSON under server/.cache/ (gitignored). Firestore later, if ever.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { repoRoot } from './paths.js';

export type Stage = 'curriculum' | 'outline' | 'script';

const cacheDir = process.env.DESIGN_CACHE_DIR ?? join(repoRoot, 'server/.cache');

const pathFor = (stage: Stage, hash: string) =>
  join(cacheDir, `${hash.slice(0, 16)}.${stage}.json`);

export async function readCache<T>(stage: Stage, hash: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(pathFor(stage, hash), 'utf8')) as T;
  } catch {
    return null;
  }
}

export async function writeCache(stage: Stage, hash: string, value: unknown): Promise<void> {
  await mkdir(cacheDir, { recursive: true });
  await writeFile(pathFor(stage, hash), JSON.stringify(value, null, 2));
}

export { cacheDir };
