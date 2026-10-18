/**
 * Which models does this key actually have?
 *
 * Model IDs started life as guesses, and a wrong one fails at call time with a
 * 404, not at startup — in the middle of a design run, forty seconds in. This
 * asks the provider for its catalogue and checks every role against it before
 * anything expensive happens.
 *
 * Works against whichever provider is configured; with FastRouter it also
 * prints what the roles cost, because the budget is credits rather than a
 * billing account.
 *
 *   npm run models
 */
// First, and on its own line: ES imports are hoisted, so dotenv has to run
// from inside a module of its own or gemini.ts reads MODELS from an empty
// environment and decides the provider before .env has been opened.
import '../src/env.js';
import { GoogleGenAI, Type } from '@google/genai';
import type { Schema } from '@google/genai';
import { MODELS, PROVIDER } from '../src/gemini.js';

const ROLES = ['design', 'text', 'fast', 'image', 'embed'] as const;

interface Listed {
  id: string;
  /** USD per million input tokens, when the provider says. */
  inPrice?: number;
  outPrice?: number;
}

const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

async function fromGoogle(): Promise<Listed[]> {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY missing. Copy .env.example to .env and put your key in it.');
  }
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const out: Listed[] = [];
  for await (const model of await ai.models.list()) {
    out.push({ id: String(model.name ?? '').replace(/^models\//, '') });
  }
  return out;
}

async function fromFastRouter(): Promise<Listed[]> {
  const key = process.env.FASTROUTER_API_KEY;
  if (!key) {
    throw new Error('FASTROUTER_API_KEY missing. Copy .env.example to .env and put your key in it.');
  }
  const base = process.env.FASTROUTER_BASE_URL ?? 'https://go.fastrouter.ai/api/v1';
  const res = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${key}` } });
  if (!res.ok) {
    throw new Error(`fastrouter ${res.status} ${res.statusText} — is the key right?`);
  }
  const body = (await res.json()) as {
    data?: { id?: string; pricing?: { prompt?: string; completion?: string } }[];
  };
  const perMillion = (raw?: string) => {
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n * 1e6 : undefined;
  };
  return (body.data ?? []).map((m) => ({
    id: String(m.id),
    inPrice: perMillion(m.pricing?.prompt),
    outPrice: perMillion(m.pricing?.completion),
  }));
}

/**
 * Does this model actually do the thing, as opposed to claiming to?
 *
 * FastRouter's catalogue reports `structured_outputs: false` for every Google
 * model and it is wrong — Argon honours `response_format: json_schema` through
 * the router perfectly well. Reading that field once cost an afternoon of
 * using a weaker design model for no reason, so the only trustworthy check is
 * to make the call. A probe is a few hundred tokens; the image probe is the
 * only one worth a cent, and it is the only one that paints.
 */
async function probe(): Promise<number> {
  const { embed, generateJson, generateImage } = await import('../src/gemini.js');
  const schema: Schema = {
    type: Type.OBJECT,
    properties: { name: { type: Type.STRING }, menace: { type: Type.INTEGER } },
    required: ['name', 'menace'],
  };

  let failed = 0;
  const run = async (label: string, model: string, work: () => Promise<string>) => {
    const started = Date.now();
    try {
      const detail = await work();
      console.log(`  ${green(' OK ')}  ${label.padEnd(7)} ${model} ${dim(`${Date.now() - started}ms — ${detail}`)}`);
    } catch (err) {
      failed++;
      const why = err instanceof Error ? err.message : String(err);
      console.log(`  ${red('FAIL')}  ${label.padEnd(7)} ${model}\n          ${why.slice(0, 220)}`);
    }
  };

  console.log('\nprobing — one real call per role\n');
  for (const role of ['design', 'text', 'fast'] as const) {
    await run(role, MODELS[role], async () => {
      const out = await generateJson<{ name: string; menace: number }>(
        'Invent one dockside villain. Menace is 1 to 10.',
        schema,
        { role, temperature: 0.4 },
      );
      if (typeof out.name !== 'string' || typeof out.menace !== 'number') {
        throw new Error(`schema ignored: got ${JSON.stringify(out).slice(0, 120)}`);
      }
      return `"${out.name}" (${out.menace})`;
    });
  }

  await run('embed', MODELS.embed, async () => {
    const [vector] = await embed(['the oracle reads only what fits in its satchel']);
    if (!vector?.length) throw new Error('no vector');
    return `vector length ${vector.length}`;
  });

  await run('image', MODELS.image, async () => {
    const painted = await generateImage('A single brass lantern on wet stone, flat vector, no text.');
    return `${painted.mimeType}, ${Math.round(painted.bytes.length / 1024)} KB`;
  });

  return failed;
}

async function main() {
  console.log(`provider: ${PROVIDER}\n`);
  const available = PROVIDER === 'fastrouter' ? await fromFastRouter() : await fromGoogle();
  const byId = new Map(available.map((m) => [m.id, m]));

  console.log(`${available.length} models visible to this key\n`);
  let missing = 0;
  for (const role of ROLES) {
    const id = MODELS[role];
    const found = byId.get(id);
    if (!found) missing++;
    const price =
      found?.inPrice !== undefined
        ? dim(` $${found.inPrice.toFixed(2)} in / $${(found.outPrice ?? 0).toFixed(2)} out per 1M`)
        : '';
    console.log(`  ${found ? green(' OK ') : red('MISS')}  ${role.padEnd(7)} ${id}${price}`);
  }

  if (missing > 0) {
    console.log(
      red(`\n${missing} of ${ROLES.length} model IDs do not exist on this provider.`),
    );
    console.log('Set DESIGN_MODEL / TEXT_MODEL / FAST_MODEL / IMAGE_MODEL / EMBED_MODEL in .env.');
    // A near-miss is almost always a typo, so offer the closest names.
    for (const role of ROLES) {
      const id = MODELS[role];
      if (byId.has(id)) continue;
      const stem = id.split('/').pop()!.split('-')[0]!;
      const near = available
        .map((m) => m.id)
        .filter((candidate) => candidate.includes(stem))
        .slice(0, 5);
      if (near.length) console.log(`\n  ${role} — did you mean:\n${near.map((n) => `    ${n}`).join('\n')}`);
    }
    process.exit(1);
  }

  console.log(green('\nEvery role resolves.'));

  if (process.argv.includes('--probe')) {
    const failed = await probe();
    if (failed > 0) {
      console.log(red(`\n${failed} role${failed === 1 ? '' : 's'} do not work in practice.`));
      process.exit(1);
    }
    console.log(green('\nEvery role works.'));
  } else {
    console.log(dim('Add --probe to make one real call per role and prove it.'));
  }
}

main().catch((err) => {
  console.error(red('FAIL'), err instanceof Error ? err.message : err);
  process.exit(1);
});
