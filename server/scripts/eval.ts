/**
 * How well does the pipeline actually do? Run real chapters through it and
 * measure, instead of asserting.
 *
 *   npm run eval                       # every fixture chapter
 *   npm run eval -- physics.md history-july-crisis.md
 *
 * Every chapter is built from scratch — no stage cache — into a scratch cache
 * directory of its own, so an eval never overwrites a world someone built.
 * No art is painted: the eval is about the game, not the pictures.
 *
 * What it reports, per chapter and in total:
 *   - concepts found, and how many could be played vs. were refused (and why)
 *   - acts shipped, and whether each one can be finished (completionOf)
 *   - first-pass validity, repairs, play-tester runs and passes, rules the
 *     evidence judge pruned, acts cut, and whether the build fell back
 *   - the odds of winning each act by guessing, worst case
 *   - citations checked verbatim, and the judge's verdict count
 *   - model calls, tokens and wall time per world
 *
 * Writes tmp/eval/report.json and tmp/eval/report.md.
 */
import { mkdtemp, mkdir, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// cache.ts reads this at import time, so it is set before anything imports it.
process.env.DESIGN_CACHE_DIR = await mkdtemp(join(tmpdir(), 'chapter-quest-eval-'));

const { config } = await import('dotenv');
const { repoRoot } = await import('../src/paths.js');
config({ path: join(repoRoot, '.env') });

const { extractText } = await import('../src/extract.js');
const { designWorld } = await import('../src/pipeline/design.js');
const { mapScenes, buildActs } = await import('../src/world.js');
const { getUsageByModel } = await import('../src/gemini.js');
const { completionOf, proofOf } = await import('@chapter-quest/shared');
type AgentEvent = import('@chapter-quest/shared').AgentEvent;

interface ActReport {
  id: string;
  title: string;
  mechanic: string;
  finishable: boolean;
  guessRate: number | null;
  citations: number;
  judged: number;
}

interface ChapterReport {
  chapter: string;
  title: string;
  ok: boolean;
  error?: string;
  fellBack: boolean;
  concepts: number;
  playable: number;
  refused: string[];
  acts: ActReport[];
  firstPassValid: boolean;
  repairs: number;
  playtests: number;
  playtestPasses: number;
  rulesPruned: number;
  actsCut: number;
  judgeRejections: number;
  seconds: number;
  calls: number;
  tokens: number;
}

const usageTotals = () =>
  Object.values(getUsageByModel()).reduce(
    (sum, u) => ({ calls: sum.calls + u.calls, tokens: sum.tokens + u.tokens }),
    { calls: 0, tokens: 0 },
  );

const count = (events: AgentEvent[], test: (e: AgentEvent) => boolean) =>
  events.filter(test).length;

async function evaluate(file: string): Promise<ChapterReport> {
  const started = Date.now();
  const before = usageTotals();
  const events: AgentEvent[] = [];
  const base = {
    chapter: file,
    title: '',
    ok: false,
    fellBack: false,
    concepts: 0,
    playable: 0,
    refused: [] as string[],
    acts: [] as ActReport[],
    firstPassValid: false,
    repairs: 0,
    playtests: 0,
    playtestPasses: 0,
    rulesPruned: 0,
    actsCut: 0,
    judgeRejections: 0,
  };
  const finish = (extra: Partial<ChapterReport>): ChapterReport => {
    const after = usageTotals();
    return {
      ...base,
      repairs: count(events, (e) => e.agent === 'Act writer' && e.kind === 'repair'),
      playtests: count(events, (e) => e.agent === 'Play-tester' && e.kind === 'start'),
      playtestPasses: count(events, (e) => e.agent === 'Play-tester' && e.kind === 'done'),
      rulesPruned: events
        .filter((e) => e.agent === 'Evidence judge' && e.kind === 'repair')
        .reduce((n, e) => n + Number(/dropped (\d+) rule/.exec(e.message)?.[1] ?? 0), 0),
      actsCut: count(events, (e) => /^Cutting /.test(e.message)),
      judgeRejections: count(events, (e) => e.agent === 'Evidence judge' && e.kind === 'rejected'),
      firstPassValid: events.some((e) => /Validator passed \(first pass\)/.test(e.message)),
      refused: events
        .filter((e) => e.agent === 'Validator' && /^Not building/.test(e.message))
        .map((e) => e.message.replace(/^Not building /, '').slice(0, 120)),
      seconds: Math.round((Date.now() - started) / 100) / 10,
      calls: after.calls - before.calls,
      tokens: after.tokens - before.tokens,
      ...extra,
    };
  };

  try {
    const chapter = await extractText(join(repoRoot, 'server/scripts/fixtures', file));
    const result = await designWorld({
      chapter,
      fresh: true,
      skipArt: true,
      emit: (e) => events.push(e),
    });
    const script = result.script;
    const acts = buildActs(script, mapScenes(script)).map((act): ActReport => {
      const proof = proofOf(act);
      const m = act.mechanic;
      const grounding =
        m && (m.type === 'sequence' || m.type === 'evidence') ? m.grounding : undefined;
      return {
        id: act.id,
        title: act.title,
        mechanic: m?.type ?? 'none',
        finishable: completionOf(act).ok,
        guessRate: proof?.guessRate ?? null,
        citations: proof?.citations.reduce((n, c) => n + c.quotes.length, 0) ?? 0,
        judged: grounding?.verdicts.length ?? 0,
      };
    });
    base.title = script.outline.title;
    base.concepts = script.curriculum.concepts.length;
    base.playable =
      events
        .filter((e) => /concepts are playable/.test(e.message))
        .map((e) => Number(/^(\d+) of/.exec(e.message)?.[1] ?? 0))[0] ?? 0;
    return finish({ ok: !result.usedFallback, fellBack: result.usedFallback, acts });
  } catch (err) {
    return finish({ error: err instanceof Error ? err.message.slice(0, 300) : String(err) });
  }
}

/** A few at a time: enough to finish in minutes, few enough not to trip rate limits. */
async function pool<T, R>(items: T[], width: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(width, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await work(items[i]!);
        console.log(`  done: ${items[i]}`);
      }
    }),
  );
  return out;
}

