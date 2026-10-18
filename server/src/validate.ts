/**
 * The validator. Pure functions in, { ok, errors[] } out — no LLM anywhere near
 * it. An agent decides what the game should be; this decides whether it is
 * actually playable, and it is the only thing allowed to say no.
 *
 * Every error carries a path so a repair prompt can quote it back.
 */
import type {
  ActSpec,
  Concept,
  Curriculum,
  GameScript,
  Outline,
  SimSpec,
  Verb,
} from '@chapter-quest/shared';
import {
  GENERATED_MECHANICS,
  MIN_QUOTE_WORDS,
  quoteInSource,
  evidenceGroundingProblems,
  evidenceProblems,
  normaliseSource,
  sequenceGroundingProblems,
  sequenceProblems,
} from '@chapter-quest/shared';
import type { Evaluator } from './evaluator.js';
import { chapterRagProblems } from './corpus.js';
import { aboutRetrieval } from './routing.js';

export interface ValidationError {
  /** Where it went wrong, e.g. "acts[1].mechanic.params[0].default". */
  path: string;
  code: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: ValidationError[];
}

const VERBS: readonly Verb[] = [
  'drive',
  'aim_launch',
  'plant_marker',
  'interrogate',
  'deduction',
  'intercept',
  'tune',
  'arrange',
];

const MAX_DIALOGUE_LINES = 6;
const MAX_WORDS_PER_LINE = 25;
const MAX_WIN_RATE = 0.5;
const WIN_RATE_SAMPLES = 400;

const err = (path: string, code: string, message: string): ValidationError => ({
  path,
  code,
  message,
});

const result = (errors: ValidationError[]): ValidationResult => ({
  ok: errors.length === 0,
  errors,
});

function duplicates(ids: string[]): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) dupes.add(id);
    seen.add(id);
  }
  return [...dupes];
}

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

export function validateStructure(
  curriculum: Curriculum,
  outline: Outline,
  acts: ActSpec[],
): ValidationResult {
  const errors: ValidationError[] = [];

  for (const id of duplicates(curriculum.concepts.map((c) => c.id))) {
    errors.push(err('curriculum.concepts', 'duplicate-id', `concept id "${id}" used twice`));
  }
  for (const id of duplicates(outline.cast.map((c) => c.id))) {
    errors.push(err('outline.cast', 'duplicate-id', `cast id "${id}" used twice`));
  }
  for (const id of duplicates(acts.map((a) => a.id))) {
    errors.push(err('acts', 'duplicate-id', `act id "${id}" used twice`));
  }

  const conceptIds = new Set(curriculum.concepts.map((c) => c.id));
  const conceptById = new Map(curriculum.concepts.map((c) => [c.id, c]));
  const castNames = new Set(
    outline.cast.flatMap((c) => [c.id.toLowerCase(), c.name.toLowerCase()]),
  );

  for (const [i, concept] of curriculum.concepts.entries()) {
    for (const [j, req] of concept.requires.entries()) {
      if (!conceptIds.has(req)) {
        errors.push(
          err(
            `curriculum.concepts[${i}].requires[${j}]`,
            'unknown-concept',
            `requires "${req}", which is not a concept in this curriculum`,
          ),
        );
      }
    }
  }

  for (const [i, act] of outline.acts.entries()) {
    if (!conceptIds.has(act.conceptId)) {
      errors.push(
        err(
          `outline.acts[${i}].conceptId`,
          'unknown-concept',
          `outline act "${act.id}" points at concept "${act.conceptId}", which does not exist`,
        ),
      );
    }
  }

  for (const [i, act] of acts.entries()) {
    const at = `acts[${i}]`;
    const concept = conceptById.get(act.conceptId);

    if (!concept) {
      errors.push(
        err(
          `${at}.conceptId`,
          'unknown-concept',
          `act "${act.id}" points at concept "${act.conceptId}", which does not exist`,
        ),
      );
    }

    if (act.verbs.length === 0) {
      errors.push(err(`${at}.verbs`, 'no-verb', 'an act with no verb is not playable'));
    }
    for (const [j, verb] of act.verbs.entries()) {
      if (!VERBS.includes(verb)) {
        errors.push(err(`${at}.verbs[${j}]`, 'unknown-verb', `"${verb}" is not a known verb`));
      }
    }

    const { options, correctIndex, question } = act.prediction;
    if (!question.trim()) {
      errors.push(err(`${at}.prediction.question`, 'empty', 'prediction question is empty'));
    }
    if (options.length < 2) {
      errors.push(
        err(`${at}.prediction.options`, 'too-few-options', 'a prediction needs at least 2 options'),
      );
    }
    if (correctIndex < 0 || correctIndex >= options.length) {
      errors.push(
        err(
          `${at}.prediction.correctIndex`,
          'index-out-of-range',
          `correctIndex ${correctIndex} is outside 0..${options.length - 1}`,
        ),
      );
    }
    const normalised = options.map((o) => o.trim().toLowerCase());
    if (new Set(normalised).size !== options.length) {
      errors.push(
        err(`${at}.prediction.options`, 'duplicate-option', 'two prediction options are the same'),
      );
    }

    if (act.dialogue.length > MAX_DIALOGUE_LINES) {
      errors.push(
        err(
          `${at}.dialogue`,
          'too-long',
          `${act.dialogue.length} lines, max ${MAX_DIALOGUE_LINES}`,
        ),
      );
    }
    for (const [j, line] of act.dialogue.entries()) {
      const words = line.line.trim().split(/\s+/).filter(Boolean).length;
      if (words > MAX_WORDS_PER_LINE) {
        errors.push(
          err(
            `${at}.dialogue[${j}].line`,
            'line-too-long',
            `${words} words, max ${MAX_WORDS_PER_LINE}`,
          ),
        );
      }
      if (!castNames.has(line.speaker.trim().toLowerCase())) {
        errors.push(
          err(
            `${at}.dialogue[${j}].speaker`,
            'unknown-speaker',
            `"${line.speaker}" is not in the cast`,
          ),
        );
      }
    }

    for (const id of duplicates(act.scene.objects.map((o) => o.id))) {
      errors.push(err(`${at}.scene.objects`, 'duplicate-id', `scene object id "${id}" used twice`));
    }

    if (concept && !mechanicMatchesKind(act, concept)) {
      errors.push(
        err(
          `${at}.mechanic.type`,
          'mechanic-kind-mismatch',
          `concept "${concept.id}" is ${concept.kind} but the mechanic is ${act.mechanic.type}`,
        ),
      );
    }
  }

  return result(errors);
}

