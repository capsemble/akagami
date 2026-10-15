import type { AgentEvent, RagRunRequest } from '@chapter-quest/shared';
import type { AdaptRequest, ApiClient, NpcTurnRequest } from './types';

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${init?.method ?? 'GET'} ${path} → ${res.status} ${body.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

export const liveApi: ApiClient = {
  async createWorld(input) {
    // Chapters go up as text in the JSON body (hence the server's 20 MB limit).
    const payload =
      typeof input === 'string'
        ? { text: input }
        : { filename: input.name, text: await input.text() };
    return json('/api/worlds', { method: 'POST', body: JSON.stringify(payload) });
  },

  getWorld: (id) => json(`/api/worlds/${id}`),

  getScene: (worldId, sceneId) => json(`/api/worlds/${worldId}/scenes/${sceneId}`),

  streamEvents(worldId, onEvent) {
    const source = new EventSource(`/api/worlds/${worldId}/events`);
    source.addEventListener('agent', (e) =>
      onEvent(JSON.parse((e as MessageEvent).data) as AgentEvent),
    );
    source.addEventListener('end', () => source.close());
    source.onerror = () => source.close();
    return () => source.close();
  },

  runRag: (req: RagRunRequest) =>
    json('/api/rag/run', { method: 'POST', body: JSON.stringify(req) }),

  npcTurn: (req: NpcTurnRequest) =>
    json('/api/npc/turn', { method: 'POST', body: JSON.stringify(req) }),

  adapt: (req: AdaptRequest) => json('/api/adapt', { method: 'POST', body: JSON.stringify(req) }),
};
