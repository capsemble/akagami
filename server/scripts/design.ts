/**
 * Run the design pipeline over one chapter and write the result to tmp/.
 *
 *   npm run design -- server/scripts/fixtures/sample-chapter.md
 *   npm run design -- chapter.pdf --fresh
 *   npm run design -- notes.md --fresh --no-art   # script only, no image calls
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { config } from 'dotenv';
import { repoRoot } from '../src/paths.js';

config({ path: join(repoRoot, '.env') });

const { extractText } = await import('../src/extract.js');
const { designWorld } = await import('../src/pipeline/design.js');
const { getUsageByModel } = await import('../src/gemini.js');

const KIND_COLOR: Record<string, string> = {
  start: '\x1b[37m',
  progress: '\x1b[36m',
  done: '\x1b[32m',
  rejected: '\x1b[31m',
  repair: '\x1b[33m',
  fallback: '\x1b[35m',
};

async function main() {
  const args = process.argv.slice(2);
  const fresh = args.includes('--fresh');
  const skipArt = args.includes('--no-art');
  const input = args.find((a) => !a.startsWith('--'));

  if (!input) {
    console.error('usage: npm run design -- <chapter.md|chapter.pdf> [--fresh]');
    process.exit(1);
  }
  const { PROVIDER } = await import('../src/gemini.js');
  const keyFor = { google: 'GEMINI_API_KEY', fastrouter: 'FASTROUTER_API_KEY' } as const;
  if (!process.env[keyFor[PROVIDER]]) {
    console.error(`${keyFor[PROVIDER]} missing. Copy .env.example to .env and put your key in it.`);
    process.exit(1);
  }

  const started = Date.now();
  const chapter = await extractText(input);
  console.log(
    `chapter: ${basename(chapter.source)} — ${chapter.pages.length} pages, ${chapter.text.length} chars, sha ${chapter.hash.slice(0, 12)}\n`,
  );

  const t0 = Date.now();
  const result = await designWorld({
    chapter,
    fresh,
    skipArt,
    emit: (e) => {
      const color = KIND_COLOR[e.kind] ?? '';
      const at = ((e.ts - t0) / 1000).toFixed(1).padStart(5);
      const model = e.model ? ` \x1b[90m[${e.model}]\x1b[0m` : '';
      console.log(`${at}s ${color}${e.kind.padEnd(9)}\x1b[0m ${e.agent}${model}: ${e.message}`);
    },
  });

  console.log('\n--- timings ---');
  for (const { stage, ms } of result.timings) {
    console.log(`  ${stage.padEnd(20)} ${String(ms).padStart(7)} ms`);
  }
  console.log(`  ${'TOTAL'.padEnd(20)} ${String(Date.now() - started).padStart(7)} ms`);
  if (result.cacheHits.length > 0) console.log(`  (cache hits: ${result.cacheHits.join(', ')})`);

  const usage = getUsageByModel();
  if (Object.keys(usage).length > 0) {
    console.log('\n--- usage ---');
    for (const [model, u] of Object.entries(usage)) {
      console.log(`  ${model}: ${u.calls} calls, ${u.tokens} tokens`);
    }
  }

  console.log('\n--- validation ---');
  if (result.validation.ok) {
    console.log('  \x1b[32mok\x1b[0m — no errors');
  } else {
    for (const e of result.validation.errors) {
      console.log(`  \x1b[31m${e.code}\x1b[0m ${e.path}: ${e.message}`);
    }
  }
  if (result.usedFallback) {
    console.log('  \x1b[35mfell back to the cached world\x1b[0m');
  }

  const tmp = join(repoRoot, 'tmp');
  mkdirSync(tmp, { recursive: true });
  const stem = basename(input).replace(/\.[^.]+$/, '');
  const scriptPath = join(tmp, `${stem}.script.json`);
  const eventsPath = join(tmp, `${stem}.events.json`);
  writeFileSync(scriptPath, JSON.stringify(result.script, null, 2));
  writeFileSync(eventsPath, JSON.stringify(result.events, null, 2));

  console.log(`\nscript → ${scriptPath}`);
  console.log(`events → ${eventsPath}`);
  console.log(
    `\n"${result.script.outline.title}" — ${result.script.acts.length} acts: ${result.script.acts.map((a) => a.title).join(' / ')}`,
  );

  process.exit(result.validation.ok || result.usedFallback ? 0 : 1);
}

main().catch((err) => {
  console.error('\n\x1b[31mFAIL\x1b[0m', err instanceof Error ? err.stack : err);
  process.exit(1);
});
