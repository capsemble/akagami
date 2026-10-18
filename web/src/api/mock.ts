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
import machineWorldJson from '@mocks/world.machine.json';
import scriptorium from '@mocks/scenes/scene-scriptorium.json';
import stacks from '@mocks/scenes/scene-stacks.json';
import sanctum from '@mocks/scenes/scene-sanctum.json';
import signalBox from '@mocks/scenes/scene-signal-box.json';
import fallingGrade from '@mocks/scenes/scene-falling-grade.json';
import gorge from '@mocks/scenes/scene-gorge.json';
import workshop1 from '@mocks/scenes/scene-workshop-1.json';
import workshop2 from '@mocks/scenes/scene-workshop-2.json';
import ragJson from '@mocks/rag.json';
import kinematicsEventsJson from '@mocks/agent-events.kinematics.json';
import ragEventsJson from '@mocks/agent-events.rag.json';
import machineEventsJson from '@mocks/agent-events.machine.json';
import type { AdaptRequest, ApiClient, NpcTurnRequest } from './types';

const worlds = [kinematicsWorldJson, ragWorldJson, machineWorldJson] as unknown as World[];
/** The demo opens on kinematics: the physics is the easiest thing to see move. */
const defaultWorld = worlds[0] as World;
const scenes = [
  signalBox,
  fallingGrade,
  gorge,
  scriptorium,
  stacks,
  sanctum,
  workshop1,
  workshop2,
] as unknown as Scene[];

const worldById = (id: string): World => worlds.find((w) => w.id === id) ?? defaultWorld;
const ragTable = ragJson as unknown as Record<string, RagRunResponse>;
const eventsByWorld: Record<string, AgentEvent[]> = {
  'world-ghat-9': kinematicsEventsJson as unknown as AgentEvent[],
  'world-oracle-library': ragEventsJson as unknown as AgentEvent[],
  'world-impossible-machine': machineEventsJson as unknown as AgentEvent[],
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
  // Mock mode builds nothing, so there is nothing to have built before. The
  // title screen hides the section rather than showing an empty one.
  listWorlds: async () => [],

  async createWorld(input) {
    // An uploaded file has to be opened before it can be matched on. Testing
    // `typeof input === 'string'` and nothing else meant every file upload
    // skipped the check entirely and silently landed on the default world,
    // however plainly the chapter announced its subject.
    const text = typeof input === 'string' ? input : await input.text();
    const label = typeof input === 'string' ? `${input.length} chars` : input.name;

    // "demo:rag" from the upload screen picks the RAG world; anything else is
    // kinematics. Word boundaries, not includes(): "average" contains "rag",
    // so a pasted chapter on any subject could land in the Oracle world.
    // Twin of the same test in server/src/index.ts — keep them identical.
    const wanted = /^demo:machine\b/i.test(text.trim())
      ? 'world-impossible-machine'
      : /\brag\b/i.test(text)
        ? 'world-oracle-library'
        : defaultWorld.id;
    console.info('[mock] createWorld', label, '→', wanted);
    return delay({ id: worldById(wanted).id });
  },

  getWorld(id) {
    // Mock mode has two prepared worlds and no pipeline. Saying so is the whole
    // difference between "it ignored my chapter" and "generation is switched off".
    const world = worldById(id);
    return delay({
      ...world,
      substituted:
        'Demo mode: this is a prepared world, matched to your chapter. Run with VITE_API=live to build one from it.',
    });
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
    const key = ragTable[pickRagKey(req.params)] ? pickRagKey(req.params) : 'default';
    const hit = ragTable[key];
    if (!hit) throw new Error('[mock] rag.json has no default entry');
    return delay({ ...hit, fixtureKey: key });
  },

  npcTurn(_req: NpcTurnRequest) {
    // Mock mode reads nothing and asks no model, so the guide says so rather
    // than playing back a canned answer about a different world.
    const turn: NpcTurn = {
      reply:
        'In demo mode I can only point: read the steps at the top, then try it — the world will show you what changed.',
      mood: 'neutral',
      understanding: 0,
      misconception: '',
      unlock: false,
      offline: true,
    };
    return delay(turn);
  },

  adapt(_req: AdaptRequest) {
    // Mock mode asks no model, so say that instead of replaying the Oracle's
    // canned move in a world about something else.
    const move: TeachingMove = {
      technique: 'simpler_wording',
      speaker: 'Demo mode',
      message:
        'No model is reading your attempt in demo mode. Look at what the board says broke, change one thing, and try again.',
      offline: true,
    };
    return delay(move);
  },
};
