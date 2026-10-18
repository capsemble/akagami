import type { AgentEvent, RagRunRequest } from '@chapter-quest/shared';
import type { AdaptRequest, ApiClient, BuiltWorld, NpcTurnRequest } from './types';

const isPdf = (file: File) => file.type === 'application/pdf' || /\.pdf$/i.test(file.name);

/** The file's bytes as base64, without the data-URL prefix. */
const base64Of = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(reader.error ?? new Error(`Could not read ${file.name}`));
    reader.readAsDataURL(file);
  });

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
    // A PDF goes up as base64 for the server to read: file.text() on a PDF is
    // the raw binary, which the pipeline would take for notes.
    const payload =
      typeof input === 'string'
        ? { text: input }
        : isPdf(input)
          ? { filename: input.name, pdf: await base64Of(input) }
          : { filename: input.name, text: await input.text() };
    return json('/api/worlds', { method: 'POST', body: JSON.stringify(payload) });
  },

  async listWorlds() {
    // null, not []: a title screen that cannot reach the API needs to say so
    // rather than quietly showing an empty library and a button that fails.
    try {
      const { worlds } = await json<{ worlds: BuiltWorld[] }>('/api/worlds');
      return worlds ?? [];
    } catch {
      return null;
    }
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
