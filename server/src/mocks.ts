import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentEvent, RagParams, RagRunResponse, Scene, World } from '@chapter-quest/shared';
import { mocksDir } from './paths.js';

/** Read at request time, so editing a fixture does not need a restart. */
async function readJson<T>(...segments: string[]): Promise<T> {
  return JSON.parse(await readFile(join(mocksDir, ...segments), 'utf8')) as T;
}

export const loadWorld = (name = 'rag') => readJson<World>(`world.${name}.json`);
export const loadScene = (sceneId: string) => readJson<Scene>('scenes', `${sceneId}.json`);
export const loadEvents = () => readJson<AgentEvent[]>('agent-events.json');
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
