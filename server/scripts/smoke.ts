/**
 * One real call per capability, so we know the key and the model IDs are good
 * before the demo. Reads GEMINI_API_KEY from the repo-root .env.
 *
 *   npm run smoke
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from 'dotenv';
import { repoRoot } from '../src/paths.js';

config({ path: join(repoRoot, '.env') });

const { MODELS, embed, generateImage, generateJson, getUsage } = await import('../src/gemini.js');

const tmp = join(repoRoot, 'tmp');
mkdirSync(tmp, { recursive: true });

function ok(label: string, detail: string) {
  console.log(`  \x1b[32mPASS\x1b[0m ${label} — ${detail}`);
}

async function main() {
  if (!process.env.GEMINI_API_KEY) {
    console.error('GEMINI_API_KEY missing. Copy .env.example to .env and put your key in it.');
    process.exit(1);
  }
  console.log(`models: text=${MODELS.text} image=${MODELS.image} embed=${MODELS.embed}\n`);

  console.log('1/3 text (JSON output)…');
  const world = await generateJson<{ title: string; logline: string }>(
    'Invent a tiny 2D RPG world that teaches binary search. Reply as JSON with "title" and a one-sentence "logline".',
    {
      type: 'object',
      properties: { title: { type: 'string' }, logline: { type: 'string' } },
      required: ['title', 'logline'],
    },
    { temperature: 0.9 },
  );
  ok('text', `${world.title} — ${world.logline}`);

  console.log('2/3 image…');
  const image = await generateImage(
    'Top-down 2D pixel-art game scene: a candlelit library with dark oak floors, tall shelves of scrolls, warm gold rim light. No text, no UI.',
  );
  const out = join(tmp, 'smoke.png');
  writeFileSync(out, image.bytes);
  ok('image', `${image.mimeType}, ${(image.bytes.length / 1024).toFixed(0)} KB → ${out}`);

  console.log('3/3 embedding…');
  const [vector] = await embed(['The Oracle reads only what fits in its satchel.'], {
    taskPrefix: 'passage: ',
    dims: 768,
  });
  ok('embed', `vector length ${vector?.length ?? 0}`);

  const usage = getUsage();
  console.log(`\nusage: ${usage.calls} calls, ${usage.tokens} tokens, ${usage.images} images`);
}

main().catch((err) => {
  console.error('\n\x1b[31mFAIL\x1b[0m', err instanceof Error ? err.message : err);
  console.error(
    '\nIf this is a 404 on the model: verify the IDs in AI Studio and update TEXT_MODEL / IMAGE_MODEL / EMBED_MODEL in .env.',
  );
  process.exit(1);
});