function mechanicMatchesKind(act: ActSpec, concept: Concept): boolean {
  return act.mechanic.type === concept.kind;
}

// ---------------------------------------------------------------------------
// Grounding — the quote has to really be in the chapter
// ---------------------------------------------------------------------------

/** Collapse whitespace, unify quote characters and dashes, lowercase. */
export function normaliseForQuoteSearch(text: string): string {
  // One normaliser for every citation the game checks, concept quotes and
  // act evidence alike: see shared/grounding.ts for what it forgives.
  return normaliseSource(text);
}

export function validateGrounding(curriculum: Curriculum, chapterText: string): ValidationResult {
  const haystack = normaliseForQuoteSearch(chapterText);
  const errors: ValidationError[] = [];

  for (const [i, concept] of curriculum.concepts.entries()) {
    const quote = normaliseForQuoteSearch(concept.quote);
    if (!quote) {
      errors.push(err(`curriculum.concepts[${i}].quote`, 'empty-quote', 'quote is empty'));
      continue;
    }
    if (!haystack.includes(quote)) {
      errors.push(
        err(
          `curriculum.concepts[${i}].quote`,
          'invented-concept',
          `quote is not in the chapter: "${concept.quote.slice(0, 80)}…"`,
        ),
      );
    }
  }

  return result(errors);
}

// ---------------------------------------------------------------------------
// Formula mechanics — the act has to be winnable, losable and not guessable
// ---------------------------------------------------------------------------

function knownVariables(spec: SimSpec, paramNames: string[]): Set<string> {
  return new Set([
    ...paramNames,
    ...Object.keys(spec.constants),
    ...Object.keys(spec.state),
    ...Object.keys(spec.outputs),
    'dt',
  ]);
}

