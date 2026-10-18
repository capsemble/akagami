/**
 * The Oracle's retrieval pipeline, for real.
 *
 * Until now `/api/rag/run` replayed one of seven canned rows from
 * mocks/rag.json, so "we used RAG to teach RAG" was a claim, not a fact. This
 * runs the thing the act is about, over the Old Library's own scrolls
 * (mocks/oracle-library.md):
 *
 *   chunk  — the panel's chunk size and overlap, cut within each scroll
 *   embed  — every chunk and the question, with the Gemini embedding model
 *   retrieve — cosine similarity, top k
 *   rerank — when asked: Gemini scores the top ten for how directly they answer
 *   answer — Gemini, playing an Oracle that answers from whatever it is handed
 *   judge  — deterministic: are the gold record's key facts in the answer?
 *            model: does the answer claim anything the gold record does not?
 *
 * The Oracle is deliberately the naive generator the chapter warns about: told
 * to use every relevant detail it is handed, it will borrow a neighbour's
 * "sixty milligrams" when the satchel is too full. That is the system under
 * study, not a bug in it.
 *
 * Every run is cached by question and settings, so a setting shows the same
 * result each time it is tried — `cached` says when that is what happened.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RagAct, RagParams, RagRunResponse } from '@chapter-quest/shared';
import { cacheDir } from './cache.js';
import { MODELS, embed, generateJson } from './gemini.js';
import { mocksDir } from './paths.js';
import { RAG_ANSWER_SCHEMA, RAG_JUDGE_SCHEMA, RAG_RERANK_SCHEMA } from './schemas.js';

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

/** The scroll whose entry is the answer. Its text is the judge's ground truth. */
export const GOLD_SCROLL = 's12';

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

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export const isGold = (chunk: Chunk): boolean =>
  chunk.scroll === GOLD_SCROLL && /forty|milligrams|taken at dusk/i.test(chunk.text);

/**
 * The facts a correct answer must contain, checked by pattern, not by a model.
 * Asking who approved it adds one: the honest answer is that no scroll says.
 */
export function keyFacts(question: string): { name: string; pattern: RegExp }[] {
  const facts = [
    { name: 'forty', pattern: /\bforty\b|\b40\b/i },
    { name: 'milligrams', pattern: /milligram|\bmg\b/i },
  ];
  // Only a question that asks when needs the hour in its answer.
  if (/\bwhen\b/i.test(question)) facts.push({ name: 'at dusk', pattern: /\bdusk\b/i });
  if (/approv/i.test(question)) {
    facts.push({
      name: 'that no scroll records who approved it',
      pattern:
        /\b(no|not|never|nothing|none|unrecorded|doesn't|does not|don't)\b[^.]{0,80}\b(record|scroll|say|state|mention|approv|written|note)/i,
    });
  }
  return facts;
}

// --- the moving parts, injectable --------------------------------------------------

export interface RagDeps {
  embed(texts: string[]): Promise<number[][]>;
  ask<T>(prompt: string, schema: object, role: 'text' | 'fast', system: string): Promise<T>;
  models: { embed: string; answer: string; judge: string };
}

const defaultDeps: RagDeps = {
  embed: (texts) => embed(texts),
  ask: <T>(prompt: string, schema: object, role: 'text' | 'fast', system: string) =>
    generateJson<T>(prompt, schema as never, {
      role,
      temperature: 0,
      systemInstruction: system,
      agent: 'Oracle pipeline',
    }),
  get models() {
    return { embed: MODELS.embed, answer: MODELS.text, judge: MODELS.text };
  },
};

// --- caches -------------------------------------------------------------------------

const ragDir = join(cacheDir, 'rag');
const indexes = new Map<string, Promise<{ chunk: Chunk; vector: number[] }[]>>();
const queries = new Map<string, Promise<number[]>>();
let runs: Record<string, RagRunResponse> | null = null;

async function loadRuns(): Promise<Record<string, RagRunResponse>> {
  if (runs) return runs;
  try {
    runs = JSON.parse(await readFile(join(ragDir, 'runs.json'), 'utf8')) as Record<
      string,
      RagRunResponse
    >;
  } catch {
    runs = {};
  }
  return runs;
}

