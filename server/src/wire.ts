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
  aiSystem?: { ragAct: RagAct; question: string; goldFact: string };
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
    return {
      type: 'ai-system',
      ragAct: wire.aiSystem.ragAct,
      question: wire.aiSystem.question,
      goldFact: wire.aiSystem.goldFact,
    };
  }
  if (!wire.qualitative)
    throw new Error('mechanic.type is "qualitative" but the branch is missing');
  return { type: 'qualitative', rubric: wire.qualitative };
}

export function toActSpec(wire: WireAct): ActSpec {
  return { ...wire, mechanic: toMechanic(wire.mechanic, wire.id) };
}
