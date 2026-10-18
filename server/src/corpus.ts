/**
 * What retrieval runs over, and the pure parts of it: no model, no network.
 *
 * Two libraries exist. The Old Library is the prepared world's — nine scrolls
 * written so its lessons have somewhere to happen. A chapter corpus is the
 * uploaded chapter itself, cut into its own paragraphs: a RAG chapter's game
 * retrieves from the chapter that teaches RAG. Both are a `Corpus`, and the
 * pipeline in rag.ts treats them the same.
 *
 * Everything here is deterministic, which is why the validator can use it to
 * prove things about an act before anyone runs it: that 40-word chunks really
 * tear the answer, that a lean satchel is really possible.
 */
import { createHash } from 'node:crypto';
import { normaliseSource } from '@chapter-quest/shared';
import type { RagParams } from '@chapter-quest/shared';

export interface Scroll {
  id: string;
  title: string;
  text: string;
}

export interface Chunk {
  id: string;
  scroll: string;
  text: string;
}

export interface Fact {
  name: string;
  pattern: RegExp;
  /** A fact about the answer's honesty ("it does not say"), not about the passage. */
  silence?: boolean;
}

export interface Corpus {
  /** Same text, same id: what the caches are keyed on. */
  id: string;
  scrolls: Scroll[];
  /** What the judge checks the answer's claims against. */
  record: string;
  /** What a correct answer must contain. */
  facts: Fact[];
  /** A chunk that holds any part of the answer. */
  isGold(chunk: Chunk): boolean;
}