async function saveRun(key: string, run: RagRunResponse): Promise<void> {
  const all = await loadRuns();
  all[key] = run;
  await mkdir(ragDir, { recursive: true });
  await writeFile(join(ragDir, 'runs.json'), JSON.stringify(all, null, 2));
}

export async function loadLibrary(): Promise<Scroll[]> {
  return parseLibrary(await readFile(join(mocksDir, 'oracle-library.md'), 'utf8'));
}

function indexFor(scrolls: Scroll[], size: number, overlap: number, deps: RagDeps) {
  const key = `${deps.models.embed}|${size}|${overlap}`;
  let index = indexes.get(key);
  if (!index) {
    const chunks = chunkScrolls(scrolls, size, overlap);
    index = deps
      .embed(chunks.map((c) => c.text))
      .then((vectors) => chunks.map((chunk, i) => ({ chunk, vector: vectors[i]! })));
    // A failed embedding is not cached: the next run tries again.
    index.catch(() => indexes.delete(key));
    indexes.set(key, index);
  }
  return index;
}

function queryFor(question: string, deps: RagDeps) {
  const key = `${deps.models.embed}|${question}`;
  let vector = queries.get(key);
  if (!vector) {
    vector = deps.embed([question]).then(([v]) => v!);
    vector.catch(() => queries.delete(key));
    queries.set(key, vector);
  }
  return vector;
}

// --- the run ------------------------------------------------------------------------

/**
 * The Oracle as it starts: the persona the world gives it — "confident even
 * when starved of facts, never volunteers that it is guessing". That is the
 * naive generator the grounding act is about, configured the way real ones
 * often are: always sound complete. A real Gemini, asked plainly, would say
 * the scrolls are silent; this one is told never to, and the grounding rule
 * the player can switch on is the real fix.
 */
const ORACLE = `You are the Oracle of the Old Library: a blue flame in a brass cage that
answers visitors' questions from the scrolls placed in your satchel. Answer
every part of the question in one or two confident sentences, and nothing
beyond it — no words about yourself. Never say that you do not know or that the
scrolls are silent: where a detail is not written, give the most likely answer
as though it were. Do not mention scroll ids.`;

/** The grounding rule the player can bind the Oracle with. */
const GROUNDED = `Use only what the scrolls state. For any part of the question the scrolls do
not answer, say plainly that the scrolls do not say.`;

const RERANKER = `You rank passages for a retrieval system. Score each passage 0 to 10 for how
directly it answers the question — 10 if it states the answer, 0 if unrelated.
Judge only what the passage says.`;

const JUDGE = `You check an answer against the record it should rest on. List every claim
in the answer, about what the question asks, that the RECORD does not support —
including details borrowed from elsewhere, like a different standard, a
different house's units or a rule meant for someone else, and any claim about
who approved something the record does not name.
A claim is supported if the record states it, paraphrases it, or it follows
directly from the record. Saying the record is silent on a point is not a
claim. Ignore the speaker's own voice ("my flame", "I recall"). Return an
empty list if every claim is supported.`;

/**
 * Whether a run shows the act's lesson, measured on the retrieval itself.
 * The answer being right is required and is not enough: a strong model can
 * stitch a fact cut across two chunks back together, and still be right for
 * the wrong reason.
 */
export function lessonOf(
  ragAct: RagAct | undefined,
  run: Pick<RagRunResponse, 'retrieved' | 'judge'>,
  params: RagParams,
): NonNullable<RagRunResponse['lesson']> {
  const correct = {
    label: 'The Oracle’s answer is right and fully supported',
    ok: run.judge.correct,
  };
  const gold = run.retrieved.filter((r) => r.gold).length;
  const checks = [correct];
  if (ragAct === 'chunking') {
    checks.push({
      label: 'One chunk carries the whole fact — "forty milligrams, taken at dusk"',
      ok: run.retrieved.some((r) => /forty milligrams/i.test(r.text) && /dusk/i.test(r.text)),
    });
  } else if (ragAct === 'topk') {
    checks.push(
      { label: 'The ledger entry is in the satchel', ok: gold > 0 },
      {
        label: `A lean satchel: at least 1 scroll in 3 is the right one (${gold} of ${params.k})`,
        ok: gold > 0 && gold / params.k >= 1 / 3,
      },
    );
  } else if (ragAct === 'grounding') {
    checks.push({
      label: 'Not one claim the scrolls do not make',
      ok: run.judge.unsupportedClaims.length === 0,
    });
  }
  return { passed: checks.every((c) => c.ok), checks };
}

