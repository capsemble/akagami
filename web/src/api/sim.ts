import type { Mechanic, SimSample, SimSpec } from '@chapter-quest/shared';
import * as shared from '@chapter-quest/shared';

export interface SimOutcome {
  won: boolean;
  outputs: Record<string, number>;
  /** The path the run took, for the plot. */
  samples: SimSample[];
}

export type FormulaMechanic = Extract<Mechanic, { type: 'formula' }>;

interface EvaluatorApi {
  simulate(
    spec: SimSpec,
    params: Record<string, number>,
    options?: { trace?: boolean | number },
  ): SimOutcome;
}

/**
 * The simulator lives in shared/expr.ts. This stays a lookup rather than a
 * direct import so the panel degrades to "not wired up" instead of crashing if
 * the evaluator is ever swapped out — a physics act that lies about its physics
 * is worse than one that admits it is not running.
 */
export function evaluator(): EvaluatorApi | null {
  const candidate = shared as unknown as Partial<EvaluatorApi>;
  return typeof candidate.simulate === 'function' ? (candidate as EvaluatorApi) : null;
}

export const SIM_AVAILABLE = evaluator() !== null;

export function runSim(
  mechanic: FormulaMechanic,
  dials: Record<string, number>,
): SimOutcome | null {
  const api = evaluator();
  if (!api) return null;
  // Trace on: the plot is the point, the number is the footnote.
  return api.simulate(mechanic.spec, dials, { trace: true });
}

/** Where every dial starts: the act must begin unsolved. */
export function defaultDials(mechanic: FormulaMechanic): Record<string, number> {
  return Object.fromEntries(mechanic.params.map((p) => [p.name, p.default]));
}
