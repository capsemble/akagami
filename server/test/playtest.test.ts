/**
 * The play-tester harness. The model is scripted here — it calls tools in a
 * fixed order — so these tests prove that the tools run the game's real
 * checks, that the loop ends when an act passes, and that a dead model costs
 * nothing. How well a real model repairs is measured by the eval, not here.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ActSpec, Curriculum, Outline, SequenceMechanic } from '@chapter-quest/shared';
import { compile, randomWinRate, simulate, variablesOf } from '@chapter-quest/shared';
import type { Tool, ToolLoopOptions, runTools } from '../src/gemini.js';
import { repoRoot } from '../src/paths.js';
import { checkAct, findInNotes, playMove, playtest } from '../src/pipeline/playtest.js';
import { toActSpec, toWireAct } from '../src/wire.js';

const evaluator = { compile, variablesOf, simulate, randomWinRate };
const NOTES = readFileSync(
  join(repoRoot, 'server/scripts/fixtures/history-july-crisis.md'),
  'utf8',
);

const curriculum: Curriculum = {
  title: 'July 1914',
  subject: 'history',
  concepts: [
    {
      id: 'july-chain',
      name: 'The chain of decisions',
      keyRule: 'Each decision in July 1914 made the next one possible.',
      requires: [],
      difficulty: 2,
      misconceptions: ['The assassination caused the war on its own.'],
      kind: 'sequence',
      quote: 'Each decision in the July Crisis depended on the one before it',
      page: 1,
    },
  ],
};
const outline: Outline = {
  title: 'The July Ledger',
  logline: 'l',
  artStyle: 'a',
  villain: 'v',
  twist: 't',
  cast: [{ id: 'tara', name: 'Tara', look: 'l', persona: 'p' }],
  acts: [{ id: 'act1', conceptId: 'july-chain', title: 'The Wire', sceneName: 's', oneLine: 'o' }],
};
const mechanic: SequenceMechanic = {
  type: 'sequence',
  prompt: 'Order the decisions of July 1914.',
  items: [
    {
      id: 'cheque',
      label: "Germany's blank cheque",
      detail: 'A promise of unconditional German support.',
    },
    { id: 'ultimatum', label: 'The ultimatum to Serbia' },
    { id: 'war', label: 'Austria-Hungary declares war on Serbia' },
    { id: 'mobilise', label: 'Russia orders general mobilisation' },
  ],
  rules: [
    {
      before: 'cheque',
      after: 'ultimatum',
      why: 'German backing made the ultimatum possible.',
      evidence: [
        'Confident of German backing, Austria-Hungary sent Serbia an ultimatum with demands designed to be almost impossible to accept in full.',
      ],
    },
    {
      before: 'ultimatum',
      after: 'war',
      why: 'The rejected demand gave Vienna its reason for war.',
      evidence: [
        '**23 July:** Confident of German backing, Austria-Hungary sent Serbia an ultimatum',
        '**28 July:** Austria-Hungary declared war on Serbia.',
      ],
    },
    {
      before: 'war',
      after: 'mobilise',
      why: 'Russia mobilised to protect Serbia.',
      evidence: [
        '**28 July:** Austria-Hungary declared war on Serbia.',
        '**30 July:** Russia, determined to protect Serbia, ordered general mobilisation.',
      ],
    },
  ],
  initial: ['mobilise', 'war', 'ultimatum', 'cheque'],
  solution: ['cheque', 'ultimatum', 'war', 'mobilise'],
};
const good: ActSpec = {
  id: 'act1',
  conceptId: 'july-chain',
  title: 'The Wire',
  goal: 'Order the cables.',
  verbs: ['arrange'],
  prediction: { question: 'q?', options: ['a', 'b'], correctIndex: 0 },
  explainAfter: 'e',
  analogy: { text: 'a', breaksWhere: 'b' },
  dialogue: [{ speaker: 'Tara', line: 'Put them in order.' }],
  scene: {
    name: 's',
    description: 'd',
    objects: [{ id: 'board', label: 'Board', look: 'l' }],
    exitSide: 'east',
  },
  mechanic,
};
const ctx = { outline, curriculum, notes: NOTES, evaluator };

// A draft with the failure real builds produced most: a quotation recalled, not copied.
const paraphrased: ActSpec = {
  ...good,
  mechanic: {
    ...mechanic,
    rules: mechanic.rules.map((r, i) =>
      i === 0
        ? {
            ...r,
            evidence: [
              'Austria-Hungary, sure of German support, sent Serbia an impossible ultimatum.',
            ],
          }
        : r,
    ),
  },
};

test('the validator, on one act, reports only its own errors with local paths', () => {
  assert.deepEqual(checkAct(good, ctx), []);
  const errors = checkAct(paraphrased, ctx);
  assert.deepEqual(
    errors.map((e) => `${e.path} ${e.code}`),
    ['mechanic.rules[0].evidence[0] evidence-not-in-source'],
  );
});

test('find_in_notes hands back the real passage for a recalled one', () => {
  const found = findInNotes(
    'Austria-Hungary, sure of German support, sent Serbia an impossible ultimatum.',
    NOTES,
  );
  assert.equal(found.verbatim, false);
  assert.ok(found.passages.some((p) => p.includes('Confident of German backing')));
  assert.equal(findInNotes(mechanic.rules[0]!.evidence![0]!, NOTES).verbatim, true);
});

test('play runs the act’s own judge on a move', () => {
  assert.equal((playMove(good, { order: mechanic.solution }) as { won: boolean }).won, true);
  assert.equal((playMove(good, { order: mechanic.initial }) as { won: boolean }).won, false);
  assert.match(String((playMove(null, {}) as { error: string }).error), /revise/);
});

test('an act survives the round trip to the model’s format and back', () => {
  const back = toActSpec(toWireAct(good));
  assert.deepEqual(back.mechanic.type === 'sequence' && back.mechanic.rules, mechanic.rules);
  assert.deepEqual(back.mechanic.type === 'sequence' && back.mechanic.solution, mechanic.solution);
});

/** A scripted model: calls the tools it is given, in order, then stops. */
function scriptedLoop(steps: { tool: string; args: (tools: Tool[]) => Record<string, unknown> }[]) {
  const seen: { tool: string; result: unknown }[] = [];
  const run = (async (_prompt: string, tools: Tool[], opts: ToolLoopOptions) => {
    let calls = 0;
    for (const [i, step] of steps.entries()) {
      const tool = tools.find((t) => t.name === step.tool)!;
      seen.push({ tool: step.tool, result: await tool.run(step.args(tools)) });
      calls++;
      if (opts.done?.()) return { turns: i + 1, calls, text: '' };
    }
    return { turns: steps.length, calls, text: '' };
  }) as unknown as typeof runTools;
  return { run, seen };
}

