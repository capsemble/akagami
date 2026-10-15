import type { Mechanic, SimSpec } from '@chapter-quest/shared';
import * as shared from '@chapter-quest/shared';

export interface SimOutcome {
  won: boolean;
  outputs: Record<string, number>;
}

export type FormulaMechanic = Extract<Mechanic, { type: 'formula' }>;

interface EvaluatorApi {
  simulate(spec: SimSpec, params: Record<string, number>): SimOutcome;
}

/**
 * The simulator lives in shared/expr.ts, which is still the placeholder. Until
 * it lands this returns null and the panel says so rather than inventing a
 * result — a physics act that lies about its physics is worse than one that
 * admits it is not wired up.
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
  return api.simulate(mechanic.spec, dials);
}

/** Where every dial starts: the act must begin unsolved. */
export function defaultDials(mechanic: FormulaMechanic): Record<string, number> {
  return Object.fromEntries(mechanic.params.map((p) => [p.name, p.default]));
}
