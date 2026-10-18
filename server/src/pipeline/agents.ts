/**
 * The agents.
 *
 * Deliberately NOT @google/adk. ADK 2.3.0 installs and runs — it reached a live
 * request in a scratch project — but it declares @google/genai ^2.29.1 while the
 * server is pinned to 1.52.0 (npm dedupes to ours, so it works by API overlap
 * rather than by contract), and it brings its own model client, which would route
 * around gemini.ts and lose the design role, the 60 s timeout, the fallback to
 * TEXT_MODEL, the per-model usage counters and the daily caps. Our agents are
 * single-shot structured-output calls with no tool loop, so ADK's session and
 * tool machinery buys nothing today.
 *
 * Everything below is therefore a plain async function behind the Agent
 * interface. Swapping in ADK later means reimplementing `run`, nothing else.
 */
import type { AgentEvent, Concept, Curriculum, Outline, OutlineAct } from '@chapter-quest/shared';
import { MODELS, generateJson } from '../gemini.js';
import type { ImageRef } from '../gemini.js';
import { ACT_SCHEMA, CURRICULUM_SCHEMA, JUDGE_SCHEMA, OUTLINE_SCHEMA } from '../schemas.js';
import type { JudgeVerdict } from '../schemas.js';
import type { FilmRegister } from '../registers.js';
import {
  actPrompt,
  curriculumPrompt,
  judgePrompt,
  repairCurriculumPrompt,
  repairPrompt,
  writersRoomPrompt,
} from '../prompts.js';
import type { ValidationError } from '../validate.js';

/** SDK errors are full JSON blobs and these land in the trace. */
export function brief(cause: unknown, max = 120): string {
  const raw = cause instanceof Error ? cause.message : String(cause);
  return raw.length > max ? `${raw.slice(0, max)}…` : raw;
}
import { toActSpec } from '../wire.js';
import type { WireAct } from '../wire.js';
import type { ActSpec } from '@chapter-quest/shared';

export type Emit = (event: AgentEvent) => void;

/** Agents decide; tools compute. The validator is a tool and is never an agent. */
export interface Agent<Input, Output> {
  name: string;
  run(input: Input, emit: Emit): Promise<Output>;
}

export function event(
  agent: string,
  kind: AgentEvent['kind'],
  message: string,
  model?: string,
): AgentEvent {
  return { ts: Date.now(), agent, kind, message, ...(model ? { model } : {}) };
}

export interface CurriculumInput {
  chapterText: string;
  /** The source PDF, sent inline so the model sees the layout too. */
  pdf?: Buffer;
  /** Set on a repair pass. */
  errors?: ValidationError[];
  previous?: Curriculum;
}

export const curriculumAgent: Agent<CurriculumInput, Curriculum> = {
  name: 'Curriculum agent',
  async run(input, emit) {
    const repairing = Boolean(input.errors?.length);
    emit(
      event(
        this.name,
        repairing ? 'repair' : 'start',
        repairing
          ? `Re-reading the chapter to fix ${input.errors?.length} grounding problem(s).`
          : 'Reading the chapter. Splitting it into teachable units…',
        MODELS.design,
      ),
    );

    const { system, prompt } =
      repairing && input.previous
        ? repairCurriculumPrompt(input.chapterText, input.previous, input.errors ?? [])
        : curriculumPrompt(input.chapterText);

    const files: ImageRef[] = input.pdf
      ? [{ mimeType: 'application/pdf', data: input.pdf.toString('base64') }]
      : [];

    const curriculum = await generateJson<Curriculum>(prompt, CURRICULUM_SCHEMA, {
      role: 'design',
      temperature: 0,
      systemInstruction: system,
      agent: this.name,
      files,
    });

    const misconceptions = curriculum.concepts.reduce((n, c) => n + c.misconceptions.length, 0);
    emit(
      event(
        this.name,
        'done',
        `Found ${curriculum.concepts.length} concepts, ${misconceptions} misconceptions in "${curriculum.title}".`,
        MODELS.design,
      ),
    );
    return curriculum;
  },
};

export interface WritersRoomInput {
  curriculum: Curriculum;
  draft: 'A' | 'B';
  /** The genre this draft is written in. The other draft gets a different one. */
  register: FilmRegister;
}

export const writersRoomAgent: Agent<WritersRoomInput, Outline> = {
  name: "Writers' room",
  async run({ curriculum, draft, register }, emit) {
    emit(
      event(this.name, 'progress', `Draft ${draft}: writing it as ${register.name}…`, MODELS.design),
    );
    const { system, prompt } = writersRoomPrompt(curriculum, draft, register);
    const outline = await generateJson<Outline>(prompt, OUTLINE_SCHEMA, {
      role: 'design',
      temperature: 0.85,
      systemInstruction: system,
      agent: this.name,
    });
    emit(
      event(
        this.name,
        'progress',
        `Draft ${draft} (${register.name}): "${outline.title}" — villain ${outline.villain}, ${outline.acts.length} acts.`,
        MODELS.design,
      ),
    );
    return outline;
  },
};

export interface JudgeInput {
  a: Outline;
  b: Outline;
}

export const draftJudgeAgent: Agent<JudgeInput, JudgeVerdict> = {
  name: 'Draft judge',
  async run({ a, b }, emit) {
    emit(event(this.name, 'progress', 'Scoring both drafts…', MODELS.design));
    const { system, prompt } = judgePrompt(a, b);
    const verdict = await generateJson<JudgeVerdict>(prompt, JUDGE_SCHEMA, {
      role: 'design',
      temperature: 0,
      systemInstruction: system,
      agent: this.name,
    });
    const winning = verdict.scores.find((s) => s.draft === verdict.winner);
    emit(
      event(
        this.name,
        'done',
        `Judge kept draft ${verdict.winner} (${winning?.total ?? '?'}/15). ${winning?.notes ?? ''}`.trim(),
        MODELS.design,
      ),
    );
    return verdict;
  },
};

export interface ActInput {
  outline: Outline;
  concept: Concept;
  act: OutlineAct;
  /** The notes, which every citation in the act is copied from. */
  chapterText?: string;
  /** Set on a repair pass. */
  errors?: ValidationError[];
  previous?: ActSpec;
}

export const actWriterAgent: Agent<ActInput, ActSpec> = {
  name: 'Act writer',
  async run({ outline, concept, act, errors, previous, chapterText = '' }, emit) {
    const repairing = Boolean(errors?.length);
    emit(
      event(
        this.name,
        repairing ? 'repair' : 'progress',
        repairing
          ? `Repairing ${act.id} "${act.title}": ${errors?.map((e) => e.code).join(', ')}`
          : `Writing ${act.id} "${act.title}" (${concept.kind}).`,
        MODELS.design,
      ),
    );

    const { system, prompt } =
      repairing && previous
        ? repairPrompt(outline, concept, act, previous, errors ?? [], chapterText)
        : actPrompt(outline, concept, act, chapterText);

    const wire = await generateJson<WireAct>(prompt, ACT_SCHEMA, {
      role: 'design',
      temperature: repairing ? 0.2 : 0.7,
      systemInstruction: system,
      agent: this.name,
    });

    const spec = toActSpec(wire);
    emit(
      event(
        this.name,
        'progress',
        `${act.id} written: ${spec.verbs.join('+')} over ${spec.mechanic.type}.`,
        MODELS.design,
      ),
    );
    return spec;
  },
};