const pct = (n: number, d: number) => (d === 0 ? '—' : `${Math.round((100 * n) / d)}%`);

async function main() {
  const named = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const files = named.length
    ? named
    : (await readdir(join(repoRoot, 'server/scripts/fixtures')))
        .filter((f) => f.endsWith('.md'))
        .sort();
  console.log(`eval: ${files.length} chapter(s), built from scratch, no art`);
  // Usage counters are process-wide and chapters build three at a time, so
  // cost is measured over the whole run and divided, never per chapter.
  const spentBefore = usageTotals();
  const reports = await pool(files, 3, evaluate);
  const spent = usageTotals();
  const runCalls = spent.calls - spentBefore.calls;
  const runTokens = spent.tokens - spentBefore.tokens;

  const acts = reports.flatMap((r) => r.acts);
  const built = reports.filter((r) => r.ok);
  const guessable = acts.map((a) => a.guessRate).filter((g): g is number => g !== null);
  const totals = {
    chapters: reports.length,
    builtFromTheirOwnChapter: built.length,
    fellBack: reports.filter((r) => r.fellBack).length,
    failed: reports.filter((r) => r.error).length,
    conceptsFound: reports.reduce((n, r) => n + r.concepts, 0),
    conceptsPlayable: reports.reduce((n, r) => n + r.playable, 0),
    actsShipped: acts.length,
    actsFinishable: acts.filter((a) => a.finishable).length,
    firstPassValid: built.filter((r) => r.firstPassValid).length,
    repairs: reports.reduce((n, r) => n + r.repairs, 0),
    playtests: reports.reduce((n, r) => n + r.playtests, 0),
    playtestPasses: reports.reduce((n, r) => n + r.playtestPasses, 0),
    rulesPruned: reports.reduce((n, r) => n + r.rulesPruned, 0),
    actsCut: reports.reduce((n, r) => n + r.actsCut, 0),
    citationsVerbatim: acts.reduce((n, a) => n + a.citations, 0),
    judgeVerdicts: acts.reduce((n, a) => n + a.judged, 0),
    worstGuessRate: guessable.length ? Math.max(...guessable) : null,
    medianSeconds:
      built.map((r) => r.seconds).sort((a, b) => a - b)[Math.floor(built.length / 2)] ?? null,
    callsPerWorld: Math.round(runCalls / reports.length),
    tokensPerWorld: Math.round(runTokens / reports.length),
  };

  const lines = [
    '# Chapter Quest — pipeline eval',
    '',
    `${totals.chapters} chapters, each built from scratch with no cache and no art, ${new Date().toISOString().slice(0, 16)}Z.`,
    '',
    '| Measure | Result |',
    '|---|---|',
    `| Built from their own chapter | ${totals.builtFromTheirOwnChapter}/${totals.chapters}${totals.fellBack ? ` (${totals.fellBack} fell back to the prepared world, reported as such)` : ''}${totals.failed ? `, ${totals.failed} refused or failed` : ''} |`,
    `| Concepts playable | ${totals.conceptsPlayable}/${totals.conceptsFound} (${pct(totals.conceptsPlayable, totals.conceptsFound)}); the rest refused with a reason |`,
    `| Acts that can be finished | ${totals.actsFinishable}/${totals.actsShipped} |`,
    `| Valid on the first pass | ${totals.firstPassValid}/${built.length} worlds |`,
    `| Repairs · play-tests (passed) · rules pruned · acts cut | ${totals.repairs} · ${totals.playtests} (${totals.playtestPasses}) · ${totals.rulesPruned} · ${totals.actsCut} |`,
    `| Citations checked word-for-word against the notes | ${totals.citationsVerbatim} |`,
    `| Evidence-judge verdicts recorded | ${totals.judgeVerdicts} |`,
    `| Worst-case odds of winning an act by guessing | ${totals.worstGuessRate === null ? '—' : `${(totals.worstGuessRate * 100).toFixed(1)}%`} |`,
    `| Median build time (script only, 3 building at once) | ${totals.medianSeconds ?? '—'} s |`,
    `| Model calls · tokens per world (averaged over the run) | ${totals.callsPerWorld} · ${totals.tokensPerWorld.toLocaleString()} |`,
    '',
    '## Per chapter',
    '',
    '| Chapter | World | Acts (mechanic: finishable, guess odds) | First pass | Repairs / play-tests / pruned / cut | Time |',
    '|---|---|---|---|---|---|',
    ...reports.map((r) =>
      r.error
        ? `| ${r.chapter} | — | ${r.error.slice(0, 140)} | — | — | ${r.seconds} s |`
        : `| ${r.chapter} | ${r.fellBack ? '(fell back) ' : ''}${r.title} | ${r.acts
            .map(
              (a) =>
                `${a.mechanic}: ${a.finishable ? '✓' : '✗'}, ${a.guessRate === null ? '—' : `${(a.guessRate * 100).toFixed(1)}%`}`,
            )
            .join(
              '; ',
            )} | ${r.firstPassValid ? 'yes' : 'no'} | ${r.repairs} / ${r.playtests} (${r.playtestPasses} passed) / ${r.rulesPruned} / ${r.actsCut} | ${r.seconds} s |`,
    ),
    '',
    '## Refused concepts',
    '',
    ...reports.flatMap((r) => r.refused.map((x) => `- ${r.chapter}: ${x}`)),
    '',
    'Deterministic: finishability, guess odds, verbatim citations, first-pass validity.',
    'Model-based: the evidence judge’s verdicts (a model’s reading, recorded, not a proof).',
  ];

  const out = join(repoRoot, 'tmp/eval');
  await mkdir(out, { recursive: true });
  await writeFile(join(out, 'report.json'), JSON.stringify({ totals, reports }, null, 2));
  await writeFile(join(out, 'report.md'), `${lines.join('\n')}\n`);
  console.log(`\n${lines.join('\n')}\n\nreport → ${join(out, 'report.md')}`);
}

main().catch((err) => {
  console.error('FAIL', err instanceof Error ? err.stack : err);
  process.exit(1);
});