export function validateFormulaMechanics(
  acts: ActSpec[],
  evaluator: Evaluator | null,
): ValidationResult {
  const errors: ValidationError[] = [];
  const formulaActs = acts
    .map((act, i) => ({ act, i }))
    .filter(({ act }) => act.mechanic.type === 'formula');

  if (formulaActs.length === 0) return result(errors);

  if (!evaluator) {
    // Not an error: shared/expr.ts has not landed yet. The design script says so.
    return result(errors);
  }

  for (const { act, i } of formulaActs) {
    if (act.mechanic.type !== 'formula') continue;
    const at = `acts[${i}].mechanic`;
    const { spec, params } = act.mechanic;
    const paramNames = params.map((p) => p.name);
    const known = knownVariables(spec, paramNames);

    const expressions: { path: string; src: string }[] = [
      ...Object.entries(spec.state).map(([k, v]) => ({ path: `${at}.spec.state.${k}`, src: v })),
      ...Object.entries(spec.step).map(([k, v]) => ({ path: `${at}.spec.step.${k}`, src: v })),
      ...Object.entries(spec.outputs).map(([k, v]) => ({
        path: `${at}.spec.outputs.${k}`,
        src: v,
      })),
      { path: `${at}.spec.win`, src: spec.win },
      ...(spec.until ? [{ path: `${at}.spec.until`, src: spec.until }] : []),
    ];

    let compiles = true;
    for (const { path, src } of expressions) {
      try {
        evaluator.compile(src);
      } catch (cause) {
        compiles = false;
        errors.push(
          err(path, 'expression-does-not-compile', `${src} — ${(cause as Error).message}`),
        );
        continue;
      }
      for (const variable of evaluator.variablesOf(src)) {
        if (!known.has(variable)) {
          errors.push(
            err(
              path,
              'unknown-variable',
              `"${variable}" is not a param, constant, state key or output`,
            ),
          );
        }
      }
    }

    for (const [j, param] of params.entries()) {
      if (param.min >= param.max) {
        errors.push(
          err(
            `${at}.params[${j}]`,
            'empty-range',
            `min ${param.min} is not below max ${param.max}`,
          ),
        );
      }
      for (const key of ['default', 'solution'] as const) {
        const value = param[key];
        if (value < param.min || value > param.max) {
          errors.push(
            err(
              `${at}.params[${j}].${key}`,
              'out-of-range',
              `${value} is outside ${param.min}..${param.max}`,
            ),
          );
        }
      }
    }

    if (!compiles || errors.some((e) => e.path.startsWith(`${at}.params`))) continue;

    const at_ = (key: 'default' | 'solution') =>
      Object.fromEntries(params.map((p) => [p.name, p[key]]));

    try {
      if (!evaluator.simulate(spec, at_('solution')).won) {
        errors.push(
          err(
            `${at}.params`,
            'solution-does-not-win',
            'the declared solution loses — the act is unwinnable',
          ),
        );
      }
    } catch (cause) {
      errors.push(err(`${at}.spec`, 'simulation-failed', (cause as Error).message));
      continue;
    }

    try {
      if (evaluator.simulate(spec, at_('default')).won) {
        errors.push(
          err(
            `${at}.params`,
            'default-already-wins',
            'the act is already solved before the player touches it',
          ),
        );
      }
    } catch (cause) {
      errors.push(err(`${at}.spec`, 'simulation-failed', (cause as Error).message));
      continue;
    }

    try {
      const rate = evaluator.randomWinRate(spec, params, WIN_RATE_SAMPLES);
      if (rate > MAX_WIN_RATE) {
        errors.push(
          err(
            `${at}`,
            'guessable',
            `guessable (${Math.round(rate * 100)}%) — random dial positions win more than ${Math.round(MAX_WIN_RATE * 100)}% of the time`,
          ),
        );
      }
    } catch (cause) {
      errors.push(err(`${at}.spec`, 'win-rate-failed', (cause as Error).message));
    }
  }

  return result(errors);
}

// ---------------------------------------------------------------------------
// ai-system mechanics
// ---------------------------------------------------------------------------

