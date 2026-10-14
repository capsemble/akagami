/**
 * Gemini schemas have no map type and no discriminated unions, so the model
 * emits name/value pairs and a tagged object with optional branches. This turns
 * that wire shape into the types in shared/types.ts.
 */
import type { ActSpec, Mechanic, ParamSpec, RagAct, SimSpec } from '@chapter-quest/shared';

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
  type: 'formula' | 'ai-system' | 'qualitative';
  formula?: { spec: WireSimSpec; params: ParamSpec[] };
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

export function toMechanic(wire: WireMechanic): Mechanic {
  if (wire.type === 'formula') {
    if (!wire.formula)
      throw new Error('mechanic.type is "formula" but the formula branch is missing');
    return {
      type: 'formula',
      spec: toSimSpec(wire.formula.spec),
      params: wire.formula.params,
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
  return { ...wire, mechanic: toMechanic(wire.mechanic) };
}
