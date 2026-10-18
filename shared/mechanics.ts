/**
 * The mechanic contract: what each kind of act declares, and whether the
 * runtime can actually finish it.
 *
 * The schema already says most of it — a mechanic is a tagged union, and each
 * branch carries its own starting state, rules and win condition. What was
 * missing was the question nobody asked until a world shipped a gate that
 * could never open: *can a player get through this act with what the game
 * gives them?* `completionOf` answers it, from the act alone, by running the
 * same code the player's attempt is judged by. The audit, the world builder
 * and the tests all ask it here, so there is one answer.
 *
 * Per mechanic, as declared in shared/types.ts:
 *
 *   formula     objective: the concept's key rule
 *               initial:   each param's `default` (must lose)
 *               actions:   whatever the stage binds — marker, needle, aim, held
 *                          control — or sliders in the panel when unstaged
 *               rules:     the SimSpec, stepped by shared/expr.ts
 *               success:   `win`, evaluated on the finished run
 *               failure:   `win` false; the readout says by how much
 *               feedback:  `beat`, `explainAfter`, the readout and the trace
 *               reset:     R in the scene puts every dial back to its default
 *
 *   sequence    objective: the concept's key rule
 *               initial:   `initial` (must break a rule)
 *               actions:   move or swap cards, check, reset (shared/sequence.ts)
 *               rules:     `rules`, each one "before comes before after"
 *               success:   an order that breaks no rule
 *               failure:   any broken rule; the earliest one's `why` is shown
 *               feedback:  rules kept out of total, the broken rule's reason,
 *                          and `explainAfter` once it lands
 *               reset:     back to `initial`; a solved act stays solved
 *
 *   evidence    objective: the concept's key rule
 *               initial:   every document on the table, nothing pinned
 *               actions:   pin a document to a claim, unpin, check, reset
 *                          (shared/evidence.ts)
 *               rules:     `links`, each one "this document backs this claim"
 *               success:   every claim backed, and no pin that is not a link
 *               failure:   a wrong pin — feedback says what that document
 *                          does show, not where it belongs — or an empty claim
 *               feedback:  claims backed out of total, then `explainAfter`
 *               reset:     everything back on the table; solved stays solved
 *
 *   Sequence and evidence acts also carry citations: every rule and every
 *   document quotes the notes, checked verbatim and then by a model judge
 *   (shared/grounding.ts, server/src/pipeline/judge.ts). Grounding decides
 *   whether an act may be built; it is not part of whether it can be finished.
 *
 *   ai-system   playable only against the canned Oracle table (`corpus:
 *               'fixture'`): the panel's judge marks the answer correct.
 *               A corpus built from the chapter does not exist yet.
 *
 *   qualitative not playable. The rubric is free text with no judge that is
 *               not itself a model's opinion, and a gate opened on a model's
 *               say-so is not a completion condition.
 *
 * Progression is the same for all of them: winning marks the act solved,
 * which opens the gate, and walking through it is the next act.
 */
import { simulate } from './expr.js';
import { evidenceProblems } from './evidence.js';
import { sequenceProblems } from './sequence.js';
import type { ActStage, Mechanic, ParamBinding } from './types.js';

export type Completion =
  /** A player can finish it, and `how` says with what. */
  | { ok: true; how: string }
  /** It cannot be finished. `unsupported` means no runtime plays this kind at all. */
  | { ok: false; unsupported: boolean; reason: string };

/** Mechanic kinds the runtime can play in a world built from a chapter. */
export const GENERATED_MECHANICS: readonly Mechanic['type'][] = ['formula', 'sequence', 'evidence'];

const boundParams = (bindings: ParamBinding[]): Set<string> =>
  new Set(bindings.flatMap((b) => (b.kind === 'aim' ? [b.paramX, b.paramY] : [b.param])));

/**
 * Can this act be finished by a player, with the controls it actually has?
 * Never throws: a mechanic that will not evaluate is an act that cannot be won.
 */
export function completionOf(act: { mechanic?: Mechanic; stage?: ActStage }): Completion {
  const mechanic = act.mechanic;
  if (!mechanic) {
    return {
      ok: false,
      unsupported: true,
      reason: 'the act has no mechanic, so nothing can win it',
    };
  }

  switch (mechanic.type) {
    case 'formula': {
      // A staged act is played only through its bindings; a param the stage
      // left unbound stays at its default for the whole act. An unstaged act
      // opens the slider panel, which reaches every param.
      const reach = act.stage ? boundParams(act.stage.bindings) : null;
      const frozen = mechanic.params.filter(
        (p) => reach && !reach.has(p.name) && p.default !== p.solution,
      );
      if (frozen.length > 0) {
        return {
          ok: false,
          unsupported: false,
          reason: `no control reaches ${frozen.map((p) => p.name).join(', ')}, and the act needs them moved`,
        };
      }
      const settings = Object.fromEntries(
        mechanic.params.map((p) => [p.name, !reach || reach.has(p.name) ? p.solution : p.default]),
      );
      try {
        if (!simulate(mechanic.spec, settings).won) {
          return { ok: false, unsupported: false, reason: 'the declared solution does not win' };
        }
      } catch (err) {
        return {
          ok: false,
          unsupported: false,
          reason: `the simulation will not run: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      const dials = reach ? reach.size : mechanic.params.length;
      return { ok: true, how: `${dials}/${mechanic.params.length} dials reach the solution` };
    }

    case 'sequence': {
      const problems = sequenceProblems(mechanic);
      if (problems.length > 0) {
        return {
          ok: false,
          unsupported: false,
          reason: problems.map((p) => `${p.at}: ${p.message}`).join('; '),
        };
      }
      return {
        ok: true,
        how: `${mechanic.items.length} cards, ${mechanic.rules.length} rules`,
      };
    }

    case 'evidence': {
      const problems = evidenceProblems(mechanic);
      if (problems.length > 0) {
        return {
          ok: false,
          unsupported: false,
          reason: problems.map((p) => `${p.at}: ${p.message}`).join('; '),
        };
      }
      return {
        ok: true,
        how: `${mechanic.claims.length} claims, ${mechanic.evidence.length} documents`,
      };
    }

    case 'ai-system':
      if (mechanic.corpus === 'chapter') {
        // Played over the uploaded chapter: shipped only once a live run has
        // shown the broken start losing and a fix winning.
        return mechanic.verified?.startLost && mechanic.verified.fix
          ? {
              ok: true,
              how: 'live retrieval over the chapter itself; start verified to lose, a fix verified to win',
            }
          : {
              ok: false,
              unsupported: false,
              reason: 'a retrieval act over the chapter has not been verified on the live pipeline',
            };
      }
      return mechanic.corpus === 'oracle'
        ? {
            ok: true,
            how: 'live retrieval over the Old Library; the starting satchel is verified to lose',
          }
        : mechanic.corpus === 'fixture'
          ? { ok: true, how: 'judged against the canned Oracle table' }
          : {
              ok: false,
              unsupported: true,
              reason:
                'this retrieval act has no corpus to run over, so its answers would belong to a different story',
            };

    case 'qualitative':
      return {
        ok: false,
        unsupported: true,
        reason:
          'qualitative acts have no deterministic win condition: the rubric is free text and only a model could judge it',
      };
  }
}
