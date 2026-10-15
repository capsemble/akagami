import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentEvent, RagParams, RagRunResponse, Scene, World } from '@chapter-quest/shared';
import { mocksDir } from './paths.js';

/** Read at request time, so editing a fixture does not need a restart. */
async function readJson<T>(...segments: string[]): Promise<T> {
  return JSON.parse(await readFile(join(mocksDir, ...segments), 'utf8')) as T;
}

/**
 * The demo worlds, by both their world id and their short demo name, so
 * /api/worlds/:id and /api/demo/:name resolve to the same fixtures.
 */
const WORLDS: Record<string, string> = {
  'world-ghat-9': 'world.kinematics.json',
  kinematics: 'world.kinematics.json',
  'world-oracle-library': 'world.rag.json',
  rag: 'world.rag.json',
};

/** What a fresh upload gets until the real pipeline builds one. */
export const DEFAULT_WORLD_ID = 'world-ghat-9';

export async function loadWorld(idOrName: string = DEFAULT_WORLD_ID): Promise<World> {
  const file = WORLDS[idOrName];
  if (!file)
    throw new Error(`unknown world "${idOrName}" (have: ${Object.keys(WORLDS).join(', ')})`);
  return readJson<World>(file);
}
export const loadScene = (sceneId: string) => readJson<Scene>('scenes', `${sceneId}.json`);
const EVENTS: Record<string, string> = {
  'world-ghat-9': 'agent-events.kinematics.json',
  kinematics: 'agent-events.kinematics.json',
  'world-oracle-library': 'agent-events.rag.json',
  rag: 'agent-events.rag.json',
};

/** The build story has to be the story of the world being built. */
export function loadEvents(idOrName: string = DEFAULT_WORLD_ID): Promise<AgentEvent[]> {
  return readJson<AgentEvent[]>(EVENTS[idOrName] ?? EVENTS[DEFAULT_WORLD_ID]!);
}
export const loadRagTable = () => readJson<Record<string, RagRunResponse>>('rag.json');

/**
 * Pick a canned RAG run for the given sliders. Exact key first, then a coarse
 * bucket so every slider combination still tells a true story.
 * Twin of the picker in web/src/api/mock.ts — both die when the real pipeline lands.
 */
export function pickRagKey(table: Record<string, RagRunResponse>, p: RagParams): string {
  const exact = `${p.chunkSize}-${p.overlap}-${p.k}-${p.rerank}`;
  if (table[exact]) return exact;
  if (p.chunkSize <= 40) return '40-0-3-false'; // cut lands mid-fact
  if (p.chunkSize >= 500) return '500-0-3-false'; // fact buried in a wall of text
  if (p.k >= 6 && !p.rerank) return '120-15-8-false'; // neighbours drown the gold scroll
  if (p.rerank && p.k <= 3) return '120-15-3-true'; // small budget, gold on top
  return 'default';
}
