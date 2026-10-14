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
}

export interface Scene {
  id: string;
  imageUrl: string;
  width: number;
  height: number;
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
