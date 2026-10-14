/**
 * Chapter in → validated game script out.
 *
 *   extract → curriculum → 2 outline drafts → judge → acts (parallel)
 *           → validate → ONE repair → validate → fallback if still broken
 *
 * Every stage is cached by sha256 of the chapter text, because a design run
 * costs real Argon calls.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  ActSpec,
  AgentEvent,
  Curriculum,
  GameScript,
  Outline,
  OutlineAct,
} from '@chapter-quest/shared';
import { readCache, writeCache } from '../cache.js';
import { loadEvaluator } from '../evaluator.js';
import type { ExtractedChapter } from '../extract.js';
import { MODELS } from '../gemini.js';
import { repoRoot } from '../paths.js';
import { validateScript } from '../validate.js';
import type { ValidationError, ValidationResult } from '../validate.js';
import {
  actWriterAgent,
  brief,
  curriculumAgent,
  draftJudgeAgent,
  event,
  writersRoomAgent,
} from './agents.js';
import type { Emit } from './agents.js';

const MAX_ACTS = 3;
const ORCHESTRATOR = 'Orchestrator';
const VALIDATOR = 'Validator';

export interface DesignOptions {
  chapter: ExtractedChapter;
  emit?: Emit;
  /** Ignore the stage cache and pay for everything again. */
  fresh?: boolean;
}

export interface DesignResult {
  script: GameScript;
  events: AgentEvent[];
  /** Milliseconds per stage, in the order they ran. */
  timings: { stage: string; ms: number }[];
  validation: ValidationResult;
  usedFallback: boolean;
  cacheHits: string[];
}

async function stage<T>(
  name: string,
  timings: { stage: string; ms: number }[],
  work: () => Promise<T>,
): Promise<T> {
  const started = Date.now();
  try {
    return await work();
  } finally {
    timings.push({ stage: name, ms: Date.now() - started });
  }
}

/** Errors that belong to a specific act, keyed by act index. */
function errorsByAct(errors: ValidationError[]): Map<number, ValidationError[]> {
  const byAct = new Map<number, ValidationError[]>();
  for (const error of errors) {
    const match = /^acts\[(\d+)\]/.exec(error.path);
    if (!match?.[1]) continue;
    const index = Number(match[1]);
    byAct.set(index, [...(byAct.get(index) ?? []), error]);
  }
  return byAct;
}

const groundingErrors = (errors: ValidationError[]) =>
  errors.filter((e) => e.path.startsWith('curriculum.'));