export function validateAiSystemMechanics(acts: ActSpec[], chapterText = ''): ValidationResult {
  const errors: ValidationError[] = [];

  for (const [i, act] of acts.entries()) {
    if (act.mechanic.type !== 'ai-system') continue;
    const at = `acts[${i}].mechanic`;
    if (!act.mechanic.goldFact.trim()) {
      errors.push(
        err(`${at}.goldFact`, 'empty-gold-fact', 'no gold fact, so nothing can be marked correct'),
      );
    }
    if (!act.mechanic.question.trim()) {
      errors.push(err(`${at}.question`, 'empty', 'the act asks the Oracle nothing'));
    }
    // An act played over the chapter itself: its answer has to be in the
    // chapter, word for word, and the lesson has to be one the corpus can
    // stage — torn chunks that really tear, a satchel that is really too full.
    const m = act.mechanic;
    if (m.corpus !== 'chapter') continue;
    if (!['chunking', 'topk', 'grounding'].includes(m.ragAct)) {
      errors.push(
        err(
          `${at}.ragAct`,
          'unsupported-rag-act',
          `"${m.ragAct}" has no lesson the game can measure`,
        ),
      );
      continue;
    }
    const quote = m.goldQuote ?? '';
    if (quote.split(/\s+/).filter(Boolean).length < MIN_QUOTE_WORDS) {
      errors.push(
        err(`${at}.goldQuote`, 'quote-too-short', 'the answering passage is missing or too short'),
      );
    } else if (!quoteInSource(quote, chapterText)) {
      errors.push(
        err(
          `${at}.goldQuote`,
          'evidence-not-in-source',
          `not found in the notes: "${quote.slice(0, 90)}"`,
        ),
      );
    }
    const facts = m.keyFacts ?? [];
    if (facts.length < 2 || facts.length > 4) {
      errors.push(
        err(`${at}.keyFacts`, 'key-fact-count', `${facts.length} key facts; 2 to 4 needed`),
      );
    }
    facts.forEach((fact, j) => {
      if (fact.split(/\s+/).length > 6) {
        errors.push(
          err(`${at}.keyFacts[${j}]`, 'key-fact-too-long', `"${fact}" is not a short phrase`),
        );
      } else if (!normaliseSource(quote).includes(normaliseSource(fact))) {
        errors.push(
          err(
            `${at}.keyFacts[${j}]`,
            'key-fact-not-in-quote',
            `"${fact}" is not in the answering passage`,
          ),
        );
      }
    });
    if (errors.some((e) => e.path.startsWith(at))) continue;
    for (const problem of chapterRagProblems(chapterText, m)) {
      errors.push(err(`${at}.keyFacts`, problem.code, problem.message));
    }
  }

  return result(errors);
}

// ---------------------------------------------------------------------------
// Sequence mechanics — the start loses, the solution wins, a guess usually loses
// ---------------------------------------------------------------------------

export function validateSequenceMechanics(acts: ActSpec[]): ValidationResult {
  const errors: ValidationError[] = [];
  for (const [i, act] of acts.entries()) {
    if (act.mechanic.type !== 'sequence') continue;
    for (const problem of sequenceProblems(act.mechanic)) {
      errors.push(err(`acts[${i}].mechanic.${problem.at}`, problem.code, problem.message));
    }
  }
  return result(errors);
}

export function validateEvidenceMechanics(acts: ActSpec[]): ValidationResult {
  const errors: ValidationError[] = [];
  for (const [i, act] of acts.entries()) {
    if (act.mechanic.type !== 'evidence') continue;
    for (const problem of evidenceProblems(act.mechanic)) {
      errors.push(err(`acts[${i}].mechanic.${problem.at}`, problem.code, problem.message));
    }
  }
  return result(errors);
}

// ---------------------------------------------------------------------------
// Citations — deterministic half of grounding
// ---------------------------------------------------------------------------

/**
 * Every sequence rule and every evidence document must quote the notes, and
 * the quote must really be there. This is the deterministic half of grounding
 * and it only proves the passages exist and are about the right things; what
 * they *mean* is checked by the evidence judge (pipeline/judge.ts), which is
 * a model and runs separately.
 */
export function validateCitations(acts: ActSpec[], chapterText: string): ValidationResult {
  const errors: ValidationError[] = [];
  for (const [i, act] of acts.entries()) {
    const problems =
      act.mechanic.type === 'sequence'
        ? sequenceGroundingProblems(act.mechanic, chapterText)
        : act.mechanic.type === 'evidence'
          ? evidenceGroundingProblems(act.mechanic, chapterText)
          : [];
    for (const problem of problems) {
      errors.push(err(`acts[${i}].mechanic.${problem.at}`, problem.code, problem.message));
    }
  }
  return result(errors);
}

// ---------------------------------------------------------------------------
// Runtime support — a generated act must be one the game can finish
// ---------------------------------------------------------------------------

/**
 * The backstop behind routing.ts. A generated act whose mechanic the runtime
 * cannot judge is rejected here, so it can never reach a player as a room with
 * a gate that will not open. Retrieval acts are named separately when the
 * concept is not about retrieval at all: that is the misrouting that sent a
 * computer-vision chapter to the Oracle's canned RAG panel.
 */
