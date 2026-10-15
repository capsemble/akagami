/**
 * The contract between server and web. Hrutik writes, Ranjan reviews.
 * Change only via PR — both sides compile against this file.
 */

export type WorldStatus =
  'reading' | 'designing' | 'validating' | 'painting' | 'mapping' | 'ready' | 'failed';

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Extrusion height for isometric rendering. Ignored in top-down scenes. */
  height?: number;
}

export interface World {
  id: string;
  title: string;
  logline: string;
  artStyle: string;
  cast: Character[];
  acts: Act[];
  status: WorldStatus;
  /** Cached three.js diorama shown behind the world-forming screen. */
  dioramaUrl?: string;
}

export interface Character {
  id: string;
  name: string;
  persona: string;
  portraits: { neutral: string; pleased: string; worried: string };
  sprite: string;
}

export type Verb =
  'drive' | 'aim_launch' | 'plant_marker' | 'interrogate' | 'deduction' | 'intercept' | 'tune';

export interface Prediction {
  question: string;
  options: string[];
  correctIndex: number;
}

export interface Act {
  id: string;
  conceptId: string;
  title: string;
  goal: string;
  verbs: Verb[];
  sceneId: string;
  prediction?: Prediction;
  explainAfter: string;
  /** How the act is actually played. Absent on acts that are dialogue only. */
  mechanic?: Mechanic;
}

export interface Scene {
  id: string;
  imageUrl: string;
  /** Size of the flat world plane the colliders live on. */
  width: number;
  height: number;
  /** How the plane is drawn. Absent means 'topdown', as before. */
  projection?: 'topdown' | 'isometric';
  /** Pixel size of the projected background. Absent means width x height. */
  view?: { width: number; height: number };
  blocked: Rect[];
  interactables: (Rect & { id: string })[];
  exits: Rect[];
  spawn: Point;
  npcSpots: Record<string, Point>;
}

export interface RagParams {
  chunkSize: 40 | 120 | 250 | 500;
  overlap: 0 | 15 | 30;
  k: number;
  rerank: boolean;
  rule?: string;
}

export interface RagRunRequest {
  worldId: string;
  actId: string;
  question: string;
  params: RagParams;
}

export interface RagRunResponse {
  retrieved: { id: string; text: string; score: number; gold: boolean }[];
  answer: string;
  judge: { correct: boolean; missingFacts: string[]; unsupportedClaims: string[] };
  latencyMs: number;
  cached: boolean;
}

export interface NpcTurn {
  reply: string;
  mood: 'neutral' | 'pleased' | 'worried';
  understanding: number;
  misconception: string;
  unlock: boolean;
}

export interface TeachingMove {
  technique: 'contrast' | 'worked_example' | 'simpler_wording' | 'debug_mistake';
  speaker: string;
  message: string;
  check?: { question: string; options: string[]; correctIndex: number; why: string };
}

export interface AgentEvent {
  ts: number;
  agent: string;
  kind: 'start' | 'progress' | 'done' | 'rejected' | 'repair' | 'fallback';
  message: string;
  /** Model ID that did the work, e.g. 'gemini-4-argon'. */
  model?: string;
}

// ---------------------------------------------------------------------------
// Design-time artifacts: chapter in → validated game script out.
// Everything above this line is the runtime contract and is unchanged.
// ---------------------------------------------------------------------------

export type ConceptKind = 'formula' | 'ai-system' | 'qualitative';

export interface Concept {
  id: string;
  name: string;
  /** The one sentence a player must end up believing. */
  keyRule: string;
  /** ids of concepts that must be taught first. */
  requires: string[];
  difficulty: 1 | 2 | 3 | 4 | 5;
  misconceptions: string[];
  kind: ConceptKind;
  /** VERBATIM from the chapter — the validator checks this is really there. */
  quote: string;
  page: number;
}

export interface Curriculum {
  title: string;
  subject: string;
  concepts: Concept[];
}

export interface CastMember {
  id: string;
  name: string;
  look: string;
  persona: string;
  /** The misconception this character personifies, if any. */
  misconception?: string;
}

export interface OutlineAct {
  id: string;
  conceptId: string;
  title: string;
  sceneName: string;
  oneLine: string;
}

