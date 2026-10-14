/**
 * One real call per capability, so we know the key and the model IDs are good
 * before the demo. Reads GEMINI_API_KEY from the repo-root .env.
 *
 *   npm run smoke
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import { Type } from '@google/genai';
import { repoRoot } from '../src/paths.js';

config({ path: join(repoRoot, '.env') });

const { MODELS, embed, generateImage, generateJson, getUsageByModel } =
  await import('../src/gemini.js');

const here = dirname(fileURLToPath(import.meta.url));
const tmp = join(repoRoot, 'tmp');
mkdirSync(tmp, { recursive: true });

/** Argon past this is too slow to sit in a live request. */
const ARGON_BUDGET_MS = 30_000;

function tokensFor(model: string): number {
  return getUsageByModel()[model]?.tokens ?? 0;
}

function ok(label: string, model: string, ms: number, tokens: number, detail: string) {
  const cost = tokens > 0 ? `${tokens} tok` : 'n/a tok';
  console.log(`  \x1b[32mPASS\x1b[0m ${label} [${model}] ${ms} ms, ${cost}`);
  console.log(`       ${detail}`);
}

async function timed<T>(work: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const started = Date.now();
  const value = await work();
  return { value, ms: Date.now() - started };
}

interface Outline {
  title: string;
  concepts: { name: string; misconception: string }[];
  acts: string[];
}

const OUTLINE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    title: { type: Type.STRING },
    concepts: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          name: { type: Type.STRING },
          misconception: { type: Type.STRING },
        },
        required: ['name', 'misconception'],
      },
    },
    acts: { type: Type.ARRAY, items: { type: Type.STRING } },
  },
  required: ['title', 'concepts', 'acts'],
};

async function main() {
  if (!process.env.GEMINI_API_KEY) {
    console.error('GEMINI_API_KEY missing. Copy .env.example to .env and put your key in it.');
    process.exit(1);
  }
  console.log(
    `models: design=${MODELS.design} text=${MODELS.text} fast=${MODELS.fast} image=${MODELS.image} embed=${MODELS.embed}\n`,
  );

  // 1 — design (Argon), on a real chapter rather than a toy prompt.
  console.log('1/5 design (Argon, chapter → outline)…');
  const chapter = readFileSync(join(here, 'fixtures/sample-chapter.md'), 'utf8');
  const design = await timed(() =>
    generateJson<Outline>(
      `You are the curriculum agent for a game that teaches a textbook chapter by making the player use the concept.\n\nRead the chapter below and reply as JSON with:\n- "title": a world title for the game\n- "concepts": exactly 3 concepts, each with the misconception a learner most often holds about it\n- "acts": exactly 3 act titles, one per concept\n\n--- CHAPTER ---\n${chapter}`,
      OUTLINE_SCHEMA,
      { role: 'design', temperature: 0.8, agent: 'Curriculum agent' },
    ),
  );
  ok(
    'design',
    MODELS.design,
    design.ms,
    tokensFor(MODELS.design),
    `${design.value.title} — ${design.value.concepts.length} concepts, acts: ${design.value.acts.join(' / ')}`,
  );
  if (design.ms > ARGON_BUDGET_MS) {
    console.log(
      '\x1b[33mWARNING: use Argon only for pre-generating worlds; run the live stage step on Flash.\x1b[0m',
    );
  }

  // 2 — text
  console.log('2/5 text (JSON output)…');
  const text = await timed(() =>
    generateJson<{ title: string; logline: string }>(
      'Invent a tiny 2D RPG world that teaches binary search. Reply as JSON with "title" and a one-sentence "logline".',
      {
        type: Type.OBJECT,
        properties: { title: { type: Type.STRING }, logline: { type: Type.STRING } },
        required: ['title', 'logline'],
      },
      { role: 'text', temperature: 0.9 },
    ),
  );
  ok(
    'text',
    MODELS.text,
    text.ms,
    tokensFor(MODELS.text),
    `${text.value.title} — ${text.value.logline}`,
  );

  // 3 — fast: the tier the live, in-game calls run on.
  console.log('3/5 fast (JSON output)…');
  const fast = await timed(() =>
    generateJson<{ reply: string; mood: string }>(
      'You are a terse librarian NPC. The player asks where the ledgers are kept. Reply as JSON with "reply" and "mood".',
      {
        type: Type.OBJECT,
        properties: { reply: { type: Type.STRING }, mood: { type: Type.STRING } },
        required: ['reply', 'mood'],
      },
      { role: 'fast', temperature: 0.7 },
    ),
  );
  ok(
    'fast',
    MODELS.fast,
    fast.ms,
    tokensFor(MODELS.fast),
    `${fast.value.mood}: ${fast.value.reply}`,
  );

  // 4 — image
  console.log('4/5 image…');
  const image = await timed(() =>
    generateImage(
      'Top-down 2D pixel-art game scene: a candlelit library with dark oak floors, tall shelves of scrolls, warm gold rim light. No text, no UI.',
    ),
  );
  const out = join(tmp, 'smoke.png');
  writeFileSync(out, image.value.bytes);
  ok(
    'image',
    MODELS.image,
    image.ms,
    tokensFor(MODELS.image),
    `${image.value.mimeType}, ${(image.value.bytes.length / 1024).toFixed(0)} KB → ${out}`,
  );

  // 5 — embedding
  console.log('5/5 embedding…');
  const vectors = await timed(() =>
    embed(['The Oracle reads only what fits in its satchel.'], {
      taskPrefix: 'passage: ',
      dims: 768,
    }),
  );
  ok(
    'embed',
    MODELS.embed,
    vectors.ms,
    tokensFor(MODELS.embed),
    `vector length ${vectors.value[0]?.length ?? 0}`,
  );

  console.log('\nusage by model:');
  for (const [model, u] of Object.entries(getUsageByModel())) {
    console.log(`  ${model}: ${u.calls} calls, ${u.tokens} tokens, ${u.images} images`);
  }
}

main().catch((err) => {
  console.error('\n\x1b[31mFAIL\x1b[0m', err instanceof Error ? err.message : err);
  console.error(
    '\nIf this is a 404 on the model: verify the IDs in AI Studio and update DESIGN_MODEL / TEXT_MODEL / FAST_MODEL / IMAGE_MODEL / EMBED_MODEL in .env.',
  );
  process.exit(1);
});
