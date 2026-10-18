/**
 * The play-tester: an act that failed the game's checks is handed back to
 * Gemini together with the game itself.
 *
 * A one-shot repair hands the model a list of errors and hopes. Most of the
 * errors that survive one are ones a model cannot fix by reading: a quotation
 * that is almost, but not exactly, in the notes; a solution that does not win
 * by a tenth of a metre; a starting order that happens to break nothing. So
 * the model gets the machinery that found them, as tools:
 *
 *   play           runs the act's own simulator or judge on a move it chooses —
 *                  does my solution win? does my start lose?
 *   find_in_notes  searches the student's notes and returns passages exactly
 *                  as written, so a quotation can be copied rather than recalled
 *   revise         submits a corrected act to the real validator; the loop
 *                  ends the moment one passes
 *
 * Nothing the model writes is executed. Tools take plain data — numbers, ids,
 * text — and every one of them is the same code that judges the player.
 */
import type {
  ActSpec,
  AgentEvent,
  Concept,
  Curriculum,
  Outline,
  OutlineAct,
} from '@chapter-quest/shared';
import {
  judgeEvidence,
  judgeSequence,
  quoteInSource,
  sharedTerms,
  simulate,
} from '@chapter-quest/shared';
import { Type } from '@google/genai';
import type { Evaluator } from '../evaluator.js';
import { runTools } from '../gemini.js';
import type { Tool } from '../gemini.js';
import { ACT_SCHEMA } from '../schemas.js';
import { validateScript } from '../validate.js';
import type { ValidationError } from '../validate.js';
import { toActSpec, toWireAct } from '../wire.js';
import type { WireAct } from '../wire.js';
import { event } from './agents.js';

export const PLAY_TESTER = 'Play-tester';
const MAX_TURNS = 6;

export interface PlaytestInput {
  outline: Outline;
  curriculum: Curriculum;
  concept: Concept;
  plan: OutlineAct;
  draft: ActSpec;
  errors: ValidationError[];
  notes: string;
  evaluator: Evaluator | null;
}

export interface PlaytestResult {
  /** The last draft the model revised to, or null if it never revised. */
  spec: ActSpec | null;
  passed: boolean;
  turns: number;
  calls: number;
}

