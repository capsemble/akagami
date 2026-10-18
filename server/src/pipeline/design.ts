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
  RagParams,
} from '@chapter-quest/shared';
import { readCache, writeCache } from '../cache.js';
import { loadEvaluator } from '../evaluator.js';
import type { ExtractedChapter } from '../extract.js';
import { MODELS } from '../gemini.js';
import { repoRoot } from '../paths.js';
import { registersFor } from '../registers.js';
import { UnsupportedChapterError, routeConcepts } from '../routing.js';
import { assess, isGrounded, judgeGrounding, pruneUnsupportedRules } from './judge.js';
import { PLAY_TESTER, playtest } from './playtest.js';
import { verifyChapterAct } from '../rag.js';
import { validateScript } from '../validate.js';
import type { ValidationError, ValidationResult } from '../validate.js';
import { paintWorld } from './art.js';
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
  /** Stop before the art director: for checking what a chapter becomes, not how it looks. */
  skipArt?: boolean;
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
        'Formula checks are off: no evaluator available. Structure, grounding, content and ai-system checks still run.',
      ),
    );
  }

  // The notes themselves, kept beside what was built from them, so every
  // citation in the world can be checked against its source after the fact.
  await writeCache('source', hash, { source: chapter.source, text: chapter.text });

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

  // ---- 1b. routing: only concepts a mechanic can play reach the story -----
  const routing = routeConcepts(working);
  for (const { concept, reason } of routing.unsupported) {
    emit(
      event(VALIDATOR, 'rejected', `Not building "${concept.name}" (${concept.kind}): ${reason}.`),
    );
  }
  if (routing.playable.length === 0) throw new UnsupportedChapterError(routing.unsupported);
  const playableIds = new Set(routing.playable.map((c) => c.id));
  emit(
    event(
      ORCHESTRATOR,
      'progress',
      `${routing.playable.length} of ${working.concepts.length} concepts are playable: ` +
        routing.playable.map((c) => `${c.name} (${c.kind})`).join(', '),
    ),
  );

  // ---- 2. writers' room: two drafts in parallel ---------------------------
  const outline = await stage('outline', timings, async () => {
    if (!fresh) {
      const cached = await readCache<Outline>('outline', hash);
      // An outline cached before routing existed may be built entirely on
      // concepts nothing can play; that one is written again.
      if (cached && cached.acts.some((act) => playableIds.has(act.conceptId))) {
        cacheHits.push('outline');
        emit(event(draftJudgeAgent.name, 'done', `Winning outline from cache: "${cached.title}".`));
        return cached;
      }
    }
    // allSettled, not all: the second draft exists so there is a choice, and
    // losing one to an overloaded model should cost the choice, not the run.
    // Promise.all rejected the whole stage the instant either draft failed —
    // including one case where the surviving draft arrived moments later and
    // was thrown away.
    // Two different films, so the judge has a real choice: two drafts of one
    // genre differ by set dressing and the judge ends up picking on prose.
    const [filmA, filmB] = registersFor(hash);
    // Prerequisites that point at a dropped concept are dropped with it.
    const playableCurriculum = {
      ...working,
      concepts: routing.playable.map((c) => ({
        ...c,
        requires: c.requires.filter((id) => playableIds.has(id)),
      })),
    };
    const [a, b] = await Promise.allSettled([
      writersRoomAgent.run({ curriculum: playableCurriculum, draft: 'A', register: filmA }, emit),
      writersRoomAgent.run({ curriculum: playableCurriculum, draft: 'B', register: filmB }, emit),
    ]);

    const survived = [a, b].filter((r) => r.status === 'fulfilled').map((r) => r.value);
    if (survived.length === 0) {
      const why = [a, b]
        .map((r) => (r.status === 'rejected' ? String(r.reason).slice(0, 80) : ''))
        .filter(Boolean)
        .join('; ');
      throw new Error(`both drafts failed: ${why}`);
    }

    let winner = survived[0]!;
    if (survived.length === 1) {
      emit(
        event(
          draftJudgeAgent.name,
          'fallback',
          `Only one draft survived, so there is nothing to judge: keeping "${winner.title}".`,
        ),
      );
    } else {
      const verdict = await draftJudgeAgent.run({ a: survived[0]!, b: survived[1]! }, emit);
      winner = verdict.winner === 'A' ? survived[0]! : survived[1]!;
    }

    await writeCache('outline', hash, winner);
    return winner;
  });

  // ---- 3. acts in parallel -------------------------------------------------
  const conceptById = new Map(working.concepts.map((c) => [c.id, c]));
  let plannedActs = outline.acts
    .filter((act) => conceptById.has(act.conceptId) && playableIds.has(act.conceptId))
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
        chapterText: chapter.text,
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
    // Same reasoning as the drafts: one act lost to an overloaded model should
    // cost that act, not the world. `plannedActs` is narrowed to match, so the
    // repair pass below still lines up act-for-act.
    const written = await Promise.allSettled(plannedActs.map((act) => writeAct(act)));
    const specs: ActSpec[] = [];
    const surviving: OutlineAct[] = [];
    written.forEach((result, i) => {
      const plan = plannedActs[i]!;
      if (result.status === 'fulfilled') {
        specs.push(result.value);
        surviving.push(plan);
      } else {
        emit(
          event(
            actWriterAgent.name,
            'rejected',
            `Act ${plan.id} was lost: ${brief(result.reason)}`,
          ),
        );
      }
    });

    if (specs.length === 0) throw new Error('no act survived writing');
    if (specs.length < plannedActs.length) {
      emit(
        event(
          ORCHESTRATOR,
          'fallback',
          `${specs.length} of ${plannedActs.length} acts survived. Shipping a shorter world rather than none.`,
        ),
      );
    }
    plannedActs = surviving;
    return specs;
  });

  // ---- 4. validate → one repair → validate --------------------------------
  const check = (current: ActSpec[]) =>
    validateAndJudge({
      acts: current,
      curriculum: working,
      outline,
      chapterText: chapter.text,
      evaluator,
      emit,
    });
  let validation: ValidationResult;
  ({ acts, validation } = await stage('validate', timings, () => check(acts)));
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
            // Problems the game's own checks can see go to the play-tester,
            // which gets the simulator, the validator and the notes as tools.
            // A judge's verdict is not one of them: those go straight to the
            // one-shot repair, which the play-tester also falls back to.
            if (actErrors.some((e) => !JUDGE_CODES.has(e.code))) {
              const tested = await playtest(
                {
                  outline,
                  curriculum: working,
                  concept: conceptById.get(plan.conceptId)!,
                  plan,
                  draft: act,
                  errors: actErrors,
                  notes: chapter.text,
                  evaluator,
                },
                emit,
              );
              if (tested.passed && tested.spec) return tested.spec;
            }
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

      ({ acts, validation } = await stage('revalidate', timings, () => check(acts)));
      emitValidation(emit, validation, 'after repair');
    }
  }

  // One more repair, only for acts whose every remaining problem is a citation
  // the notes do not back. The first repair is usually spent copying quotes
  // verbatim; this one is for citing the passage that actually says it.
  if (!validation.ok) {
    const byAct = errorsByAct(validation.errors);
    const citationOnly = [...byAct.entries()].filter(([, errors]) =>
      errors.every((e) => GROUNDING_CODES.has(e.code)),
    );
    if (citationOnly.length > 0) {
      const again = new Map(citationOnly);
      acts = await stage('regrounding', timings, () =>
        Promise.all(
          acts.map(async (act, i) => {
            const errors = again.get(i);
            const plan = plannedActs[i];
            if (!errors || !plan) return act;
            try {
              return await writeAct(plan, act, errors);
            } catch (cause) {
              emit(
                event(
                  actWriterAgent.name,
                  'rejected',
                  `Re-citing ${plan.id} failed: ${brief(cause)}`,
                ),
              );
              return act;
            }
          }),
        ),
      );
      ({ acts, validation } = await stage('revalidate', timings, () => check(acts)));
      emitValidation(emit, validation, 'after re-citing');
    }
  }

  // A sequence act whose only remaining problems are rules the notes do not
  // establish keeps the rules they do, if that still leaves a puzzle.
  if (!validation.ok) {
    const byAct = errorsByAct(validation.errors);
    let pruned = false;
    acts = acts.map((act, i) => {
      const errors = byAct.get(i);
      if (!errors?.length || act.mechanic.type !== 'sequence') return act;
      const at = `acts[${i}].mechanic.`;
      const saved = pruneUnsupportedRules(
        act.mechanic,
        errors.map((e) => ({
          at: e.path.startsWith(at) ? e.path.slice(at.length) : e.path,
          code: e.code,
        })),
        act.id,
      );
      if (!saved) return act;
      pruned = true;
      emit(
        event(
          'Evidence judge',
          'repair',
          `${act.id}: dropped ${saved.pruned.length} rule(s) the notes do not establish (${saved.pruned
            .map((r) => `${r.before} → ${r.after}`)
            .join(', ')}); those cards are now unordered.`,
        ),
      );
      return { ...act, mechanic: saved.mechanic };
    });
    if (pruned) {
      ({ acts, validation } = await check(acts));
      emitValidation(emit, validation, 'after pruning');
    }
  }

  // Acts that are still broken after their one repair are cut, as long as the
  // rest of the world is sound: a two-act world about the chapter beats the
  // prepared world about someone else's. Only act-scoped errors qualify — a
  // broken curriculum or outline still falls back.
  if (!validation.ok) {
    const byAct = errorsByAct(validation.errors);
    const actScoped = byAct.size > 0 && validation.errors.every((e) => /^acts\[\d+\]/.test(e.path));
    const keep = acts.filter((_, i) => !byAct.has(i));
    if (actScoped && keep.length > 0) {
      for (const [i, errors] of byAct) {
        emit(
          event(
            ORCHESTRATOR,
            'fallback',
            `Cutting ${acts[i]?.id} "${acts[i]?.title}": still invalid after repair (${errors
              .map((e) => e.code)
              .join(', ')}).`,
          ),
        );
      }
      acts = keep;
      validation = validateScript({
        script: { curriculum: working, outline, acts },
        chapterText: chapter.text,
        evaluator,
      });
      emitValidation(emit, validation, 'after cutting');
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

  // Art last, and only once the script is known good: a world that failed
  // validation is thrown away, and painting it first would be paying for
  // pictures nobody will ever see. Nothing here can fail the run — a dead
  // image model costs placeholders, not the world.
  const art = options.skipArt
    ? undefined
    : await stage('art', timings, () =>
        paintWorld({
          hash,
          artStyle: outline.artStyle,
          cast: outline.cast,
          props: propsOf(acts),
          // Keyed by act, because that is what the mapper keys a scene off too.
          rooms: acts.map((act) => ({
            id: act.id,
            name: act.scene.name,
            description: act.scene.description,
          })),
          emit,
          ...(options.fresh ? { fresh: true } : {}),
        }),
      );

  const script: GameScript = {
    id: `world-${hash.slice(0, 12)}`,
    curriculum: working,
    outline,
    acts,
    ...(art ? { art } : {}),
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

/** Verdicts only the evidence judge can give; the play-tester's validator cannot see them. */
const JUDGE_CODES = new Set([
  'rag-start-wins',
  'rag-unwinnable',
  'rag-unverified',
  'evidence-insufficient',
  'evidence-contradicts',
  'card-unsupported',
  'ambiguous-evidence',
  'grounding-unchecked',
]);

/** Problems with what an act cites, as opposed to how it is built. */
const GROUNDING_CODES = new Set([
  'missing-evidence',
  'quote-too-short',
  'evidence-not-in-source',
  'evidence-off-topic',
  'evidence-conflict',
  'evidence-insufficient',
  'evidence-contradicts',
  'card-unsupported',
  'ambiguous-evidence',
  'grounding-unchecked',
  'rag-start-wins',
  'rag-unwinnable',
  'rag-unverified',
]);

/** "chunks of 120 words with 15 of overlap, 3 in the satchel, reranked, grounding rule on". */
function describeFix(p: RagParams): string {
  return `chunks of ${p.chunkSize} words with ${p.overlap} of overlap, ${p.k} in the satchel${p.rerank ? ', reranked' : ''}${p.rule === 'grounded' ? ', grounding rule on' : ''}`;
}

interface CheckInput {
  acts: ActSpec[];
  curriculum: Curriculum;
  outline: Outline;
  chapterText: string;
  evaluator: Awaited<ReturnType<typeof loadEvaluator>>;
  emit: Emit;
}

/**
 * Deterministic validation, then the evidence judge on every sequence and
 * evidence act that passed it. The judge is a model, so it runs only once the
 * citations are known to exist, and its verdicts are written onto the act
 * (`grounding`) whatever they say — the record is the audit trail.
 */
async function validateAndJudge(input: CheckInput): Promise<{
  acts: ActSpec[];
  validation: ValidationResult;
}> {
  const { curriculum, outline, chapterText, evaluator, emit } = input;
  const base = validateScript({
    script: { curriculum, outline, acts: input.acts },
    chapterText,
    evaluator,
  });
  const failing = errorsByAct(base.errors);
  const judged = await Promise.all(
    input.acts.map(async (act, i) => {
      const mechanic = act.mechanic;
      // A retrieval act over the chapter is played live, here, before anyone
      // else plays it: its broken start must lose and a real fix must win.
      if (mechanic.type === 'ai-system' && mechanic.corpus === 'chapter' && !failing.has(i)) {
        if (mechanic.verified?.startLost && mechanic.verified.fix) {
          return { act, errors: [] as ValidationError[] };
        }
        try {
          const { verified, problems } = await verifyChapterAct(mechanic, chapterText);
          emit(
            event(
              PLAY_TESTER,
              problems.length ? 'rejected' : 'done',
              problems.length
                ? `${act.id}: ran the retrieval act live over the chapter — ${problems.map((p) => p.code).join(', ')}.`
                : `${act.id}: ran the retrieval act live over the chapter — the broken start loses, and ${describeFix(verified.fix!)} wins.`,
            ),
          );
          return {
            act: { ...act, mechanic: { ...mechanic, verified } },
            errors: problems.map((p) => ({
              path: `acts[${i}].mechanic`,
              code: p.code,
              message: p.message,
            })),
          };
        } catch (err) {
          return {
            act,
            errors: [
              {
                path: `acts[${i}].mechanic`,
                code: 'rag-unverified',
                message: `the act could not be run live: ${brief(err)}`,
              },
            ],
          };
        }
      }
      if (!isGrounded(mechanic) || failing.has(i)) return { act, errors: [] as ValidationError[] };
      // A cached act already judged clean is not paid for twice.
      if (mechanic.grounding && assess(mechanic, mechanic.grounding).length === 0) {
        return { act, errors: [] as ValidationError[] };
      }
      const { record, problems, failure } = await judgeGrounding(mechanic, chapterText);
      const supported = record.verdicts.filter((v) => v.verdict === 'supported').length;
      emit(
        event(
          'Evidence judge',
          problems.length ? 'rejected' : 'done',
          failure
            ? `${act.id}: the judge could not answer (${failure.slice(0, 80)}), so nothing in it is accepted.`
            : problems.length
              ? `${act.id}: ${problems.length} statement(s) not backed by the notes — ${problems
                  .slice(0, 2)
                  .map((p) => p.code)
                  .join(', ')}.`
              : `${act.id}: all ${record.verdicts.length} statements checked against the notes (${supported} supported, every decoy backs nothing).`,
          record.judge,
        ),
      );
      return {
        act: { ...act, mechanic: { ...mechanic, grounding: record } },
        errors: problems.map((p) => ({
          path: `acts[${i}].mechanic.${p.at}`,
          code: p.code,
          message: p.message,
        })),
      };
    }),
  );
  const errors = [...base.errors, ...judged.flatMap((j) => j.errors)];
  return { acts: judged.map((j) => j.act), validation: { ok: errors.length === 0, errors } };
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

/** Every distinct prop across the acts, so each one is painted exactly once. */
function propsOf(acts: ActSpec[]): { id: string; label: string; look: string }[] {
  const seen = new Map<string, { id: string; label: string; look: string }>();
  for (const act of acts) {
    for (const object of act.scene.objects ?? []) {
      if (!seen.has(object.id)) {
        seen.set(object.id, { id: object.id, label: object.label, look: object.look });
      }
    }
  }
  return [...seen.values()];
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