export function validateRuntimeSupport(curriculum: Curriculum, acts: ActSpec[]): ValidationResult {
  const errors: ValidationError[] = [];
  const conceptById = new Map(curriculum.concepts.map((c) => [c.id, c]));
  for (const [i, act] of acts.entries()) {
    const type = act.mechanic.type;
    if (GENERATED_MECHANICS.includes(type)) continue;
    const concept = conceptById.get(act.conceptId);
    // A retrieval act on a real corpus: the prepared Oracle's, or the chapter
    // itself — but only for a concept that is about retrieval.
    if (
      act.mechanic.type === 'ai-system' &&
      act.mechanic.corpus &&
      (!concept || aboutRetrieval(concept))
    ) {
      continue;
    }
    if (type === 'ai-system' && concept && !aboutRetrieval(concept)) {
      errors.push(
        err(
          `acts[${i}].mechanic.type`,
          'misrouted-rag',
          `concept "${concept.id}" is not about retrieval, so a RAG act would teach the wrong thing`,
        ),
      );
      continue;
    }
    errors.push(
      err(
        `acts[${i}].mechanic.type`,
        'unsupported-mechanic',
        `"${type}" acts cannot be finished in a generated world; use ${GENERATED_MECHANICS.join(' or ')}`,
      ),
    );
  }
  return result(errors);
}

// ---------------------------------------------------------------------------
// Content — claims we refuse to teach, and analogies with no edge
// ---------------------------------------------------------------------------

export interface BannedClaim {
  pattern: RegExp;
  why: string;
}

/**
 * Per-subject claims that are popular, wrong, and sticky. Keyed by the subject
 * the curriculum agent reports; matched loosely against subject strings.
 */
export const BANNED_CLAIMS: Record<string, BannedClaim[]> = {
  quantum: [
    {
      pattern: /consciousness\s+(causes|collapses|triggers)/i,
      why: 'consciousness does not cause wavefunction collapse',
    },
    {
      pattern:
        /entangle\w*[^.]{0,60}(faster than light|ftl|send\w*\s+(a\s+)?signal|instant\w*\s+communicat)/i,
      why: 'entanglement cannot send signals faster than light',
    },
    {
      pattern: /observer\s+(means|is|must be)\s+(a\s+)?(human|conscious|person)/i,
      why: '"observer" means any interaction that records information, not a person',
    },
  ],
};

function bannedClaimsFor(subject: string): BannedClaim[] {
  const key = Object.keys(BANNED_CLAIMS).find((k) => subject.toLowerCase().includes(k));
  return key ? (BANNED_CLAIMS[key] ?? []) : [];
}

export function validateContent(curriculum: Curriculum, acts: ActSpec[]): ValidationResult {
  const errors: ValidationError[] = [];
  const banned = bannedClaimsFor(curriculum.subject);

  for (const [i, act] of acts.entries()) {
    const at = `acts[${i}]`;

    if (!act.analogy.breaksWhere.trim()) {
      errors.push(
        err(
          `${at}.analogy.breaksWhere`,
          'analogy-has-no-edge',
          'every analogy must say where it stops being true',
        ),
      );
    }

    const prose: { path: string; text: string }[] = [
      { path: `${at}.goal`, text: act.goal },
      { path: `${at}.explainAfter`, text: act.explainAfter },
      { path: `${at}.analogy.text`, text: act.analogy.text },
      ...act.dialogue.map((d, j) => ({ path: `${at}.dialogue[${j}].line`, text: d.line })),
    ];

    for (const { path, text } of prose) {
      for (const claim of banned) {
        if (claim.pattern.test(text)) {
          errors.push(err(path, 'banned-claim', claim.why));
        }
      }
    }
  }

  for (const [i, concept] of curriculum.concepts.entries()) {
    for (const claim of banned) {
      if (claim.pattern.test(concept.keyRule)) {
        errors.push(err(`curriculum.concepts[${i}].keyRule`, 'banned-claim', claim.why));
      }
    }
  }

  return result(errors);
}

// ---------------------------------------------------------------------------
// Everything, in one call
// ---------------------------------------------------------------------------

export interface ValidateScriptInput {
  script: Pick<GameScript, 'curriculum' | 'outline' | 'acts'>;
  chapterText: string;
  evaluator: Evaluator | null;
}

export function validateScript({
  script,
  chapterText,
  evaluator,
}: ValidateScriptInput): ValidationResult {
  const { curriculum, outline, acts } = script;
  return result([
    ...validateStructure(curriculum, outline, acts).errors,
    ...validateGrounding(curriculum, chapterText).errors,
    ...validateFormulaMechanics(acts, evaluator).errors,
    ...validateAiSystemMechanics(acts, chapterText).errors,
    ...validateSequenceMechanics(acts).errors,
    ...validateEvidenceMechanics(acts).errors,
    ...validateCitations(acts, chapterText).errors,
    ...validateRuntimeSupport(curriculum, acts).errors,
    ...validateContent(curriculum, acts).errors,
  ]);
}
