/**
 * Which concepts can become acts, decided before anyone writes one.
 *
 * The writers' room used to be handed every concept the curriculum found and
 * told to pick the three that make the best game. It picked by story, and a
 * concept with no playable mechanic became an act whose gate never opens —
 * or, for anything that sounded vaguely like AI, the Oracle's RAG panel with
 * the Oracle's canned answers, in a world about something else entirely.
 *
 * So the choice is made here, by rule, and the reasons are kept: a concept the
 * runtime cannot play is reported, never quietly turned into something it can.
 */
import type { Concept, Curriculum } from '@chapter-quest/shared';
import { GENERATED_MECHANICS } from '@chapter-quest/shared';

export interface Unroutable {
  concept: Concept;
  reason: string;
}

export interface Routing {
  playable: Concept[];
  unsupported: Unroutable[];
}

/**
 * Words that mean a concept is genuinely about a retrieval pipeline. Matched
 * against the concept's own name, rule and quote — never the subject, because
 * "machine-learning" covers convolutions as readily as it covers retrieval.
 */
const RETRIEVAL =
  /\b(retriev\w*|rag|chunk\w*|embedding\w*|vector (store|database|search)|top-?k|re-?rank\w*|grounded|grounding|prompt injection)\b/i;

export function aboutRetrieval(concept: Concept): boolean {
  return RETRIEVAL.test(`${concept.name} ${concept.keyRule} ${concept.quote}`);
}

export function routeConcepts(curriculum: Curriculum): Routing {
  const playable: Concept[] = [];
  const unsupported: Unroutable[] = [];
  for (const concept of curriculum.concepts) {
    if (GENERATED_MECHANICS.includes(concept.kind)) {
      playable.push(concept);
      continue;
    }
    if (concept.kind === 'ai-system') {
      unsupported.push({
        concept,
        reason: aboutRetrieval(concept)
          ? 'a retrieval act needs a corpus built from this chapter, and the runtime only has the canned Oracle table'
          : 'classified as an AI-system behaviour but it is not about retrieval, so the RAG panel would teach the wrong thing',
      });
      continue;
    }
    unsupported.push({
      concept,
      reason:
        'an argument or distinction with no quantity to tune and no order to arrange; no mechanic can judge it yet',
    });
  }
  return { playable, unsupported };
}

/** No concept in the chapter can be played. The build stops and says why. */
export class UnsupportedChapterError extends Error {
  constructor(readonly unsupported: Unroutable[]) {
    super(
      `None of the ${unsupported.length} concept(s) in this chapter fits a mechanic the game can play: ` +
        unsupported.map((u) => `${u.concept.name} (${u.concept.kind}: ${u.reason})`).join('; '),
    );
    this.name = 'UnsupportedChapterError';
  }
}