export interface Outline {
  title: string;
  logline: string;
  artStyle: string;
  villain: string;
  twist: string;
  cast: CastMember[];
  acts: OutlineAct[];
}

export interface DialogueLine {
  speaker: string;
  line: string;
}

export interface Analogy {
  text: string;
  /** Where the analogy stops being true. Never empty — a lie with no edge is a lie. */
  breaksWhere: string;
}

export type ExitSide = 'north' | 'south' | 'east' | 'west';

export interface SceneObject {
  id: string;
  label: string;
  look: string;
}

export interface SceneSpec {
  name: string;
  description: string;
  objects: SceneObject[];
  exitSide: ExitSide;
}

/**
 * The simulation behind a 'formula' mechanic: a tiny explicit-Euler loop the
 * evaluator runs. Expressions are read by expr.ts and may reference params,
 * constants, state and (in `win`/`outputs`) earlier outputs.
 *
 * TODO(hrutik): this is the wire shape the model emits, written to match the
 * params/constants/outputs/state namespaces the evaluator resolves. If the
 * tested expr.ts uses a different SimSpec, change it here and in
 * server/src/schemas.ts (SIM_SPEC_SCHEMA) — those are the only two places.
 */
/**
 * How to draw a run so the concept is visible rather than merely numeric.
 * Every field is an expression evaluated against the simulation, so a plot can
 * reference params, constants, state and outputs by name.
 */
export interface SimVisual {
  /** trajectory = y against x; timeline = y against time; gauge = one value on a scale. */
  kind: 'trajectory' | 'timeline' | 'gauge';
  /** Per-sample expression for the x axis. Defaults to 't' (seconds). */
  x?: string;
  /** Per-sample expression for the y axis, or the single value for a gauge. */
  y: string;
  xLabel?: string;
  yLabel?: string;
  /** The band you are aiming for, as expressions over constants and outputs. */
  band?: { from: string; to: string; label?: string; axis?: 'x' | 'y' };
  /** Reference lines, e.g. where the siding ends. */
  markers?: { value: string; label: string; axis?: 'x' | 'y' }[];
}

export interface SimSpec {
  /** Fixed values, e.g. { g: 9.81 }. */
  constants: Record<string, number>;
  /** Initial state, as expressions over params/constants, e.g. { x: '0', v: 'u0' }. */
  state: Record<string, string>;
  /** Per-step updates over state/params/constants, e.g. { v: 'v + a * dt' }. */
  step: Record<string, string>;
  /** Computed once the run ends, e.g. { stopDistance: 'x' }. */
  outputs: Record<string, string>;
  /** Boolean expression. True = the player's settings solved it. */
  win: string;
  /** Integration step in seconds. */
  dt: number;
  /** Ceiling on simulated seconds, so a bad spec cannot hang the run. */
  maxTime: number;
  /** Optional boolean expression that ends the run early, e.g. 'v <= 0'. */
  until?: string;
  /** How a run is drawn. Absent means numbers only. */
  visual?: SimVisual;
}

export interface ParamSpec {
  name: string;
  min: number;
  max: number;
  /** Where the dial starts. Must NOT already win, or the act is free. */
  default: number;
  /** A value that wins. The validator checks this really does. */
  solution: number;
}

export type RagAct = 'chunking' | 'embeddings' | 'topk' | 'grounding' | 'injection';

export type Mechanic =
  | { type: 'formula'; spec: SimSpec; params: ParamSpec[] }
  | { type: 'ai-system'; ragAct: RagAct; question: string; goldFact: string }
  | { type: 'qualitative'; rubric: { mustShow: string[]; misconceptions: string[] } };

export interface ActSpec {
  id: string;
  conceptId: string;
  title: string;
  goal: string;
  verbs: Verb[];
  prediction: Prediction;
  explainAfter: string;
  analogy: Analogy;
  /** At most 6 lines, each at most 25 words. */
  dialogue: DialogueLine[];
  scene: SceneSpec;
  mechanic: Mechanic;
}

export interface GameScript {
  id: string;
  curriculum: Curriculum;
  outline: Outline;
  acts: ActSpec[];
  /** sha256 of the chapter text this was built from. */
  sourceHash: string;
  createdAt: string;
}
