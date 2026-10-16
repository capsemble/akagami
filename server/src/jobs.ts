/**
 * In-flight design runs.
 *
 * `POST /api/worlds` cannot wait for a design run — it takes tens of seconds and
 * the client wants an id immediately so it can open the event stream and show
 * the world forming. So the run starts in the background under an id derived
 * from the chapter hash, which is the same id `designWorld` will give it, and
 * everything else resolves against this registry.
 *
 * Memory only, deliberately: the stage cache on disk already makes a repeat of
 * the same chapter cheap, and a process restart during a hackathon demo should
 * lose a job rather than resurrect a half-finished one. Firestore later, if ever.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentEvent, GameScript, Scene, World } from '@chapter-quest/shared';
import type { ExtractedChapter } from './extract.js';
import { repoRoot } from './paths.js';
import { designWorld } from './pipeline/design.js';
import { mapScenes, toWorld } from './world.js';

export type Listener = (event: AgentEvent | null) => void;

export interface Job {
  id: string;
  /** Everything emitted so far, so a late subscriber still sees the whole story. */
  events: AgentEvent[];
  listeners: Set<Listener>;
  world?: World;
  scenes?: Map<string, Scene>;
  error?: string;
  /** True when the prepared world stood in for a build that could not run. */
  usedFallback?: boolean;
  done: boolean;
}

const jobs = new Map<string, Job>();

/** The id `designWorld` will give this chapter, known before it has run. */
export const worldIdFor = (hash: string): string => `world-${hash.slice(0, 12)}`;

export const getJob = (id: string): Job | undefined => jobs.get(id);

/**
 * Start a design run, or return the id of one already running or finished for
 * the same chapter. Never throws: a failed run is recorded on the job and
 * reported as a terminal event, because the client is watching a stream, not
 * waiting on this call.
 */
export function startDesign(chapter: ExtractedChapter, fresh = false): string {
  const id = worldIdFor(chapter.hash);
  const existing = jobs.get(id);
  if (existing && !fresh) return id;

  const job: Job = { id, events: [], listeners: new Set(), done: false };
  jobs.set(id, job);

  const push = (event: AgentEvent) => {
    job.events.push(event);
    for (const listener of job.listeners) listener(event);
  };
  const finish = () => {
    job.done = true;
    for (const listener of job.listeners) listener(null);
    job.listeners.clear();
  };

  void (async () => {
    try {
      const result = await designWorld({ chapter, emit: push, ...(fresh ? { fresh: true } : {}) });
      const scenes = mapScenes(result.script);
      job.scenes = scenes;
      job.world = toWorld(result.script, scenes);
      push({
        ts: Date.now(),
        agent: 'Orchestrator',
        kind: 'done',
        message: `World ready. ${job.world.acts.length} acts, ${scenes.size} rooms, ${job.world.cast.length} characters. Step in.`,
      });
    } catch (err) {
      // The models were unreachable — rate limited, overloaded, or down. The
      // pipeline's own fallback only covers a script that fails validation, so
      // a 503 on the way out would otherwise hand the player a dead screen.
      // A prepared world is a worse demo than a generated one and a far better
      // demo than an error.
      const reason = err instanceof Error ? err.message : String(err);
      push({
        ts: Date.now(),
        agent: 'Orchestrator',
        kind: 'fallback',
        message: `Could not reach the design models (${reason.slice(0, 120)}). Shipping the prepared world so the demo still runs.`,
      });
      try {
        const script = JSON.parse(
          await readFile(join(repoRoot, 'server/fixtures/fallback-script.json'), 'utf8'),
        ) as GameScript;
        const scenes = mapScenes(script);
        job.scenes = scenes;
        job.world = {
          ...toWorld(script, scenes),
          id,
          substituted: `The design models could not be reached (${reason.slice(0, 90)}), so this is the prepared world, not yours.`,
        };
        job.usedFallback = true;
      } catch (inner) {
        job.error = inner instanceof Error ? inner.message : String(inner);
      }
    } finally {
      finish();
    }
  })();

  return id;
}

/**
 * Watch a job. Anything already emitted arrives first, then live events, then
 * one null to say it is over. Returns an unsubscribe.
 */
export function watch(job: Job, listener: Listener): () => void {
  for (const event of job.events) listener(event);
  if (job.done) {
    listener(null);
    return () => undefined;
  }
  job.listeners.add(listener);
  return () => job.listeners.delete(listener);
}
