import type {
  AgentEvent,
  AttemptReport,
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
  /** The conversation so far, oldest first. The server keeps the last few. */
  history?: { who: 'player' | 'guide'; text: string }[];
  /** The player's last run of this act, so "why did that happen?" has an answer. */
  attempt?: { won: boolean; settings: Record<string, number>; outputs: Record<string, number> };
  /** Once the act is won, the guide may talk about the answer. */
  solved?: boolean;
}

export interface AdaptRequest {
  worldId: string;
  actId: string;
  /** What the player just did, which the server re-judges itself. */
  attempt: AttemptReport;
  /** How many times this act has been failed, counting this one. */
  failures: number;
}

/** Same signatures in mock and live mode — swap with VITE_API, change nothing else. */
/** A world that has already been built, for the list under the demo buttons. */
export interface BuiltWorld {
  id: string;
  title: string;
  logline: string;
  acts: number;
  builtAt: number;
}

export interface ApiClient {
  createWorld(input: File | string): Promise<{ id: string }>;
  /**
   * Worlds this server has built before, or null when the API cannot be
   * reached at all. The difference matters on the title screen: nothing built
   * yet is normal, a dead API means the upload button is about to lie.
   */
  listWorlds(): Promise<BuiltWorld[] | null>;
  getWorld(id: string): Promise<World>;
  getScene(worldId: string, sceneId: string): Promise<Scene>;
  /** Returns an unsubscribe function. */
  streamEvents(worldId: string, onEvent: (event: AgentEvent) => void): () => void;
  runRag(req: RagRunRequest): Promise<RagRunResponse>;
  npcTurn(req: NpcTurnRequest): Promise<NpcTurn>;
  adapt(req: AdaptRequest): Promise<TeachingMove>;
}
