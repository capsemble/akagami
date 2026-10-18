/**
 * What has been proved about an act, for the player to see.
 *
 * Every number here is recomputed from the act itself by the same functions
 * that judge the player's attempts — not read from a label a model wrote. The
 * one exception is the evidence judge's verdict on whether a citation
 * supports a rule, and that is reported as what it is: a model's reading,
 * with the model's name on it.
 */
import { evidenceWinRate } from './evidence.js';
import { randomWinRate, simulate } from './expr.js';
import { completionOf } from './mechanics.js';
import { judgeSequence, sequenceWinRate } from './sequence.js';
import type { ActStage, Mechanic } from './types.js';

export interface ProofCheck {
  label: string;
  ok: boolean;
}

export interface Citation {
  /** What the act asserts. */
  claim: string;
  /** The passages of the notes it rests on, verbatim. */
  quotes: string[];
}

export interface Proof {
  checks: ProofCheck[];
  /** Fraction of random attempts that win. */
  guessRate: number | null;
  citations: Citation[];
  /** The evidence judge's record, when the act has one. */
  judge?: { model: string; verdicts: number; checkedAt: string };
}

export function proofOf(act: { mechanic?: Mechanic; stage?: ActStage }): Proof | null {
  const m = act.mechanic;
  if (!m) return null;
  const finishable = completionOf(act);
  const checks: ProofCheck[] = [
    { label: 'A winning move exists, with the controls you have', ok: finishable.ok },
  ];
  let guessRate: number | null = null;
  let citations: Citation[] = [];

  if (m.type === 'formula') {
    const start = Object.fromEntries(m.params.map((p) => [p.name, p.default]));
    let startLoses = false;
    try {
      startLoses = !simulate(m.spec, start).won;
    } catch {
      startLoses = false;
    }
    checks.push({ label: 'The starting settings lose', ok: startLoses });
    try {
      guessRate = randomWinRate(m.spec, m.params, 200);
    } catch {
      guessRate = null;
    }
  } else if (m.type === 'sequence') {
    const start = judgeSequence(m, m.initial);
    checks.push({
      label: `The starting order breaks ${start.total - start.kept} of ${start.total} rules`,
      ok: !start.won,
    });
    guessRate = sequenceWinRate(m);
    const label = new Map(m.items.map((i) => [i.id, i.label]));
    citations = m.rules.map((r) => ({
      claim: `${label.get(r.before)} → ${label.get(r.after)}: ${r.why}`,
      quotes: r.evidence ?? [],
    }));
  } else if (m.type === 'evidence') {
    const linked = new Set(m.links.map((l) => l.evidence));
    const decoys = m.evidence.filter((e) => !linked.has(e.id)).length;
    checks.push({
      label: `Every claim has a document that proves it; ${decoys} decoy${decoys === 1 ? '' : 's'}`,
      ok: finishable.ok,
    });
    guessRate = evidenceWinRate(m);
    const claim = new Map(m.claims.map((c) => [c.id, c.text]));
    const doc = new Map(m.evidence.map((e) => [e.id, e]));
    citations = m.links.map((l) => ({
      claim: `“${doc.get(l.evidence)?.title}” proves: ${claim.get(l.claim)}`,
      quotes: [doc.get(l.evidence)?.excerpt ?? ''],
    }));
  }

  const grounding = m.type === 'sequence' || m.type === 'evidence' ? m.grounding : undefined;
  if (citations.length) {
    checks.push({
      label: `Every rule quotes your notes word for word (${citations.length})`,
      ok: citations.every((c) => c.quotes.length > 0 && c.quotes.every((q) => q.trim())),
    });
  }
  return {
    checks,
    guessRate,
    citations,
    ...(grounding
      ? {
          judge: {
            model: grounding.judge,
            verdicts: grounding.verdicts.length,
            checkedAt: grounding.checkedAt,
          },
        }
      : {}),
  };
}
