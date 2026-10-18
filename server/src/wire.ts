/**
 * Gemini schemas have no map type and no discriminated unions, so the model
 * emits name/value pairs and a tagged object with optional branches. This turns
 * that wire shape into the types in shared/types.ts.
 */
import type {
  ActSpec,
  EvidenceClaim,
  Mechanic,
  ParamSpec,
  RagAct,
  SequenceItem,
  SequenceRule,
  SimSpec,
} from '@chapter-quest/shared';
import { startingOrder } from '@chapter-quest/shared';
import { RAG_START } from './corpus.js';

export interface NamedValue {
  name: string;
  value: number;
}

export interface NamedExpr {
  name: string;
  expr: string;
}

export interface WireSimSpec {
  constants: NamedValue[];
  state: NamedExpr[];
  step: NamedExpr[];
  outputs: NamedExpr[];
  win: string;
  dt: number;
  maxTime: number;
  until?: string;
}

export interface WireMechanic {
  type: 'formula' | 'sequence' | 'evidence' | 'ai-system' | 'qualitative';
  formula?: { spec: WireSimSpec; params: ParamSpec[] };
  /** No `initial`: where the cards start is decided by `startingOrder`, not the model. */
  sequence?: { prompt: string; items: SequenceItem[]; rules: SequenceRule[]; solution: string[] };
  evidence?: {
    prompt: string;
    claims: EvidenceClaim[];
    documents: { id: string; title: string; excerpt: string; shows: string }[];
    links: { claim: string; document: string; why: string }[];
  };
  aiSystem?: {
    ragAct: RagAct;
    question: string;
    goldFact: string;
    goldQuote?: string;
    keyFacts?: string[];
    silentOn?: string;
  };
  qualitative?: { mustShow: string[]; misconceptions: string[] };
}

export type WireAct = Omit<ActSpec, 'mechanic'> & { mechanic: WireMechanic };

const numbers = (pairs: NamedValue[] = []): Record<string, number> =>
  Object.fromEntries(pairs.map((p) => [p.name, p.value]));

const exprs = (pairs: NamedExpr[] = []): Record<string, string> =>
  Object.fromEntries(pairs.map((p) => [p.name, p.expr]));

export function toSimSpec(wire: WireSimSpec): SimSpec {
  return {
    constants: numbers(wire.constants),
    state: exprs(wire.state),
    step: exprs(wire.step),
    outputs: exprs(wire.outputs),
    win: wire.win,
    dt: wire.dt,
    maxTime: wire.maxTime,
    ...(wire.until ? { until: wire.until } : {}),
  };
}

/** `seed` keeps a sequence act's starting order stable across rebuilds: the act id. */
export function toMechanic(wire: WireMechanic, seed = ''): Mechanic {
  if (wire.type === 'formula') {
    if (!wire.formula)
      throw new Error('mechanic.type is "formula" but the formula branch is missing');
    return {
      type: 'formula',
      spec: toSimSpec(wire.formula.spec),
      params: wire.formula.params,
    };
  }
  if (wire.type === 'sequence') {
    if (!wire.sequence)
      throw new Error('mechanic.type is "sequence" but the sequence branch is missing');
    const { prompt, items, rules, solution } = wire.sequence;
    return {
      type: 'sequence',
      prompt,
      items: items.map(({ id, label, detail }) => ({
        id,
        label,
        ...(detail?.trim() ? { detail } : {}),
      })),
      // Only the fields a rule has: a model cannot smuggle in its own verdict.
      rules: rules.map(({ before, after, why, evidence }) => ({
        before,
        after,
        why,
        evidence: evidence ?? [],
      })),
      initial: startingOrder({ rules, solution }, seed),
      solution,
    };
  }
  if (wire.type === 'evidence') {
    if (!wire.evidence)
      throw new Error('mechanic.type is "evidence" but the evidence branch is missing');
    const { prompt, claims, documents, links } = wire.evidence;
    return {
      type: 'evidence',
      prompt,
      claims: claims.map(({ id, text }) => ({ id, text })),
      evidence: documents.map(({ id, title, excerpt, shows }) => ({ id, title, excerpt, shows })),
      links: links.map(({ claim, document, why }) => ({ claim, evidence: document, why })),
    };
  }
  if (wire.type === 'ai-system') {
    if (!wire.aiSystem)
      throw new Error('mechanic.type is "ai-system" but the aiSystem branch is missing');
    // A generated retrieval act is always played over the chapter it came
    // from, starting broken in the way its lesson is about. The model names
    // neither: the corpus and the start are the harness's, never the model's.
    const { ragAct, question, goldFact, goldQuote, keyFacts, silentOn } = wire.aiSystem;
    const lesson =
      ragAct === 'chunking' || ragAct === 'topk' || ragAct === 'grounding' ? ragAct : null;
    return {
      type: 'ai-system',
      ragAct,
      question,
      goldFact,
      ...(lesson ? { corpus: 'chapter' as const, start: RAG_START[lesson] } : {}),
      ...(goldQuote ? { goldQuote } : {}),
      ...(keyFacts?.length ? { keyFacts } : {}),
      ...(silentOn?.trim() ? { silentOn } : {}),
    };
  }
  if (!wire.qualitative)
    throw new Error('mechanic.type is "qualitative" but the branch is missing');
  return { type: 'qualitative', rubric: wire.qualitative };
}

export function toActSpec(wire: WireAct): ActSpec {
  return { ...wire, mechanic: toMechanic(wire.mechanic, wire.id) };
}

/**
 * ActSpec → the wire shape the model writes. The inverse of `toActSpec`, so a
 * drafted act can be handed back to the model to revise in its own format.
 * What the harness adds after the model — a sequence's computed start, a
 * grounding record — is left out: the model never writes those.
 */
export function toWireAct(spec: ActSpec): WireAct {
  const m = spec.mechanic;
  let mechanic: WireMechanic;
  if (m.type === 'formula') {
    mechanic = {
      type: 'formula',
      formula: {
        spec: {
          constants: Object.entries(m.spec.constants).map(([name, value]) => ({ name, value })),
          state: Object.entries(m.spec.state).map(([name, expr]) => ({ name, expr })),
          step: Object.entries(m.spec.step).map(([name, expr]) => ({ name, expr })),
          outputs: Object.entries(m.spec.outputs).map(([name, expr]) => ({ name, expr })),
          win: m.spec.win,
          dt: m.spec.dt,
          maxTime: m.spec.maxTime,
          ...(m.spec.until ? { until: m.spec.until } : {}),
        },
        params: m.params,
      },
    };
  } else if (m.type === 'sequence') {
    mechanic = {
      type: 'sequence',
      sequence: { prompt: m.prompt, items: m.items, rules: m.rules, solution: m.solution },
    };
  } else if (m.type === 'evidence') {
    mechanic = {
      type: 'evidence',
      evidence: {
        prompt: m.prompt,
        claims: m.claims,
        documents: m.evidence,
        links: m.links.map((l) => ({ claim: l.claim, document: l.evidence, why: l.why })),
      },
    };
  } else if (m.type === 'ai-system') {
    mechanic = {
      type: 'ai-system',
      aiSystem: {
        ragAct: m.ragAct,
        question: m.question,
        goldFact: m.goldFact,
        ...(m.goldQuote ? { goldQuote: m.goldQuote } : {}),
        ...(m.keyFacts ? { keyFacts: m.keyFacts } : {}),
        ...(m.silentOn ? { silentOn: m.silentOn } : {}),
      },
    };
  } else {
    mechanic = { type: 'qualitative', qualitative: m.rubric };
  }
  return { ...spec, mechanic };
}