/** Passages of the notes, as written: sentences and short lines. */
export function passagesOf(notes: string): string[] {
  return notes
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[.!?])\s+(?=[A-Z0-9"“*-])/))
    .map((p) => p.trim())
    .filter((p) => p.split(/\s+/).length >= 4);
}

export function findInNotes(
  text: string,
  notes: string,
): { verbatim: boolean; passages: string[] } {
  const ranked = passagesOf(notes)
    .map((p) => ({ p, score: sharedTerms(text, p) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((r) => r.p);
  return { verbatim: quoteInSource(text, notes), passages: ranked };
}

/** The validator, on one act: only the errors that belong to it, paths made local. */
export function checkAct(
  spec: ActSpec,
  input: Pick<PlaytestInput, 'outline' | 'curriculum' | 'notes' | 'evaluator'>,
): ValidationError[] {
  const result = validateScript({
    script: { curriculum: input.curriculum, outline: input.outline, acts: [spec] },
    chapterText: input.notes,
    evaluator: input.evaluator,
  });
  return result.errors
    .filter((e) => e.path.startsWith('acts[0]'))
    .map((e) => ({ ...e, path: e.path.replace(/^acts\[0\]\.?/, '') || 'act' }));
}

/** One move on the current draft, judged by the code that judges players. */
export function playMove(spec: ActSpec | null, args: Record<string, unknown>): unknown {
  if (!spec) return { error: 'There is no draft yet. Call revise with your act first.' };
  const m = spec.mechanic;
  if (m.type === 'formula') {
    const given = Array.isArray(args.settings) ? args.settings : [];
    const settings = Object.fromEntries(
      m.params.map((p) => {
        const hit = given.find((s: { name?: unknown }) => s?.name === p.name) as
          { value?: unknown } | undefined;
        return [p.name, typeof hit?.value === 'number' ? hit.value : p.default];
      }),
    );
    const run = simulate(m.spec, settings);
    return { settings, won: run.won, outputs: run.outputs };
  }
  if (m.type === 'sequence') {
    const order = Array.isArray(args.order) ? args.order.map(String) : m.initial;
    const judged = judgeSequence(m, order);
    return {
      order,
      won: judged.won,
      rulesKept: `${judged.kept} of ${judged.total}`,
      broken: judged.broken.map((r) => `${r.before} must come before ${r.after}`),
      ...(judged.invalid ? { invalid: judged.invalid } : {}),
    };
  }
  if (m.type === 'evidence') {
    const pins = Object.fromEntries(
      (Array.isArray(args.pins) ? args.pins : []).map(
        (p: { document?: unknown; claim?: unknown }) => [String(p?.document), String(p?.claim)],
      ),
    );
    const judged = judgeEvidence(m, pins);
    return {
      won: judged.won,
      backed: `${judged.backed} of ${judged.total}`,
      wrong: judged.wrong,
      empty: judged.empty,
    };
  }
  return { error: `a ${m.type} act cannot be played here` };
}

const PLAY_PARAMS = {
  type: Type.OBJECT,
  properties: {
    settings: {
      type: Type.ARRAY,
      description: 'Formula acts: a value for each dial. Dials left out stay at their default.',
      items: {
        type: Type.OBJECT,
        properties: { name: { type: Type.STRING }, value: { type: Type.NUMBER } },
        required: ['name', 'value'],
      },
    },
    order: {
      type: Type.ARRAY,
      description: 'Sequence acts: every card id, in the order to test.',
      items: { type: Type.STRING },
    },
    pins: {
      type: Type.ARRAY,
      description: 'Evidence acts: which document is pinned to which claim.',
      items: {
        type: Type.OBJECT,
        properties: { document: { type: Type.STRING }, claim: { type: Type.STRING } },
        required: ['document', 'claim'],
      },
    },
  },
};

const SYSTEM = `You are the play-tester for Chapter Quest, an educational game built from a
student's notes. An act you are given failed the game's checks. You have the
game itself as tools:

- play: run the act's own simulator or judge on a move. Use it to confirm the
  declared solution really wins and the starting position really loses.
- find_in_notes: search the student's notes. It returns passages exactly as
  written. Every quotation in the act must be copied from what it returns,
  character for character — never retyped from memory.
- revise: submit the whole corrected act to the game's validator. It answers
  with the errors that remain, or ok.

Fix exactly what the errors say and change nothing else: keep the act's id,
concept, story, cast and scene. You have ${MAX_TURNS} turns and can call several
tools in one turn. For every quotation the checks rejected, the closest real
passages are already listed below — copy from those. Work like this:
  turn 1 — play the moves the errors are about, if any; search only for what
           is not already listed;
  turn 2 — call revise with the whole corrected act;
  then   — if revise lists errors, fix exactly those and revise again.
Searching is never the goal: revise early. When revise answers ok you are done.`;

/**
 * Hand a failed act to Gemini with the game as tools. Never throws: a dead
 * model or a loop that runs out of turns returns what it had, and the
 * pipeline carries on exactly as it would have without a play-tester.
 */
export async function playtest(
  input: PlaytestInput,
  emit: (e: AgentEvent) => void,
  run: typeof runTools = runTools,
): Promise<PlaytestResult> {
  const { plan, draft } = input;
  let current: ActSpec | null = null;
  let passed = false;
  let used = 0;
  /** Every result carries the budget, and past half of it, the instruction to revise. */
  const budget = (result: object) => {
    used++;
    const left = MAX_TURNS * 2 - used;
    return {
      ...result,
      budget:
        left <= MAX_TURNS
          ? 'Stop testing and searching: call revise with the corrected act now.'
          : `${left} tool calls left.`,
    };
  };
  const say = (kind: AgentEvent['kind'], message: string) =>
    emit(event(PLAY_TESTER, kind, `${plan.id}: ${message}`));

  const tools: Tool[] = [
    {
      name: 'play',
      description:
        'Run the current draft with a move and report whether it wins. Formula acts take settings; sequence acts take an order of card ids; evidence acts take pins.',
      parameters: PLAY_PARAMS,
      run: (args) => {
        const result = playMove(current ?? draft, args) as { won?: boolean };
        say(
          'progress',
          `played a move — ${result.won === undefined ? 'no result' : result.won ? 'it wins' : 'it loses'}.`,
        );
        return budget(result);
      },
    },
    {
      name: 'find_in_notes',
      description:
        "Search the student's notes. Returns whether the text is already verbatim, and the closest passages exactly as written.",
      parameters: {
        type: Type.OBJECT,
        properties: { text: { type: Type.STRING, description: 'What to look for.' } },
        required: ['text'],
      },
      run: (args) => {
        const found = findInNotes(String(args.text ?? ''), input.notes);
        say(
          'progress',
          `searched the notes for "${String(args.text ?? '').slice(0, 50)}" — ${found.verbatim ? 'already verbatim' : `${found.passages.length} passage(s)`}.`,
        );
        return budget(found);
      },
    },
    {
      name: 'revise',
      description:
        'Submit the whole corrected act to the validator. Returns ok, or the errors that remain.',
      parameters: {
        type: Type.OBJECT,
        properties: { act: ACT_SCHEMA },
        required: ['act'],
      },
      run: (args) => {
        let spec: ActSpec;
        try {
          // The act stays the act it was planned as, whatever the model sends.
          spec = toActSpec({ ...(args.act as WireAct), id: plan.id, conceptId: plan.conceptId });
        } catch (err) {
          return { ok: false, errors: [err instanceof Error ? err.message : String(err)] };
        }
        current = spec;
        const errors = checkAct(spec, input);
        passed = errors.length === 0;
        say(
          passed ? 'done' : 'progress',
          passed
            ? 'the revised act passes the game’s checks.'
            : `revised — ${errors.length} problem(s) left.`,
        );
        return passed
          ? { ok: true }
          : {
              ok: false,
              errors: errors.slice(0, 12).map((e) => `[${e.path}] ${e.code}: ${e.message}`),
            };
      },
    },
  ];

  say('start', `play-testing a draft that failed ${input.errors.length} check(s).`);
  // The search the model most needs, done for it: for every quotation the
  // validator could not find, the closest passages that really are there.
  /** The text an error path points at, in the draft. Paths use the act's own names. */
  const quoted = (path: string): string | undefined => {
    const keys = path
      .replace(/^acts\[\d+\]\./, '')
      .split(/\.|\[(\d+)\]/)
      .filter((k): k is string => k !== undefined && k !== '');
    const value = keys.reduce<unknown>(
      (at, key) => (at as Record<string, unknown> | undefined)?.[key],
      draft as unknown,
    );
    return typeof value === 'string' ? value : undefined;
  };
  const leads = input.errors
    .filter((e) => e.code === 'evidence-not-in-source' || e.code === 'quote-too-short')
    .flatMap((e) => {
      const text = quoted(
        e.path.replace(/\.mechanic\./, '.mechanic.').replace(/^mechanic\./, 'mechanic.'),
      );
      if (!text) return [];
      const found = findInNotes(text, input.notes);
      return [
        `- for [${e.path}] "${text.slice(0, 80)}":`,
        ...found.passages.map((p) => `    "${p}"`),
      ];
    });

  const prompt = [
    `CONCEPT: ${input.concept.name} — ${input.concept.keyRule}`,
    '',
    'THE CHECKS IT FAILED:',
    ...input.errors.map((e) => `- [${e.path}] ${e.code}: ${e.message}`),
    ...(leads.length
      ? ['', 'CLOSEST REAL PASSAGES IN THE NOTES (copy from these):', ...leads]
      : []),
    '',
    'THE ACT, AS DRAFTED:',
    JSON.stringify(toWireAct(draft), null, 1),
  ].join('\n');

  try {
    const loop = await run(prompt, tools, {
      role: 'text',
      systemInstruction: SYSTEM,
      maxTurns: MAX_TURNS,
      done: () => passed,
    });
    if (!passed)
      say(
        'rejected',
        `still failing after ${loop.turns} turn(s); the pipeline takes it from here.`,
      );
    return { spec: current, passed, turns: loop.turns, calls: loop.calls };
  } catch (err) {
    say(
      'fallback',
      `play-tester unavailable (${err instanceof Error ? err.message.slice(0, 80) : err}).`,
    );
    return { spec: current, passed, turns: 0, calls: 0 };
  }
}
