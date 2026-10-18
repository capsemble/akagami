/**
 * Can every act of every world on disk actually be finished?
 *
 * The mapper decides which params become dials, and a param left unbound that
 * has to move is an act nobody can win. `npm run audit` answers that for the
 * worlds this machine has built, which is the only place the question is real.
 */
import '../src/env.js';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ActSpec, Curriculum, GameScript, Mechanic, Outline } from '@chapter-quest/shared';
import {
  completionOf,
  evidenceGroundingProblems,
  sequenceGroundingProblems,
} from '@chapter-quest/shared';
import { assess, isGrounded } from '../src/pipeline/judge.js';
import { cacheDir } from '../src/cache.js';
import { buildActs, mapScenes } from '../src/world.js';

const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

const readJson = async <T>(path: string): Promise<T | null> => {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return null;
  }
};

async function main() {
  const files = (await readdir(cacheDir)).filter((f) => f.endsWith('.script.json'));
  let broken = 0;
  let total = 0;
  let ungrounded = 0;

  for (const file of files.sort()) {
    const hash = file.slice(0, -'.script.json'.length);
    const outline = await readJson<Outline>(join(cacheDir, `${hash}.outline.json`));
    const specs = await readJson<ActSpec[]>(join(cacheDir, file));
    if (!outline || !specs) continue;
    const curriculum = await readJson<Curriculum>(join(cacheDir, `${hash}.curriculum.json`));
    const source = await readJson<{ text: string }>(join(cacheDir, `${hash}.source.json`));
    console.log(`\n${outline.title}`);

    // Exactly what the server would hand the client — rooms mapped, stages
    // bound, unbound params settled — before any act is left out, so an act
    // the world builder would drop still shows up here as a failure.
    const script = {
      id: `world-${hash.slice(0, 12)}`,
      ...(curriculum ? { curriculum } : {}),
      outline,
      acts: specs,
    } as GameScript;
    for (const act of buildActs(script, mapScenes(script))) {
      total++;
      const completion = completionOf(act);
      const kind = act.mechanic?.type ?? 'no mechanic';
      if (completion.ok) {
        console.log(
          `  ${green(' OK  ')} ${act.id.padEnd(5)} ${act.title.padEnd(26)} ${dim(`${kind}: ${completion.how}`)}`,
        );
        const grounding = groundingOf(act.mechanic, source?.text);
        if (grounding) {
          if (!grounding.ok) ungrounded++;
          console.log(`        ${grounding.ok ? dim(grounding.line) : red(grounding.line)}`);
        }
        continue;
      }
      broken++;
      console.log(
        `  ${red(completion.unsupported ? 'UNSUP' : 'STUCK')} ${act.id.padEnd(5)} ${act.title.padEnd(26)} ${dim(kind)}\n` +
          `        ${red(completion.reason)}`,
      );
    }
  }

  console.log(
    broken === 0
      ? green(`\nAll ${total} acts can be finished with the controls they give you.`)
      : red(`\n${broken} of ${total} act(s) cannot be finished.`),
  );
  console.log(
    ungrounded === 0
      ? green(
          'Every sequence and evidence act that can be finished cites the notes and passed the judge.',
        )
      : red(`${ungrounded} finishable act(s) are not grounded in their notes (see above).`),
  );
  if (broken > 0 || ungrounded > 0) process.exit(1);
}

/**
 * Citations re-checked against the notes the world was built from, and the
 * judge's stored verdicts re-read. Nothing is asked of a model here: the
 * deterministic half is recomputed, the model half is the record it left.
 */
function groundingOf(
  mechanic: Mechanic | undefined,
  notes: string | undefined,
): { ok: boolean; line: string } | null {
  if (!mechanic || !isGrounded(mechanic)) return null;
  if (!notes)
    return {
      ok: false,
      line: 'UNGROUNDED: built before the notes were kept; nothing to check citations against',
    };
  const cited =
    mechanic.type === 'sequence'
      ? mechanic.rules.every((r) => (r.evidence?.length ?? 0) > 0)
      : mechanic.evidence.every((e) => e.excerpt.trim());
  if (!cited) return { ok: false, line: 'UNGROUNDED: a rule cites nothing from the notes' };
  const exact =
    mechanic.type === 'sequence'
      ? sequenceGroundingProblems(mechanic, notes)
      : evidenceGroundingProblems(mechanic, notes);
  if (exact.length) {
    return { ok: false, line: `CITATION: ${exact.map((p) => `${p.at} ${p.code}`).join('; ')}` };
  }
  const judged = assess(mechanic, mechanic.grounding);
  if (judged.length) {
    return {
      ok: false,
      line: `JUDGE: ${judged
        .slice(0, 3)
        .map((p) => p.message)
        .join(' | ')}`,
    };
  }
  const n = mechanic.grounding!.verdicts.length;
  return {
    ok: true,
    line: `grounded: citations verbatim in the notes; all ${n} judge verdicts as required (${mechanic.grounding!.judge} — a model's reading, not a proof)`,
  };
}

main().catch((err) => {
  console.error(red('FAIL'), err instanceof Error ? err.message : err);
  process.exit(1);
});
