/**
 * The Oracle's retrieval pipeline. Chunking, cosine ranking, the key-fact
 * check and the lesson checks are deterministic and tested against the real
 * library file. Embeddings and the three model calls are faked here, so these
 * tests prove the plumbing — the live behaviour was measured on real Gemini
 * runs and is reported as such.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RagRunResponse } from '@chapter-quest/shared';
import type { RagDeps } from '../src/rag.js';
import { chunkScrolls, cosine, keyFacts, lessonOf, loadLibrary, runRag } from '../src/rag.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chapterRagProblems, paragraphsOf } from '../src/corpus.js';
import { repoRoot } from '../src/paths.js';
import { chapterCorpus, verifyChapterAct } from '../src/rag.js';
import { validateAiSystemMechanics } from '../src/validate.js';
import type { ActSpec } from '@chapter-quest/shared';

const Q1 = 'What dose did the Archivist record, and when?';
const Q2 = 'What dose did the Archivist record, and who approved it?';

test('the library parses into its scrolls, the ledger holding the gold entry', async () => {
  const scrolls = await loadLibrary();
  assert.deepEqual(
    scrolls.map((s) => s.id),
    ['s12', 's19', 's04', 's27', 's11', 's02', 's31', 's07', 's05'],
  );
  assert.match(scrolls[0]!.text, /a dose of forty milligrams, taken at dusk/);
});

test('40-word chunks with no overlap cut the gold fact in two — the Torn Scrolls lesson is real', async () => {
  const chunks = chunkScrolls(await loadLibrary(), 40, 0);
  const ledger = chunks.filter((c) => c.scroll === 's12');
  assert.match(ledger[0]!.text, /a dose of forty$/);
  assert.match(ledger[1]!.text, /^milligrams, taken at dusk/);
  assert.equal(
    chunks.some((c) => /forty milligrams/.test(c.text)),
    false,
    'no chunk carries the whole fact',
  );
});

test('overlap restaples the seam: 40 words with 15 of overlap keep the fact whole', async () => {
  const chunks = chunkScrolls(await loadLibrary(), 40, 15);
  assert.ok(chunks.some((c) => /forty milligrams, taken at dusk/.test(c.text)));
});

test('a chunk never runs from one scroll into the next', async () => {
  const scrolls = await loadLibrary();
  for (const size of [40, 120, 250, 500]) {
    for (const c of chunkScrolls(scrolls, size, 0)) {
      const scroll = scrolls.find((s) => s.id === c.scroll)!;
      assert.ok(scroll.text.includes(c.text), `${c.id} at ${size} words leaves its scroll`);
    }
  }
});

test('the key facts follow the question: the hour only when asked, the silence when approval is asked', () => {
  assert.deepEqual(
    keyFacts(Q1).map((f) => f.name),
    ['forty', 'milligrams', 'at dusk'],
  );
  const q2 = keyFacts(Q2);
  assert.deepEqual(
    q2.map((f) => f.name),
    ['forty', 'milligrams', 'that no scroll records who approved it'],
  );
  assert.ok(q2[2]!.pattern.test('The scrolls do not say who approved it.'));
  assert.equal(q2[2]!.pattern.test('It was approved by the Binder.'), false);
});

// --- the lessons, measured on the retrieval --------------------------------------------

const run = (
  retrieved: { text: string; gold: boolean }[],
  judge: Partial<RagRunResponse['judge']> = {},
): Pick<RagRunResponse, 'retrieved' | 'judge'> => ({
  retrieved: retrieved.map((r, i) => ({ id: `c${i}`, score: 1, ...r })),
  judge: { correct: true, missingFacts: [], unsupportedClaims: [], ...judge },
});
const params = (k: number) => ({ chunkSize: 120 as const, overlap: 15 as const, k, rerank: false });

test('chunking: a right answer from a torn fact still fails the lesson', () => {
  const torn = run([
    { text: '...recorded a dose of forty', gold: true },
    { text: 'milligrams, taken at dusk...', gold: true },
  ]);
  assert.equal(lessonOf('chunking', torn, params(2)).passed, false);
  const whole = run([{ text: 'a dose of forty milligrams, taken at dusk', gold: true }]);
  assert.equal(lessonOf('chunking', whole, params(1)).passed, true);
});

test('top-k: the ledger has to be in a lean satchel, not drowned in eight', () => {
  const eight = run([
    { text: 'gold', gold: true },
    ...Array.from({ length: 7 }, () => ({ text: 'x', gold: false })),
  ]);
  assert.equal(lessonOf('topk', eight, params(8)).passed, false);
  const three = run([
    { text: 'gold', gold: true },
    { text: 'x', gold: false },
    { text: 'y', gold: false },
  ]);
  assert.equal(lessonOf('topk', three, params(3)).passed, true);
  const missing = run([{ text: 'x', gold: false }]);
  assert.equal(lessonOf('topk', missing, params(1)).passed, false);
});

test('grounding: one unsupported claim fails it, however right the rest is', () => {
  const invented = run([{ text: 'gold', gold: true }], {
    correct: false,
    unsupportedClaims: ['The Archivist approved it alone.'],
  });
  assert.equal(lessonOf('grounding', invented, params(1)).passed, false);
  assert.equal(lessonOf('grounding', run([{ text: 'gold', gold: true }]), params(1)).passed, true);
});

// --- the pipeline, with the models faked -----------------------------------------------------

/** A bag-of-words "embedding": enough for cosine to prefer the passage that shares words. */
const vocab = [
  'dose',
  'forty',
  'milligrams',
  'dusk',
  'archivist',
  'sixty',
  'grains',
  'binder',
  'record',
];
const bow = (t: string) => vocab.map((w) => (t.toLowerCase().includes(w) ? 1 : 0) + 0.01);