export async function runRag(
  question: string,
  params: RagParams,
  ragAct?: RagAct,
  deps: RagDeps = defaultDeps,
  library?: Scroll[],
): Promise<RagRunResponse> {
  const grounded = params.rule === 'grounded';
  const key = `${deps.models.embed}|${deps.models.answer}|${question}|${params.chunkSize}-${params.overlap}-${params.k}-${params.rerank}-${grounded ? 'g' : 'n'}`;
  if (deps === defaultDeps) {
    const hit = (await loadRuns())[key];
    if (hit) {
      // Everything deterministic is recomputed from the cached answer — the
      // facts it must contain, and the lesson, which depends on the act. Only
      // the model's reading of unsupported claims is reused.
      const missingFacts = keyFacts(question)
        .filter((f) => !f.pattern.test(hit.answer))
        .map((f) => f.name);
      const judge = {
        ...hit.judge,
        missingFacts,
        correct: missingFacts.length === 0 && hit.judge.unsupportedClaims.length === 0,
      };
      const fresh = { ...hit, judge };
      return { ...fresh, cached: true, lesson: lessonOf(ragAct, fresh, params) };
    }
  }

  const started = Date.now();
  const scrolls = library ?? (await loadLibrary());
  const [index, query] = await Promise.all([
    indexFor(scrolls, params.chunkSize, params.overlap, deps),
    queryFor(question, deps),
  ]);
  const ranked = index
    .map(({ chunk, vector }) => ({ chunk, score: cosine(query, vector) }))
    .sort((a, b) => b.score - a.score);

  let chosen = ranked.slice(0, params.k);
  if (params.rerank) {
    const pool = ranked.slice(0, Math.max(10, params.k));
    const { scores } = await deps.ask<{ scores: { id: string; score: number }[] }>(
      `QUESTION: ${question}\n\nPASSAGES:\n${pool.map((p) => `[${p.chunk.id}] ${p.chunk.text}`).join('\n')}`,
      RAG_RERANK_SCHEMA,
      'fast',
      RERANKER,
    );
    const by = new Map(scores.map((s) => [s.id, Number(s.score) || 0]));
    chosen = [...pool]
      .sort((a, b) => (by.get(b.chunk.id) ?? 0) - (by.get(a.chunk.id) ?? 0) || b.score - a.score)
      .slice(0, params.k);
  }

  const { answer } = await deps.ask<{ answer: string }>(
    `SCROLLS IN YOUR SATCHEL:\n${chosen.map((c) => `- ${c.chunk.text}`).join('\n')}\n\nQUESTION: ${question}`,
    RAG_ANSWER_SCHEMA,
    'text',
    grounded ? `${ORACLE}\n\n${GROUNDED}` : ORACLE,
  );

  const facts = keyFacts(question);
  const missingFacts = facts.filter((f) => !f.pattern.test(answer)).map((f) => f.name);
  const record = scrolls.find((s) => s.id === GOLD_SCROLL)?.text ?? '';
  const { unsupported } = await deps.ask<{ unsupported: string[] }>(
    `QUESTION: ${question}\n\nRECORD:\n${record}\n\nANSWER:\n${answer}`,
    RAG_JUDGE_SCHEMA,
    // Not the fast model: on real runs it flagged "my blue flame" as a claim.
    'text',
    JUDGE,
  );
  const unsupportedClaims = (unsupported ?? []).map((c) => String(c).trim()).filter(Boolean);

  const run: RagRunResponse = {
    retrieved: chosen.map(({ chunk, score }) => ({
      id: chunk.id,
      text: chunk.text,
      score: Math.round(score * 100) / 100,
      gold: isGold(chunk),
    })),
    answer: answer.trim(),
    judge: {
      correct: missingFacts.length === 0 && unsupportedClaims.length === 0,
      missingFacts,
      unsupportedClaims,
    },
    latencyMs: Date.now() - started,
    cached: false,
    live: true,
    models: deps.models,
  };
  if (deps === defaultDeps) await saveRun(key, run);
  run.lesson = lessonOf(ragAct, run, params);
  return run;
}
