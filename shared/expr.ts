/**
 * Placeholder for the safe expression evaluator used to score player actions
 * against an act's win condition (e.g. "k >= 3 && rerank").
 *
 * TODO(hrutik): drop in the tested evaluator. Until then this throws loudly so
 * nothing silently depends on a fake result.
 */
export interface ExprScope {
  [key: string]: number | boolean | string;
}

export function evaluateExpr(_expr: string, _scope: ExprScope): boolean {
  throw new Error('evaluateExpr: not implemented yet — tested evaluator lands in a follow-up PR');
}
