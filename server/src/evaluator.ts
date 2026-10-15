/**
 * Adapter over the expression evaluator in shared/expr.ts.
 *
 * The probe stays deliberately: if the evaluator is ever swapped or a build
 * ships without it, the formula checks in validate.ts report themselves as
 * skipped instead of crashing a design run.
 */
import type { ParamSpec, SimSpec } from '@chapter-quest/shared';

export interface SimResult {
  won: boolean;
  outputs: Record<string, number>;
}

export interface Evaluator {
  /** Throws if the expression does not parse. */
  compile(src: string): unknown;
  /** Free variables referenced by the expression. */
  variablesOf(src: string): string[];
  /** Run the sim once with these dial positions. */
  simulate(spec: SimSpec, params: Record<string, number>): SimResult;
  /** Fraction of random dial positions that win, 0..1. */
  randomWinRate(spec: SimSpec, params: ParamSpec[], samples?: number, seed?: number): number;
}

const REQUIRED = ['compile', 'variablesOf', 'simulate', 'randomWinRate'] as const;

let cached: Evaluator | null | undefined;

export async function loadEvaluator(): Promise<Evaluator | null> {
  if (cached !== undefined) return cached;
  const shared = (await import('@chapter-quest/shared')) as unknown as Record<string, unknown>;
  const complete = REQUIRED.every((name) => typeof shared[name] === 'function');
  cached = complete ? (shared as unknown as Evaluator) : null;
  return cached;
}

/** For tests: inject a stand-in so the formula checks can be exercised. */
export function setEvaluator(evaluator: Evaluator | null): void {
  cached = evaluator;
}