export function parseLibrary(markdown: string): Scroll[] {
  const scrolls: Scroll[] = [];
  for (const block of markdown.split(/^## /m).slice(1)) {
    const [heading = '', ...body] = block.split('\n');
    const match = /^(\S+)\s+—\s+(.*)$/.exec(heading.trim());
    if (!match) continue;
    scrolls.push({
      id: match[1]!,
      title: match[2]!,
      text: body.join(' ').replace(/\s+/g, ' ').trim(),
    });
  }
  return scrolls;
}

/**
 * A chapter, as the paragraphs its author wrote. A heading on its own is
 * folded into the paragraph that follows it, so a chunk keeps its context.
 */
export function paragraphsOf(text: string): Scroll[] {
  const blocks = text
    .split(/\n\s*\n|\f/)
    .map((b) =>
      b
        .replace(/^#+\s*/gm, '')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter(Boolean);
  const merged: string[] = [];
  let carry = '';
  for (const block of blocks) {
    if (block.split(' ').length < 12) {
      carry = carry ? `${carry} ${block}` : block;
      continue;
    }
    merged.push(carry ? `${carry} ${block}` : block);
    carry = '';
  }
  if (carry) merged.push(carry);
  return merged.map((text, i) => ({
    id: `p${String(i + 1).padStart(2, '0')}`,
    title: text.split(' ').slice(0, 6).join(' '),
    text,
  }));
}

/** Fixed-size word windows within each scroll; a chunk never spans two. */
export function chunkScrolls(scrolls: Scroll[], size: number, overlap: number): Chunk[] {
  const step = Math.max(1, size - overlap);
  const chunks: Chunk[] = [];
  for (const scroll of scrolls) {
    const words = scroll.text.split(' ');
    for (let start = 0, n = 1; start < words.length; start += step, n++) {
      chunks.push({
        id: `${scroll.id}#${n}`,
        scroll: scroll.id,
        text: words.slice(start, start + size).join(' '),
      });
      if (start + size >= words.length) break;
    }
  }
  return chunks;
}

/** A phrase as a pattern: case and spacing forgiven, words not. */
export function factPattern(phrase: string): RegExp {
  const words = normaliseSource(phrase)
    .split(' ')
    .filter(Boolean)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(words.join('[\\s\\W]+'), 'i');
}

/** An answer that says the source is silent on something. */
export const SILENCE =
  /\b(no|not|never|nothing|none|unrecorded|doesn't|does not|don't|isn't|is not)\b[^.]{0,80}\b(record|scroll|say|state|mention|approv|written|note|cover|specify|describe|discuss|address|chapter|text)/i;

/** A chunk carries the whole fact when every non-silence fact is in it. */
export const carriesWholeFact = (text: string, facts: Fact[]): boolean => {
  const needed = facts.filter((f) => !f.silence);
  return needed.length > 0 && needed.every((f) => f.pattern.test(text));
};

const hash = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 12);

/**
 * The uploaded chapter as the library. The record the judge checks claims
 * against is the whole chapter: a claim the chapter makes anywhere is
 * supported; one it makes nowhere is not.
 */
export function chapterCorpus(
  text: string,
  act: { keyFacts?: string[]; silentOn?: string },
): Corpus {
  const facts: Fact[] = (act.keyFacts ?? []).map((phrase) => ({
    name: phrase,
    pattern: factPattern(phrase),
  }));
  if (act.silentOn?.trim()) {
    facts.push({
      name: `that the chapter does not say ${act.silentOn.trim()}`,
      pattern: SILENCE,
      silence: true,
    });
  }
  const scrolls = paragraphsOf(text);
  const passageFacts = facts.filter((f) => !f.silence);
  return {
    id: `chapter:${hash(text)}`,
    scrolls,
    record: text,
    facts,
    isGold: (chunk) => passageFacts.some((f) => f.pattern.test(chunk.text)),
  };
}

/**
 * What can be proved about a chapter-corpus act before it is ever run: the
 * deterministic half of verifying it. The live half runs the pipeline.
 */
export function chapterRagProblems(
  text: string,
  act: { ragAct: string; keyFacts?: string[]; silentOn?: string },
): { code: string; message: string }[] {
  const corpus = chapterCorpus(text, act);
  const problems: { code: string; message: string }[] = [];
  const passageFacts = corpus.facts.filter((f) => !f.silence);
  for (const fact of passageFacts) {
    if (!fact.pattern.test(normaliseSource(text))) {
      problems.push({
        code: 'fact-not-in-chapter',
        message: `key fact "${fact.name}" is not in the chapter`,
      });
    }
  }
  if (problems.length) return problems;

  if (act.ragAct === 'chunking') {
    const torn = !chunkScrolls(corpus.scrolls, 40, 0).some((c) =>
      carriesWholeFact(c.text, corpus.facts),
    );
    const mendable = [120, 250].some((size) =>
      chunkScrolls(corpus.scrolls, size, 30).some((c) => carriesWholeFact(c.text, corpus.facts)),
    );
    if (!torn) {
      problems.push({
        code: 'rag-start-intact',
        message:
          'every key fact fits inside one 40-word chunk, so the torn starting satchel would already win; choose key facts that sit further apart in the passage',
      });
    }
    if (!mendable) {
      problems.push({
        code: 'rag-fact-too-spread',
        message:
          'no chunk of 120 or 250 words holds every key fact, so no setting can win; choose facts closer together',
      });
    }
  }
  if (act.ragAct === 'topk') {
    const gold = chunkScrolls(corpus.scrolls, 120, 15).filter((c) => corpus.isGold(c)).length;
    if (gold > 2) {
      problems.push({
        code: 'rag-start-lean',
        message: `${gold} chunks hold the answer, so eight in the satchel can already be lean; choose key facts only one passage holds`,
      });
    }
  }
  if (act.ragAct === 'grounding' && !act.silentOn?.trim()) {
    problems.push({
      code: 'rag-nothing-to-ground',
      message:
        'a grounding act needs a second part of the question the chapter does not answer (silentOn)',
    });
  }
  return problems;
}

/**
 * Where each retrieval lesson starts, broken: torn chunks, an overstuffed
 * satchel, an Oracle with no grounding rule. And the fixes the build tries,
 * live, to prove the act can be won — in the order a player would reach for
 * them.
 */
export const RAG_START: Record<'chunking' | 'topk' | 'grounding', RagParams> = {
  chunking: { chunkSize: 40, overlap: 0, k: 3, rerank: false },
  topk: { chunkSize: 120, overlap: 15, k: 8, rerank: false },
  grounding: { chunkSize: 120, overlap: 15, k: 8, rerank: false },
};

export const RAG_FIXES: Record<'chunking' | 'topk' | 'grounding', RagParams[]> = {
  chunking: [
    { chunkSize: 120, overlap: 15, k: 3, rerank: false },
    { chunkSize: 250, overlap: 30, k: 3, rerank: false },
  ],
  topk: [
    { chunkSize: 120, overlap: 15, k: 3, rerank: true },
    { chunkSize: 120, overlap: 15, k: 2, rerank: false },
  ],
  grounding: [
    { chunkSize: 120, overlap: 15, k: 8, rerank: false, rule: 'grounded' },
    { chunkSize: 120, overlap: 15, k: 3, rerank: true, rule: 'grounded' },
  ],
};
