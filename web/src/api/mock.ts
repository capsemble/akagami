import type {
  AgentEvent,
  NpcTurn,
  RagParams,
  RagRunRequest,
  RagRunResponse,
  Scene,
  TeachingMove,
  World,
} from '@chapter-quest/shared';
import ragWorldJson from '@mocks/world.rag.json';
import kinematicsWorldJson from '@mocks/world.kinematics.json';
import scriptorium from '@mocks/scenes/scene-scriptorium.json';
import stacks from '@mocks/scenes/scene-stacks.json';
import sanctum from '@mocks/scenes/scene-sanctum.json';
import signalBox from '@mocks/scenes/scene-signal-box.json';
import fallingGrade from '@mocks/scenes/scene-falling-grade.json';
import gorge from '@mocks/scenes/scene-gorge.json';
import ragJson from '@mocks/rag.json';
import kinematicsEventsJson from '@mocks/agent-events.kinematics.json';
import ragEventsJson from '@mocks/agent-events.rag.json';
import npcJson from '@mocks/npc.json';
import teachingJson from '@mocks/teaching-move.json';
import type { AdaptRequest, ApiClient, NpcTurnRequest } from './types';

const worlds = [kinematicsWorldJson, ragWorldJson] as unknown as World[];
/** The demo opens on kinematics: the physics is the easiest thing to see move. */
const defaultWorld = worlds[0] as World;
const scenes = [signalBox, fallingGrade, gorge, scriptorium, stacks, sanctum] as unknown as Scene[];

const worldById = (id: string): World => worlds.find((w) => w.id === id) ?? defaultWorld;
const ragTable = ragJson as unknown as Record<string, RagRunResponse>;
const eventsByWorld: Record<string, AgentEvent[]> = {
  'world-ghat-9': kinematicsEventsJson as unknown as AgentEvent[],
  'world-oracle-library': ragEventsJson as unknown as AgentEvent[],
};

/** The build story has to be the story of the world being built. */
const eventsFor = (worldId: string): AgentEvent[] =>
  eventsByWorld[worldId] ?? eventsByWorld[defaultWorld.id] ?? [];

/** Network that isn't there. Keeps loading states honest in mock mode. */
const latency = () => 300 + Math.random() * 500;
const delay = <T>(value: T): Promise<T> =>
  new Promise((resolve) => setTimeout(() => resolve(value), latency()));

/** Twin of pickRagKey in server/src/mocks.ts — both die when retrieval is real. */
function pickRagKey(p: RagParams): string {
  const exact = `${p.chunkSize}-${p.overlap}-${p.k}-${p.rerank}`;
  if (ragTable[exact]) return exact;
  if (p.chunkSize <= 40) return '40-0-3-false'; // cut lands mid-fact
  if (p.chunkSize >= 500) return '500-0-3-false'; // fact buried in a wall of text
  if (p.k >= 6 && !p.rerank) return '120-15-8-false'; // neighbours drown the gold scroll
  if (p.rerank && p.k <= 3) return '120-15-3-true'; // small budget, gold on top
  return 'default';
}

export const mockApi: ApiClient = {
  async createWorld(input) {
    const label = typeof input === 'string' ? `${input.length} chars` : input.name;
    console.info('[mock] createWorld', label);
    // "demo:rag" from the upload screen picks the RAG world; anything else is kinematics.
    const wanted =
      typeof input === 'string' && input.includes('rag') ? 'world-oracle-library' : defaultWorld.id;
    return delay({ id: worldById(wanted).id });
  },

  getWorld(id) {
    return delay(worldById(id));
  },

  async getScene(_worldId, sceneId) {
    const scene = scenes.find((s) => s.id === sceneId);
    if (!scene) throw new Error(`[mock] no scene ${sceneId}`);
    return delay(scene);
  },

  streamEvents(worldId, onEvent) {
    const timers: ReturnType<typeof setTimeout>[] = [];
    let previous = 0;
    let elapsed = 0;
    for (const event of eventsFor(worldId)) {
      elapsed += Math.max(0, event.ts - previous);
      previous = event.ts;
      timers.push(setTimeout(() => onEvent(event), elapsed));
    }
    return () => timers.forEach(clearTimeout);
  },

  async runRag(req: RagRunRequest) {
    const hit = ragTable[pickRagKey(req.params)] ?? ragTable.default;
    if (!hit) throw new Error('[mock] rag.json has no default entry');
    return delay(hit);
  },

  npcTurn(_req: NpcTurnRequest) {
    return delay(npcJson as unknown as NpcTurn);
  },

  adapt(_req: AdaptRequest) {
    return delay(teachingJson as unknown as TeachingMove);
  },
};