test('the play-tester searches the notes, revises with the real passage, and stops when the act passes', async () => {
  const events: string[] = [];
  const { run, seen } = scriptedLoop([
    { tool: 'play', args: () => ({ order: mechanic.solution }) },
    {
      tool: 'find_in_notes',
      args: () => ({ text: 'sure of German support, impossible ultimatum' }),
    },
    { tool: 'revise', args: () => ({ act: toWireAct(good) }) },
    { tool: 'play', args: () => ({ order: mechanic.initial }) },
  ]);
  const result = await playtest(
    {
      ...ctx,
      concept: curriculum.concepts[0]!,
      plan: outline.acts[0]!,
      draft: paraphrased,
      errors: checkAct(paraphrased, ctx),
    },
    (e) => events.push(e.message),
    run,
  );
  assert.equal(result.passed, true);
  assert.equal(seen.length, 3, 'the loop ends the moment revise answers ok');
  assert.deepEqual(seen[2]!.result, { ok: true });
  assert.ok(events.some((m) => /passes the game’s checks/.test(m)));
});

test('a revision that still fails is reported back with its errors, and the act id cannot be changed', async () => {
  const { run, seen } = scriptedLoop([
    {
      tool: 'revise',
      args: () => ({ act: { ...toWireAct(paraphrased), id: 'act9', conceptId: 'other' } }),
    },
  ]);
  const result = await playtest(
    {
      ...ctx,
      concept: curriculum.concepts[0]!,
      plan: outline.acts[0]!,
      draft: paraphrased,
      errors: [],
    },
    () => {},
    run,
  );
  assert.equal(result.passed, false);
  assert.equal(result.spec?.id, 'act1');
  assert.equal(result.spec?.conceptId, 'july-chain');
  const answer = seen[0]!.result as { ok: boolean; errors: string[] };
  assert.equal(answer.ok, false);
  assert.match(answer.errors[0]!, /evidence-not-in-source/);
});

test('a dead model costs nothing: the pipeline gets its draft back and carries on', async () => {
  const dead = (async () => {
    throw new Error('503');
  }) as unknown as typeof runTools;
  const result = await playtest(
    {
      ...ctx,
      concept: curriculum.concepts[0]!,
      plan: outline.acts[0]!,
      draft: paraphrased,
      errors: [],
    },
    () => {},
    dead,
  );
  assert.deepEqual(result, { spec: null, passed: false, turns: 0, calls: 0 });
});
