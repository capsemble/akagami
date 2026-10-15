import type {
  AgentEvent,
  NpcTurn,
  RagRunRequest,
  RagRunResponse,
  Scene,
  TeachingMove,
  World,
} from '@chapter-quest/shared';

export interface NpcTurnRequest {
  worldId: string;
  actId: string;
  characterId: string;
  playerSays: string;
}

export interface AdaptRequest {
  worldId: string;
  actId: string;
  misconception: string;
  understanding: number;
}

/** Same signatures in mock and live mode — swap with VITE_API, change nothing else. */
export interface ApiClient {
  createWorld(input: File | string): Promise<{ id: string }>;
  getWorld(id: string): Promise<World>;
  getScene(worldId: string, sceneId: string): Promise<Scene>;
  /** Returns an unsubscribe function. */
  streamEvents(worldId: string, onEvent: (event: AgentEvent) => void): () => void;
  runRag(req: RagRunRequest): Promise<RagRunResponse>;
  npcTurn(req: NpcTurnRequest): Promise<NpcTurn>;
  adapt(req: AdaptRequest): Promise<TeachingMove>;
}