export async function designWorld(options: DesignOptions): Promise<DesignResult> {
  const { chapter, fresh = false } = options;
  const events: AgentEvent[] = [];
  const timings: { stage: string; ms: number }[] = [];
  const cacheHits: string[] = [];

  const emit: Emit = (e) => {
    events.push(e);
    options.emit?.(e);
  };

  const hash = chapter.hash;
  const evaluator = await loadEvaluator();

  emit(
    event(
      ORCHESTRATOR,
      'start',
      `Chapter received: ${chapter.source} — ${chapter.pages.length} pages, ${chapter.text.length} chars.`,
      MODELS.text,
    ),
  );
  if (!evaluator) {
    emit(
      event(
        VALIDATOR,
        'progress',
        'Formula checks are off: shared/expr.ts has not landed yet. Structure, grounding, content and ai-system checks still run.',
      ),
    );
  }

  // ---- 1. curriculum -------------------------------------------------------
  const curriculum = await stage('curriculum', timings, async () => {
    if (!fresh) {
      const cached = await readCache<Curriculum>('curriculum', hash);
      if (cached) {
        cacheHits.push('curriculum');
        emit(event(curriculumAgent.name, 'done', `Curriculum from cache: "${cached.title}".`));
        return cached;
      }
    }
    const fetched = await curriculumAgent.run(
      { chapterText: chapter.text, ...(chapter.pdf ? { pdf: chapter.pdf } : {}) },
      emit,
    );
    await writeCache('curriculum', hash, fetched);
    return fetched;
  });

  // Grounding is checked before we spend anything on story.
  let working = curriculum;
  const grounding = validateScript({
    script: { curriculum, outline: emptyOutline(), acts: [] },
    chapterText: chapter.text,
    evaluator,
  });
  const quoteProblems = groundingErrors(grounding.errors);
  if (quoteProblems.length > 0) {
    emit(
      event(
        VALIDATOR,
        'rejected',
        `Rejected curriculum: ${quoteProblems.length} quote(s) not found in the chapter. Repairing…`,
      ),
    );
    working = await stage('curriculum-repair', timings, () =>
      curriculumAgent.run(
        {
          chapterText: chapter.text,
          ...(chapter.pdf ? { pdf: chapter.pdf } : {}),
          errors: quoteProblems,
          previous: curriculum,
        },
        emit,
      ),
    );
    await writeCache('curriculum', hash, working);
  }

  // ---- 2. writers' room: two drafts in parallel ---------------------------
  const outline = await stage('outline', timings, async () => {
    if (!fresh) {
      const cached = await readCache<Outline>('outline', hash);
      if (cached) {
        cacheHits.push('outline');
        emit(event(draftJudgeAgent.name, 'done', `Winning outline from cache: "${cached.title}".`));
        return cached;
      }
    }
    const [a, b] = await Promise.all([
      writersRoomAgent.run({ curriculum: working, draft: 'A' }, emit),
      writersRoomAgent.run({ curriculum: working, draft: 'B' }, emit),
    ]);
    const verdict = await draftJudgeAgent.run({ a, b }, emit);
    const winner = verdict.winner === 'A' ? a : b;
    await writeCache('outline', hash, winner);
    return winner;
  });

  // ---- 3. acts in parallel -------------------------------------------------
  const conceptById = new Map(working.concepts.map((c) => [c.id, c]));
  const plannedActs = outline.acts
    .filter((act) => conceptById.has(act.conceptId))
    .slice(0, MAX_ACTS);

  if (plannedActs.length === 0) {
    emit(event(VALIDATOR, 'rejected', 'The outline has no act pointing at a real concept.'));
    return fallback({
      hash,
      events,
      timings,
      cacheHits,
      emit,
      evaluator,
      chapterText: chapter.text,
    });
  }

  const writeAct = (act: OutlineAct, previous?: ActSpec, errors?: ValidationError[]) =>
    actWriterAgent.run(
      {
        outline,
        concept: conceptById.get(act.conceptId)!,
        act,
        ...(previous ? { previous } : {}),
        ...(errors ? { errors } : {}),
      },
      emit,
    );

  let acts = await stage('acts', timings, async () => {
    if (!fresh) {
      const cached = await readCache<ActSpec[]>('script', hash);
      if (cached) {
        cacheHits.push('script');
        emit(event(ORCHESTRATOR, 'progress', `${cached.length} acts from cache.`));
        return cached;
      }
    }
    return Promise.all(plannedActs.map((act) => writeAct(act)));
  });

  // ---- 4. validate → one repair → validate --------------------------------
  let validation = await stage('validate', timings, async () =>
    validateScript({
      script: { curriculum: working, outline, acts },
      chapterText: chapter.text,
      evaluator,
    }),
  );
  emitValidation(emit, validation, 'first pass');

  if (!validation.ok) {
    const byAct = errorsByAct(validation.errors);
    if (byAct.size > 0) {
      acts = await stage('repair', timings, async () => {
        const repaired = await Promise.all(
          acts.map(async (act, i) => {
            const actErrors = byAct.get(i);
            if (!actErrors?.length) return act;
            const plan = plannedActs[i];
            if (!plan) return act;
            try {
              return await writeAct(plan, act, actErrors);
            } catch (cause) {
              emit(
                event(
                  actWriterAgent.name,
                  'rejected',
                  `Repair of ${plan.id} failed: ${brief(cause)}`,
                ),
              );
              return act;
            }
          }),
        );
        return repaired;
      });

      validation = await stage('revalidate', timings, async () =>
        validateScript({
          script: { curriculum: working, outline, acts },
          chapterText: chapter.text,
          evaluator,
        }),
      );
      emitValidation(emit, validation, 'after repair');
    }
  }

  if (!validation.ok) {
    return fallback({
      hash,
      events,
      timings,
      cacheHits,
      emit,
      evaluator,
      chapterText: chapter.text,
      validation,
    });
  }

  await writeCache('script', hash, acts);

  const script: GameScript = {
    id: `world-${hash.slice(0, 12)}`,
    curriculum: working,
    outline,
    acts,
    sourceHash: hash,
    createdAt: new Date().toISOString(),
  };

  emit(
    event(
      ORCHESTRATOR,
      'done',
      `Script ready: "${outline.title}" — ${acts.length} acts, ${working.concepts.length} concepts.`,
      MODELS.text,
    ),
  );

  return { script, events, timings, validation, usedFallback: false, cacheHits };
}

function emitValidation(emit: Emit, validation: ValidationResult, label: string): void {
  if (validation.ok) {
    emit(event(VALIDATOR, 'done', `Validator passed (${label}): no errors.`));
    return;
  }
  const summary = validation.errors
    .slice(0, 4)
    .map((e) => `${e.path}: ${e.code}`)
    .join('; ');
  emit(
    event(
      VALIDATOR,
      'rejected',
      `Validator rejected (${label}): ${validation.errors.length} error(s) — ${summary}${validation.errors.length > 4 ? '; …' : ''}`,
    ),
  );
}

function emptyOutline(): Outline {
  return {
    title: '',
    logline: '',
    artStyle: '',
    villain: '',
    twist: '',
    cast: [],
    acts: [],
  };
}

interface FallbackInput {
  hash: string;
  events: AgentEvent[];
  timings: { stage: string; ms: number }[];
  cacheHits: string[];
  emit: Emit;
  evaluator: Awaited<ReturnType<typeof loadEvaluator>>;
  chapterText: string;
  validation?: ValidationResult;
}

/** The demo must never die on stage: a known-good script ships instead. */
async function fallback(input: FallbackInput): Promise<DesignResult> {
  const { emit, events, timings, cacheHits, hash } = input;
  const path = join(repoRoot, 'server/fixtures/fallback-script.json');
  const script = JSON.parse(await readFile(path, 'utf8')) as GameScript;

  emit(
    event(
      ORCHESTRATOR,
      'fallback',
      `Could not produce a valid script for this chapter. Shipping the cached world "${script.outline.title}" instead.`,
    ),
  );

  return {
    script: { ...script, sourceHash: hash },
    events,
    timings,
    validation: input.validation ?? { ok: false, errors: [] },
    usedFallback: true,
    cacheHits,
  };
}
