/**
 * Medals.
 *
 * A verdict is a yes or a no, and a yes-or-no is a puzzle you solve once and
 * then stop playing. A medal is a reason to go again: you landed it, but two
 * metres from the middle, and the middle is right there. Every retry is
 * another experiment, which is the whole point of the act.
 *
 * So a run is graded on how close the number it is judged on came to the
 * middle of the span that wins — and that span is *measured*, never written:
 *
 *   1. play the validated solution to the end;
 *   2. hold everything about where it ended fixed, and slide only the judged
 *      output up and down until `win` turns false on each side.
 *
 * That works for any spec without parsing its win expression. `stopX between
 * scaleNear and scaleFar` gives 96..104; `speedDrift within ±0.2` gives
 * -0.2..0.2. A win that does not hinge on the output alone — no edge on one
 * side or the other — has no band, and the act simply goes ungraded.
 */
import { Run, compile } from './expr.js';
import type { ExprScope } from './expr.js';
import type { ParamSpec, SimSpec } from './types.js';

export interface Band {
  from: number;
  to: number;
}

export type Medal = 'gold' | 'silver' | 'bronze';

export interface Grade {
  /** Inside the band: how near its middle, as a medal. Null outside it. */
  medal: Medal | null;
  /** Outside the band: by how much, signed — positive is past the top edge. Zero inside. */
  miss: number;
  /** 1 at the middle, 0 at either edge, negative outside. */
  closeness: number;
}

/** The middle third of the band is gold, the next ring silver, the rim bronze. */
const GOLD = 0.6;
const SILVER = 0.25;

/**
 * The span of `output` that wins, holding everything else about the solution's
 * finish fixed. Null when the solution does not win, the output is not in the
 * spec, or the output alone does not decide the verdict.
 */
export function winningBand(spec: SimSpec, params: ParamSpec[], output: string): Band | null {
  if (!(output in spec.outputs)) return null;

  const solution = Object.fromEntries(params.map((p) => [p.name, p.solution]));
  let scope: ExprScope;
  let centre: number;
  try {
    const run = new Run(spec, solution);
    while (run.step()) {
      // to the end
    }
    const result = run.finish();
    if (!result.won) return null;
    centre = result.outputs[output] ?? Number.NaN;
    scope = run.scope;
  } catch {
    return null;
  }
  if (!Number.isFinite(centre)) return null;

  const win = compile(spec.win);
  const wins = (value: number): boolean => {
    try {
      return win.evaluate({ ...scope, [output]: value }) !== 0;
    } catch {
      return false;
    }
  };

  const reach = Math.max(Math.abs(centre), 1) * 8;
  const edge = (direction: 1 | -1): number | null => {
    let inside = centre;
    let outside = centre + direction * reach;
    // Still winning that far out: this side has no edge, so the output is not
    // what the verdict turns on and a medal for it would be meaningless.
    if (wins(outside)) return null;
    for (let i = 0; i < 48; i++) {
      const mid = (inside + outside) / 2;
      if (wins(mid)) inside = mid;
      else outside = mid;
    }
    return inside;
  };

  const from = edge(-1);
  const to = edge(1);
  if (from === null || to === null || !(to > from)) return null;
  return { from, to };
}

/** Where `value` sits against `band`. Says nothing about whether the run won. */
export function gradeRun(value: number, band: Band): Grade {
  const mid = (band.from + band.to) / 2;
  const half = (band.to - band.from) / 2;
  const closeness = half > 0 ? 1 - Math.abs(value - mid) / half : value === mid ? 1 : -1;
  if (value > band.to) return { medal: null, miss: value - band.to, closeness };
  if (value < band.from) return { medal: null, miss: value - band.from, closeness };
  const medal: Medal = closeness >= GOLD ? 'gold' : closeness >= SILVER ? 'silver' : 'bronze';
  return { medal, miss: 0, closeness };
}