function fake(answer: string, unsupported: string[] = []) {
  const calls: string[] = [];
  const deps: RagDeps = {
    embed: async (texts) => texts.map(bow),
    ask: async <T>(prompt: string, _schema: object, _role: 'text' | 'fast', system: string) => {
      calls.push(system.slice(0, 20));
      if (/rank passages/.test(system)) {
        const ids = [...prompt.matchAll(/\[(s\d+#\d+)\]/g)].map((m) => m[1]!);
        return { scores: ids.map((id) => ({ id, score: id.startsWith('s12') ? 10 : 1 })) } as T;
      }
      if (/check an answer/.test(system)) return { unsupported } as T;
      return { answer } as T;
    },
    models: { embed: 'fake-embed', answer: 'fake-answer', judge: 'fake-judge' },
  };
  return { deps, calls };
}

test('a run retrieves k chunks, marks the gold ones, answers, judges and measures the lesson', async () => {
  const { deps } = fake('The Archivist recorded forty milligrams, taken at dusk.');
  const r = await runRag(Q1, { chunkSize: 120, overlap: 15, k: 3, rerank: false }, 'topk', deps);
  assert.equal(r.retrieved.length, 3);
  assert.equal(
    r.retrieved[0]!.id.startsWith('s12'),
    true,
    'the ledger shares the most words with the question',
  );
  assert.equal(r.retrieved[0]!.gold, true);
  assert.equal(r.judge.correct, true);
  assert.equal(r.live, true);
  assert.equal(r.lesson?.passed, true);
});

test('an answer that borrows a neighbour is judged wrong, and the lesson fails', async () => {
  const { deps } = fake('Forty milligrams at dusk, down from sixty.', ['down from sixty']);
  const r = await runRag(Q1, { chunkSize: 120, overlap: 15, k: 3, rerank: false }, 'topk', deps);
  assert.equal(r.judge.correct, false);
  assert.deepEqual(r.judge.unsupportedClaims, ['down from sixty']);
  assert.equal(r.lesson?.passed, false);
});

test('rerank asks the reranker and puts what it scores highest first', async () => {
  const { deps, calls } = fake('Forty milligrams at dusk.');
  const r = await runRag(Q1, { chunkSize: 40, overlap: 0, k: 2, rerank: true }, 'chunking', deps);
  assert.ok(calls.some((c) => c.startsWith('You rank passages')));
  assert.ok(r.retrieved.every((c) => c.id.startsWith('s12')));
});

test('the grounding rule is what changes the Oracle’s instructions', async () => {
  const seen: string[] = [];
  const base = fake('x');
  const deps: RagDeps = {
    ...base.deps,
    ask: async <T>(prompt: string, schema: object, role: 'text' | 'fast', system: string) => {
      seen.push(system);
      return base.deps.ask<T>(prompt, schema, role, system);
    },
  };
  await runRag(Q2, { chunkSize: 120, overlap: 15, k: 3, rerank: false }, 'grounding', deps);
  await runRag(
    Q2,
    { chunkSize: 120, overlap: 15, k: 3, rerank: false, rule: 'grounded' },
    'grounding',
    deps,
  );
  const oracle = seen.filter((s) => s.startsWith('You are the Oracle'));
  assert.match(oracle[0]!, /Never say that you do not know/);
  assert.doesNotMatch(oracle[0]!, /Use only what the scrolls state/);
  assert.match(oracle[1]!, /Use only what the scrolls state/);
});

test('cosine is the cosine', () => {
  assert.equal(cosine([1, 0], [1, 0]), 1);
  assert.equal(cosine([1, 0], [0, 1]), 0);
  assert.equal(cosine([0, 0], [1, 1]), 0);
});

// --- the chapter as its own library -----------------------------------------------------

const RAG_CHAPTER = readFileSync(
  join(repoRoot, 'server/scripts/fixtures/sample-chapter.md'),
  'utf8',
);
const P05 = paragraphsOf(RAG_CHAPTER).find((p) => /^Cut too small/.test(p.text))!.text;

test('a chapter becomes its own library: paragraphs, headings folded into what follows', () => {
  const scrolls = paragraphsOf(RAG_CHAPTER);
  assert.equal(scrolls[0]!.id, 'p01');
  assert.ok(scrolls.every((s) => s.text.split(' ').length >= 12));
  assert.ok(
    scrolls.some((s) =>
      /^7\.2 Chunking: where the scissors fall Documents are too long/.test(s.text),
    ),
  );
});

test('DETERMINISTIC: a chunking act whose key facts sit together would be free, and is refused', () => {
  const together = chapterRagProblems(RAG_CHAPTER, {
    ragAct: 'chunking',
    keyFacts: ['forty milligrams', 'taken at dusk'],
  });
  assert.deepEqual(
    together.map((p) => p.code),
    ['rag-start-intact'],
  );
  const apart = chapterRagProblems(RAG_CHAPTER, {
    ragAct: 'chunking',
    keyFacts: ['Cut too small', 'half a fact'],
  });
  assert.deepEqual(
    apart,
    [],
    '40-word chunks tear these apart, 120-word chunks keep them together',
  );
});

test('DETERMINISTIC: a top-k act on facts many passages share could be lean with eight, and is refused', () => {
  assert.deepEqual(
    chapterRagProblems(RAG_CHAPTER, { ragAct: 'topk', keyFacts: ['chunk', 'retrieval'] }).map(
      (p) => p.code,
    ),
    ['rag-start-lean'],
  );
  assert.deepEqual(
    chapterRagProblems(RAG_CHAPTER, {
      ragAct: 'grounding',
      keyFacts: ['half a fact', 'Cut too small'],
    }).map((p) => p.code),
    ['rag-nothing-to-ground'],
  );
});

test('the validator checks the passage is verbatim and the key facts are inside it', () => {
  const act = (mechanic: object) => ({ mechanic }) as unknown as ActSpec;
  const base = {
    type: 'ai-system',
    ragAct: 'chunking',
    question: 'Why does a small chunk give a wrong answer?',
    goldFact: 'the chunk holds half a fact',
    corpus: 'chapter',
    goldQuote: P05,
    keyFacts: ['Cut too small', 'half a fact'],
  };
  assert.deepEqual(validateAiSystemMechanics([act(base)], RAG_CHAPTER).errors, []);
  const recalled = validateAiSystemMechanics(
    [
      act({
        ...base,
        goldQuote: 'If you cut too small a chunk, the model only gets half of the fact it needs.',
      }),
    ],
    RAG_CHAPTER,
  ).errors;
  assert.ok(recalled.some((e) => e.code === 'evidence-not-in-source'));
  const outside = validateAiSystemMechanics(
    [act({ ...base, keyFacts: ['Cut too small', 'reranking'] })],
    RAG_CHAPTER,
  ).errors;
  assert.ok(outside.some((e) => e.code === 'key-fact-not-in-quote'));
});

test('verification plays the act on the pipeline: the torn start loses, the first real fix wins', async () => {
  // A fake embedding that prefers passages sharing the question's words, and a
  // fake Oracle that answers correctly whatever it is handed: what decides the
  // lesson here is the retrieval — which chunk carries the whole fact.
  const words = ['cut', 'small', 'half', 'fact', 'chunk'];
  const deps: RagDeps = {
    embed: async (texts) =>
      texts.map((t) => words.map((w) => (t.toLowerCase().includes(w) ? 1 : 0) + 0.01)),
    ask: async <T>(_p: string, _s: object, _r: 'text' | 'fast', system: string) =>
      (/check an answer/.test(system)
        ? { unsupported: [] }
        : /rank passages/.test(system)
          ? { scores: [] }
          : { answer: 'Cut too small, the chunk holds half a fact.' }) as T,
    models: { embed: 'fake-embed-v', answer: 'fake-answer', judge: 'fake-judge' },
  };
  const mechanic = {
    ragAct: 'chunking' as const,
    question: 'Cut too small: why does the chunk hold half a fact?',
    keyFacts: ['Cut too small', 'half a fact'],
  };
  const { verified, problems } = await verifyChapterAct(mechanic, RAG_CHAPTER, deps);
  assert.deepEqual(problems, []);
  assert.equal(verified.startLost, true);
  assert.deepEqual(verified.fix, { chunkSize: 120, overlap: 15, k: 3, rerank: false });

  // The corpus the runtime uses is the same one: same facts, same chunks.
  const corpus = chapterCorpus(RAG_CHAPTER, mechanic);
  assert.equal(corpus.facts.length, 2);
  assert.ok(corpus.scrolls.some((s) => s.text === P05));
});
