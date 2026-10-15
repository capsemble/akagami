/**
 * Which models does this key actually have? The IDs in .env started life as
 * guesses, and a wrong one fails at call time with a 404, not at startup.
 *
 *   npm run models
 */
import { join } from 'node:path';
import { config } from 'dotenv';
import { GoogleGenAI } from '@google/genai';
import { repoRoot } from '../src/paths.js';

config({ path: join(repoRoot, '.env') });

const ROLES = ['DESIGN_MODEL', 'TEXT_MODEL', 'FAST_MODEL', 'IMAGE_MODEL', 'EMBED_MODEL'] as const;

async function main() {
  if (!process.env.GEMINI_API_KEY) {
    console.error('GEMINI_API_KEY missing. Copy .env.example to .env and put your key in it.');
    process.exit(1);
  }

  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const available: string[] = [];

  try {
    for await (const model of await ai.models.list()) {
      available.push(String(model.name ?? '').replace(/^models\//, ''));
    }
  } catch (err) {
    const message = String((err as Error).message);
    const url = message.match(/https:\/\/[^\s"\\]+/)?.[0];
    console.error('\x1b[31mCould not list models.\x1b[0m');
    if (/\b403\b/.test(message)) {
      console.error('The key is readable but the Generative Language API is off for its project.');
      if (url) console.error(`Enable it here, wait a minute, then re-run:\n  ${url}`);
    } else {
      console.error(message.slice(0, 300));
    }
    process.exit(1);
  }

  console.log(`${available.length} models visible to this key\n`);
  let missing = 0;
  for (const role of ROLES) {
    const id = process.env[role];
    const ok = id ? available.includes(id) : false;
    if (!ok) missing++;
    console.log(
      `  ${ok ? '\x1b[32m OK \x1b[0m' : '\x1b[31mMISS\x1b[0m'}  ${role.padEnd(13)} ${id ?? '(unset)'}`,
    );
  }

  console.log('\n--- available ---');
  for (const name of available.sort()) console.log(`  ${name}`);

  if (missing > 0) {
    console.log(
      `\n\x1b[33m${missing} of ${ROLES.length} model IDs do not exist. Update .env from the list above.\x1b[0m`,
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('\x1b[31mFAIL\x1b[0m', err instanceof Error ? err.message : err);
  process.exit(1);
});
